// recommendations.test.mjs — the read-only upgrade Recommendations advisor (AD-044 Plan 4 +
// REC-UX-REWORK/AD-053). Pins: the verdict-first D1 state matrix over the frozen severity
// registry, the D2 shape gate (one-line char-capped registry strings, banned tokens, the add()
// runtime backstop, capped skip reasons), the present-even-when-empty section contract, --cwd
// explicitness (subdir-proof), cwd-independent apply one-liners, the fact-true frozen benefit
// registry (bridge tier claims velocity ONLY; the dual security wording rides only the
// real-security-delta items; posture/risk prose lives in the mode-doc notes at the consent
// moment — never inline in registry strings, D3), the sandbox-lane fingerprint-ack convergence
// (D4/D6), honest probe degradation (a failed probe = a stated skipped-item line, never a crash,
// never a fabricated item), and the advisor's read-only nature (source scan).

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
  composeVerdict,
  BENEFITS,
  WHATS,
  ITEM_LINE_CAP,
  SKIP_REASON_CAP,
  SEVERITIES,
  SEVERITY_ATTENTION,
  SEVERITY_OPTIONAL,
  SEVERITY_LABELS,
  DUAL_SECURITY_BENEFIT,
  RECOMMENDATIONS_SECTION_HEADER,
  RECOMMENDATIONS_EMPTY_LINE,
  VERDICT_ATTENTION_TEMPLATE,
  VERDICT_NOTHING_BROKEN,
  VERDICT_OPTIONAL_TEMPLATE,
  VERDICT_SKIPS_TEMPLATE,
  recipeFingerprint,
  SANDBOX_LANE_ACK_PARENT,
  SANDBOX_LANE_ACK_KEY,
  RISK_NOTED_KEYS,
} from './recommendations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Recipe expectations are READ FROM the bundled manifests (the advisor's own single source) —
// a hardcoded list here would silently outdate the moment a manifest gains an observed entry.
const BUNDLE_ROOT = join(HERE, '..', 'bridges');
const manifestField = (bridge, field) =>
  JSON.parse(readFileSync(join(BUNDLE_ROOT, bridge, 'capability.json'), 'utf8'))[field];
const AGY_HOSTS = manifestField('antigravity-cli-bridge', 'networkHosts');
const CODEX_HOSTS = manifestField('codex-cli-bridge', 'networkHosts');
const AGY_DIRS = manifestField('antigravity-cli-bridge', 'writableDirs');
const CODEX_DIRS = manifestField('codex-cli-bridge', 'writableDirs');

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

// Synthetic item/skip factories for the D1 verdict state matrix (formatRecommendations consumes
// plain data — severity rides each item, attached by add()).
const mkItems = (severity, n) =>
  Array.from({ length: n }, (_, i) => ({ key: 'synthetic', severity, what: `w${i}`, benefit: 'b', apply: 'x' }));
const mkSkips = (n) => Array.from({ length: n }, (_, i) => ({ key: 'gate-hook', reason: `r${i}` }));
const fillCount = (template, count) => template.replace(/\{[A-Za-z]+\}/, String(count));

describe('recommendations — verdict-first contract (D1 state matrix)', () => {
  it('optimal (no items, no skips) adds ZERO lines — the frozen empty-state line ALONE is the verdict', () => {
    assert.equal(composeVerdict({ attention: 0, optional: 0, skipped: 0 }), null);
    const out = formatRecommendations({ items: [], skips: [] });
    assert.equal(out, `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });

  it('optional-only: the nothing-is-broken lead-in + the optional offer', () => {
    assert.equal(
      composeVerdict({ attention: 0, optional: 3, skipped: 0 }),
      `${VERDICT_NOTHING_BROKEN} — ${fillCount(VERDICT_OPTIONAL_TEMPLATE, 3)}`,
    );
  });

  it('attention-only: the attention count leads, no nothing-is-broken claim', () => {
    const v = composeVerdict({ attention: 2, optional: 0, skipped: 0 });
    assert.equal(v, fillCount(VERDICT_ATTENTION_TEMPLATE, 2));
    assert.ok(!v.includes(VERDICT_NOTHING_BROKEN));
  });

  it('attention+optional: attention leads and the nothing-is-broken wording never rides beside it', () => {
    const v = composeVerdict({ attention: 1, optional: 2, skipped: 0 });
    assert.equal(v, `${fillCount(VERDICT_ATTENTION_TEMPLATE, 1)}; ${fillCount(VERDICT_OPTIONAL_TEMPLATE, 2)}`);
    assert.ok(!v.includes(VERDICT_NOTHING_BROKEN), 'the nothing-is-broken wording renders ONLY when attention==0');
  });

  it('skips append the NOT-attested part last in every state; NO state with skips claims nothing is broken', () => {
    assert.equal(
      composeVerdict({ attention: 1, optional: 1, skipped: 2 }),
      `${fillCount(VERDICT_ATTENTION_TEMPLATE, 1)}; ${fillCount(VERDICT_OPTIONAL_TEMPLATE, 1)}; ${fillCount(VERDICT_SKIPS_TEMPLATE, 2)}`,
    );
    // A skipped probe could hide an attention-class problem — the nothing-is-broken claim renders
    // ONLY when attention==0 AND skipped==0.
    const optionalWithSkips = composeVerdict({ attention: 0, optional: 2, skipped: 1 });
    assert.equal(optionalWithSkips, `${fillCount(VERDICT_OPTIONAL_TEMPLATE, 2)}; ${fillCount(VERDICT_SKIPS_TEMPLATE, 1)}`);
    assert.ok(!optionalWithSkips.includes(VERDICT_NOTHING_BROKEN), 'skipped probes suppress the nothing-is-broken claim');
    const skipsOnly = composeVerdict({ attention: 0, optional: 0, skipped: 2 });
    assert.equal(skipsOnly, fillCount(VERDICT_SKIPS_TEMPLATE, 2));
    assert.ok(!skipsOnly.includes(VERDICT_NOTHING_BROKEN), 'a skips-only state must not claim nothing is broken');
  });

  it('the verdict line is the FIRST body line — items-only, skips-only, items+skips', () => {
    const bodyFirst = (payload) => formatRecommendations(payload).split('\n')[2];
    assert.equal(bodyFirst({ items: mkItems(SEVERITY_OPTIONAL, 2), skips: [] }),
      `${VERDICT_NOTHING_BROKEN} — ${fillCount(VERDICT_OPTIONAL_TEMPLATE, 2)}`);
    assert.equal(bodyFirst({ items: [], skips: mkSkips(1) }), fillCount(VERDICT_SKIPS_TEMPLATE, 1));
    assert.equal(bodyFirst({ items: mkItems(SEVERITY_ATTENTION, 1), skips: mkSkips(1) }),
      `${fillCount(VERDICT_ATTENTION_TEMPLATE, 1)}; ${fillCount(VERDICT_SKIPS_TEMPLATE, 1)}`);
  });

  it('items render attention-first, each tagged with its frozen severity label', () => {
    const out = formatRecommendations({
      items: [...mkItems(SEVERITY_OPTIONAL, 1), ...mkItems(SEVERITY_ATTENTION, 1)],
      skips: [],
    });
    const itemLines = out.split('\n').filter((l) => /^\d+\. /.test(l));
    assert.equal(itemLines.length, 2);
    assert.ok(itemLines[0].startsWith(`1. ${SEVERITY_LABELS[SEVERITY_ATTENTION]}: `), `attention leads: ${itemLines[0]}`);
    assert.ok(itemLines[1].startsWith(`2. ${SEVERITY_LABELS[SEVERITY_OPTIONAL]}: `), `optional follows: ${itemLines[1]}`);
  });

  it('every built item carries the frozen registry severity; the severity registry is total over BENEFITS', () => {
    // Base keys == BENEFITS keys exactly; `<key>.<variant>` entries are allowed (a per-site arm
    // may carry its own class — the agy-adddir invalid-env arm) and each names a real item key.
    const baseKeys = new Set(Object.keys(SEVERITIES).map((k) => k.split('.')[0]));
    assert.deepEqual([...baseKeys].sort(), Object.keys(BENEFITS).sort());
    for (const key of Object.keys(BENEFITS)) assert.ok(key in SEVERITIES, `${key} has a base severity`);
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.length >= 3, 'the broad fixture fires items');
    for (const item of items) assert.equal(item.severity, SEVERITIES[item.key], `${item.key} carries its registry severity`);
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

});

// ── the D2 shape gate: every registry string is scannable-one-line data; posture/risk prose
// lives in the mode doc at the consent moment, never inline (replaces the retired risk-inline pins).
const REGISTRY_STRINGS = Object.entries({
  ...Object.fromEntries(Object.entries(BENEFITS).map(([k, v]) => [`BENEFITS.${k}`, v])),
  ...Object.fromEntries(Object.entries(WHATS).map(([k, v]) => [`WHATS.${k}`, v])),
});
const BANNED_TOKENS = [
  ['RISK', /RISK/u],
  ['CAVEAT', /CAVEAT/u],
  ['IF-hedge', /\bIF /u],
  ['live-observed', /live-observed/iu],
  ['EROFS', /EROFS/u],
  ['date literal', /\b20\d{2}-\d{2}-\d{2}\b/u],
];

describe('recommendations — shape is contract (D2 static registry gate)', () => {
  it('the pinned cap is exact named test data at or below the 160-char hard ceiling', () => {
    assert.equal(ITEM_LINE_CAP, 140);
    assert.ok(ITEM_LINE_CAP <= 160, 'the cap never exceeds the plan ceiling');
  });

  it('every registry string (BENEFITS + WHATS) is exactly ONE line within the cap', () => {
    for (const [name, s] of REGISTRY_STRINGS) {
      assert.doesNotMatch(s, /[\r\n]/u, `${name} must be a single line`);
      assert.ok(s.length <= ITEM_LINE_CAP, `${name} is ${s.length} chars (cap ${ITEM_LINE_CAP}): ${s}`);
    }
  });

  it('no banned tokens ride any registry string (risk prose belongs to the mode-doc consent moment)', () => {
    for (const [name, s] of REGISTRY_STRINGS) {
      for (const [token, re] of BANNED_TOKENS) {
        assert.doesNotMatch(s, re, `${name} carries the banned token ${token}: ${s}`);
      }
    }
  });

  it('WHATS is total over the item keys and every variant names a real item key', () => {
    const baseKeys = new Set(Object.keys(WHATS).map((k) => k.split('.')[0]));
    assert.deepEqual([...baseKeys].sort(), Object.keys(BENEFITS).sort(), 'WHATS bases == BENEFITS keys');
    for (const key of Object.keys(BENEFITS)) assert.ok(key in WHATS, `${key} has a base WHAT template`);
  });
});

describe('recommendations — the add() runtime backstop (D2)', () => {
  const run = (probe) => buildRecommendations({ cwd: HERE, deps: { probes: [probe] } });

  it('a multiline composed WHAT is a stated skip, never a rendered violation', () => {
    const { items, skips } = run(({ add }) => add('velocity-core', 'line one\nline two', 'x'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => s.key === 'velocity-core' && /shape violation.*not a single line/u.test(s.reason)));
  });

  it('an over-cap composed WHAT is a stated skip naming the cap', () => {
    const { items, skips } = run(({ add }) => add('velocity-core', 'x'.repeat(ITEM_LINE_CAP + 1), 'x'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => s.key === 'velocity-core' && s.reason.includes(`${ITEM_LINE_CAP}-char cap`)));
  });

  it('an unregistered item key is a stated skip (the registries stay closed-world)', () => {
    const { items, skips } = run(({ add }) => add('made-up-key', 'w', 'x'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => s.key === 'made-up-key' && /unregistered item key/u.test(s.reason)));
  });

  it('a multiline apply is a stated skip (apply one-liners stay one line)', () => {
    const { items, skips } = run(({ add }) => add('velocity-core', 'w', 'cmd\n--flag'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => /apply is not a single line/u.test(s.reason)));
  });

  it('a valid one-line item passes through unchanged (the backstop green arm)', () => {
    const { items, skips } = run(({ add }) => add('velocity-core', 'a one-line WHAT', 'node /x.mjs'));
    assert.equal(skips.length, 0);
    assert.deepEqual(items, [{ key: 'velocity-core', severity: SEVERITIES['velocity-core'], what: 'a one-line WHAT', benefit: BENEFITS['velocity-core'], apply: 'node /x.mjs' }]);
  });
});

// The full-coverage fixture set: every registry item key fires at least once across these builds
// (no fixture-coverage gamble — the inventory assertion below is exact).
const buildInventoryFixtures = () => {
  const results = [];
  // (1) broad hermetic project: velocity-core, kit-tools-tier, autonomy-policy,
  // gates-declaration, sandbox-provision.
  const root1 = makeProject();
  results.push(buildRecommendations({ cwd: root1, deps: hermeticDeps(root1, { platform: 'linux', hasBinary: () => false }) }));
  rmSync(root1, { recursive: true, force: true });
  // (2) placed-but-unseeded bridges: bridge-tier + agy-adddir.
  const root2 = makeProject();
  results.push(buildRecommendations({ cwd: root2, deps: hermeticDeps(root2, { findWrapper: (c) => c === 'agy-review' || c === 'codex-review' }) }));
  rmSync(root2, { recursive: true, force: true });
  // (3) wired two-surface tier: the manifest-recipe item.
  const root3 = makeProject();
  mkdirSync(join(root3, '.claude'), { recursive: true });
  writeFileSync(join(root3, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
  results.push(buildRecommendations({ cwd: root3, deps: hermeticDeps(root3, { findWrapper: (c) => c === 'agy-review' }) }));
  rmSync(root3, { recursive: true, force: true });
  // (4) declared-but-degrading config: autonomy-render, review-recipe, gate-hook.
  const root4 = makeProject();
  writeFileSync(join(root4, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
  writeFileSync(join(root4, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
  writeFileSync(join(root4, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'g', title: 'G', cmd: 'true' }] }));
  results.push(buildRecommendations({ cwd: root4, deps: hermeticDeps(root4) }));
  rmSync(root4, { recursive: true, force: true });
  // (5) stale family member: family-freshness.
  const root5 = makeProject();
  results.push(buildRecommendations({
    cwd: root5,
    deps: hermeticDeps(root5, { surveyFamily: () => [{ name: 'agent-workflow-engine', version: '1.0.0', freshness: 'behind' }] }),
  }));
  rmSync(root5, { recursive: true, force: true });
  // (6) git work tree with an unfenced device mask: sandbox-masks.
  const root6 = mkdtempSync(join(tmpdir(), 'recommendations-inventory-'));
  spawnSync('git', ['init', '-q'], { cwd: root6, encoding: 'utf8' });
  mkdirSync(join(root6, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root6, 'docs', 'ai', '.workflow-version'), '2.0.0\n');
  const fakeChar = {
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isCharacterDevice: () => true,
    isBlockDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
  results.push(buildRecommendations({
    cwd: root6,
    deps: hermeticDeps(root6, { listUntracked: () => ['.bashrc'], lstat: (p) => (p.endsWith('.bashrc') ? fakeChar : lstatSync(p)) }),
  }));
  rmSync(root6, { recursive: true, force: true });
  return results;
};

describe('recommendations — full item-key coverage over fixtures (D2 inventory + D4 zero-hedge)', () => {
  it('the fixture set fires EVERY registry item key at least once (fired == registry, exact)', () => {
    const fired = new Set(buildInventoryFixtures().flatMap((r) => r.items.map((i) => i.key)));
    assert.deepEqual([...fired].sort(), Object.keys(BENEFITS).sort());
  });

  it('ZERO IF-hedges and zero banned tokens in every RENDERED item across the fixture set (D4)', () => {
    for (const { items } of buildInventoryFixtures()) {
      for (const item of items) {
        assert.doesNotMatch(item.what, /\bIF /u, `${item.key} WHAT hedges on an unknowable condition: ${item.what}`);
        assert.doesNotMatch(item.what, /[\r\n]/u, `${item.key} WHAT stays one line`);
        assert.ok(item.what.length <= ITEM_LINE_CAP, `${item.key} composed WHAT is ${item.what.length} chars: ${item.what}`);
      }
    }
  });
});

describe('recommendations — skip reasons can never rebuild a prose wall (D2)', () => {
  const run = (probe) => buildRecommendations({ cwd: HERE, deps: { probes: [probe] } });

  it('a multiline Error.message is normalized to ONE line', () => {
    const { skips } = run(({ skip }) => skip('gate-hook', new Error('first\nsecond\r\nthird')));
    assert.equal(skips.length, 1);
    assert.doesNotMatch(skips[0].reason, /[\r\n]/u);
    assert.equal(skips[0].reason, 'first second third');
  });

  it('an oversized Error.message is length-capped with a stated truncation count', () => {
    const { skips } = run(({ skip }) => skip('gate-hook', new Error('e'.repeat(SKIP_REASON_CAP * 3))));
    assert.equal(skips.length, 1);
    assert.ok(skips[0].reason.length <= SKIP_REASON_CAP, `reason is ${skips[0].reason.length} chars (cap ${SKIP_REASON_CAP})`);
    assert.match(skips[0].reason, /… \(\+\d+ more chars\)$/u, 'the truncation states its count');
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

  it('the invalid-env arm is an ATTENTION-class item — an invalid configured value is never "nothing is broken"', () => {
    // A set-but-INVALID AGY_REVIEW_ALLOW_ADDDIR is a configured declaration that is invalid —
    // the D1 attention definition; rendering it under optional would put "nothing is broken"
    // beside a broken config. The unset arm stays an optional offer.
    const root = makeProject();
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: 'yes' } });
    const result = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = result.items.find((i) => i.key === 'agy-adddir');
    assert.ok(item, 'the invalid-env arm fires');
    assert.equal(item.severity, SEVERITY_ATTENTION, 'an invalid configured value needs attention');
    const verdict = formatRecommendations(result).split('\n')[2];
    assert.ok(verdict.startsWith(fillCount(VERDICT_ATTENTION_TEMPLATE, 1)), `the verdict leads with the attention count: ${verdict}`);
    assert.ok(!verdict.includes(VERDICT_NOTHING_BROKEN), 'no nothing-is-broken claim beside an invalid config');
  });

  it('a LONG invalid env value still renders a capped item — never a skipped probe (truncation holds the cap)', () => {
    // templateBudget for the invalid-env WHAT is smaller than the truncation count-note — the
    // helper must guarantee result.length <= cap even there (an overflow fell into the
    // stated-skip lane instead of rendering).
    const root = makeProject();
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: 'x'.repeat(300) } });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!skips.some((s) => s.key === 'agy-adddir'), 'a long value must not degrade the item to a skip');
    const item = items.find((i) => i.key === 'agy-adddir');
    assert.ok(item, 'the invalid-env arm fires');
    assert.ok(item.what.length <= ITEM_LINE_CAP, `composed WHAT is ${item.what.length} chars (cap ${ITEM_LINE_CAP})`);
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

  it('an EMPTY env AGY_REVIEW_ALLOW_ADDDIR is the wrapper opt-out shape — never nagged as invalid', () => {
    // The wrapper's ${!key+x} check: a set-but-empty env var shadows the file and falls back to
    // the built-in refuse default — an explicit user CHOICE (codex, Segment C opening).
    const root = makeProject();
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: '' } });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'agy-adddir'), 'an explicit empty-env opt-out is respected');
  });

  it('a DUPLICATE-carrying bridge-settings file renders fix-duplicates-first HAND-APPLY — never the writer command it would refuse', () => {
    const root = makeProject();
    mkdirSync(join(root, '.config', 'agent-workflow'), { recursive: true });
    writeFileSync(join(root, '.config', 'agent-workflow', 'bridge-settings.conf'), 'CODEX_SERVICE_TIER=priority\nCODEX_SERVICE_TIER=priority\n');
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { XDG_CONFIG_HOME: join(root, '.config') } });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agy-adddir');
    assert.ok(item, 'the unset knob still fires the item');
    assert.ok(item.apply.startsWith('HAND-APPLY'), 'the writer command would refuse a duplicate-carrying file — hand-fix first');
    assert.match(item.apply, /CODEX_SERVICE_TIER/, 'the duplicates are named');
    assert.match(item.apply, /--set AGY_REVIEW_ALLOW_ADDDIR=1 --apply/, 'the writer line follows the hand-fix');
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

  it('the sandbox-lane item converges on the NEUTRAL fingerprint ack — project scope', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const fp = recipeFingerprint({ hosts: AGY_HOSTS, dirs: [AGY_DIRS[0].default], home: root });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['agy-review'] },
        permissions: { allow: ['Bash(agy-review code:*)'] },
        [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: fp },
      }),
    );
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'the acknowledged recipe silences the item');
  });

  it('a LOCAL-scope ack silences too; the security keys are NEVER read as an ack channel', () => {
    // (a) ack in settings.local.json — both scopes are read (D4).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const fp = recipeFingerprint({ hosts: AGY_HOSTS, dirs: [AGY_DIRS[0].default], home: root });
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: fp } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a local-scope ack converges the item');
    // (b) fully-populated security keys WITHOUT the ack keep the item firing — an inert-intent
    // allowedDomains/allowWrite entry must never double as an acknowledgement (codex R3 blocker).
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['agy-review'], network: { allowedDomains: [...AGY_HOSTS] }, filesystem: { allowWrite: [AGY_DIRS[0].default] } },
        permissions: { allow: ['Bash(agy-review code:*)'] },
      }),
    );
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({}));
    const again = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(again.items.some((i) => i.key === 'sandbox-lane'), 'security keys are not consulted — no ack, the item fires');
  });

  it('a CHANGED recipe re-fires the item: an env override moves a writable dir and the old ack goes stale', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const staleFp = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [CODEX_DIRS[0].default], home: root });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['codex-review'] },
        permissions: { allow: ['Bash(codex-review code:*)'] },
        [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: staleFp },
      }),
    );
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'codex-review', getenv: { CODEX_HOME: '/opt/codex-home' } });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'sandbox-lane');
    assert.ok(item, 'a changed recipe (env-moved dir) re-fires despite the old ack');
    assert.ok(item.apply.includes('/opt/codex-home'), 'the RESOLVED override dir rides the recipe');
    const freshFp = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: ['/opt/codex-home'], home: root });
    assert.ok(item.apply.includes(freshFp), 'the apply carries the CURRENT recipe fingerprint');
  });

  it('D6 resolution arms: unset → default; EMPTY ≡ unset; tilde/absolute as-given; relative anchors to --cwd', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['codex-review'] }, permissions: { allow: ['Bash(codex-review code:*)'] } }));
    const laneApply = (getenv) => {
      const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'codex-review', getenv: { PATH: '/nonexistent-path-for-tests', ...getenv } });
      const { items } = buildRecommendations({ cwd: root, deps });
      const item = items.find((i) => i.key === 'sandbox-lane');
      assert.ok(item, 'the wired fixture fires the item');
      return item.apply;
    };
    assert.ok(laneApply({}).includes(CODEX_DIRS[0].default), 'env unset → the manifest default');
    assert.ok(laneApply({ CODEX_HOME: '' }).includes(CODEX_DIRS[0].default), 'an EMPTY env value ≡ unset (the ${VAR:-default} form)');
    assert.ok(laneApply({ CODEX_HOME: '~/.codex-alt' }).includes('~/.codex-alt'), 'a tilde-form override rides as-given');
    assert.ok(laneApply({ CODEX_HOME: '/abs/codex-state' }).includes('/abs/codex-state'), 'an absolute override rides as-given');
    // The wrapper's case-arms treat ONLY `~`, `~/…` and `/…` as-given; every other form —
    // including `~user/state` — anchors like a relative path (a `~`-prefix heuristic would
    // misclassify `~user/…` as a home path the wrapper never resolves).
    assert.ok(laneApply({ CODEX_HOME: '~user/state' }).includes(resolve(root, '~user/state')), 'a ~user/… form anchors like a relative path, never as a home path');
    // A RELATIVE env value anchors to the TARGET PROJECT ROOT (the pinned --cwd), never the
    // shell cwd — exercised with process.cwd() deliberately different from --cwd (codex R3).
    const prev = process.cwd();
    process.chdir(join(root, 'docs'));
    try {
      const apply = laneApply({ CODEX_HOME: 'state/codex' });
      assert.ok(apply.includes(resolve(root, 'state/codex')), 'a relative override anchors to the named root');
      assert.ok(!apply.includes(resolve(join(root, 'docs'), 'state/codex')), 'never the shell cwd');
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the fingerprint is MACHINE-PORTABLE for home-anchored recipes (a committed project ack stays stable)', () => {
    // The ack may live in the COMMITTED .claude/settings.json — different users' home dirs must
    // not churn a shared ack: home-anchored dirs hash in their symbolic ~/ form.
    const a = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [CODEX_DIRS[0].default], home: '/home/alpha' });
    const b = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [CODEX_DIRS[0].default], home: '/home/beta' });
    assert.equal(a, b, 'the default recipe fingerprint is identical across machines/users');
    const viaAbsolute = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: ['/home/alpha/.codex'], home: '/home/alpha' });
    assert.equal(viaAbsolute, a, 'an absolute expansion under home canonicalizes back to the symbolic form');
    const outsideHome = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: ['/opt/codex-state'], home: '/home/alpha' });
    assert.notEqual(outsideHome, a, 'a genuinely-outside-home override is a different recipe');
  });

  it('a tilde default and its absolute expansion acknowledge the SAME recipe (fingerprint equivalence)', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    // The ack is minted while the recipe renders the tilde DEFAULT; the equivalent absolute
    // env override must still converge (the agy-nit expansion case — normalization pre-hash).
    const fp = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [CODEX_DIRS[0].default], home: root });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['codex-review'] },
        permissions: { allow: ['Bash(codex-review code:*)'] },
        [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: fp },
      }),
    );
    const absolute = join(root, CODEX_DIRS[0].default.slice(2));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'codex-review', getenv: { CODEX_HOME: absolute } });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'the absolute expansion of the acked tilde recipe stays converged');
  });

  it('the sandbox-lane item demands the TWO-SURFACE tier proof — excludedCommands alone (no code-mode allow rule) stays silent', () => {
    // The bridge tier wires BOTH surfaces; surfacing the recipe before the permissions.allow
    // half exists would front-run the bridge-tier item (codex terminal).
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'half-wired = the bridge-tier item covers first');
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'half-wired is not a probe failure either');
  });

  it('the sandbox-lane item is HAND-APPLY, fires only for WIRED wrappers, and renders the manifest recipe', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'sandbox-lane');
    assert.ok(item, 'fires when a placed review wrapper is wired into excludedCommands');
    assert.ok(item.apply.startsWith('HAND-APPLY (a neutral acknowledgement, never a security key)'), 'hand-apply by design — never an agent-run writer');
    for (const h of AGY_HOSTS) assert.ok(item.apply.includes(h), `the wired bridge's manifest host ${h} rides the recipe`);
    assert.ok(item.apply.includes(AGY_DIRS[0].default), "the wired bridge's writable state dir rides the recipe");
    for (const h of CODEX_HOSTS) assert.ok(!item.apply.includes(h), `un-wired bridge host ${h} must not ride`);
    assert.ok(!item.apply.includes(CODEX_DIRS[0].default), 'un-wired bridge dirs must not ride');
    assert.doesNotMatch(item.apply, /allowedDomains|allowWrite/u, 'the apply never asks the user to touch a security key');
    // Key-path MERGE semantics: a re-fire must never instruct "adding" a whole top-level
    // object beside an existing one (duplicate key / sibling clobber).
    assert.match(
      item.apply,
      new RegExp(`set "${SANDBOX_LANE_ACK_PARENT}"\\."${SANDBOX_LANE_ACK_KEY}" to "[0-9a-f]{16}"`, 'u'),
      'the ack is a key-path set, carrying the current fingerprint',
    );
    assert.match(item.apply, new RegExp(`MERGE into the existing ${SANDBOX_LANE_ACK_PARENT} object`, 'u'), 'the merge semantics are stated');
    assert.doesNotMatch(item.apply, new RegExp(`"${SANDBOX_LANE_ACK_PARENT}": \\{`, 'u'), 'no whole-object JSON shape to paste beside an existing one');
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
    for (const key of ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'sandbox-lane']) {
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
    assert.ok(out.includes(fillCount(VERDICT_SKIPS_TEMPLATE, 1)), 'the non-attestation is the stated verdict, never implied');
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
    assert.equal(item.apply, `node ${join(HERE, 'seed-gates.mjs')} --cwd ${root}`, 'the apply line is a PURE executable command — run-exactly-as-rendered must not feed prose to the CLI');
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
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a partial manifest walk must not render a recipe');
    const skip = skips.find((s) => s.key === 'sandbox-lane');
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
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'ENOTDIR on a stray file must not skip the item');
    const item = items.find((i) => i.key === 'sandbox-lane');
    assert.ok(item, 'the item still renders from the real bridge manifests');
    for (const h of AGY_HOSTS) assert.ok(item.apply.includes(h), `manifest host ${h} still rides the recipe line`);
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
