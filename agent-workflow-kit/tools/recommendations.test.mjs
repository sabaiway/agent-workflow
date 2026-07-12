// recommendations.test.mjs — the read-only upgrade Recommendations advisor (AD-044 Plan 4,
// Phase 3.4). Pins: the present-even-when-empty section contract, --cwd explicitness (subdir-proof),
// cwd-independent apply one-liners, the fact-true frozen benefit registry (bridge tier claims
// velocity ONLY; the dual security wording rides only the real-security-delta items; risk-bearing
// items state the risk inline), honest probe degradation (a failed probe = a stated skipped-item
// line, never a crash, never a fabricated item), and the advisor's read-only nature (source scan).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  main,
  buildRecommendations,
  formatRecommendations,
  BENEFITS,
  DUAL_SECURITY_BENEFIT,
  RECOMMENDATIONS_SECTION_HEADER,
  RECOMMENDATIONS_EMPTY_LINE,
} from './recommendations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Host expectations are READ FROM the bundled manifests (the advisor's own single source) —
// a hardcoded list here would silently outdate the moment a manifest gains an observed host.
const BUNDLE_ROOT = join(HERE, '..', 'bridges');
const manifestHosts = (bridge) =>
  JSON.parse(readFileSync(join(BUNDLE_ROOT, bridge, 'capability.json'), 'utf8')).networkHosts;
const AGY_HOSTS = manifestHosts('antigravity-cli-bridge');
const CODEX_HOSTS = manifestHosts('codex-cli-bridge');

// A minimal deployed project: the stamp velocity's preflight reads; no .claude yet.
const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'recommendations-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
  return root;
};

// Deps that keep the host machine out of the probes: no placed wrappers, empty env/PATH, and a
// fixture HOME (no bridge-settings.conf).
const hermeticDeps = (root, extra = {}) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home: root,
  ...extra,
});

describe('recommendations — section contract', () => {
  it('renders PRESENT-EVEN-WHEN-EMPTY with the exact empty-state line', () => {
    const out = formatRecommendations({ items: [], skips: [] });
    assert.equal(out, `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });

  it('the section always opens at the header — items or not', () => {
    const root = makeProject();
    const r = main(['--cwd', root], { deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith(RECOMMENDATIONS_SECTION_HEADER), 'the header opens the section');
  });

  it('--cwd is REQUIRED — the target project is explicit, never inferred (usage exit 2)', () => {
    const r = main([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--cwd .* required|--cwd <project-root> is required/);
  });

  it('an unknown argument is a loud usage error (exit 2)', () => {
    const r = main(['--cwd', HERE, '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument: --bogus/);
  });

  it('a --cwd that is not a directory is a loud error (exit 1)', () => {
    const r = main(['--cwd', join(HERE, 'no-such-dir-xyz')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a directory/);
  });

  it('--help names the empty-state line and the hand-apply boundary', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(RECOMMENDATIONS_EMPTY_LINE));
    assert.match(r.stdout, /HAND-APPLY/);
  });
});

describe('recommendations — fact-true frozen benefit registry', () => {
  it('the bridge-wrappers benefit claims velocity ONLY — no security wording rides it', () => {
    assert.match(BENEFITS['bridge-tier'], /^velocity — /);
    assert.doesNotMatch(BENEFITS['bridge-tier'], /safer|security|blast radius/iu);
  });

  it('the dual security wording rides EXACTLY the real-security-delta items', () => {
    const dual = Object.keys(BENEFITS).filter((k) => BENEFITS[k].includes(DUAL_SECURITY_BENEFIT));
    assert.deepEqual(dual.sort(), ['autonomy-render', 'sandbox-provision']);
  });

  it('risk-bearing items state their risk in the SAME line (agy stall; network egress widening)', () => {
    assert.match(BENEFITS['agy-adddir'], /CAVEAT.*stall risk/u);
    assert.match(BENEFITS['network-allowlist'], /RISK stated plainly.*EVERY sandboxed command/u);
  });
});

describe('recommendations — cwd-independent apply one-liners (subdir-proof)', () => {
  it('every rendered apply line is absolute-path node + pinned --cwd, a skill invocation, or HAND-APPLY', () => {
    const root = makeProject();
    // Fire a broad item set: no allowlist (velocity items), no autonomy policy, no gates.
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.length >= 3, `expected a broad fixture item set, got ${items.map((i) => i.key).join(', ')}`);
    for (const item of items) {
      const okShape =
        /^node \/[^\s]+\.mjs(?: |$)/.test(item.apply) ||
        /^cd \/[^\s]+ && node \/[^\s]+\.mjs$/.test(item.apply) ||
        /^\/agent-workflow-kit [a-z-]+ \(run IN the target project/.test(item.apply) ||
        item.apply.startsWith('HAND-APPLY');
      assert.ok(okShape, `${item.key}: apply must be abs-path node / cd-pinned node / skill invocation / HAND-APPLY: ${item.apply}`);
      assert.doesNotMatch(item.apply, /(?:^|\s)(?:\.\/|\.\.\/|node tools\/)/u, `${item.key}: no relative path segments: ${item.apply}`);
      if (item.apply.startsWith('node ') && item.apply.includes(' --cwd ')) {
        assert.match(item.apply, / --cwd \//u, `${item.key}: --cwd must pin an absolute root`);
      }
    }
  });

  it('a from-a-subdirectory invocation still advises on the NAMED root (never the shell cwd)', () => {
    const root = makeProject();
    const sub = join(root, 'docs');
    const prev = process.cwd();
    process.chdir(sub);
    try {
      const r = main(['--cwd', root], { deps: hermeticDeps(root) });
      assert.equal(r.code, 0, r.stderr);
      // Project-scoped applies carry --cwd; host-level ones (doctor, bridge-settings) rightly don't.
      const cwdApplies = r.stdout.split('\n').filter((l) => l.trim().startsWith('apply: node ') && l.includes(' --cwd '));
      assert.ok(cwdApplies.length >= 1, 'at least one project-scoped node apply line in the fixture');
      for (const line of cwdApplies) {
        assert.ok(line.includes(`--cwd ${root}`), `apply pins the named root: ${line}`);
        assert.ok(!line.includes(`--cwd ${sub}`), `apply never pins the shell cwd: ${line}`);
      }
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('recommendations — honest probe degradation', () => {
  it('a probe failure is a stated skipped-item line — exit 0, never a crash, never a fabricated item', () => {
    const root = makeProject();
    // A PRESENT gates.json whose read explodes: the gates probe must degrade to a stated skip.
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }));
    const boom = () => {
      throw new Error('injected probe failure');
    };
    const r = main(['--cwd', root], { deps: hermeticDeps(root, { readFile: boom }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠ skipped item [a-z-]+ — probe failed: /u);
    assert.match(r.stdout, /injected probe failure/);
  });
});

describe('recommendations — item probes over fixtures', () => {
  it('an undeployed allowlist fires velocity-core with the exact --apply one-liner', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const core = items.find((i) => i.key === 'velocity-core');
    assert.ok(core, 'velocity-core fires on a project with no seeded allowlist');
    assert.equal(core.apply, `node ${join(HERE, 'velocity-profile.mjs')} --apply --cwd ${root}`);
    assert.equal(core.benefit, BENEFITS['velocity-core']);
  });

  it('no autonomy policy fires the set-autonomy item; a placed policy does not', () => {
    const root = makeProject();
    const before = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    assert.ok(before.items.some((i) => i.key === 'autonomy-policy'));
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{}\n');
    const after = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!after.items.some((i) => i.key === 'autonomy-policy'), 'a declared policy is not re-recommended');
  });

  it('a REAL declared policy with unrendered settings fires the autonomy-render item; the sparse seed never does', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
    const real = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    const item = real.items.find((i) => i.key === 'autonomy-render');
    assert.ok(item, 'a real policy with no rendered settings drifts');
    assert.match(item.apply, /--autonomy --apply --cwd /);
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ "_README": "note" }');
    const sparse = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!sparse.items.some((i) => ['autonomy-render', 'autonomy-policy'].includes(i.key)), 'the defaults-equivalent seed fires neither autonomy item');
  });

  it('agy placed without AGY_REVIEW_ALLOW_ADDDIR fires the bridge-settings one-liner; a configured env does not', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const fired = buildRecommendations({ cwd: root, deps });
    const item = fired.items.find((i) => i.key === 'agy-adddir');
    assert.ok(item, 'fires when placed and unconfigured');
    assert.equal(item.apply, `node ${join(HERE, 'bridge-settings.mjs')} --set AGY_REVIEW_ALLOW_ADDDIR=1 --apply`);
    const configured = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: '0' } }),
    });
    assert.ok(!configured.items.some((i) => i.key === 'agy-adddir'), 'an env-configured knob is not re-recommended');
    // env > file: an INVALID env value shadows the settings file — the file writer cannot fix it,
    // so the apply is fix/unset-the-env guidance, never the bridge-settings one-liner (codex).
    const invalidEnv = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: 'yes' } }),
    });
    rmSync(root, { recursive: true, force: true });
    const envItem = invalidEnv.items.find((i) => i.key === 'agy-adddir');
    assert.ok(envItem, 'an invalid env value fires');
    assert.match(envItem.apply, /^HAND-APPLY: unset AGY_REVIEW_ALLOW_ADDDIR/, 'the apply targets the env var, not the shadowed file');
  });

  it('an INVALID bridge-settings value does not suppress the agy-adddir item', () => {
    // agy-review validates the value and falls back to the default (refuse) on garbage — a
    // presence-only check would suppress the item while the knob is effectively unset (codex R3).
    const root = makeProject();
    mkdirSync(join(root, '.config', 'agent-workflow'), { recursive: true });
    writeFileSync(join(root, '.config', 'agent-workflow', 'bridge-settings.conf'), 'AGY_REVIEW_ALLOW_ADDDIR=2\n');
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { XDG_CONFIG_HOME: join(root, '.config') } });
    const fired = buildRecommendations({ cwd: root, deps });
    assert.ok(fired.items.some((i) => i.key === 'agy-adddir'), 'an invalid value is effectively unset — the item fires');
    writeFileSync(join(root, '.config', 'agent-workflow', 'bridge-settings.conf'), 'AGY_REVIEW_ALLOW_ADDDIR=0\n');
    const explicit = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!explicit.items.some((i) => i.key === 'agy-adddir'), 'an explicit valid 0 is a user CHOICE — never nagged');
  });

  it('an EXPLICIT policy declaring exactly the default values is a DECLARATION — the render item still fires', () => {
    // Resolved-equality conflated a declared-defaults policy with the _README-only seed and
    // suppressed the render nudge — but the render carries the red-line ask rules, a real
    // security surface; seed detection is STRUCTURAL (codex, Segment B closing).
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'prompt' } }));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.some((i) => i.key === 'autonomy-render'), 'a declared-defaults policy still gets the render nudge');
  });

  it('the network item converges once the hosts are hand-applied', () => {
    // The advisor must reach "flow optimal" after the user pastes the domains — comparing the
    // live allowedDomains against the manifests' networkHosts (codex R3).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: {
          excludedCommands: ['agy-review'],
          network: { allowedDomains: [...AGY_HOSTS] },
        },
        permissions: { allow: ['Bash(agy-review code:*)'] },
      }),
    );
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'network-allowlist'), 'all manifest hosts present → the item suppresses');
  });

  it('the HAND-APPLY snippet states a key-path merge that preserves excludedCommands', () => {
    // A `"sandbox": { "network": … }`-shaped snippet pasted verbatim could REPLACE the whole
    // sandbox object and drop excludedCommands — the text must state the precise key-path merge
    // and name what is preserved (codex terminal, Segment B).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'network-allowlist');
    assert.ok(item, 'the item fires');
    assert.match(item.apply, /set the key sandbox\.network\.allowedDomains/u, 'a key-path operation, never a whole-object paste');
    assert.match(item.apply, /keep excludedCommands and every other sandbox key/u, 'the preserve semantics are stated');
    assert.doesNotMatch(item.apply, /"sandbox": \{/u, 'no whole-sandbox-object JSON shape to paste over the block');
  });

  it('a PARTIAL hand-apply renders the full desired final allowlist so the paste never drops applied domains', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { excludedCommands: ['agy-review'], network: { allowedDomains: [AGY_HOSTS[0]] } }, permissions: { allow: ['Bash(agy-review code:*)'] } }),
    );
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'network-allowlist');
    assert.ok(item, 'missing hosts keep the item firing');
    assert.ok(item.apply.includes(JSON.stringify(AGY_HOSTS[0])), 'the ALREADY-applied domain stays in the pasted value');
    for (const h of AGY_HOSTS.slice(1)) assert.ok(item.apply.includes(JSON.stringify(h)), `missing host ${h} rides the same full final list`);
  });

  it('the network item demands the TWO-SURFACE tier proof — excludedCommands alone (no code-mode allow rule) stays silent', () => {
    // The bridge tier wires BOTH surfaces; surfacing the risky egress hand-apply before the
    // permissions.allow half exists would front-run the bridge-tier item (codex terminal).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'network-allowlist'), 'half-wired = the bridge-tier item covers first');
    assert.ok(!skips.some((s) => s.key === 'network-allowlist'), 'half-wired is not a probe failure either');
  });

  it('local-scope allowedDomains count toward coverage but NEVER leak into the PROJECT paste value', () => {
    // The paste targets the COMMITTED .claude/settings.json — a domain allowed only in the
    // private settings.local.json must not be widened to the whole project (codex terminal).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { excludedCommands: ['agy-review'], network: { allowedDomains: [AGY_HOSTS[0]] } }, permissions: { allow: ['Bash(agy-review code:*)'] } }),
    );
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { network: { allowedDomains: ['private-vpn.corp.internal', AGY_HOSTS[1]] } } }),
    );
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'network-allowlist');
    assert.ok(item, 'uncovered manifest hosts keep the item firing');
    assert.ok(!item.apply.includes('private-vpn.corp.internal'), 'a local-only domain never rides the committed project paste');
    assert.ok(!item.apply.includes(JSON.stringify(AGY_HOSTS[1])), 'a locally-covered manifest host is coverage, not project paste content');
    assert.ok(item.apply.includes(JSON.stringify(AGY_HOSTS[0])), 'project-applied domains stay in the paste value');
    for (const h of AGY_HOSTS.slice(2)) assert.ok(item.apply.includes(JSON.stringify(h)), `missing manifest host ${h} rides the paste value`);
  });

  it('the network-allowlist item is HAND-APPLY, fires only for WIRED wrappers, and sources hosts from the manifests', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'network-allowlist');
    assert.ok(item, 'fires when a placed review wrapper is wired into excludedCommands');
    assert.ok(item.apply.startsWith('HAND-APPLY (the kit never writes this)'), 'hand-apply by design — never an agent-run writer');
    for (const h of AGY_HOSTS) assert.ok(item.apply.includes(JSON.stringify(h)), `the wired bridge's manifest host ${h} rides the paste line`);
    for (const h of CODEX_HOSTS) assert.ok(!item.apply.includes(JSON.stringify(h)), `un-wired bridge host ${h} must not ride`);
  });

  it('an unwired non-empty gate declaration fires the gate-hook one-liner', () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'docs', 'ai', 'gates.json'),
      JSON.stringify({ gates: [{ id: 'unit-tests', title: 'Unit tests', cmd: 'node --test' }] }),
    );
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'gate-hook');
    assert.ok(item, 'fires on declared-but-unwired gates');
    assert.equal(item.apply, `node ${join(HERE, 'gate-hook.mjs')} --apply --cwd ${root}`);
  });

  it('sandbox masks visible with no managed block fire the sandbox-masks apply one-liner (git fixture)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recommendations-git-'));
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
    const fakeChar = {
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isCharacterDevice: () => true,
      isBlockDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
    const deps = hermeticDeps(root, {
      listUntracked: () => ['.bashrc'],
      lstat: (p) => (p.endsWith('.bashrc') ? fakeChar : lstatSync(p)),
    });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'sandbox-masks');
    assert.ok(item, 'fires when the derivation diverges from the (absent) managed block');
    assert.match(item.apply, /sandbox-masks\.mjs.*--apply/u, 'the apply one-liner is the lane the tool itself renders');
  });
});

describe('recommendations — every probe degrades honestly (per-branch skip coverage)', () => {
  it('a MALFORMED settings.json skips the velocity items, the render check, and the network item — exit 0', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } })); // REAL policy → the render check runs and throws
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const skipped = skips.map((s) => s.key);
    for (const key of ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'network-allowlist']) {
      assert.ok(skipped.includes(key), `${key} degrades to a stated skip on malformed settings (got: ${skipped.join(', ')})`);
    }
    assert.ok(!items.some((i) => ['velocity-core', 'autonomy-render'].includes(i.key)), 'no fabricated items');
  });

  it('an unseedable (space-carrying) project root skips ONLY the kit-tools tier — core still fires', () => {
    const root = mkdtempSync(join(tmpdir(), 'rec space-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'kit-tools-tier'), 'the tier derivation refuses the unseedable root — a stated skip');
    assert.ok(items.some((i) => i.key === 'velocity-core'), 'the core item still fires (its apply line shell-quotes the root)');
  });

  it('a throwing wrapper probe skips the bridge-tier item', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, {
      findWrapper: () => {
        throw new Error('probe exploded');
      },
    });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'bridge-tier' && /probe exploded/.test(s.reason)));
  });

  it('a MALFORMED autonomy policy skips the autonomy items with the loud parse reason', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ not json');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'autonomy-policy' && /malformed JSON/.test(s.reason)));
    assert.ok(!items.some((i) => i.key === 'autonomy-policy'), 'a malformed policy is never re-declared as a fire');
  });

  it('a non-ENOENT bridge-settings read failure skips the agy-adddir item (never treated as unconfigured)', () => {
    const root = makeProject();
    const boom = () => {
      throw Object.assign(new Error('EACCES conf'), { code: 'EACCES' });
    };
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', readFile: boom });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'agy-adddir' && /EACCES/.test(s.reason)));
  });

  it('a DEGRADING configured review recipe fires the review-recipe item (config says council, nothing is ready)', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'review-recipe');
    assert.ok(item, 'a configured-but-unsatisfiable recipe is a real sub-optimality');
    assert.match(item.what, /plan-execution\.review: configured council degrades to solo/);
    assert.equal(item.apply, '/agent-workflow-kit backends');
  });

  it('a MALFORMED gates.json skips the gate-hook item with the declaration reason', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), '{ not json');
    const { skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'gate-hook'), 'an unreadable declaration is a stated skip, never a guess');
  });

  it('family-freshness: behind/caveated rows fire the init item; a throwing survey degrades to a skip', () => {
    const root = makeProject();
    const rows = [
      { name: 'agent-workflow-engine', version: '1.0.0', freshness: 'behind' },
      { name: 'agent-workflow-memory', freshness: 'current', caveats: ['orchestration template missing', 'autonomy template missing'] },
    ];
    const fired = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { surveyFamily: () => rows }) });
    const item = fired.items.find((i) => i.key === 'family-freshness');
    assert.ok(item, 'behind + caveated rows fire');
    assert.match(item.what, /agent-workflow-engine 1\.0\.0 is behind/);
    assert.match(item.what, /orchestration template missing; autonomy template missing/, 'ALL caveats per row — the second is never dropped');
    assert.equal(item.apply, 'npx @sabaiway/agent-workflow-kit@latest init');
    const broken = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, {
        surveyFamily: () => {
          throw new Error('registry exploded');
        },
      }),
    });
    rmSync(root, { recursive: true, force: true });
    assert.ok(broken.skips.some((s) => s.key === 'family-freshness' && /registry exploded/.test(s.reason)));
  });

  it('a stale-real-only fence renders the clear form of the apply one-liner', () => {
    // The mask was applied, then the path became a REAL file: derivation is now EMPTY while the
    // block is non-empty — a plain --apply REFUSES there, so the rendered one-liner must carry
    // --clear (codex R1, Segment B).
    const root = mkdtempSync(join(tmpdir(), 'recommendations-stalereal-'));
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(
      join(root, '.git', 'info', 'exclude'),
      '# >>> agent-workflow sandbox-masks — managed block, fully REPLACED by the kit sandbox-masks lane; do not hand-edit inside >>>\n/was-a-mask.txt\n# <<< agent-workflow sandbox-masks <<<\n',
    );
    writeFileSync(join(root, 'was-a-mask.txt'), 'now a real file\n');
    const deps = hermeticDeps(root, { listUntracked: () => ['was-a-mask.txt'] });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'sandbox-masks');
    assert.ok(item, 'a stale-real fence fires the item');
    assert.match(item.apply, /--apply --clear$/, 'the exact one-liner must not be the refusing plain --apply');
  });

  it('probe skips suppress the flow-optimal claim', () => {
    const out = formatRecommendations({ items: [], skips: [{ key: 'gate-hook', reason: 'boom' }] });
    assert.ok(!out.includes(RECOMMENDATIONS_EMPTY_LINE), 'skipped checks mean the flow is NOT attested optimal');
    assert.match(out, /skipped item gate-hook/);
    assert.match(out, /NOT attested optimal/i, 'the non-attestation is stated, never implied');
  });

  it('a throwing untracked walk skips the sandbox-masks item (git fixture)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recommendations-git-skip-'));
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
    const deps = hermeticDeps(root, {
      listUntracked: () => {
        throw new Error('walk exploded');
      },
    });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'sandbox-masks' && /walk exploded/.test(s.reason)));
  });

  it('the sandbox-provision apply pins the target project via a cd prefix', () => {
    // autonomy-doctor reads process.cwd() and refuses outside a deployment — a bare one-liner
    // could diagnose the WRONG project from a subdirectory (codex R2, Segment B).
    const root = makeProject();
    const deps = hermeticDeps(root, { platform: 'linux', hasBinary: () => false });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'sandbox-provision');
    assert.ok(item, 'fires when the sandbox is unavailable');
    assert.ok(item.apply.startsWith(`cd ${root} && node `), `the doctor run is pinned to the named root: ${item.apply}`);
  });

  it('a schema-invalid orchestration config degrades to a stated review-recipe skip', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'bogus-activity': { review: 'council' } }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'review-recipe'), 'an invalid config is a stated skip, never silently ignored');
    assert.ok(!items.some((i) => i.key === 'review-recipe'), 'no item is fabricated from an invalid config');
  });

  it('a seeded-empty gate declaration fires the consent-gated seeder one-liner', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'gates-declaration');
    assert.ok(item, 'an EMPTY declaration is as undeclared as an absent file');
    assert.equal(item.apply, `node ${join(HERE, 'seed-gates.mjs')} --cwd ${root}`, 'the apply line is a PURE executable command — run-exactly-verbatim must not feed prose to the CLI');
    assert.match(item.what, /PREVIEW.*writes nothing/i, 'the two-step is stated in WHAT — the rendered line previews, it does not write');
    assert.match(item.what, /--apply/, 'the consent step is named in WHAT: the preview prints the exact --apply line to run');
  });

  it('a throwing sandbox-availability probe skips the sandbox-provision item', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, {
      platform: 'linux',
      hasBinary: () => {
        throw new Error('binary probe exploded');
      },
    });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'sandbox-provision' && /binary probe exploded/.test(s.reason)));
  });

  it('an unreadable bundled manifest is a STATED skip — never a silently thinner paste list', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, {
      findWrapper: (cmd) => cmd === 'agy-review',
      readdir: () => ['ghost-bridge-without-manifest'],
    });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'network-allowlist'), 'a partial manifest walk must not render a paste list');
    const skip = skips.find((s) => s.key === 'network-allowlist');
    assert.ok(skip, 'the failure is a stated skipped-item line');
    assert.match(skip.reason, /ghost-bridge-without-manifest.*capability\.json/, 'the reason names the unreadable manifest');
  });

  it('an UNCAVEATED unknown-freshness row is a stated skip — never a silent flow-optimal claim', () => {
    // family-registry sets freshness 'unknown' WITHOUT a caveat on a non-ENOENT template-probe
    // error — dropping such a row would let the advisor claim optimal despite a failed check
    // (codex terminal); 'not-checked' surfaces stay out (deliberately unprobed, not failed).
    const root = makeProject();
    const deps = hermeticDeps(root, {
      surveyFamily: () => [
        { name: 'agent-workflow-memory', freshness: 'unknown', caveats: [] },
        { name: 'agent-workflow-kit', freshness: 'not-checked', caveats: [] },
      ],
    });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'family-freshness'), 'nothing is provably behind — no item is fabricated');
    const skipRec = skips.find((s) => s.key === 'family-freshness');
    assert.ok(skipRec, 'an unverifiable freshness check is a stated skip');
    const namesPart = skipRec.reason.match(/^freshness unknown for (.+?) — /)?.[1] ?? '';
    assert.match(namesPart, /agent-workflow-memory/, 'the reason names the unverifiable row');
    assert.doesNotMatch(namesPart, /agent-workflow-kit/, 'a not-checked surface is not a failure (the kit name may appear only in the recovery command)');
  });

  it('a stray regular FILE in the bundle root is ignored — never read as a broken bridge bundle', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const enotdir = () => {
      const e = new Error('ENOTDIR: not a directory');
      e.code = 'ENOTDIR';
      throw e;
    };
    const deps = hermeticDeps(root, {
      findWrapper: (cmd) => cmd === 'agy-review',
      readdir: () => ['.DS_Store', 'antigravity-cli-bridge'],
      readFile: (p, enc) => (p.includes('.DS_Store') ? enotdir() : readFileSync(p, enc)),
    });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!skips.some((s) => s.key === 'network-allowlist'), 'ENOTDIR on a stray file must not skip the item');
    const item = items.find((i) => i.key === 'network-allowlist');
    assert.ok(item, 'the item still renders from the real bridge manifests');
    for (const h of AGY_HOSTS) assert.ok(item.apply.includes(JSON.stringify(h)), `manifest host ${h} still rides the paste line`);
  });

  it('the direct CLI run renders the section and exits 0 (the spawn covers the emit tail)', () => {
    const root = makeProject();
    const out = execFileSync(process.execPath, [join(HERE, 'recommendations.mjs'), '--cwd', root], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.ok(out.startsWith(RECOMMENDATIONS_SECTION_HEADER));
  });
});

describe('recommendations — read-only by construction', () => {
  it('the advisor source carries no write/spawn API (pure reader over exported probes)', () => {
    const source = readFileSync(join(HERE, 'recommendations.mjs'), 'utf8');
    assert.doesNotMatch(
      source,
      /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream|copyFileSync|node:child_process/u,
      'recommendations.mjs must stay a pure reader',
    );
  });

  it('a full fixture run leaves the project tree byte-identical (no fs writes)', () => {
    const root = makeProject();
    const snapshot = () => readFileSync(join(root, 'docs', 'ai', '.workflow-version'), 'utf8');
    const before = snapshot();
    main(['--cwd', root], { deps: hermeticDeps(root) });
    const after = snapshot();
    const claudeDirExists = (() => {
      try {
        lstatSync(join(root, '.claude'));
        return true;
      } catch {
        return false;
      }
    })();
    rmSync(root, { recursive: true, force: true });
    assert.equal(after, before);
    assert.equal(claudeDirExists, false, 'the advisor never creates .claude');
  });
});
