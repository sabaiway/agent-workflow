import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, chmodSync, symlinkSync, realpathSync, cpSync, existsSync } from 'node:fs';
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
  LANES_FILE,
  RISK_NOTED_KEYS,
  OPT_IN_CAPABILITIES,
} from './recommendations.mjs';
import { shellQuoteArg } from './review-state.mjs';
import { quoteArg } from './jev-facts.mjs';
import { GIT_MAX_BUFFER, hermeticGitEnv } from './git-env.mjs';
// The producer body is READ from the shared vocabulary leaf, never re-typed: the inert-declaration
// item decides through that predicate, so a fixture spelling its own body would drift off it.
import { COVERAGE_PRODUCER_BODY } from './coverage-producer.mjs';
// The inert item's cause-A apply is a PREVIEW of this fill, so its non-vacuity is the fill's own
// consented apply run against the rendered selection — the real writer, never a re-implementation.
import { applyFill } from './gates-init.mjs';
import { EXPECTED_WORKFLOW_VERSION, UNIVERSAL_READONLY_ALLOWLIST, planVelocityProfile, preflightVelocityProfile } from './velocity-profile.mjs';
// The registration fixtures are built from the LEAF's own constants and derived rules — a fixture
// spelling its own server path or allow rules would drift off the thing the probe actually reads.
import { DEFAULT_SERVER_PATH, ENABLED_KEY, MCP_JSON_REL, SERVER_NAME, SETTINGS_REL, allowRulesFor } from './mcp-registration.mjs';
// The decline fact is the leaf's own derivation, and the store fixtures are the spec-check harness's
// document builders — a fixture spelling either here would drift off what the probe reads. Dynamic:
// the suite must LOAD against the pre-fix tree (no leaf, no probe export) so the red proof observes it.
const { declineFingerprint } = await import('./spec-adoption.mjs').catch(() => ({}));
const recommendations = await import('./recommendations.mjs');
const velocityModule = await import('./velocity-profile.mjs');
const { probeSpecAdoption, probeEnforcement, probeProfileGaps } = recommendations;
const { composeProfileGapScreen } = await import('./profile-gap-screen.mjs').catch(() => ({}));
const lanes = await import('./write-lanes.mjs').catch(() => ({}));
const gitHooks = await import('./git-hooks.mjs');
const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
import { ROOT_DOC, specDoc } from './spec-check-harness.test.mjs';
import { makeProject as makeProfileProject } from './tier-preview.test/harness.test.mjs';
import { CENSUS_VERDICT } from './tracked-tree-census.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PACKAGE_JSON = '{"name":"fixture"}\n';
const FIXTURE_PYPROJECT = '[project]\nname = "fixture"\n';
const FIXTURE_SCRIPT = '// fixture\n';
const ENFORCEMENT_KEY = 'enforcement';
const DEPLOYED_NODE_SCRIPT = 'archive-decisions.mjs';
const COLLISION_SCRIPT = join('agent-workflow', 'shared', 'markdown-blocks.mjs');
const EACCES_CODE = 'EACCES';
const EVIDENCE_GATE_FAILURE = 'the clobber scan ran before the evidence gate';
const KIT_ROOT = resolve(HERE, '..');
const BUNDLED_SCRIPTS = resolve(KIT_ROOT, 'references', 'scripts');
const INSTALLER_MODULE = join('git-hooks', 'install-git-hooks.mjs');
const KIT_INSTALLER = join('scripts', 'agent-workflow', INSTALLER_MODULE);
const COMMIT_GUARD_OWN_STEP = 'the hook installer (scripts/agent-workflow/git-hooks/install-git-hooks.mjs) is not deployed here \u2014 deploying the enforcement scripts into this project is your own step, then re-run';
const COMMIT_GUARD_VIA_ITEM = 'the hook installer (scripts/agent-workflow/git-hooks/install-git-hooks.mjs) is not deployed \u2014 apply the enforcement item first, then re-run';
// The deployed installer stand-in at its kit-folder path, its folders created.
const placeInstaller = (root, bytes = '// deployed installer stand-in\n') => {
  mkdirSync(dirname(join(root, KIT_INSTALLER)), { recursive: true });
  writeFileSync(join(root, KIT_INSTALLER), bytes);
};
const ENFORCEMENT_UNMANAGED = 'an UNMANAGED pre-commit hook exists \u2014 the installer never overwrites it, so the kit places no script here; with that hook moved aside (your own step) the enforcement item is offered';
const COMMIT_GUARD_UNMANAGED = 'an UNMANAGED pre-commit hook exists \u2014 the installer never overwrites it; adding the guard line to it is your own step';
const FOREIGN_HOOK = '#!/bin/sh\nexit 0\n';
const MANAGED_GUARDLESS = '#!/usr/bin/env bash\n# fixture:install-git-hooks.mjs\nset -e\nnode scripts/check.mjs\n';
const SPACE_PROJECT_PREFIX = 'recommendations none ';
const EMPTY_BUNDLE_PREFIX = 'recommendations-empty-bundle-';
const NATIVE_WINDOWS_DETAIL = 'on native Windows Claude Code runs no sandbox: this item takes no effect there';
const UNFILLABLE_STEP = 'your own step — in docs/ai/gates.json declare or move a suite gate carrying the coverage reporters before the coverage checker (references/modes/gates.md names the exact form), or drop that checker, then run /agent-workflow-kit recommendations';
const PRODUCER_UNRECOGNIZED_STEP = 'your own step — in docs/ai/gates.json mark the gate that writes the lcov with "lcovProducer": true (references/modes/gates.md names the key), or drop the coverage checker, then run /agent-workflow-kit recommendations';
const REVIEW_RECIPE_STEP = 'your own step — set up the backend the recipe names with /agent-workflow-kit setup (it places the bridge skill and links its wrappers, and names the CLI install and sign-in that stay yours; /agent-workflow-kit backends shows what is missing), or re-pick the recipe with /agent-workflow-kit set-recipe, then run /agent-workflow-kit recommendations';
const CHECKER_NOT_LAST = 'coverage-check is not the LAST declared gate, so there is no trailing position to place a producer before, and the fill never reorders entries it did not write';
const PRODUCER_COLLISION = 'a producer IS offerable here, but its id "test" is already declared, so the fill refuses it as a collision — rename that gate, or repoint it at the producer form';
const NO_PRODUCER = 'no offerable producer exists here, and the fill never reorders entries it did not write';
const PRODUCER_UNRECOGNIZED_DETAIL = 'coverage-check has no producer declared and none offerable — the fill offers only terminating-class script names, so a recognized body under another name (a "ci" script running node --test) is declared as its own gate entry, never marked';

// Recipe expectations are READ FROM the bundled manifests (the advisor's own single source) —
// a hardcoded list here would silently outdate the moment a manifest gains an observed entry.
const BUNDLE_ROOT = join(HERE, '..', 'bridges');
const manifestField = (bridge, field) =>
  JSON.parse(readFileSync(join(BUNDLE_ROOT, bridge, 'capability.json'), 'utf8'))[field];
const CODEX_HOSTS = manifestField('codex-cli-bridge', 'networkHosts');
const CODEX_DIRS = manifestField('codex-cli-bridge', 'writableDirs');
const codexReady = () => [{ name: 'codex-cli-bridge', readiness: 'ready' }];
const agyReady = () => [{ name: 'antigravity-cli-bridge', readiness: 'ready' }];
const bothBridgesReady = () => [...codexReady(), ...agyReady()];

// A minimal deployed project: the stamp velocity's preflight reads; no .claude yet.
const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'recommendations-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(root, 'package.json'), FIXTURE_PACKAGE_JSON);
  return root;
};

const runFixtureGit = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: hermeticGitEnv(process.env, root), maxBuffer: GIT_MAX_BUFFER });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `git ${args.join(' ')} received ${result.signal}`);
  assert.equal(result.status, 0, result.stderr);
  return result;
};

const removePackageEvidence = (root) => {
  rmSync(join(root, 'package.json'), { force: true });
  writeFileSync(join(root, 'pyproject.toml'), FIXTURE_PYPROJECT);
  return root;
};
const makeNoneEvidenceProject = (withDocs = true) => removePackageEvidence(withDocs ? makeProject() : mkdtempSync(join(tmpdir(), 'recommendations-none-')));
const makeEacces = (path) => Object.assign(new Error(`${EACCES_CODE}: ${path}`), { code: EACCES_CODE });
const lstatUnreadableAt = (path) => (candidate) => {
  if (candidate === path) throw makeEacces(candidate);
  return lstatSync(candidate);
};

// A FINAL-run-capable declaration: both canonical core checks as quoted absolute paths to the
// kit's OWN tools (realpath-matched by run-gates), the coverage checker LAST.
const finalCapableGatesJson = () => JSON.stringify({
  gates: [
    { id: 'review-state', title: 'Review state', cmd: `node "${join(HERE, 'review-state.mjs')}" --check` },
    { id: 'coverage-check', title: 'Coverage', cmd: `node "${join(HERE, 'coverage-check.mjs')}" --check` },
  ],
});

// A final-run-capable project with the installer deployed and a fixture hooks dir (injected —
// the probe never spawns git in these tests).
const guardProject = () => {
  const root = makeProject();
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
  placeInstaller(root);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  return root;
};
const guardDeps = (root, extra = {}) => hermeticDeps(root, { gitHooksPath: () => join(root, 'hooks'), ...extra });
// A git deployment carrying the bundled installer and an empty hooks/; `piles` tracked files in lib/ put lib/ past the entries band.
const layoutRoot = ({ piles = 0, installer = true, root = makeProject() } = {}) => {
  runFixtureGit(root, ['init', '-q']);
  if (installer) cpSync(join(BUNDLED_SCRIPTS, INSTALLER_MODULE), join(root, KIT_INSTALLER));
  mkdirSync(join(root, 'hooks'));
  mkdirSync(join(root, 'lib'));
  for (let i = 0; i < piles; i += 1) writeFileSync(join(root, 'lib', `m${i}.mjs`), FIXTURE_SCRIPT);
  runFixtureGit(root, ['add', '-A']);
  return root;
};
// The hermetic git env with a PATH, so the source-size probe's own git reads reach the fixture.
const gitPathEnv = (root) => hermeticGitEnv({ PATH: process.env.PATH }, root);

// An AVAILABLE census over an ordinary JS project — the tree every declaration row here is about. It
// is injected because makeProject() is deliberately NOT a git tree (git-initing it would change what
// the sandbox-masks probe sees in every unrelated suite here), and because an unchosen census would
// make its gates-inert rows assertions about two things at once. The census's OWN dispositions —
// narrow, tie, minority, unavailable — are pinned against REAL git trees in
// test/advisor-third-outcomes.test.mjs and test/tracked-tree-census.test.mjs, never faked.
import * as FOREIGN from '../../scripts/testing/foreign-fixture.mjs';

const WITHIN_DOMAIN_CENSUS = Object.freeze({
  counts: { assessable: 3, unsupported: 0, 'out-of-domain': 1, 'excluded-test': 0 },
  unsupportedExtensions: [],
  verdict: 'within-domain',
  total: 4,
});

// Deps that keep the host machine out of the probes: no placed wrappers, empty env/PATH, and a
// fixture HOME (no bridge-settings.conf).
const hermeticDeps = (root, extra = {}) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home: root,
  takeCensus: () => WITHIN_DOMAIN_CENSUS,
  ...extra,
});

const maskingDeps = (root, rels = [MCP_JSON_REL]) =>
  hermeticDeps(root, {
    lstat: (path, ...rest) =>
      rels.some((rel) => path === join(root, rel))
        ? Object.fromEntries(
            ['isCharacterDevice', 'isBlockDevice', 'isFIFO', 'isSocket', 'isSymbolicLink', 'isDirectory', 'isFile'].map((p) => [
              p,
              () => p === 'isCharacterDevice',
            ]),
          )
        : lstatSync(path, ...rest),
  });

const enforcementFor = (root, extra = {}) => {
  const { items, skips } = buildRecommendations({
    cwd: root,
    deps: hermeticDeps(root, { probes: probeEnforcement ? [probeEnforcement] : [], gitHooksPath: () => null, ...extra }),
  });
  return {
    item: items.find((entry) => entry.key === ENFORCEMENT_KEY),
    skip: skips.find((entry) => entry.key === ENFORCEMENT_KEY),
  };
};
const assertEnforcementSkip = (disposition, path) => {
  assert.equal(disposition.item, undefined);
  assert.ok(disposition.skip?.reason.includes(path), disposition.skip?.reason);
};
const guardedBundleRead = (path) => {
  if (resolve(path) === BUNDLED_SCRIPTS) throw new Error(EVIDENCE_GATE_FAILURE);
  return readdirSync(path);
};

describe('recommendations — section contract', () => {
  it('renders PRESENT-EVEN-WHEN-EMPTY with the exact empty-state line', () => {
    const out = formatRecommendations({ items: [], skips: [] });
    assert.equal(out, `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });

  it('an item with a `detail` renders a `recipe:` line BETWEEN benefit and apply', () => {
    const out = formatRecommendations({ items: [{ key: 'bridge-tier', severity: SEVERITY_OPTIONAL, what: 'w', benefit: 'b', apply: 'a', detail: 'egress hosts [h1, h2]' }], skips: [] });
    const lines = out.split('\n');
    const bi = lines.findIndex((l) => l.includes('benefit:'));
    const ri = lines.findIndex((l) => l.includes('recipe:'));
    const ai = lines.findIndex((l) => l.includes('apply:'));
    assert.ok(bi >= 0 && ri > bi && ai > ri, 'recipe: renders between benefit: and apply:');
    assert.match(out, /recipe: egress hosts \[h1, h2\]/);
  });

  it('an item WITHOUT detail renders NO recipe: line', () => {
    const out = formatRecommendations({ items: [{ key: 'gate-hook', severity: SEVERITY_OPTIONAL, what: 'w', benefit: 'b', apply: 'a', detail: null }], skips: [] });
    assert.doesNotMatch(out, /recipe:/);
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

  it('--help names the empty-state line, the user-step sentence, and the optional `recipe:` line', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(RECOMMENDATIONS_EMPTY_LINE));
    assert.doesNotMatch(r.stdout, /HAND-APPLY/);
    assert.ok(r.stdout.split('\n').includes("A user item stays the user's own step."));
    assert.ok(r.stdout.replace(/\s+/gu, ' ').includes("an optional `recipe:` line (an item's own facts or its alternative, such as the bridge-tier missing-entries line or the worktrees-dir ack fallback)"));
    // The literal `recipe:` label (with the colon), checked against the ACTUAL rendered --help output.
    assert.match(r.stdout, /optional `recipe:` line/i, 'the --help documents the optional recipe: line');
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
    const baseKeys = new Set(Object.keys(SEVERITIES).map((k) => k.split('.')[0]));
    assert.deepEqual([...baseKeys].sort(), Object.keys(BENEFITS).sort());
    for (const key of Object.keys(BENEFITS)) assert.ok(key in SEVERITIES, `${key} has a base severity`);
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.length >= 3, 'the broad fixture fires items');
    assert.equal(SEVERITIES['sandbox-provision.installable'], SEVERITY_OPTIONAL);
    assert.ok(!('mcp-channel.masked' in SEVERITIES));
    for (const item of items) assert.equal(item.severity, SEVERITIES[item.variant], `${item.variant} carries its registry severity`);
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
    assert.ok(!('mcp-channel.masked' in WHATS));
  });
});

describe('recommendations — the spec-adoption item (spec:spec-adoption/S5)', () => {
  const specsAt = (root) => join(root, 'docs', 'ai', 'specs');
  const ackAt = (root) => join(root, 'docs', 'ai', 'acks.json');
  const draftDoc = (slug) => specDoc(slug).replace('status: live', 'status: draft');
  const DRAFTS = { 'index.md': ROOT_DOC(['- [a](./a.md)', '- [b](./b.md)']), 'a.md': draftDoc('a'), 'b.md': draftDoc('b') };
  const seedStore = (root, docs) => {
    mkdirSync(specsAt(root), { recursive: true });
    for (const [name, text] of Object.entries(docs)) writeFileSync(join(specsAt(root), name), text);
    return root;
  };
  const advise = (root) => {
    const built = buildRecommendations({ cwd: root, deps: { probes: [probeSpecAdoption] } });
    rmSync(root, { recursive: true, force: true });
    return built;
  };

  it('an absent store is ONE optional offer: the ensure applies it, the decline the agent records on the recipe line', () => {
    const root = makeProject();
    const { items, skips } = advise(root);
    assert.deepEqual([items.length, skips.length], [1, 0]);
    // Both arms are OFFERS: the layer is opt-in, and the frozen registry reserves attention for a
    // configured declaration that is broken.
    assert.deepEqual([items[0].key, items[0].variant, items[0].severity], ['spec-adoption', 'spec-adoption', SEVERITY_OPTIONAL]);
    assert.deepEqual([SEVERITIES['spec-adoption'], SEVERITIES['spec-adoption.adopting']], [SEVERITY_OPTIONAL, SEVERITY_OPTIONAL]);
    assert.match(items[0].what, /feature-spec store absent \(docs\/ai\/specs\)/);
    assert.ok(items[0].apply.startsWith('node ') && items[0].apply.includes('ensure-configs.mjs'), items[0].apply);
    assert.ok(items[0].apply.includes('--reconcile --only specs --cwd '), items[0].apply);
    const alternative = need(recommendations, 'DECLINE_ALTERNATIVE');
    assert.equal(alternative, 'decline alternative (asked apart, before the confirmation; on your decline the agent records it instead of the apply, never after it): ');
    assert.equal(items[0].detail, alternative + `node ${shellQuoteArg(join(HERE, 'ack-write.mjs'))} --lane spec-adoption --fingerprint ${declineFingerprint()} --cwd ${shellQuoteArg(root)}`);
    assert.doesNotMatch(items[0].detail, /HAND-APPLY/u);
    const out = formatRecommendations({ items, skips });
    assert.ok(!out.includes(RECOMMENDATIONS_EMPTY_LINE), 'an item never renders beside the flow-optimal line');
    assert.match(out, /1 optional recommendation\(s\)/);
  });

  it('drafts only is the OPTIONAL adopting variant whose apply IS the decline preview; one live contract silences it', () => {
    const { items, skips } = advise(seedStore(makeProject(), DRAFTS));
    assert.deepEqual([items.length, skips.length], [1, 0]);
    assert.deepEqual([items[0].variant, items[0].severity, items[0].detail], ['spec-adoption.adopting', SEVERITY_OPTIONAL, null]);
    assert.match(items[0].what, /2 draft spec\(s\)/);
    assert.ok(items[0].apply.startsWith('node ') && items[0].apply.includes('--lane spec-adoption'), items[0].apply);
    const live = advise(seedStore(makeProject(), { ...DRAFTS, 'c.md': specDoc('c') }));
    assert.deepEqual([live.items.length, live.skips.length], [0, 0]);
  });

  it('a RECORDED decline silences the item, and the flow-optimal line renders over this probe alone', () => {
    const root = makeProject();
    writeFileSync(ackAt(root), JSON.stringify({ specAdoptionAck: declineFingerprint() }));
    const { items, skips } = advise(root);
    assert.deepEqual([items.length, skips.length], [0, 0]);
    assert.equal(formatRecommendations({ items, skips }), `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });

  it('an unreadable store and a malformed ack store are stated skips — never an item, never a claimed optimum', () => {
    const asFile = makeProject();
    writeFileSync(specsAt(asFile), 'not a directory\n');
    const store = advise(asFile);
    assert.deepEqual([store.items.length, store.skips.length], [0, 1]);
    assert.equal(store.skips[0].key, 'spec-adoption');
    assert.match(store.skips[0].reason, /docs\/ai\/specs is a file/);
    const out = formatRecommendations(store);
    assert.match(out, /NOT attested/);
    assert.ok(!out.includes(RECOMMENDATIONS_EMPTY_LINE), 'a probe that could not run never renders flow-optimal');
    const bad = makeProject();
    writeFileSync(ackAt(bad), '{ not json');
    const ack = advise(bad);
    assert.deepEqual([ack.items.length, ack.skips.length], [0, 1]);
    assert.equal(ack.skips[0].key, 'spec-adoption');
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

  it('the VARIANT identifier is the machine-readable outcome — a per-site arm reports its own, not the base key', () => {
    // The human render says which ITEM fired; only this field says which ARM did. A consumer asserting
    // an exact outcome (the pre-publish smoke) would else pattern-match prose the registry may reword.
    const { items } = run(({ add }) => add('mcp-channel', 'w', 'HAND-APPLY: x', 'mcp-channel.differing'));
    assert.equal(items[0].key, 'mcp-channel', 'the base key still names the item');
    assert.equal(items[0].variant, 'mcp-channel.differing', 'and the variant names the arm');
    assert.equal(items[0].severity, SEVERITIES['mcp-channel.differing'], 'severity still resolves through the variant');
  });

  it('a multi-line recipe detail is a stated shape violation (the backstop covers the recipe line too)', () => {
    const { items, skips } = run(({ add }) => add('bridge-tier', 'a one-line WHAT', 'node /x.mjs', 'bridge-tier', 'line1\nline2'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => /recipe detail is not a single line/u.test(s.reason)));
  });
});

const buildInventoryFixtures = () => {
  const results = [];
  const root1 = makeNoneEvidenceProject();
  results.push(buildRecommendations({ cwd: root1, deps: hermeticDeps(root1, {
    platform: 'linux', hasBinary: () => false,
    isExecutable: (p) => ['/usr/bin/apt-get', '/usr/bin/env', '/usr/bin/sudo'].includes(p), euid: () => 1000,
  }) }));
  rmSync(root1, { recursive: true, force: true });
  const root2 = makeProject();
  results.push(buildRecommendations({ cwd: root2, deps: hermeticDeps(root2, { detect: bothBridgesReady, findWrapper: (c) => c === 'agy-review' || c === 'codex-review' }) }));
  rmSync(root2, { recursive: true, force: true });
  const root3 = makeProject();
  mkdirSync(join(root3, '.claude'), { recursive: true });
  writeFileSync(join(root3, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
  results.push(buildRecommendations({ cwd: root3, deps: hermeticDeps(root3, { detect: agyReady, findWrapper: (c) => c === 'agy-review' }) }));
  rmSync(root3, { recursive: true, force: true });
  const root4 = makeProject();
  writeFileSync(join(root4, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
  writeFileSync(join(root4, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
  writeFileSync(join(root4, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'g', title: 'G', cmd: 'true' }] }));
  results.push(buildRecommendations({ cwd: root4, deps: hermeticDeps(root4) }));
  rmSync(root4, { recursive: true, force: true });
  const root5 = makeProject();
  results.push(buildRecommendations({
    cwd: root5,
    deps: hermeticDeps(root5, { surveyFamily: () => [{ name: 'agent-workflow-engine', version: '1.0.0', freshness: 'behind' }] }),
  }));
  rmSync(root5, { recursive: true, force: true });
  const root6 = mkdtempSync(join(tmpdir(), 'recommendations-inventory-'));
  runFixtureGit(root6, ['init', '-q']);
  mkdirSync(join(root6, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root6, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
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
  const root7 = makeProject();
  mkdirSync(join(root7, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(root7, '.claude', 'hooks', 'agent-workflow-gates.mjs'), '// placed hook\n');
  writeFileSync(
    join(root7, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] }] } }),
  );
  results.push(buildRecommendations({ cwd: root7, deps: hermeticDeps(root7) }));
  rmSync(root7, { recursive: true, force: true });
  const root8 = makeProject();
  writeFileSync(join(root8, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
  placeInstaller(root8);
  results.push(buildRecommendations({ cwd: root8, deps: hermeticDeps(root8, { gitHooksPath: () => join(root8, 'hooks') }) }));
  rmSync(root8, { recursive: true, force: true });
  const root9 = makeProject();
  results.push(buildRecommendations({ cwd: root9, deps: hermeticDeps(root9, { canWriteDir: () => false }) }));
  rmSync(root9, { recursive: true, force: true });
  const root10 = makeProject();
  mkdirSync(join(root10, 'docs', 'ai', 'history'), { recursive: true });
  writeFileSync(join(root10, 'docs', 'ai', 'history', 'decisions-archive.md'), '# retired archive\n');
  results.push(buildRecommendations({ cwd: root10, deps: hermeticDeps(root10) }));
  rmSync(root10, { recursive: true, force: true });
  const root11 = makeProject();
  writeFileSync(join(root11, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ routine: { carrier: 'subagent' } }));
  results.push(buildRecommendations({ cwd: root11, deps: hermeticDeps(root11) }));
  rmSync(root11, { recursive: true, force: true });
  const root12 = makeProject();
  const home12 = mkdtempSync(join(tmpdir(), 'rec-jev-home-'));
  results.push(buildRecommendations({ cwd: root12, deps: hermeticDeps(root12, {
    getenv: { PATH: '/nonexistent-path-for-tests', TYPESAFE_API_KEY: 'a-test-key' }, jevHost: { home: home12 } }) }));
  rmSync(root12, { recursive: true, force: true });
  rmSync(home12, { recursive: true, force: true });
  const attributionRoot = makeProject();
  writeFileSync(join(attributionRoot, 'AGENTS.md'), '> **Agent attribution: off** (chosen at setup).\n');
  results.push(buildRecommendations({ cwd: attributionRoot, deps: hermeticDeps(attributionRoot) }));
  rmSync(attributionRoot, { recursive: true, force: true });
  const footprintRoot = makeProject();
  results.push(buildRecommendations({ cwd: footprintRoot, deps: hermeticDeps(footprintRoot, {
    planGlobalRemoval: () => ({ source: join(footprintRoot, '.gitignore_global'), before: '/scripts/check-docs-size.mjs\n', after: '', removedLines: ['/scripts/check-docs-size.mjs'] }),
  }) }));
  rmSync(footprintRoot, { recursive: true, force: true });
  const layoutPiles = layoutRoot({ piles: 25 });
  results.push(buildRecommendations({ cwd: layoutPiles, deps: guardDeps(layoutPiles, { env: gitPathEnv(layoutPiles) }) }));
  rmSync(layoutPiles, { recursive: true, force: true });
  return results;
};

describe('recommendations — full item-key coverage over fixtures (D2 inventory + D4 zero-hedge)', () => {
  it('the fixture set fires EVERY registry item key at least once (fired == registry, exact)', () => {
    const items = buildInventoryFixtures().flatMap((r) => r.items);
    const fired = new Set(items.map((i) => i.key));
    assert.deepEqual([...fired].sort(), Object.keys(BENEFITS).sort());
    assert.ok(items.some((i) => i.variant === 'sandbox-provision.installable'));
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

describe('spec:init-project/S4 — item lanes, check and apply slots, and masks read as absent', () => {
  const buildCheckLine = (variant, root, claudeDir) => ['node', ...[
    join(HERE, 'apply-danger-check.mjs'), '--variant', variant, '--cwd', root,
    ...(claudeDir === undefined ? [] : ['--claude-dir', claudeDir]),
  ].map(quoteArg)].join(' ');
  const assertHarnessSlot = (item, root, facts = {}) => {
    const check = buildCheckLine(item.variant, root, facts.claudeDir);
    const expected = { check, apply: `${check} --apply --expect <digest>` };
    const applySlot = need(lanes, 'applySlot');
    assert.deepEqual(applySlot(item.variant, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux', ...facts }), expected);
    assert.equal(item.lane, 'harness');
    assert.deepEqual({ check: item.check, apply: item.apply }, expected);
    const lines = formatRecommendations({ items: [item], skips: [] }).split('\n');
    const checkAt = lines.indexOf(`   check: ${check}`);
    assert.ok(checkAt > lines.indexOf(`   lane: harness`));
    assert.equal(lines[checkAt + 1], `   apply: ${expected.apply}`);
  };

  it('every rendered item carries lane and check in JSON, preserves chat applies and omits retired lines', () => {
    const items = buildInventoryFixtures().flatMap((r) => r.items);
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const json = main(['--cwd', root, '--json'], { deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const laneOf = need(lanes, 'laneOf');
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.ok(parsed.items.length > 0);
    for (const [key, apply] of [
      ['gates-declaration', `node ${join(HERE, 'gates-init.mjs')} --cwd ${root}`],
    ]) {
      const item = parsed.items.find((entry) => entry.key === key);
      assert.ok(item);
      assert.equal(item.lane, 'chat');
      assert.equal(item.apply, apply);
    }
    const review = parsed.items.find((entry) => entry.key === 'review-recipe');
    assert.ok(review);
    assert.equal(review.lane, 'user');
    assert.equal(review.check, null);
    assert.equal(review.apply, need(lanes, 'applySlot')('review-recipe', { toolsDir: HERE, root }).apply);
    for (const item of [...items, ...parsed.items]) {
      const lines = formatRecommendations({ items: [item], skips: [] }).split('\n');
      assert.equal(item.lane, laneOf(item.variant));
      assert.ok(['chat', 'harness', 'kit', 'user'].includes(item.lane), item.variant);
      assert.equal(lines[lines.indexOf(`   benefit: ${item.benefit}`) + 1], `   lane: ${item.lane}`);
      assert.equal(Object.hasOwn(item, 'check'), true, item.variant);
      if (['chat', 'user'].includes(item.lane)) {
        assert.equal(item.check, null, item.variant);
        assert.ok(!lines.some((line) => line.startsWith('   check: ')), item.variant);
      }
      assert.doesNotMatch(lines.join('\n'), /applies at your next npx|restart the agent from that console|lane: console/u);
    }
    for (const entry of parsed.items) {
      assert.deepEqual(Object.keys(entry).sort(), ['apply', 'benefit', 'check', 'detail', 'key', 'lane', 'severity', 'variant', 'what']);
    }
  });

  it('a kit item counts in neither verdict class: alone it opens with nothing is broken and is listed as optional; beside one optional harness item the count is 1', () => {
    const kit = { key: 'agents', variant: 'agents.not-current', severity: SEVERITY_OPTIONAL, lane: need(lanes, 'laneOf')('agents.not-current'), what: 'w', benefit: 'b', detail: null, check: 'c', apply: 'a' };
    assert.deepEqual(formatRecommendations({ items: [kit], skips: [] }).split('\n').slice(2, 8), [VERDICT_NOTHING_BROKEN, '', `1. ${SEVERITY_LABELS[SEVERITY_OPTIONAL]}: w`, '   benefit: b', '   lane: kit', '   check: c']);
    const beside = { items: [kit, { ...kit, key: 'agents', variant: 'agents', lane: 'harness' }], skips: [] };
    assert.equal(formatRecommendations(beside).split('\n')[2], `${VERDICT_NOTHING_BROKEN} — ${fillCount(VERDICT_OPTIONAL_TEMPLATE, 1)}`);
  });

  it('harness items render applySlot check before apply and carry the same check in --json', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, { detect: codexReady, findWrapper: (cmd) => cmd === 'codex-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    const json = main(['--cwd', root, '--json'], { deps });
    const home = mkdtempSync(join(tmpdir(), "rec-slot home's "));
    const skillDeps = hermeticDeps(root, { getenv: { TYPESAFE_API_KEY: 'test-key' }, jevHost: { home, platform: 'linux' } });
    const skill = buildRecommendations({ cwd: root, deps: skillDeps }).items.find((item) => item.key === 'jev-skill');
    const skillJson = main(['--cwd', root, '--json'], { deps: skillDeps });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(skillJson.code, 0, skillJson.stderr);
    for (const variant of ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'mcp-channel', 'agents']) {
      const item = items.find((entry) => entry.variant === variant);
      assert.ok(item);
      assertHarnessSlot(item, root);
      assert.deepEqual(JSON.parse(json.stdout).items.find((entry) => entry.variant === variant), item);
    }
    assert.ok(skill);
    assertHarnessSlot(skill, root, { env: skillDeps.getenv, home, claudeDir: join(home, '.claude') });
    assert.deepEqual(JSON.parse(skillJson.stdout).items.find((entry) => entry.variant === skill.variant), skill);
  });

  it('user items render applySlot user steps without a check line', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, { surveyFamily: () => [{ name: 'agent-workflow-engine', version: '1.0.0', freshness: 'behind' }] });
    const { items } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    const applySlot = need(lanes, 'applySlot');
    const facts = { toolsDir: HERE, root, env: deps.getenv, home: root, platform: 'linux' };
    for (const [variant, apply] of [
      ['jev-connect', `your own step — it asks for the key in your terminal and the key never goes into the chat — run in a terminal of your own: node ${quoteArg(join(HERE, 'jev-connect.mjs'))}`],
      ['family-freshness', 'your own step — run in a terminal of your own: npx @sabaiway/agent-workflow-kit@latest init'],
    ]) {
      const item = items.find((entry) => entry.variant === variant);
      assert.ok(item);
      assert.deepEqual(applySlot(variant, facts), { check: null, apply });
      assert.deepEqual([item.lane, item.check, item.apply], ['user', null, apply]);
      const lines = formatRecommendations({ items: [item], skips: [] }).split('\n');
      assert.ok(lines.includes(`   apply: ${apply}`));
      assert.ok(!lines.some((line) => line.startsWith('   check: ')));
    }
  });

  it('a doctor plan renders sandbox-provision.installable as a user step when euid is 0 or sudo is trusted', () => {
    const results = [false, true].map((rootUser) => {
      const root = makeProject();
      const deps = hermeticDeps(root, {
        platform: 'linux', hasBinary: () => false,
        isExecutable: (p) => ['/usr/bin/apt-get', '/usr/bin/env', ...(rootUser ? [] : ['/usr/bin/sudo'])].includes(p),
        euid: () => rootUser ? 0 : 1000,
      });
      const built = buildRecommendations({ cwd: root, deps });
      rmSync(root, { recursive: true, force: true });
      return { root, items: built.items.filter((item) => item.key === 'sandbox-provision') };
    });
    for (const { root, items } of results) {
      assert.equal(items.length, 1);
      assert.equal(items[0].key, 'sandbox-provision');
      assert.equal(items[0].variant, 'sandbox-provision.installable');
      assert.ok(items[0].what.includes('consent tuple apt-get:bubblewrap,socat'));
      const apply = `your own step (a sudo install; the doctor prints the --apply line to run next) — run in a terminal of your own: cd ${quoteArg(root)} && node ${quoteArg(join(HERE, 'autonomy-doctor.mjs'))}`;
      const applySlot = need(lanes, 'applySlot');
      assert.deepEqual(applySlot(items[0].variant, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' }), { check: null, apply });
      assert.deepEqual([items[0].lane, items[0].check, items[0].apply], ['user', null, apply]);
      assert.equal(items[0].detail, null);
      assert.ok(formatRecommendations({ items, skips: [] }).split('\n').includes(`   apply: ${apply}`));
    }
  });

  it('every other unavailable doctor plan renders sandbox-provision with the bare WHAT and native-Windows sentence', () => {
    const cases = [
      { isExecutable: (p) => ['/usr/bin/apt-get', '/usr/bin/env'].includes(p) },
      { isExecutable: (p) => ['/usr/bin/apt-get', '/usr/bin/env', '/usr/local/bin/sudo'].includes(p), env: { PATH: '/usr/local/bin' } },
      { hasBinary: (n) => n === 'socat', isExecutable: (p) => ['/usr/local/bin/socat', '/usr/bin/apt-get', '/usr/bin/env', '/usr/bin/sudo'].includes(p), env: { PATH: '/usr/local/bin' } },
      { platform: 'win32', isExecutable: () => false },
    ];
    const results = cases.map((extra) => {
      const root = makeProject();
      const deps = hermeticDeps(root, { platform: 'linux', hasBinary: () => false, euid: () => 1000, ...extra });
      const built = buildRecommendations({ cwd: root, deps });
      rmSync(root, { recursive: true, force: true });
      return { root, items: built.items.filter((item) => item.key === 'sandbox-provision') };
    });
    for (const { root, items } of results) {
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.variant, 'sandbox-provision');
      assert.ok(item.what.startsWith('the OS sandbox is unavailable: '));
      assert.ok(!item.what.includes('consent tuple'));
      const apply = `your own step — the doctor has no install it can run for you here (the reason is this item's text) — run in a terminal of your own: cd ${quoteArg(root)} && node ${quoteArg(join(HERE, 'autonomy-doctor.mjs'))}`;
      assert.equal(item.apply, apply);
      assert.deepEqual(need(lanes, 'applySlot')('sandbox-provision', { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' }), { check: null, apply });
      assert.equal(item.detail, NATIVE_WINDOWS_DETAIL);
      assert.equal(item.lane, 'user');
      assert.equal(item.check, null);
      assert.ok(!formatRecommendations({ items, skips: [] }).split('\n').some((line) => line.startsWith('   check: ')));
    }
  });

  it('device masks read as absent for velocity, mcp-channel and worktrees-dir while sandbox-masks still counts them', () => {
    const results = ['real-project-settings', 'absent-project-settings', 'mcp', 'worktrees'].map((kind) => {
      const root = makeProject();
      mkdirSync(join(root, '.claude'));
      if (kind === 'real-project-settings') writeFileSync(join(root, SETTINGS_REL), '{}');
      if (kind === 'mcp') runFixtureGit(root, ['init', '-q']);
      if (kind === 'worktrees') {
        mkdirSync(join(root, 'farm'));
        writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: join(root, 'farm') }));
      }
      const rel = kind === 'mcp' ? MCP_JSON_REL : kind === 'absent-project-settings' ? SETTINGS_REL : '.claude/settings.local.json';
      const deps = { ...maskingDeps(root, [rel]), ...(kind === 'mcp' ? { listUntracked: () => ['.mcp.json'] } : {}) };
      const built = buildRecommendations({ cwd: root, deps });
      rmSync(root, { recursive: true, force: true });
      return { kind, root, ...built };
    });
    for (const { kind, root, items, skips } of results) {
      const keys = kind === 'worktrees' ? ['worktrees-dir'] : kind === 'mcp' ? ['mcp-channel'] : kind === 'absent-project-settings' ? ['velocity-core', 'kit-tools-tier'] : ['velocity-core'];
      for (const key of keys) {
        const item = items.find((entry) => entry.key === key);
        assert.ok(item, `${kind}: ${key}`);
        assert.ok(!skips.some((skip) => skip.key === key), `${kind}: no ${key} skip`);
        if (key !== 'worktrees-dir') {
          assert.equal(item.variant, key);
          assertHarnessSlot(item, root);
        }
      }
      if (kind === 'mcp') assert.ok(items.find((item) => item.key === 'sandbox-masks')?.what.startsWith('1 sandbox mask(s)'));
    }
  });

  it('a device mask on the placed gate hook is read as the node it is, the pre-commit hook mask as absent', () => {
    const root = makeProject();
    const hook = join('.claude', 'hooks', 'agent-workflow-gates.mjs');
    const preCommit = join('hooks', 'pre-commit');
    const wired = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] }] } };
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, SETTINGS_REL), JSON.stringify(wired));
    writeFileSync(join(root, hook), '');
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
    placeInstaller(root);
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, preCommit), '');
    const deps = { ...maskingDeps(root, [hook, preCommit]), gitHooksPath: () => join(root, 'hooks') };
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.equal(items.find((item) => item.key === 'read-lane')?.variant, 'read-lane');
    assert.ok(!items.some((item) => item.key === 'gate-hook'));
    assert.ok(skips.find((skip) => skip.key === 'gate-hook')?.reason.includes(`${hook} exists but is not a regular file`), JSON.stringify(skips));
    assert.ok(items.some((item) => item.key === 'commit-guard'), 'a masked pre-commit hook reads as absent: the installer offer');
    assert.ok(!skips.some((skip) => skip.key === 'commit-guard' || skip.key === 'read-lane'));
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
  it('chat applies keep their cwd-independent shape', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.length >= 3, `expected a broad fixture item set, got ${items.map((i) => i.key).join(', ')}`);
    for (const item of items) {
      if (item.lane !== 'chat') continue;
      const okShape =
        /^node \/[^\s]+\.mjs(?: |$)/.test(item.apply) ||
        /^cd \/[^\s]+ && node \/[^\s]+\.mjs$/.test(item.apply) ||
        /^\/agent-workflow-kit [a-z-]+ \(run IN the target project/.test(item.apply);
      assert.ok(okShape, `${item.key}: apply must be abs-path node / cd-pinned node / skill invocation: ${item.apply}`);
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
  it('an undeployed allowlist fires velocity-core with its registry benefit', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const core = items.find((i) => i.key === 'velocity-core');
    assert.ok(core, 'velocity-core fires on a project with no seeded allowlist');
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
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ "_README": "note" }');
    const sparse = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!sparse.items.some((i) => ['autonomy-render', 'autonomy-policy'].includes(i.key)), 'the defaults-equivalent seed fires neither autonomy item');
  });

  // The advisor used to OFFER to arm AGY_REVIEW_ALLOW_ADDDIR ("large reviews — an oversized agy code
  // review offloads to a staging dir instead of refusing"). That lane is retired: headless agy
  // auto-denies its own read_file, so the offload could return a confident fabrication. The
  // withdrawal is a CHECKED registry deletion (advisor-coverage's orphan guard fails on an add() key
  // no capability claims, its set-equality on a declaration with no row) — never a silent one.
  it('a placed agy-review NEVER offers the retired add-dir knob, in any configuration', () => {
    const root = makeProject();
    mkdirSync(join(root, '.config', 'agent-workflow'), { recursive: true });
    const configurations = [
      hermeticDeps(root, { detect: agyReady, findWrapper: (cmd) => cmd === 'agy-review' }),
      hermeticDeps(root, { detect: agyReady, findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: 'yes' } }),
      hermeticDeps(root, { detect: agyReady, findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: '' } }),
      hermeticDeps(root, { detect: agyReady, findWrapper: (cmd) => cmd === 'agy-review', getenv: { XDG_CONFIG_HOME: join(root, '.config') } }),
    ];
    writeFileSync(join(root, '.config', 'agent-workflow', 'bridge-settings.conf'), 'AGY_REVIEW_ALLOW_ADDDIR=2\n');
    const results = configurations.map((deps) => buildRecommendations({ cwd: root, deps }));
    rmSync(root, { recursive: true, force: true });
    for (const { items, skips } of results) {
      assert.ok(!items.some((i) => i.key === 'agy-adddir'), 'the retired knob is never offered');
      assert.ok(!skips.some((s) => s.key === 'agy-adddir'), 'and never even probed');
    }
  });

  it('no advisor text anywhere still sells the retired offload lane', () => {
    for (const registry of [SEVERITIES, WHATS, BENEFITS]) {
      for (const key of Object.keys(registry)) {
        assert.ok(!key.startsWith('agy-adddir'), `${key} still names the retired capability`);
      }
    }
    for (const text of Object.values(BENEFITS)) {
      assert.ok(!/add-?dir|staging dir/i.test(text), `a benefit still advertises the offload: ${text}`);
    }
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
  });

  it('sandbox masks visible with no managed block fire the sandbox-masks apply one-liner (git fixture)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recommendations-git-'));
    const g = (...args) => runFixtureGit(root, args);
    g('init', '-q');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
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

describe('spec:init-project/S25 — velocity-core names the apply ask rule while it is missing', () => {
  const velocityCoreOn = (core, rule) => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: {
      allow: core ? [...UNIVERSAL_READONLY_ALLOWLIST] : [],
      ask: rule ? [need(velocityModule, 'APPLY_ASK_RULE')] : [],
    } }));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return items.find((item) => item.key === 'velocity-core');
  };
  const rows = [
    ['core seeded, rule absent', true, false, 'auto mode refuses a harness apply, so work cannot stay in auto mode — the apply ask rule is not seeded'],
    ['neither', false, false, `routine read-only commands still prompt, and auto mode refuses a harness apply — ${UNIVERSAL_READONLY_ALLOWLIST.length + 1} entr(ies) not seeded`],
    ['rule present, no core', false, true, `routine read-only commands still prompt — ${UNIVERSAL_READONLY_ALLOWLIST.length} audited read-only allowlist entr(ies) not seeded`],
  ];
  for (const [state, core, rule, what] of rows) {
    it(`fires with the text of its state, within ITEM_LINE_CAP: ${state}`, () => {
      need(velocityModule, 'APPLY_ASK_RULE');
      const item = velocityCoreOn(core, rule);
      assert.ok(item);
      assert.equal(item.variant, 'velocity-core');
      assert.equal(item.what, what);
      assert.ok(item.what.length <= ITEM_LINE_CAP);
    });
  }
  it('silent with both present', () => {
    need(velocityModule, 'APPLY_ASK_RULE');
    assert.equal(velocityCoreOn(true, true), undefined);
  });
  it('one benefit naming the purpose (all work stays in auto mode); no text claims the rule removes a prompt; seventeen harness variants', () => {
    need(velocityModule, 'APPLY_ASK_RULE');
    assert.equal(BENEFITS['velocity-core'], 'velocity — routine read-only commands stop prompting while the maintainer is away; all work stays in auto mode');
    for (const text of [...Object.values(WHATS), ...Object.values(BENEFITS), ...rows.map((row) => row[3])]) {
      if (/ask rule|harness apply/i.test(text)) assert.doesNotMatch(text, /\b(?:remov|silenc)/i);
    }
    assert.equal(Object.values(need(lanes, 'VARIANT_LANES')).filter((lane) => lane === 'harness').length, 17);
  });
});

describe('spec:init-project/S31 the three render as harness items', () => {
  // wired: the gate hook wired over an older placed body, the gate marked lcovProducer, the read-lane toggle on.
  const buildHookItem = (variant, { wired = false } = {}) => {
    const root = makeProject();
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hooks', 'agent-workflow-gates.mjs'), '// an old placed hook\n');
    if (wired) writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] }],
    } }));
    if (wired) writeFileSync(join(root, LANES_FILE), JSON.stringify({ readLane: true }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{
      id: 'suite', title: 'suite', ...(wired ? { lcovProducer: true } : {}), cmd: 'vitest run --coverage',
    }] }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return { root, built, item: built.items.find((entry) => entry.variant === variant) };
  };

  it('no item variant is a retired hook arm and no rendered line carries --reseed', () => {
    const { built } = buildHookItem('gate-hook.not-current', { wired: true });
    const retired = ['gate-hook.marker-stale', 'read-lane.stale', 'read-lane.missing'];
    assert.deepEqual(built.items.filter((item) => retired.includes(item.variant)).map((item) => item.variant), []);
    assert.doesNotMatch(formatRecommendations(built), /--reseed/u);
  });

  for (const variant of ['gate-hook', 'state-block']) {
    it(`${variant} renders the harness check immediately before its apply without HAND-APPLY`, () => {
      const { root, item } = buildHookItem(variant);
      assert.ok(item, variant);
      const facts = { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' };
      const expected = need(lanes, 'applySlot')(variant, facts);
      const lines = formatRecommendations({ items: [item], skips: [] }).split('\n');
      assert.equal(item.lane, 'harness');
      assert.deepEqual({ check: item.check, apply: item.apply }, expected);
      const checkAt = lines.indexOf(`   check: ${expected.check}`);
      assert.ok(checkAt > lines.indexOf('   lane: harness'));
      assert.equal(lines[checkAt + 1], `   apply: ${expected.apply}`);
      assert.doesNotMatch(item.apply, /^HAND-APPLY/u);
    });
  }

  it('the writer argv places state-block without --require-block and applies the gate hook with the plain --apply', () => {
    const { root } = buildHookItem('gate-hook');
    const facts = { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' };
    const consoleArgv = need(lanes, 'consoleArgv');
    const stateBlock = consoleArgv('state-block', facts);
    assert.ok(stateBlock, 'state-block has a writer argv');
    assert.deepEqual(stateBlock.apply, ['node', join(HERE, 'state-block-hook.mjs'), '--apply', '--cwd', root]);
    assert.ok(!stateBlock.apply.includes('--require-block'));
    assert.deepEqual(consoleArgv('gate-hook', facts).apply, ['node', join(HERE, 'gate-hook.mjs'), '--apply', '--cwd', root]);
  });

  it('the exported state-block constants and Stop convergence agree with the writer leaf', async () => {
    const results = [
      ['node ./.claude/hooks/state-block-guard.mjs --require-block', true],
      ['node ./scripts/something-else.mjs', false],
    ].map(([command, wired]) => {
      const root = makeProject();
      const data = { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } };
      mkdirSync(join(root, '.claude'));
      writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(data));
      const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
      rmSync(root, { recursive: true, force: true });
      return { data, wired, offered: items.some((item) => item.variant === 'state-block') };
    });
    const leaf = await import('./state-block-hook.mjs').catch(() => ({}));
    const needLeaf = (name) => need(leaf, name);
    assert.equal(recommendations.STATE_BLOCK_HOOK_RUNTIME, needLeaf('STATE_BLOCK_HOOK_RUNTIME'));
    assert.equal(recommendations.STATE_BLOCK_HOOK_COMMAND, needLeaf('STATE_BLOCK_HOOK_COMMAND'));
    const isStopHookWired = needLeaf('isStopHookWired');
    for (const { data, wired, offered } of results) {
      assert.equal(isStopHookWired(data), wired);
      assert.equal(offered, !isStopHookWired(data));
    }
  });

  it('a Stop hook in settings.local.json alone silences state-block without a skip', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: 'command', command: recommendations.STATE_BLOCK_HOOK_COMMAND }] }],
    } }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((item) => item.variant === 'state-block'));
    assert.ok(!skips.some((skip) => skip.key === 'state-block'));
  });

  it('enforcement and commit-guard render applySlot harness lines without hand steps or installer commands', (t) => {
    const fixtures = [['enforcement', makeNoneEvidenceProject()], ['commit-guard', guardProject()]];
    for (const [, root] of fixtures) t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [variant, root] of fixtures) {
      const { items } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
      const item = items.find((entry) => entry.key === variant);
      assert.ok(item, variant);
      const expected = need(lanes, 'applySlot')(variant, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' });
      assert.equal(item.lane, 'harness');
      assert.deepEqual({ check: item.check, apply: item.apply }, expected);
      const lines = formatRecommendations({ items: [item], skips: [] }).split('\n');
      const checkAt = lines.indexOf(`   check: ${expected.check}`);
      assert.ok(checkAt > lines.indexOf('   lane: harness'));
      assert.equal(lines[checkAt + 1], `   apply: ${expected.apply}`);
      for (const line of lines) assert.doesNotMatch(line, /HAND-APPLY|install-git-hooks\.mjs|\bcp\b|mkdir -p/u);
    }
  });

  it('VARIANT_LANES contains seventeen harness variants', () => assert.equal(Object.values(need(lanes, 'VARIANT_LANES')).filter((lane) => lane === 'harness').length, 17));
});

// This item exists because its ABSENCE fired: kit 3.14.0 shipped the state-block detector with a mode
// doc, a catalog row and a README row but NO advisor entry, so `upgrade` told a user who did not have
// it that «nothing is broken». Filed as OPT-IN-SHIPS-INVISIBLE.
describe('recommendations — the state-block-guard offer (AD-075)', () => {
  const stopWiring = (command) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  const flatStopWiring = (command) => JSON.stringify({ hooks: { Stop: [{ type: 'command', command }] } });

  it('a project with no Stop hook is OFFERED the detector, with the writer\'s checked apply', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'state-block');
    assert.ok(item, 'a shipped opt-in capability must never be invisible');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    const facts = { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' };
    assert.equal(item.lane, 'harness');
    assert.deepEqual({ check: item.check, apply: item.apply }, need(lanes, 'applySlot')('state-block', facts));
    assert.doesNotMatch(item.apply, /HAND-APPLY/u);
    assert.ok(!skips.some((s) => s.key === 'state-block'));
  });

  // The offered command must NOT carry --require-block: that flag turns on the absent-block report, and
  // this kit does not mandate the block — every project would get a hook warning after nearly every turn.
  it('the offered wiring does NOT enable the strict absent-block report', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.doesNotMatch(items.find((i) => i.key === 'state-block').apply, /--require-block/u);
  });

  it('a FLAT Stop entry converges it too — the question is whether anything is watching', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), flatStopWiring('node ./.claude/hooks/state-block-guard.mjs'));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.variant === 'state-block'), 'a working wiring must never be nagged');
  });

  // Matched on the RUNTIME FILE NAME: with no writer every user pastes their own path, so an exact
  // command comparison would keep offering the item to someone who already wired it.
  for (const command of [
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs" --require-block',
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs"',
    'node /abs/path/agent-workflow-kit/references/hooks/state-block-guard.mjs --require-block',
  ]) {
    it(`converges on any Stop entry that runs the runtime: «${command.slice(0, 52)}…»`, () => {
      const root = makeProject();
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.json'), stopWiring(command));
      const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
      rmSync(root, { recursive: true, force: true });
      assert.ok(!items.some((i) => i.variant === 'state-block'), 'already watching — do not nag');
    });
  }

  it('an unrelated Stop hook does NOT converge it', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), stopWiring('node ./scripts/something-else.mjs'));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.some((i) => i.key === 'state-block'), 'someone else\'s Stop hook is not this detector');
  });
});

describe('recommendations — the read-lane offer (AD-055 Part II, Help-through-Recommendations)', () => {
  const HOOK_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"';
  // The REAL bundled hook the advisor byte-compares the placed hook against (council B7).
  const REAL_BUNDLE = readFileSync(join(HERE, '..', 'references', 'hooks', 'gate-approve.mjs'), 'utf8');
  // A deployment with the gate hook PLACED and WIRED (the read-lane item's precondition). hookCurrent
  // (default true) copies the real bundle (byte-current); false writes an older placeholder.
  const wiredHookProject = ({ lanes, hookCurrent = true } = {}) => {
    const root = makeProject();
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hooks', 'agent-workflow-gates.mjs'), hookCurrent ? REAL_BUNDLE : '// an old placed hook\n');
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_CMD }] }] } }),
    );
    if (lanes !== undefined) writeFileSync(join(root, LANES_FILE), lanes);
    return root;
  };

  it('placed + wired + no lanes.json → fires the gate-hook --read-lane PREVIEW one-liner; the gate-hook item stays silent (no double-fire)', () => {
    const root = wiredHookProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'read-lane');
    assert.ok(item, 'fires once the hook is wired and the lane is off');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.equal(item.apply, `node ${join(HERE, 'gate-hook.mjs')} --read-lane --cwd ${root}`);
    assert.doesNotMatch(item.apply, /--apply/u, 'the offer is the PREVIEW form (the currency check + posture fire at the writer)');
    assert.ok(!skips.some((s) => s.key === 'read-lane'));
    assert.ok(!items.some((i) => i.key === 'gate-hook'), 'the gate-hook item never fires for a WIRED hook — no double-offer');
  });

  it('readLane: true + a byte-CURRENT hook → converged (the item does not fire)', () => {
    const root = wiredHookProject({ lanes: JSON.stringify({ readLane: true }), hookCurrent: true });
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'read-lane'), 'an enabled lane over a current hook converges the item');
  });

  it('readLane:false / a non-boolean value → the lane is off → the item fires (the writer will flip it), never a skip', () => {
    for (const lanes of [JSON.stringify({ readLane: false }), JSON.stringify({ readLane: 'yes', _README: 'x' })]) {
      const root = wiredHookProject({ lanes });
      const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
      rmSync(root, { recursive: true, force: true });
      assert.ok(items.some((i) => i.key === 'read-lane'), `readLane off (${lanes}) → offer`);
      assert.ok(!skips.some((s) => s.key === 'read-lane'), 'a valid off lane is not a skip');
    }
  });

  it('no double-fire: an unwired hook is covered by the gate-hook item, never the read-lane item', () => {
    // (a) nothing placed/wired — no read-lane offer.
    const bare = makeProject();
    const a = buildRecommendations({ cwd: bare, deps: hermeticDeps(bare) });
    rmSync(bare, { recursive: true, force: true });
    assert.ok(!a.items.some((i) => i.key === 'read-lane'), 'no read-lane offer without a wired hook');
    // (b) placed-but-NOT-wired — still no read-lane offer.
    const placedUnwired = makeProject();
    mkdirSync(join(placedUnwired, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(placedUnwired, '.claude', 'hooks', 'agent-workflow-gates.mjs'), '// placed\n');
    const b = buildRecommendations({ cwd: placedUnwired, deps: hermeticDeps(placedUnwired) });
    rmSync(placedUnwired, { recursive: true, force: true });
    assert.ok(!b.items.some((i) => i.key === 'read-lane'), 'placed-but-unwired does not offer the lane');
    // (c) gates declared but hook unwired → the gate-hook item fires, the read-lane item does not.
    const unwiredGates = makeProject();
    writeFileSync(join(unwiredGates, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 'T', cmd: 'node --test' }] }));
    const c = buildRecommendations({ cwd: unwiredGates, deps: hermeticDeps(unwiredGates) });
    rmSync(unwiredGates, { recursive: true, force: true });
    assert.ok(c.items.some((i) => i.key === 'gate-hook'), 'the gate-hook item covers the unwired case');
    assert.ok(!c.items.some((i) => i.key === 'read-lane'), 'and the read-lane item stays silent');
  });

  it('a MALFORMED lanes.json is a stated SKIP — never a wrong offer, never a crash', () => {
    const root = wiredHookProject({ lanes: '{ not json' });
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'read-lane'), 'a malformed lanes.json never fabricates an offer');
    assert.ok(skips.some((s) => s.key === 'read-lane'), 'a malformed lanes.json is a stated skip');
  });

  it('a NON-OBJECT lanes.json root (e.g. []) is a fail-closed SKIP', () => {
    const root = wiredHookProject({ lanes: '[]' });
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'read-lane'));
    assert.ok(skips.some((s) => s.key === 'read-lane'));
  });

  it('a SYMLINKED lanes.json is a fail-closed SKIP (never read from outside the project)', () => {
    const root = wiredHookProject();
    symlinkSync(join(root, 'nonexistent-lane-target'), join(root, LANES_FILE)); // a dangling symlink
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'read-lane'), 'a symlinked lanes.json never fires');
    assert.ok(skips.some((s) => s.key === 'read-lane'), 'a symlinked lanes.json is a stated skip');
  });

  it('a NON-REGULAR lanes.json (a directory at the path) is a fail-closed SKIP', () => {
    const root = wiredHookProject();
    mkdirSync(join(root, LANES_FILE)); // a dir where the toggle file should be (a FIFO hits the same guard)
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'read-lane'), 'a non-regular lanes.json never fires');
    assert.ok(skips.some((s) => s.key === 'read-lane'), 'a non-regular lanes.json is a stated skip');
  });

});

describe('spec:init-project/S72 the gate-hook and state-block keys by their state table', () => {
  const GATE = '.claude/hooks/agent-workflow-gates.mjs';
  const STOP = '.claude/hooks/state-block-guard.mjs';
  const OLD = '// an earlier kit hook body\n';
  const CURRENT = { [GATE]: readFileSync(join(HERE, '..', 'references', 'hooks', 'gate-approve.mjs')), [STOP]: readFileSync(join(HERE, '..', 'references', 'hooks', 'state-block-guard.mjs')) };
  const KIT_BENEFIT = 'currency — a hook you wired runs the body the kit writes for it today';
  const gateEntry = (matcher = 'Bash') => ({ matcher, hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] });
  const stopEntry = (command = recommendations.STATE_BLOCK_HOOK_COMMAND) => ({ hooks: [{ type: 'command', command }] });
  // wired: 'project' | 'local' | null; an entry is written to the project file in place of the kit's;
  // file: undefined (absent) | bytes | 'link' | 'dir'; device: a rel read as a character device.
  const project = (t, key, { wired = 'project', entry, file, device, stamp, gates = true, lanes } = {}) => {
    const root = makeProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const [rel, event] = key === 'gate-hook' ? [GATE, 'PreToolUse'] : [STOP, 'Stop'];
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    const hooks = { hooks: { [event]: [entry ?? (key === 'gate-hook' ? gateEntry() : stopEntry())] } };
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(wired === 'project' || entry ? hooks : {}));
    if (wired === 'local') writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify(hooks));
    if (file === 'link') symlinkSync(join(root, 'package.json'), join(root, rel));
    else if (file === 'dir') mkdirSync(join(root, rel));
    else if (file !== undefined) writeFileSync(join(root, rel), file);
    if (stamp) writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${stamp}\n`);
    if (gates) writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 'T', cmd: 'node --test' }] }));
    if (lanes !== undefined) writeFileSync(join(root, LANES_FILE), JSON.stringify({ readLane: lanes }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root, device ? { lstat: maskingDeps(root, [device]).lstat } : {}) });
    const pick = (k) => [built.items.filter((item) => item.key === k), built.skips.filter((skip) => skip.key === k)];
    return { root, rel, built, pick };
  };
  const NOT_REGULAR = (rel) => new RegExp(`${rel.replaceAll('.', '\\.')} exists but is not a regular file`, 'u');
  const rows = [
    ['unwired, a differing file', { wired: null }, 'offer'], ['a gate entry under another matcher, a differing file', { entry: gateEntry('Write') }, 'offer', 'gate-hook'],
    ['wired, an absent file', { file: null }, 'kit'], ['wired, a differing file', {}, 'kit'], ['wired only in settings.local.json, a differing file', { wired: 'local' }, 'kit'],
    ['wired, a current file', { file: 'current' }, 'nothing'], ['wired, a link at the kit path', { file: 'link' }, NOT_REGULAR],
    ['wired, a directory at the kit path', { file: 'dir' }, NOT_REGULAR], ['wired, a device at the kit path', { file: '', device: 'rel' }, NOT_REGULAR],
    ['wired, a device at .claude/hooks', { device: '.claude/hooks' }, () => /\.claude\/hooks exists but is not a directory/u],
    ['wired, a stale stamp beside a planned file', { stamp: '2.9.0' }, () => /run \/agent-workflow-kit upgrade first/u],
    ['another copy of the runtime, no kit file', { entry: stopEntry('node agent-workflow-kit/references/hooks/state-block-guard.mjs --require-block'), file: null }, 'kit', 'state-block'],
  ];
  for (const key of ['gate-hook', 'state-block']) {
    for (const [label, setup, expected] of rows.filter((row) => !row[3] || row[3] === key)) it(`${key}: ${label}`, (t) => {
      const rel = key === 'gate-hook' ? GATE : STOP;
      const file = setup.file === null ? undefined : setup.file === 'current' ? CURRENT[rel] : setup.file ?? OLD;
      const { root, pick } = project(t, key, { ...setup, file, device: setup.device === 'rel' ? rel : setup.device });
      const [items, skips] = pick(key);
      const variant = expected === 'kit' ? `${key}.not-current` : key;
      if (typeof expected === 'function') {
        assert.deepEqual([items, skips.length], [[], 1], JSON.stringify(skips));
        assert.match(skips[0].reason, expected(rel));
        return;
      }
      assert.deepEqual([items.map((item) => item.variant), skips], [expected === 'nothing' ? [] : [variant], []], JSON.stringify(skips));
      if (expected === 'nothing') return;
      const slot = need(lanes, 'applySlot')(variant, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' });
      assert.deepEqual([items[0].lane, items[0].check, items[0].apply], [expected === 'kit' ? 'kit' : 'harness', slot.check, slot.apply]);
      if (expected === 'offer') return;
      const what = `${rel} is absent or differs from the body the kit writes for it — written with that body, with no question`;
      assert.deepEqual([items[0].severity, items[0].what, items[0].benefit, items[0].detail], [SEVERITY_OPTIONAL, what, KIT_BENEFIT, `writes: ${rel}`]);
      assert.ok(what.length <= ITEM_LINE_CAP);
    });
  }
  it('gate-hook: a wired gate hook with no declaration renders gates-declaration beside its kit arm', (t) => {
    const { built, pick } = project(t, 'gate-hook', { file: OLD, gates: false });
    assert.deepEqual([pick('gate-hook')[0].map((item) => item.variant), built.items.some((item) => item.key === 'gates-declaration')], [['gate-hook.not-current'], true]);
  });
  it('the read-lane offer renders exactly while the gate hook is wired and the toggle is off, whatever the hook bytes', (t) => {
    for (const lanes of [false, true]) {
      for (const file of [CURRENT[GATE], OLD, undefined]) {
        const [items, skips] = project(t, 'gate-hook', { file, lanes }).pick('read-lane');
        assert.deepEqual([items.map((item) => item.variant), skips], [lanes ? [] : ['read-lane'], []], `toggle ${lanes}, ${file === undefined ? 'absent' : file === OLD ? 'differing' : 'current'}`);
      }
    }
  });
  it('no WHATS or SEVERITIES key is gate-hook.marker-stale, read-lane.stale or read-lane.missing', () => {
    for (const retired of ['gate-hook.marker-stale', 'read-lane.stale', 'read-lane.missing']) {
      assert.equal(Object.hasOwn(WHATS, retired) || Object.hasOwn(SEVERITIES, retired), false, retired);
    }
  });
});

describe('recommendations — the typed-channel (mcp) registration offer', () => {
  const OUR_ENTRY = { type: 'stdio', command: 'node', args: [DEFAULT_SERVER_PATH] };
  const mcpProject = ({ servers, settings } = {}) => {
    const root = makeProject();
    if (servers !== undefined) writeFileSync(join(root, MCP_JSON_REL), JSON.stringify({ mcpServers: servers }));
    if (settings !== undefined) {
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, SETTINGS_REL), JSON.stringify(settings));
    }
    return root;
  };
  const registeredSettings = { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } };
  const build = (root, deps) => {
    const r = buildRecommendations({ cwd: root, deps: deps ?? hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return r;
  };

  it('unregistered → an OPTIONAL registration offer', () => {
    const root = makeProject();
    const { items, skips } = build(root);
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'a project with no registration gets the offer');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('fully registered → silent (no item, no skip)', () => {
    const { items, skips } = build(mcpProject({ servers: { [SERVER_NAME]: OUR_ENTRY }, settings: registeredSettings }));
    assert.ok(!items.some((i) => i.key === 'mcp-channel'), 'a complete registration converges the item');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('half-registered (the entry stands, one allow rule missing) → the offer still fires', () => {
    const [first] = allowRulesFor();
    const root = mcpProject({
      servers: { [SERVER_NAME]: OUR_ENTRY },
      settings: { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: [first] } },
    });
    assert.ok(build(root).items.some((i) => i.key === 'mcp-channel'), 'a missing rule is still an unfinished registration');
  });

  it('a DIFFERING entry → ATTENTION with no detail', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/elsewhere/mcp-server.mjs'] } } });
    const item = build(root).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'a differing entry is reported');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.equal(item.variant, 'mcp-channel.differing');
    assert.equal(item.detail, null);
  });

  // `differs` is any STRUCTURAL difference from what this kit copy would write — a second copy of the
  // kit, an added env block, a null. The item may claim only that, never the narrower "points at a
  // different executable", which is one cause among several and false for the rest.
  it('fold: the differing WHAT states only the proven fact, not a cause it did not establish', () => {
    const sameExecutablePlusEnv = { ...OUR_ENTRY, env: { EXTRA: '1' } };
    const root = mcpProject({ servers: { [SERVER_NAME]: sameExecutablePlusEnv } });
    const item = build(root).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'an entry that is structurally different is still reported');
    assert.equal(item.variant, 'mcp-channel.differing');
    assert.doesNotMatch(item.what, /different executable/iu, 'this entry names the SAME executable — the claim would be false');
    // Nor may it claim where the typed tools GO: this arm is reached with settings absent, with the
    // server not enabled, and with an entry that is not a launchable shape at all.
    assert.doesNotMatch(item.what, /reach/iu, 'no claim about what the tools reach — nothing here established it');
  });

  it('a MASKED .mcp.json with the settings half INCOMPLETE → the base item', () => {
    const root = makeProject();
    const { items, skips } = build(root, maskingDeps(root));
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'something IS missing regardless of what the masked file says');
    assert.equal(item.variant, 'mcp-channel');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('a MASKED .mcp.json with the settings half COMPLETE reads as absent → an unregistered item', () => {
    const root = mcpProject({ settings: registeredSettings });
    const { items, skips } = build(root, maskingDeps(root));
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item);
    assert.equal(item.variant, 'mcp-channel');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('a masked settings.json beside a real .mcp.json is judged as absent → the base item', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: OUR_ENTRY } });
    const { items, skips } = build(root, maskingDeps(root, [SETTINGS_REL]));
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item);
    assert.equal(item.variant, 'mcp-channel');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('fold: a DIFFERING entry is reported even when the settings half is masked', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/elsewhere/mcp-server.mjs'] } } });
    const item = build(root, maskingDeps(root, [SETTINGS_REL])).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'the .mcp.json half is fully observable, so its verdict stands on its own');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.equal(item.variant, 'mcp-channel.differing');
    assert.equal(item.detail, null);
  });


  // The scope limit, pinned where the ADVISOR would have reported it. A converged `mcp-channel` means
  // what the mode writes is in place — never that the client will load the server.
  it('fold: a disabled server is reported ahead of nothing — the advisor has no such arm', () => {
    const root = mcpProject({
      servers: { [SERVER_NAME]: OUR_ENTRY },
      settings: { [ENABLED_KEY]: [SERVER_NAME], disabledMcpjsonServers: [SERVER_NAME], permissions: { allow: allowRulesFor() } },
    });
    const { items, skips } = build(root);
    assert.ok(!items.some((i) => i.key === 'mcp-channel'), 'the item converges on what this kit writes');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'), 'and does not pretend to withhold a verdict it never forms');
    // Non-vacuity: "no item" must mean CONVERGED, not "this advisor has no such item at all" — which
    // is what the same two assertions would have proved on a kit without the mcp-channel probe.
    assert.ok(build(makeProject()).items.some((i) => i.key === 'mcp-channel'), 'the item does exist and does fire when the registration is missing');
  });

  it('BOTH targets masked read as absent → the base item', () => {
    const root = makeProject();
    const { items, skips } = build(root, maskingDeps(root, [MCP_JSON_REL, SETTINGS_REL]));
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item);
    assert.equal(item.variant, 'mcp-channel');
    assert.ok(!skips.some((s) => s.key === 'mcp-channel'));
  });

  it('a MALFORMED or SYMLINKED .mcp.json is a fail-closed SKIP — never a fabricated offer', () => {
    for (const make of [
      () => {
        const root = makeProject();
        writeFileSync(join(root, MCP_JSON_REL), '{ not json');
        return root;
      },
      () => {
        const root = makeProject();
        symlinkSync(join(root, 'nonexistent-mcp-target'), join(root, MCP_JSON_REL));
        return root;
      },
    ]) {
      const { items, skips } = build(make());
      assert.ok(!items.some((i) => i.key === 'mcp-channel'));
      assert.ok(skips.some((s) => s.key === 'mcp-channel'));
    }
  });
});

describe('recommendations — retired sandbox lane and bridge recipe — spec:velocity-profile/S20', () => {
  const retiredKey = 'sandbox-lane';
  const bridgeKey = 'bridge-tier';
  const ackKey = 'sandboxLaneAck';
  const invalidEnabled = 'yes';
  const reviewRule = 'Bash(codex-review code:*)';
  const reviewExclusion = 'codex-review *';
  const executeExclusion = 'codex-exec *';
  const stateDir = CODEX_DIRS[0].default;
  const missingHost = CODEX_HOSTS[0];
  const expectedWhat = (count) => `bridge-wrappers tier incomplete — ${count} entr(ies) missing (allow rules, exclusions, hosts or state dirs of used bridges)`;
  const readBridgeItem = (t, sandbox, { allow = [reviewRule], delegated = false } = {}) => {
    const root = makeProject();
    const home = mkdtempSync(join(tmpdir(), 'recommendations-bridge-home-'));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });
    const config = Object.fromEntries(['plan-authoring', 'plan-execution', 'feedback-triage', 'epic'].map((activity) => [activity, { review: 'reviewed' }]));
    if (delegated) config['plan-execution'].execute = 'delegated';
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(config));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow }, sandbox }));
    const deps = hermeticDeps(root, { home, detect: codexReady, findWrapper: (cmd) => cmd === 'codex-review' });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    return { root, deps, item: items.find((entry) => entry.key === bridgeKey), skip: skips.find((entry) => entry.key === bridgeKey) };
  };
  for (const [name, registry] of Object.entries({ WHATS, BENEFITS, SEVERITIES, VARIANT_LANES: need(lanes, 'VARIANT_LANES') })) {
    it(`removes sandbox-lane from ${name}`, () => assert.ok(!Object.hasOwn(registry, retiredKey)));
  }
  it('removes sandbox-lane from opt-in capabilities', () => {
    assert.ok(!OPT_IN_CAPABILITIES.some(({ id, advisorKey }) => id === retiredKey || advisorKey === retiredKey));
  });
  it('removes sandbox-lane from risk-noted keys', () => assert.ok(!RISK_NOTED_KEYS.includes(retiredKey)));
  it('removes probeSandboxLane from the probe chain', () => {
    const source = readFileSync(join(HERE, 'recommendations.mjs'), 'utf8');
    const start = source.indexOf('const PROBES = Object.freeze([');
    assert.ok(start >= 0);
    assert.doesNotMatch(source.slice(start, source.indexOf(']);', start)), /probeSandboxLane/u);
  });
  it('exports no SANDBOX_LANE_ACK name', () => {
    assert.ok(!Object.keys(recommendations).some((name) => name.startsWith('SANDBOX_LANE_ACK')));
  });
  it('keeps both on-disk acknowledgements byte-identical without an item or skip', (t) => {
    const root = makeProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.claude'), { recursive: true });
    const settingsPath = join(root, '.claude', 'settings.json');
    const acksPath = join(root, 'docs', 'ai', 'acks.json');
    writeFileSync(settingsPath, JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] }, ['agentWorkflow']: { [ackKey]: '0000000000000000' } }));
    writeFileSync(acksPath, JSON.stringify({ [ackKey]: '1111111111111111' }));
    const before = [settingsPath, acksPath].map((path) => readFileSync(path));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { detect: agyReady, findWrapper: (cmd) => cmd === 'agy-review' }) });
    assert.deepEqual([settingsPath, acksPath].map((path) => readFileSync(path)), before);
    assert.ok(!skips.some((entry) => entry.key === retiredKey));
    assert.ok(!items.some((entry) => entry.key === retiredKey));
  });
  const reviewDetail = 'missing — allow rules: Bash(codex-review code:*); exclusions: codex-review *; hosts: chatgpt.com; state dirs: ~/.codex';
  for (const enabled of [undefined, true, invalidEnabled]) {
    it(`names every missing review entry with sandbox.enabled=${enabled}`, (t) => {
      const { item, skip } = readBridgeItem(t, { excludedCommands: ['codex-review'], network: { allowedDomains: CODEX_HOSTS.slice(1) }, ...(enabled === undefined ? {} : { enabled }) }, { allow: [] });
      assert.equal(skip, undefined);
      assert.equal(item?.what, expectedWhat(4));
      if (enabled === invalidEnabled) {
        assert.match(item.detail, / — host condition unchecked: .*enabled/u);
        assert.match(item.detail, /settings\.json/u);
      } else {
        assert.equal(item.detail, reviewDetail + (enabled === true ? ' — once added, wired where the host honors the settings sandbox keys' : ''));
      }
    });
  }
  const executeCases = [
    { kind: 'exclusions', entry: executeExclusion, excludedCommands: [reviewExclusion], hosts: CODEX_HOSTS, dirs: [stateDir], missing: { excludedCommands: [executeExclusion], hosts: [], dirs: [] } },
    { kind: 'hosts', entry: missingHost, excludedCommands: [reviewExclusion, executeExclusion], hosts: CODEX_HOSTS.slice(1), dirs: [stateDir], missing: { excludedCommands: [], hosts: [missingHost], dirs: [] } },
    { kind: 'state dirs', entry: stateDir, excludedCommands: [reviewExclusion, executeExclusion], hosts: CODEX_HOSTS, missing: { excludedCommands: [], hosts: [], dirs: [stateDir] } },
  ];
  for (const { kind, entry, excludedCommands, hosts, dirs, missing } of executeCases) {
    it(`names the execution wrapper's missing ${kind} and returns executeToAdd`, (t) => {
      const sandbox = { excludedCommands, network: { allowedDomains: hosts }, ...(dirs ? { filesystem: { allowWrite: dirs } } : {}) };
      const { root, deps, item, skip } = readBridgeItem(t, sandbox, { delegated: true });
      const plan = planVelocityProfile(preflightVelocityProfile({ cwd: root }, deps), { bridgeTier: true, findWrapper: deps.findWrapper, detect: deps.detect, env: deps.getenv, home: deps.home });
      assert.equal(skip, undefined);
      assert.equal(item?.what, expectedWhat(1));
      if (kind === 'exclusions') {
        const reviewOnly = readBridgeItem(t, sandbox);
        const reviewPlan = planVelocityProfile(preflightVelocityProfile({ cwd: reviewOnly.root }, reviewOnly.deps), { bridgeTier: true, findWrapper: reviewOnly.deps.findWrapper, detect: reviewOnly.deps.detect, env: reviewOnly.deps.getenv, home: reviewOnly.deps.home });
        assert.equal(reviewOnly.item, undefined);
        assert.equal(reviewOnly.skip, undefined);
        assert.deepEqual(reviewPlan.executeToAdd, { excludedCommands: [], hosts: [], dirs: [] });
      }
      assert.deepEqual(plan.executeToAdd, missing);
      assert.equal(item.detail, `missing — ${kind}: ${entry}; the execution wrapper codex-exec needs: ${entry}`);
    });
  }
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
    for (const key of ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render']) {
      assert.ok(skipped.includes(key), `${key} degrades to a stated skip on malformed settings (got: ${skipped.join(', ')})`);
    }
    assert.ok(!items.some((i) => ['velocity-core', 'autonomy-render'].includes(i.key)), 'no fabricated items');
  });

  it('an unseedable (space-carrying) project root skips ONLY the kit-tools tier — core still fires', () => {
    const root = mkdtempSync(join(tmpdir(), 'rec space-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'kit-tools-tier'), 'the tier derivation refuses the unseedable root — a stated skip');
    assert.ok(items.some((i) => i.key === 'velocity-core'), 'the core item still fires (its apply line shell-quotes the root)');
  });

  it('a throwing detector skips the bridge-tier item with the detector error', () => {
    const root = makeProject();
    const deps = hermeticDeps(root, {
      detect: () => {
        throw new Error('detector exploded');
      },
    });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.equal(items.find((item) => item.key === 'bridge-tier'), undefined);
    assert.ok(skips.some((s) => s.key === 'bridge-tier' && /detector exploded/.test(s.reason)), 'bridge-tier skip must carry the detector error: detector exploded');
  });

  it('the bridge-tier item counts used bridges\' missing surfaces — spec:velocity-profile/S6', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'reviewed' } }));
    const deps = hermeticDeps(root, { detect: codexReady, findWrapper: (cmd) => cmd === 'codex-review' });
    const recommendationsWith = (excludedCommands, allowedDomains, allowWrite, extra = {}) => {
      const sandbox = { excludedCommands, network: { allowedDomains } };
      if (allowWrite !== undefined) sandbox.filesystem = { allowWrite };
      writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(codex-review code:*)'] }, sandbox }));
      return buildRecommendations({ cwd: root, deps: hermeticDeps(root, { ...deps, ...extra }) });
    };
    const beforeRevision4 = recommendationsWith(['codex-review'], CODEX_HOSTS);
    const missingHost = recommendationsWith(['codex-review *'], CODEX_HOSTS.slice(1), ['~/.codex']);
    const complete = recommendationsWith(['codex-review *'], CODEX_HOSTS, ['~/.codex']);
    const unusedAgy = {
      detect: bothBridgesReady,
      findWrapper: (cmd) => cmd === 'codex-review' || cmd === 'agy-review',
    };
    const incompleteWithUnusedAgy = recommendationsWith(['codex-review'], CODEX_HOSTS, undefined, unusedAgy);
    const completeWithUnusedAgy = recommendationsWith(['codex-review *'], CODEX_HOSTS, ['~/.codex'], unusedAgy);
    rmSync(root, { recursive: true, force: true });
    for (const [result, n, reason] of [
      [beforeRevision4, 2, 'the missing codex-review * and ~/.codex count'],
      [missingHost, 1, 'one missing declared host counts'],
      [incompleteWithUnusedAgy, 2, 'a ready, placed agy no slot uses adds nothing to the count'],
    ]) {
      const item = result.items.find((entry) => entry.key === 'bridge-tier');
      assert.equal(item?.what, `bridge-wrappers tier incomplete — ${n} entr(ies) missing (allow rules, exclusions, hosts or state dirs of used bridges)`, reason);
      assert.ok(item.what.length <= ITEM_LINE_CAP, 'the exact text fits the item cap');
      assert.ok(!result.skips.some((entry) => entry.key === 'bridge-tier'), 'a successful derivation never skips bridge-tier');
    }
    for (const result of [complete, completeWithUnusedAgy]) {
      assert.equal(result.items.find((entry) => entry.key === 'bridge-tier'), undefined, 'every used surface is present: silent even with unused agy placed');
      assert.ok(!result.skips.some((entry) => entry.key === 'bridge-tier'), 'complete is not a failed probe');
    }
    assert.ok(RISK_NOTED_KEYS.includes('bridge-tier'), 'bridge-tier is risk-noted');
    const doc = readFileSync(join(KIT_ROOT, 'references', 'modes', 'recommendations.md'), 'utf8');
    const notes = doc.slice(doc.indexOf('**Per-item posture notes'), doc.indexOf('**Sandbox lanes'));
    const note = notes.split('\n').find((line) => line.startsWith('- `bridge-tier` —'));
    assert.ok(note?.includes('sandbox.network.allowedDomains'), 'the bridge-tier posture note names sandbox.network.allowedDomains');
    assert.ok(note?.includes('allowWrite'), 'the bridge-tier posture note names allowWrite');
  });

  it('a MALFORMED autonomy policy skips the autonomy items with the loud parse reason', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ not json');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'autonomy-policy' && /malformed JSON/.test(s.reason)));
    assert.ok(!items.some((i) => i.key === 'autonomy-policy'), 'a malformed policy is never re-declared as a fire');
  });

  it('a DEGRADING configured review recipe fires the review-recipe item (config says council, nothing is ready)', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'review-recipe');
    assert.ok(item, 'a configured-but-unsatisfiable recipe is a real sub-optimality');
    assert.match(item.what, /plan-execution\.review: configured council degrades to solo/);
    assert.equal(item.lane, 'user');
    assert.equal(item.check, null);
    assert.equal(item.apply, REVIEW_RECIPE_STEP);
  });

  it('a bridge detector that throws makes the review-recipe probe a stated SKIP, never an item from an empty readiness', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { detect: () => { throw new Error('detector down'); } }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(items.find((i) => i.key === 'review-recipe'), undefined, 'no item may be minted from an empty readiness');
    assert.ok(skips.some((s) => s.key === 'review-recipe' && /detector down/.test(String(s.reason ?? s.error ?? s.message ?? JSON.stringify(s)))), `the failure is a stated skip: ${JSON.stringify(skips)}`);
  });

  it('the review-recipe probe never judges a subagent slot — missing or placed, the executor is not its finding', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ routine: { carrier: 'subagent' } }));
    const itemsFor = (state) => buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { surveyVehicle: () => ({ state, reason: null, rel: '.claude/agents/executor.md' }) }),
    }).items;
    const missing = itemsFor('missing').find((i) => i.key === 'review-recipe');
    const placed = itemsFor('placed').find((i) => i.key === 'review-recipe');
    rmSync(root, { recursive: true, force: true });
    assert.equal(missing, undefined, 'a missing vehicle is the executor probe\'s finding, never a /backends remedy');
    assert.equal(placed, undefined, 'a placed vehicle mis-degrades nothing');
  });

  it('a MALFORMED gates.json skips the gate-hook item with the declaration reason', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), '{ not json');
    const { skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'gate-hook'), 'an unreadable declaration is a stated skip, never a guess');
  });
});

// The ONLY surface that can report a configured carrier with no vehicle: the review-recipe probe
// skips a subagent slot, and the agents offer converges on nothing-left-to-place — true of a broken one.
describe('recommendations — the executor-vehicle attention item (spec:carriers/S7)', () => {
  const BUNDLED = readFileSync(join(HERE, '..', 'references', 'agents', 'executor.md'), 'utf8');
  const CARRIER = JSON.stringify({ routine: { carrier: 'subagent' } });
  const run = (config, vehicle) => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), config);
    const dir = join(root, '.claude', 'agents');
    if (vehicle !== undefined) { mkdirSync(dir, { recursive: true }); if (vehicle === null) symlinkSync(join(root, 'nowhere'), join(dir, 'executor.md')); else writeFileSync(join(dir, 'executor.md'), vehicle); }
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return { ...built, root, found: built.items.filter((i) => i.key === 'executor-vehicle') };
  };
  it('configured + missing: exactly ONE attention item, counted, applied by the agents writer', () => {
    const { found, items, root } = run(JSON.stringify({ 'plan-execution': { execute: 'subagent' }, routine: { carrier: 'subagent' } }));
    assert.equal(found.length, 1, `one item, never one per slot: ${JSON.stringify(items.map((i) => i.key))}`);
    assert.equal(found[0].severity, SEVERITY_ATTENTION);
    assert.equal(found[0].what, '2 slot(s) configured subagent but the executor vehicle is missing — every such slot runs solo until it is usable');
    assert.match(found[0].detail, /hidden-mode deployments only:.*--reconcile/u, 'the reconcile rides the detail, never the apply');
    assert.equal(found[0].detail, `hidden-mode deployments only: after the apply, run node ${join(HERE, 'hide-footprint.mjs')} --dir ${root} --reconcile so the placed .claude/agents/ stays invisible to git status`);
  });
  it('configured + a symlinked executor: the attention item, the survey reason riding the text', () => {
    const { found } = run(CARRIER, null);
    assert.equal(found.length, 1);
    assert.ok(found[0].what.startsWith('1 slot(s) configured subagent but the executor vehicle is unusable: ') && /executor\.md exists but is not a regular file/u.test(found[0].detail), found[0].detail);
  });
  it('configured + a regular executor failing the check: the kit item alone, the base arm yielding to agents.not-current', () => {
    const { found, items } = run(CARRIER, '---\nname: executor\ntools: Read\n---\nbody\n');
    assert.deepEqual([found.map((i) => i.variant), items.filter((i) => i.key === 'agents').map((i) => i.variant)], [[], ['agents.not-current']]);
  });
  it('placed, customized and no subagent slot: no attention item — the rest of the list is untouched', () => {
    const placed = run(CARRIER, BUNDLED);
    const unconfigured = run(JSON.stringify({ routine: { carrier: 'solo' } }), BUNDLED);
    const cases = { placed, customized: run(CARRIER, '---\nname: executor\ntools: Read, Bash\n---\nmine\n'), unconfigured };
    for (const [label, r] of Object.entries(cases)) assert.deepEqual(r.found.filter((i) => i.variant === 'executor-vehicle'), [], `${label} raises no attention item`);
    assert.deepEqual(placed.items.map((i) => i.key), unconfigured.items.map((i) => i.key), 'the same full list either way');
  });
  it('a config the validated reader refuses is a stated SKIP, never an item', () => {
    const { found, skips } = run(JSON.stringify({ routine: { carrier: 'bogus' } }));
    assert.deepEqual(found, []);
    assert.ok(skips.some((s) => s.key === 'executor-vehicle'), `the invalid config is stated: ${JSON.stringify(skips)}`);
  });
});

// ── the inert-declaration item ─────────────────────────────────────────────────────
// The field-report class: a declaration that RUNS GREEN and verifies nothing. The gates-declaration
// offer converges the moment any gate exists, so it can never observe this state — the advisor was
// silent while the runner reported every gate PASS. Both causes are read off the declaration through
// the SAME predicates --final and the fill decide with, so the advisor can never disagree.

describe('recommendations — the inert gate declaration item', () => {
  const kitCheck = (tool) => `node "${join(HERE, tool)}" --check`;
  const CHECKER = kitCheck('coverage-check.mjs');
  // The ONE row here that needs a real git tree (the census reads the index) borrows the builder the
  // third-outcomes suite uses; every other row in this block runs on the non-git makeProject fixture
  // with its injected within-domain census.
  const { buildForeignFixture, hermeticAdvisorDeps } = FOREIGN;
  const gate = (id, cmd) => ({ id, title: id, cmd });
  const inertFor = (gates) => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return { ...built, item: built.items.find((i) => i.key === 'gates-inert'), skip: built.skips.find((s) => s.key === 'gates-inert') };
  };

  it('cause A — a lint-only declaration carrying the checker with NO producer fires, names the checker, and hands the reorder to the maintainer', () => {
    const { item } = inertFor([gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)]);
    assert.ok(item, 'a declared checker with nothing writing its lcov is a real sub-optimality');
    assert.equal(item.severity, SEVERITY_ATTENTION, 'a declaration that verifies nothing needs attention, it is not an offer');
    assert.match(item.what, /coverage-check/, 'the WHAT names the checker gate');
    // Both outcomes, because both are real: no lcov at all, or a verdict over bytes an earlier run
    // left in the git dir — the second reads as `coverage=certified`, so it cannot be called a pass
    // over nothing.
    assert.match(item.what, /certifies nothing this run, or reads a stale lcov/);
    assert.equal(item.variant, 'gates-inert.unfillable');
    assert.equal(item.apply, UNFILLABLE_STEP);
    assert.equal(item.detail, NO_PRODUCER);
  });

  // The D-8 consequence for this item: once the fill can PLACE a producer before a trailing checker,
  // cause A stops being maintainer-only wherever that placement would actually land the fix.
  it('cause A: an offered producer whose id is ALREADY declared is not placeable — the fill would refuse it', () => {
    // The offer derives ids from script names, so a declaration already carrying that id makes the
    // fill refuse the very entry this item would be pointing at. Counting it as placeable renders a
    // preview that cannot fix what the item just reported.
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [gate('test', 'true'), gate('coverage-check', CHECKER)],
    }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'the inert pair still fires');
    assert.equal(item.variant, 'gates-inert.unfillable');
    assert.equal(item.apply, UNFILLABLE_STEP);
    assert.equal(item.detail, PRODUCER_COLLISION);
  });

  it('cause A: a checker that is NOT last states THAT cause — never "no offerable producer" over a producer that exists', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [gate('coverage-check', CHECKER), gate('lint', 'npm exec -- eslint .')],
    }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'a checker with nothing before it is inert whatever follows it');
    assert.equal(item.variant, 'gates-inert.unfillable');
    assert.equal(item.apply, UNFILLABLE_STEP);
    assert.equal(item.detail, CHECKER_NOT_LAST);
  });

  it('cause A with an OFFERABLE producer and the checker LAST renders the fill preview, not HAND-APPLY', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)] }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'the inert pair still fires — the offer does not fix anything by existing');
    assert.equal(item.variant, 'gates-inert');
    assert.match(item.apply, /^node \/[^\s]*gates-init\.mjs --cwd \//, `it renders the seeder preview: ${item.apply}`);
  });

  it('cause B — a declaration of nothing but kit checkers fires its OWN what and the consent-gated seeder preview', () => {
    const { item } = inertFor([
      gate('review-state', kitCheck('review-state.mjs')),
      gate('commit-guard', kitCheck('commit-guard.mjs')),
      gate('flow-check', kitCheck('flow-check.mjs')),
    ]);
    assert.ok(item, 'a matrix that only checks the kit verifies nothing of the project');
    assert.match(item.what, /no project-verification command/);
    assert.doesNotMatch(item.what, /certifying nothing/, 'cause B carries its own WHAT, never cause A’s');
    assert.match(item.apply, /^node \/[^\s]*gates-init\.mjs --cwd \//, `cause B renders the seeder preview: ${item.apply}`);
  });

  it('a producer declared AFTER the checker still fires cause A — ORDER is the question, not presence', () => {
    // The checker runs first and reads nothing (or stale bytes an earlier run left behind), then the
    // producer writes the lcov too late. Only --final refuses this shape; a plain run reports PASS.
    const { item } = inertFor([gate('coverage-check', CHECKER), gate('unit-tests', COVERAGE_PRODUCER_BODY)]);
    assert.ok(item, 'a producer that runs too late leaves the checker just as inert');
    assert.match(item.what, /has no producer before it/);
    assert.match(item.what, /reads a stale lcov/, 'the late-producer shape is exactly where stale bytes get certified');
    assert.equal(item.variant, 'gates-inert.unfillable');
    assert.equal(item.apply, UNFILLABLE_STEP);
    assert.equal(item.detail, CHECKER_NOT_LAST);
  });

  // The apply is a PREVIEW, so what it must earn is a runnable next step. In cause A the declaration
  // already carries the checker, and so does the offer — a whole-offer apply collides on that id by
  // construction. Naming the producer keeps the one entry that fixes the reported state.
  it('cause A: the previewed apply names the PRODUCER, and running it converges the item', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [gate('review-state', kitCheck('review-state.mjs')), gate('coverage-check', CHECKER)],
    }));
    const item = buildRecommendations({ cwd: root, deps: hermeticDeps(root) }).items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'a declared checker with no producer before it is inert');
    assert.match(item.apply, / --only test$/, `the apply names the producer entry: ${item.apply}`);
    // Non-vacuous: the consented follow-up of exactly that preview really does resolve the item.
    applyFill({ cwd: root, onlyIds: ['test'] });
    const after = buildRecommendations({ cwd: root, deps: hermeticDeps(root) }).items.find((i) => i.key === 'gates-inert');
    rmSync(root, { recursive: true, force: true });
    assert.equal(after, undefined, 'following the rendered lane converges the item it was rendered for');
  });

  // The source-size checker is one of the kit's OWN checkers. A classifier that does not know it reads
  // a matrix of nothing but that gate as carrying project verification — so a project that just
  // adopted the practice is told its deployment is optimal: the invisibility this item removes.
  it('cause B: a matrix of nothing but kit checkers INCLUDING source-size fires the no-verification arm', () => {
    const root = makeProject();
    const { item } = (() => {
      writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
        gates: [gate('source-size', `node "${join(HERE, 'source-size-check.mjs')}" --check`)],
      }));
      const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
      return { item: built.items.find((i) => i.key === 'gates-inert') };
    })();
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'a matrix that only runs the kit checks no project command at all');
    assert.match(item.what, /no project-verification command/);
  });

  it('cause B: a matrix of nothing but the declarable kit checkers fires the no-verification arm', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [
      gate('control-bytes', kitCheck('control-bytes.mjs')),
      gate('plan-shape', `node "${join(HERE, 'plan-shape-cli.mjs')}" --check --in-flight`),
      gate('spec-check', `node "${join(HERE, 'spec-check-cli.mjs')}" --all`),
      gate('spec-coverage', kitCheck('spec-coverage-cli.mjs')), gate('project-rules', kitCheck('project-rules/rules-cli.mjs')),
    ] }));
    const item = buildRecommendations({ cwd: root, deps: hermeticDeps(root) }).items.find((i) => i.key === 'gates-inert');
    rmSync(root, { recursive: true, force: true });
    assert.equal(item?.variant, 'gates-inert.no-verification', 'the declarable kit checkers verify no project command');
  });

  // The SAME class as cause A, reached from the other arm: a kit checker the offer also carries is
  // already declared, so an unrestricted preview leads to an id collision here too. The rule is one
  // rule — a rendered preview names only entries the fill would accept — so both arms obey it.
  it('cause B: the previewed apply names only entries the fill would accept, and running it converges', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [gate('review-state', kitCheck('review-state.mjs'))] }));
    const item = buildRecommendations({ cwd: root, deps: hermeticDeps(root) }).items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'a matrix of nothing but kit checkers runs no project command');
    assert.match(item.apply, /--only test/, `the already-declared review-state must not ride the selection: ${item.apply}`);
    assert.doesNotMatch(item.apply, /--only review-state/, `it would collide: ${item.apply}`);
    const ids = [...item.apply.matchAll(/--only (\S+)/g)].map((m) => m[1]);
    applyFill({ cwd: root, onlyIds: ids });
    const after = buildRecommendations({ cwd: root, deps: hermeticDeps(root) }).items.find((i) => i.key === 'gates-inert');
    rmSync(root, { recursive: true, force: true });
    assert.equal(after, undefined, 'following the rendered lane converges the item it was rendered for');
  });

  // Selecting a non-colliding entry is not enough — it has to be an entry that RESOLVES the item.
  // Cause B says the matrix runs no project command, so offering another kit checker converges
  // nothing: the item simply fires again on the next run.
  it('cause B: the selection names only PROJECT-verification entries — another kit checker cannot resolve it', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }));
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [gate('source-size', `node "${join(HERE, 'source-size-check.mjs')}" --check`)],
    }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'a matrix of nothing but kit checkers runs no project command');
    assert.doesNotMatch(item.apply, /--only review-state/, `declaring one more kit checker resolves nothing: ${item.apply}`);
  });

  it('neither cause renders the flow-optimal line — the advisor never attests over an inert matrix', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)] }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const rendered = formatRecommendations(built);
    assert.ok(!rendered.includes(RECOMMENDATIONS_EMPTY_LINE), 'flow optimal must not render over a declaration that verifies nothing');
    assert.match(rendered, /item\(s\) need attention/, 'it opens on the attention verdict instead');
  });

  // The residual the producer-unrecognized arm must never overstate. The fill screens by terminating
  // -class script NAME before it looks at a body, so a recognizable `node --test` under `ci` is a
  // producer the offer can never carry. The arm still fires, but its text must not tell that project
  // its suite is inexpressible — the reader would hunt for a script they already run. (It lives here,
  // not beside its siblings, so the third-outcomes suite's frozen bytes keep their red-proofs.)
  it('cause A over a recognizable producer under a NON-OFFERED script name says what it knows, never that the suite is inexpressible', () => {
    const built = buildForeignFixture({
      spawn: (command, args, options) => {
        assert.equal(command, 'git');
        return runFixtureGit(options.cwd, args);
      },
      tsFiles: 3,
      testScript: 'vitest run',
      extraFiles: { 'package.json': `${JSON.stringify({ name: 'f', private: true, scripts: { ci: 'node --test' } }, null, 2)}\n` },
      gates: [{ id: 'lint', title: 'lint', cmd: 'true' }, { id: 'coverage-check', title: 'c', cmd: CHECKER }],
    });
    const item = buildRecommendations({ cwd: built.root, deps: hermeticAdvisorDeps(built.root) })
      .items.find((i) => i.key === 'gates-inert');
    built.teardown();
    assert.ok(item, 'nothing declares or offers a producer, so the pair is still dead');
    assert.equal(item.variant, 'gates-inert.producer-unrecognized');
    assert.doesNotMatch(item.what, /cannot be expressed/, `the false claim is gone: ${item.what}`);
    assert.match(item.what, /NO producer declared and none offerable/, item.what);
    assert.equal(item.apply, PRODUCER_UNRECOGNIZED_STEP);
    assert.equal(item.detail, PRODUCER_UNRECOGNIZED_DETAIL);
    assert.match(item.detail, /a recognized body under another name/, `the recipe names the gap: ${item.detail}`);
  });

  it('an EXACT producer ahead of the checker fires neither cause — and never a skip', () => {
    const { item, skip } = inertFor([gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)]);
    assert.equal(item, undefined, 'a live producer/checker pair is exactly what the item wants to see');
    assert.equal(skip, undefined, 'a readable declaration is decided, never skipped');
  });

  it('a NEAR-MISS producer still fires cause A — the closed predicate decides, never a substring', () => {
    for (const [label, cmd] of [
      ['the destination inside an echo', 'echo "$AW_GIT_DIR/agent-workflow-lcov.info"'],
      ['a partial reporter flag set', 'node --test --experimental-test-coverage --test-reporter=lcov'],
      ['the destination as a bare substring', 'cat "$AW_GIT_DIR/agent-workflow-lcov.info" | wc -l'],
    ]) {
      const { item } = inertFor([gate('unit-tests', cmd), gate('coverage-check', CHECKER)]);
      assert.ok(item, `${label} must not read as a producer`);
      assert.match(item.what, /has no producer before it/);
    }
  });

  it('a MALFORMED declaration is a stated skip, never a crash and never a fabricated item', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), '{ not json');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'gates-inert' && /malformed JSON/.test(s.reason)));
    assert.ok(!items.some((i) => i.key === 'gates-inert'), 'an unreadable declaration is never reported as inert');
  });

  it('an ABSENT or EMPTY declaration belongs to the gates-declaration item — never this one', () => {
    const root = makeProject();
    const absent = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }));
    const empty = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    for (const [label, built] of [['absent', absent], ['empty', empty]]) {
      assert.ok(!built.items.some((i) => i.key === 'gates-inert'), `an ${label} declaration is undeclared, not inert`);
      assert.ok(!built.skips.some((s) => s.key === 'gates-inert'), `an ${label} declaration is not a probe failure either`);
      assert.ok(built.items.some((i) => i.key === 'gates-declaration'), `the ${label} declaration fires the item that owns it`);
    }
  });
});

describe('recommendations \u2014 the enforcement item', () => {
  // spec:node-evidence/S9
  it('recommendations \u2014 the enforcement item: docs/ai + pyproject.toml, no package.json, no scripts/ renders the harness offer', (t) => {
    const root = makeNoneEvidenceProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { item, skip } = enforcementFor(root);
    const registryRow = OPT_IN_CAPABILITIES.find((row) => row.id === ENFORCEMENT_KEY);
    assert.deepEqual(registryRow, { id: ENFORCEMENT_KEY, mode: 'bootstrap', advisorKey: ENFORCEMENT_KEY });
    assert.deepEqual([item?.key, item?.severity, item?.what, skip], [ENFORCEMENT_KEY, SEVERITY_OPTIONAL, WHATS[ENFORCEMENT_KEY], undefined]);
    assert.ok(RISK_NOTED_KEYS.includes(ENFORCEMENT_KEY));
    const spaceRoot = mkdtempSync(join(tmpdir(), SPACE_PROJECT_PREFIX));
    t.after(() => rmSync(spaceRoot, { recursive: true, force: true }));
    mkdirSync(join(spaceRoot, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(spaceRoot, 'pyproject.toml'), FIXTURE_PYPROJECT);
    const { item: spaceItem, skip: spaceSkip } = enforcementFor(spaceRoot);
    assert.equal(spaceSkip, undefined);
    for (const [candidateRoot, candidate] of [[root, item], [spaceRoot, spaceItem]]) {
      const expected = need(lanes, 'applySlot')('enforcement', { toolsDir: HERE, root: candidateRoot, env: {}, home: candidateRoot, platform: 'linux' });
      assert.equal(candidate?.lane, 'harness');
      assert.deepEqual({ check: candidate.check, apply: candidate.apply }, expected);
    }
  });
  it('evidence none skips a foreign pre-commit but offers enforcement over managed and absent hooks', (t) => {
    const root = makeNoneEvidenceProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'hooks'));
    const deps = { gitHooksPath: () => join(root, 'hooks') };
    writeFileSync(join(root, 'hooks', 'pre-commit'), FOREIGN_HOOK);
    const foreign = enforcementFor(root, deps);
    writeFileSync(join(root, 'hooks', 'pre-commit'), MANAGED_GUARDLESS);
    const managed = enforcementFor(root, deps);
    rmSync(join(root, 'hooks', 'pre-commit'));
    const absent = enforcementFor(root, deps);
    assert.equal(foreign.item, undefined);
    assert.equal(foreign.skip?.reason, ENFORCEMENT_UNMANAGED);
    for (const disposition of [managed, absent]) {
      assert.equal(disposition.item?.key, ENFORCEMENT_KEY);
      assert.equal(disposition.skip, undefined);
    }
  });
  it('recommendations \u2014 the enforcement scripts bundle uses its own dependency seam', () => {
    const root = makeNoneEvidenceProject();
    const emptyBundleRoot = mkdtempSync(join(tmpdir(), EMPTY_BUNDLE_PREFIX));
    const { item, skip } = enforcementFor(root, {
      bundleRoot: emptyBundleRoot,
      scriptsBundleRoot: BUNDLED_SCRIPTS,
    });
    assert.equal(item?.key, ENFORCEMENT_KEY);
    assert.equal(skip, undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBundleRoot, { recursive: true, force: true });
  });
  it('recommendations \u2014 package.json and deployed-node-scripts evidence keep enforcement silent', () => {
    assert.equal(typeof probeEnforcement, 'function', 'the enforcement probe is active');
    const packageRoot = makeProject();
    const scriptRoot = makeNoneEvidenceProject();
    mkdirSync(join(scriptRoot, 'scripts'));
    writeFileSync(join(scriptRoot, 'scripts', DEPLOYED_NODE_SCRIPT), FIXTURE_SCRIPT);
    const dispositions = [enforcementFor(packageRoot, { readdir: guardedBundleRead }), enforcementFor(scriptRoot, { readdir: guardedBundleRead })];
    for (const disposition of dispositions) assert.deepEqual(disposition, { item: undefined, skip: undefined });
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(scriptRoot, { recursive: true, force: true });
  });
  it('recommendations \u2014 wrong-kind evidence is a stated enforcement skip naming the path', () => {
    const cases = [
      ['package.json', (root) => mkdirSync(join(root, 'package.json'))],
      ['scripts', (root) => {
        mkdirSync(join(root, 'linked-scripts'));
        symlinkSync(join(root, 'linked-scripts'), join(root, 'scripts'), 'dir');
      }],
      [join('scripts', DEPLOYED_NODE_SCRIPT), (root) => {
        mkdirSync(join(root, 'scripts'));
        writeFileSync(join(root, 'seed-target.mjs'), FIXTURE_SCRIPT);
        symlinkSync(join(root, 'seed-target.mjs'), join(root, 'scripts', DEPLOYED_NODE_SCRIPT));
      }],
    ];
    for (const [relativePath, seed] of cases) {
      const root = makeNoneEvidenceProject();
      seed(root);
      assertEnforcementSkip(enforcementFor(root, { readdir: guardedBundleRead }), join(root, relativePath));
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Every deployed path is itself a Node-evidence probe, so the evidence gate answers a destination first: an
  // existing one is evidence and renders nothing, a linked one is the wrong-kind skip naming it, an unreadable one
  // the unreadable skip naming the probe.
  it('recommendations \u2014 an existing bundled destination renders nothing; a symlinked or unreadable one is a stated enforcement skip naming it', () => {
    const cases = [
      (root, path) => {
        writeFileSync(path, FIXTURE_SCRIPT);
        return [{}, (disposition) => assert.deepEqual(disposition, { item: undefined, skip: undefined })];
      },
      (root, path) => {
        writeFileSync(join(root, 'collision-target.mjs'), FIXTURE_SCRIPT);
        symlinkSync(join(root, 'collision-target.mjs'), path);
        return [{}, (disposition) => assertEnforcementSkip(disposition, path)];
      },
      (root, path) => [{ lstat: lstatUnreadableAt(path) }, (disposition) => assertEnforcementSkip(disposition, `${EACCES_CODE} on ${join('scripts', COLLISION_SCRIPT)}`)],
    ];
    for (const seed of cases) {
      const root = makeNoneEvidenceProject();
      const path = join(root, 'scripts', COLLISION_SCRIPT);
      mkdirSync(dirname(path), { recursive: true });
      const [extra, judge] = seed(root, path);
      judge(enforcementFor(root, extra));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('recommendations \u2014 an EACCES node-evidence probe is a stated enforcement skip naming the probe', () => {
    const root = makeNoneEvidenceProject();
    const path = join(root, 'package.json');
    const lstat = lstatUnreadableAt(path);
    const disposition = enforcementFor(root, { lstat, readdir: guardedBundleRead });
    assert.equal(disposition.item, undefined);
    assert.ok(disposition.skip?.reason.includes(root), disposition.skip?.reason);
    assert.ok(disposition.skip?.reason.includes(`${EACCES_CODE} on package.json`), disposition.skip?.reason);
    rmSync(root, { recursive: true, force: true });
  });
  it('recommendations \u2014 no docs/ai is silent and unreadable docs/ai is a stated enforcement skip', () => {
    const absent = makeNoneEvidenceProject(false);
    const unreadable = makeNoneEvidenceProject();
    const path = join(unreadable, 'docs', 'ai');
    const lstat = lstatUnreadableAt(path);
    assert.deepEqual(enforcementFor(absent, { readdir: guardedBundleRead }), { item: undefined, skip: undefined });
    assertEnforcementSkip(enforcementFor(unreadable, { lstat, readdir: guardedBundleRead }), path);
    rmSync(absent, { recursive: true, force: true });
    rmSync(unreadable, { recursive: true, force: true });
  });
});

describe('spec:init-project/S35 the advisor\'s reader and table by proof', () => {
  const UNARMED = { rulesArmed: false, rulesForeign: false, layoutArmed: false, layoutForeign: false };
  it('readPreCommitState distinguishes no hooks dir, absent, managed and unmanaged, armed only by the canonical line, its four role fields false with no role line', (t) => {
    const root = makeNoneEvidenceProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'hooks'));
    const deps = guardDeps(root);
    const canonical = `node "${join(HERE, 'commit-guard.mjs')}" --check\n`;
    const lookalike = `node "${join(root, 'fake-commit-guard.mjs')}" --check\n`;
    const readPreCommitState = need(recommendations, 'readPreCommitState');
    assert.deepEqual(readPreCommitState(root, { gitHooksPath: () => null }), { state: 'no-hooks-dir', armed: false, ...UNARMED });
    assert.deepEqual(readPreCommitState(root, deps), { state: 'absent', armed: false, ...UNARMED });
    for (const [state, prefix] of [['managed', MANAGED_GUARDLESS], ['unmanaged', FOREIGN_HOOK]]) {
      for (const [line, armed] of [['', false], [canonical, true], [`# ${canonical}`, false], [lookalike, false]]) {
        writeFileSync(join(root, 'hooks', 'pre-commit'), `${prefix}${line}`);
        assert.deepEqual(readPreCommitState(root, deps), { state, armed, ...UNARMED }, `${state}: ${line}`);
      }
    }
  });

  it('readPreCommitState reports a directory hook as unreadable EISDIR and never armed, its four role fields false', async (t) => {
    const root = guardProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'hooks', 'pre-commit');
    mkdirSync(path);
    const loaded = await import('./git-hooks.mjs');
    const readPreCommitState = loaded.readPreCommitState ?? (() => { throw new Error('readPreCommitState is absent'); });
    assert.deepEqual(readPreCommitState(root, guardDeps(root)), { state: 'unreadable', code: 'EISDIR', path, armed: false, ...UNARMED });
  });

  for (const key of ['commit-guard', ENFORCEMENT_KEY]) {
    it(`${key} skips an unreadable hook with its path and EISDIR instead of offering an item`, (t) => {
      const root = key === 'commit-guard' ? guardProject() : makeNoneEvidenceProject();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, 'hooks', 'pre-commit');
      mkdirSync(path, { recursive: true });
      const built = buildRecommendations({ cwd: root, deps: guardDeps(root) });
      const reason = `${path} is unreadable (EISDIR) — the pre-commit hook cannot be judged`;
      assert.deepEqual(built.items.filter((item) => item.key === key), []);
      assert.deepEqual(built.skips.filter((skip) => skip.key === key), [{ key, reason }]);
    });
  }

  it('enforcementAdmits equals the rendered offer on every admitted, silent and refused root', (t) => {
    const cases = [
      ['no hooks dir', true, () => {}],
      ['unreadable hook', false, (root) => mkdirSync(join(root, 'hooks', 'pre-commit'), { recursive: true })],
      ['absent hook', true, (root) => mkdirSync(join(root, 'hooks'))],
      ['managed hook', true, (root) => {
        mkdirSync(join(root, 'hooks'));
        writeFileSync(join(root, 'hooks', 'pre-commit'), MANAGED_GUARDLESS);
      }],
      ['empty scripts dir', true, (root) => mkdirSync(join(root, 'scripts'))],
      ['no docs/ai', false, (root) => rmSync(join(root, 'docs', 'ai'), { recursive: true })],
      ['package.json', false, (root) => writeFileSync(join(root, 'package.json'), FIXTURE_PACKAGE_JSON)],
      ['deployed script', false, (root) => {
        mkdirSync(join(root, 'scripts'));
        writeFileSync(join(root, 'scripts', DEPLOYED_NODE_SCRIPT), FIXTURE_SCRIPT);
      }],
      ['wrong-kind path', false, (root) => mkdirSync(join(root, 'package.json'))],
      ['existing bundled basename', false, (root) => {
        mkdirSync(dirname(join(root, 'scripts', COLLISION_SCRIPT)), { recursive: true });
        writeFileSync(join(root, 'scripts', COLLISION_SCRIPT), FIXTURE_SCRIPT);
      }],
      ['foreign hook', false, (root) => {
        mkdirSync(join(root, 'hooks'));
        writeFileSync(join(root, 'hooks', 'pre-commit'), FOREIGN_HOOK);
      }],
    ];
    const rows = cases.map(([label, expected, seed]) => {
      const root = makeNoneEvidenceProject();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      seed(root);
      const deps = guardDeps(root, label === 'no hooks dir' ? { gitHooksPath: () => null } : {});
      const disposition = enforcementFor(root, deps);
      return { label, expected, root, deps, disposition };
    });
    const guardRoot = guardProject();
    t.after(() => rmSync(guardRoot, { recursive: true, force: true }));
    const guard = buildRecommendations({ cwd: guardRoot, deps: guardDeps(guardRoot) }).items.find((item) => item.key === 'commit-guard');
    const enforcementAdmits = need(recommendations, 'enforcementAdmits');
    for (const { label, expected, root, deps, disposition } of rows) {
      const admitted = enforcementAdmits(root, deps);
      assert.equal(admitted, expected, label);
      assert.equal(admitted, Boolean(disposition.item), label);
      if (admitted) assert.equal(disposition.skip, undefined, label);
    }
    for (const item of [guard, ...rows.filter((row) => row.expected).map((row) => row.disposition.item)]) {
      assert.ok(item);
      assert.equal(item.lane, 'harness');
      assert.equal(typeof item.check, 'string');
      assert.ok(item.check.length > 0);
    }
  });
});

describe('recommendations — the commit-guard item (the D10 consumer surface)', () => {
  it('an ABSENT pre-commit hook under a final-capable declaration fires the harness offer', () => {
    const root = guardProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'commit-guard');
    assert.ok(item, 'an absent hook gets the offer too — the installer creates it armed');
    const expected = need(lanes, 'applySlot')('commit-guard', { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' });
    assert.equal(item.lane, 'harness');
    assert.deepEqual({ check: item.check, apply: item.apply }, expected);
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.ok(!skips.some((s) => s.key === 'commit-guard'));
  });

  it('a MANAGED guardless hook fires the same offer; an ARMED guard line converges silently', () => {
    const root = guardProject();
    writeFileSync(join(root, 'hooks', 'pre-commit'), MANAGED_GUARDLESS);
    const managed = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    assert.ok(managed.items.some((i) => i.key === 'commit-guard'), 'a managed guardless hook gets the offer');
    writeFileSync(join(root, 'hooks', 'pre-commit'), `${MANAGED_GUARDLESS}node "${join(HERE, 'commit-guard.mjs')}" --check\n`);
    const armed = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!armed.items.some((i) => i.key === 'commit-guard'), 'an armed guard converges the item');
    assert.ok(!armed.skips.some((s) => s.key === 'commit-guard'));
  });

  it('convergence needs the EXACT canonical armed line — a comment or a lookalike guard still FIRES the offer', () => {
    const root = guardProject();
    writeFileSync(join(root, 'hooks', 'pre-commit'), `${MANAGED_GUARDLESS}# node "${join(HERE, 'commit-guard.mjs')}" --check\n`);
    const commented = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    assert.ok(commented.items.some((i) => i.key === 'commit-guard'), 'a commented-out guard line never reads as armed');
    writeFileSync(join(root, 'hooks', 'pre-commit'), `${MANAGED_GUARDLESS}node "${join(root, 'fake-commit-guard.mjs')}" --check\n`);
    const lookalike = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(lookalike.items.some((i) => i.key === 'commit-guard'), 'a non-canonical guard path never reads as armed');
  });

  it('an UNMANAGED pre-commit hook is a stated skip naming the user\'s own step', () => {
    const root = guardProject();
    writeFileSync(join(root, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'commit-guard'));
    assert.equal(skips.find((s) => s.key === 'commit-guard')?.reason, COMMIT_GUARD_UNMANAGED);
  });

  it('a null hooks directory converges without an item or a skip', (t) => {
    const root = guardProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root, { gitHooksPath: () => null }) });
    assert.ok(!items.some((item) => item.key === 'commit-guard'));
    assert.ok(!skips.some((skip) => skip.key === 'commit-guard'));
  });

  it('a declaration that is NOT final-run-capable gets NO offer and NO skip (an armed guard there would refuse every commit)', () => {
    const root = guardProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit', title: 'T', cmd: 'node --test' }] }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'commit-guard'));
    assert.ok(!skips.some((s) => s.key === 'commit-guard'));
  });

  // spec:node-evidence/S10
  it('a final-capable declaration WITHOUT the installer names the admitted item or the user\'s own deploy step', (t) => {
    const packageRoot = guardProject();
    const scriptsRoot = removePackageEvidence(guardProject());
    rmSync(join(packageRoot, KIT_INSTALLER));
    rmSync(join(scriptsRoot, KIT_INSTALLER));
    writeFileSync(join(scriptsRoot, 'scripts', DEPLOYED_NODE_SCRIPT), FIXTURE_SCRIPT);
    const admittedRoot = makeNoneEvidenceProject();
    writeFileSync(join(admittedRoot, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
    mkdirSync(join(admittedRoot, 'hooks'));
    for (const root of [packageRoot, scriptsRoot, admittedRoot]) t.after(() => rmSync(root, { recursive: true, force: true }));
    const admitted = buildRecommendations({ cwd: admittedRoot, deps: guardDeps(admittedRoot) });
    writeFileSync(join(admittedRoot, 'hooks', 'pre-commit'), FOREIGN_HOOK);
    const foreign = buildRecommendations({ cwd: admittedRoot, deps: guardDeps(admittedRoot) });
    for (const root of [packageRoot, scriptsRoot]) {
      const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
      assert.ok(!items.some((i) => i.key === 'commit-guard'));
      const commitGuardSkip = skips.find((entry) => entry.key === 'commit-guard');
      assert.equal(commitGuardSkip?.reason, COMMIT_GUARD_OWN_STEP);
      assert.ok(!items.some((entry) => entry.key === ENFORCEMENT_KEY) && !skips.some((entry) => entry.key === ENFORCEMENT_KEY));
      assert.doesNotMatch(commitGuardSkip.reason, /\babove\b/u);
      assert.doesNotMatch(commitGuardSkip.reason, /bootstrap/u);
    }
    assert.ok(admitted.items.some((item) => item.key === ENFORCEMENT_KEY));
    assert.ok(!admitted.items.some((item) => item.key === 'commit-guard'));
    assert.equal(admitted.skips.find((skip) => skip.key === 'commit-guard')?.reason, COMMIT_GUARD_VIA_ITEM);
    assert.ok(!foreign.items.some((item) => item.key === ENFORCEMENT_KEY || item.key === 'commit-guard'));
    assert.equal(foreign.skips.find((skip) => skip.key === 'commit-guard')?.reason, COMMIT_GUARD_OWN_STEP);
    assert.equal(foreign.skips.find((skip) => skip.key === ENFORCEMENT_KEY)?.reason, ENFORCEMENT_UNMANAGED);
    for (const built of [admitted, foreign]) {
      for (const skip of built.skips) assert.doesNotMatch(skip.reason, /bootstrap/u);
    }
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
    // --clear (Segment B).
    const root = mkdtempSync(join(tmpdir(), 'recommendations-stalereal-'));
    runFixtureGit(root, ['init', '-q']);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
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
    runFixtureGit(root, ['init', '-q']);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    const deps = hermeticDeps(root, {
      listUntracked: () => {
        throw new Error('walk exploded');
      },
    });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'sandbox-masks' && /walk exploded/.test(s.reason)));
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
    assert.equal(item.apply, `node ${join(HERE, 'gates-init.mjs')} --cwd ${root}`, 'the apply line is a PURE executable command — run-exactly-as-rendered must not feed prose to the CLI');
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
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'reviewed' } }));
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, {
      detect: agyReady,
      findWrapper: (cmd) => cmd === 'agy-review',
      readdir: () => ['ghost-bridge-without-manifest'],
    });
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'bridge-tier'), 'a partial manifest walk must not render a recipe');
    const skip = skips.find((s) => s.key === 'bridge-tier');
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
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'reviewed' } }));
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const enotdir = () => {
      const e = new Error('ENOTDIR: not a directory');
      e.code = 'ENOTDIR';
      throw e;
    };
    const deps = hermeticDeps(root, {
      detect: agyReady,
      findWrapper: (cmd) => cmd === 'agy-review',
      readdir: () => ['.DS_Store', 'antigravity-cli-bridge'],
      readFile: (p, enc) => (p.includes('.DS_Store') ? enotdir() : readFileSync(p, enc)),
    });
    const { skips } = buildRecommendations({ cwd: root, deps });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!skips.some((s) => s.key === 'bridge-tier'), 'ENOTDIR on a stray file must not skip the item');
  });

  it('the direct CLI run renders the section and exits 0 (the spawn covers the emit tail)', () => {
    const root = makeProject();
    // HOME at a temp dir and CLAUDE_CONFIG_DIR unset: the default route never reads the real skill roots.
    const home = mkdtempSync(join(tmpdir(), 'rec-cli-home-'));
    const env = hermeticGitEnv(process.env, home);
    delete env.CLAUDE_CONFIG_DIR;
    const out = execFileSync(process.execPath, [join(HERE, 'recommendations.mjs'), '--cwd', root], { encoding: 'utf8', env });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    assert.ok(out.startsWith(RECOMMENDATIONS_SECTION_HEADER));
  });
});

describe('spec:init-project/S64 the advisor\'s hook-checks item by its table', () => {
  const whatOf = (checks) => `the pre-commit hook lacks this kit's ${checks} — the kit arms each line`;
  const NAMES = { rules: 'project-rules check', layout: 'layout check', both: 'project-rules and layout checks' };
  const CURRENT = { checkRules: () => [{ theme: 'project-layout', verdict: 'current' }] };
  const roleLine = (tool, role) => `node "${tool}" --check # ${role}\n`;
  const RULES = roleLine(join(HERE, 'project-rules', 'rules-cli.mjs'), 'rules-check');
  const LAYOUT = roleLine(join(HERE, 'source-size-check.mjs'), 'layout-check');
  const hook = (text) => (root) => writeFileSync(join(root, 'hooks', 'pre-commit'), text);
  const boom = (name) => () => { throw new Error(`${name} exploded`); };
  // The leaf's own dry run over the same tree: the checks it would arm, or null on its nothing-to-plan refusal.
  const leafChecks = (root, extra) => {
    try {
      const { roles } = need(gitHooks, 'planGitHooks')({ root, variant: 'hook-checks', gitHooksPath: () => join(root, 'hooks'), ...extra });
      return NAMES[roles.length === 2 ? 'both' : roles[0]];
    } catch (error) {
      if (error.exitCode !== 3 || !error.message.startsWith('nothing to plan')) throw error;
    }
    return null;
  };
  const rows = [
    { label: 'no docs/ai', seed: (root) => rmSync(join(root, 'docs', 'ai'), { recursive: true }), extra: CURRENT, want: null },
    { label: 'no hooks dir', extra: { ...CURRENT, gitHooksPath: () => null }, want: null },
    { label: 'both lines armed', seed: hook(MANAGED_GUARDLESS + RULES + LAYOUT), extra: CURRENT, want: null, leaf: true },
    { label: 'layout armed, rules not current', seed: hook(MANAGED_GUARDLESS + LAYOUT), want: null, leaf: true },
    { label: 'the tree on disk past its band, rules not current: the layout line waits for the record', piles: 25, want: NAMES.layout, wait: true },
    { label: 'layout armable on disk, hook absent', want: NAMES.layout, leaf: true },
    { label: 'both armable', extra: CURRENT, want: NAMES.both, leaf: true },
    { label: 'rules line on another path', seed: hook(MANAGED_GUARDLESS + roleLine('/elsewhere/rules-cli.mjs', 'rules-check') + LAYOUT), want: NAMES.rules, leaf: true },
    { label: 'unmanaged hook', seed: hook(FOREIGN_HOOK), skip: () => 'an UNMANAGED pre-commit hook exists — the installer never overwrites it; adding the lines this item would arm to it is your own step' },
    { label: 'installer absent, enforcement admitted', installer: false, none: true, skip: () => COMMIT_GUARD_VIA_ITEM },
    { label: 'installer absent', installer: false, skip: () => COMMIT_GUARD_OWN_STEP },
    { label: 'rules answer throws', extra: { checkRules: boom('rules') }, skip: () => 'rules exploded' },
    { label: 'layout answer throws', extra: { readLayoutSetup: boom('layout') }, skip: () => 'layout exploded' },
    { label: 'unreadable hook', seed: (root) => mkdirSync(join(root, 'hooks', 'pre-commit')), skip: (root) => `${join(root, 'hooks', 'pre-commit')} is unreadable (EISDIR) — the pre-commit hook cannot be judged` },
  ];

  it('renders nothing, a stated skip or the optional harness item by each row, its layout answer the leaf\'s over the tree on disk', (t) => {
    for (const { label, seed, extra = {}, want, leaf, skip, piles, installer, none, wait = false } of rows) {
      const root = layoutRoot({ piles, installer, root: none ? makeNoneEvidenceProject() : makeProject() });
      t.after(() => rmSync(root, { recursive: true, force: true }));
      seed?.(root);
      const built = buildRecommendations({ cwd: root, deps: guardDeps(root, { env: gitPathEnv(root), ...extra }) });
      const items = built.items.filter((item) => item.key === 'hook-checks');
      assert.deepEqual(built.skips.filter((entry) => entry.key === 'hook-checks'), skip ? [{ key: 'hook-checks', reason: skip(root) }] : [], label);
      assert.equal(built.items.some((item) => item.variant === 'source-size.layout'), wait, label);
      if (leaf) assert.equal(leafChecks(root, extra), want, label);
      assert.deepEqual(items.map((item) => [item.severity, item.lane, item.what, item.detail]), want ? [[SEVERITY_OPTIONAL, 'harness', whatOf(want), wait ? 'the layout line follows the source-size.layout record — apply that item first; this item\'s check line then arms the layout line too' : null]] : [], label);
      if (!want) continue;
      assert.deepEqual({ check: items[0].check, apply: items[0].apply }, need(lanes, 'applySlot')('hook-checks', { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' }), label);
    }
  });

  it('the mode doc applies source-size.layout before the hook-checks check line, its hook-checks note carries the risk profile, and RISK_NOTED_KEYS holds hook-checks', () => {
    const note = (key) => readFileSync(join(KIT_ROOT, 'references', 'modes', 'recommendations.md'), 'utf8').split('\n').find((text) => text.startsWith(`- \`${key}\` — `)) ?? '';
    assert.ok(note('source-size').includes('`source-size.layout` is applied before the `hook-checks` check line runs, whose layout line follows that record.'));
    assert.match(note('hook-checks'), /Risk profile: \S/u);
    assert.ok(RISK_NOTED_KEYS.includes('hook-checks'));
  });

  it('a kit tools path holding $ renders the stated skip naming it (a copy of the kit, spawned)', (t) => {
    const [base, root] = [mkdtempSync(join(tmpdir(), 'rec-kit-$-')), makeProject()];
    t.after(() => [base, root].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    cpSync(KIT_ROOT, base, { recursive: true, filter: (src) => !/^[\\/](?:test|releases|stats)(?:[\\/]|$)|\.test(?:\.mjs)?$/u.test(src.slice(KIT_ROOT.length)) });
    const env = { ...hermeticGitEnv(process.env, base), CLAUDE_CONFIG_DIR: undefined };
    const run = spawnSync(process.execPath, [join(base, 'tools', 'recommendations.mjs'), '--cwd', root, '--json'], { encoding: 'utf8', env, maxBuffer: GIT_MAX_BUFFER });
    assert.deepEqual([run.error, run.signal, run.status], [undefined, null, 0], run.stderr);
    const { items, skips } = JSON.parse(run.stdout);
    assert.ok(!items.some((item) => item.key === 'hook-checks'));
    const prefix = `the kit's tools path ${join(base, 'tools')} carries ", $, a backtick, a backslash, CR or LF`;
    assert.deepEqual(skips.filter((entry) => entry.key === 'hook-checks').map((entry) => entry.reason.slice(0, prefix.length)), [prefix]);
  });

  it('a no to the record writes nothing and renders both again; a yes to both, the record first, arms the layout line and the next run renders neither', (t) => {
    const root = layoutRoot({ piles: 25 });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const [env, hooks] = [gitPathEnv(root), join(root, '.git', 'hooks')];
    const run = () => buildRecommendations({ cwd: root, deps: hermeticDeps(root, { env, gitHooksPath: () => hooks }) }).items
      .filter((item) => item.variant === 'source-size.layout' || item.key === 'hook-checks')
      .map((item) => (item.key === 'hook-checks' ? [item.variant, item.what, item.detail] : [item.variant]));
    const both = [['source-size.layout'], ['hook-checks', whatOf(NAMES.layout), 'the layout line follows the source-size.layout record — apply that item first; this item\'s check line then arms the layout line too']];
    assert.deepEqual(run(), both);
    assert.deepEqual(run(), both, 'a no: the next run renders both again');
    assert.deepEqual([existsSync(join(root, 'docs', 'ai', 'source-size.json')), existsSync(join(hooks, 'pre-commit'))], [false, false]);
    const record = spawnSync(process.execPath, [join(HERE, 'source-size-check.mjs'), '--write-baseline', '--reason', 'initial adoption', '--cwd', root], { encoding: 'utf8', env });
    assert.deepEqual([record.error, record.signal, record.status], [undefined, null, 0], record.stderr);
    const plan = need(gitHooks, 'planGitHooks')({ root, variant: 'hook-checks', gitHooksPath: () => hooks });
    const io = { env, spawn: (argv, options) => spawnSync(argv[0], argv.slice(1), { ...options, stdio: 'pipe' }), error: (message) => assert.fail(message) };
    assert.equal(need(gitHooks, 'applyGitHooks')(plan, io), 0);
    const state = need(recommendations, 'readPreCommitState')(root, { gitHooksPath: () => hooks });
    assert.deepEqual([state.state, state.layoutArmed, state.rulesArmed], ['managed', true, false]);
    assert.deepEqual(run(), []);
  });
});

const worktreesSlot = (root) => {
  const slot = need(lanes, 'applySlot')('worktrees-dir', { toolsDir: HERE, root: resolve(root) });
  if (slot == null) throw new Error('worktrees-dir check line is absent');
  return slot;
};

describe('recommendations — the worktrees-dir arming item', () => {
  it('quiet only when a trusted host signal confirms the resolved parent dir writable', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: () => true }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'worktrees-dir'));
    assert.ok(!skips.some((s) => s.key === 'worktrees-dir'));
  });

  it('worktrees-dir-apply-slot-is-the-harness-line-against-a-trusted-no: no ack lane', () => {
    const root = makeProject();
    const home = realpathSync(root);
    const dir = join(root, 'farm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: dir }));
    const probed = realpathSync(dir);
    const seen = [];
    const { items } = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { home, canWriteDir: (d) => { seen.push(d); return false; } }),
    });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'worktrees-dir');
    assert.ok(item, 'fires when host capability does not confirm the parent dir writable');
    assert.deepEqual(seen, [probed], 'the host signal sees the canonical existing configured parent');
    assert.ok(item.what.includes(probed), `the WHAT names the probed dir: ${item.what}`);
    const expected = worktreesSlot(root);
    assert.equal(item.variant, 'worktrees-dir');
    assert.equal(item.lane, 'harness');
    assert.deepEqual({ check: item.check, apply: item.apply }, expected);
    assert.equal(item.detail, null, 'the ack lane cannot converge against a trusted NO, so it is not offered');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.equal(item.benefit, BENEFITS['worktrees-dir']);
  });

  it('the probe shares provision canonical derivation: an ABSENT configured parentDir probes its nearest EXISTING ancestor', () => {
    const root = makeProject();
    const rootReal = realpathSync(root);
    const farm = join(root, 'farm');
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: join(farm, 'deep') }));
    const seenAbsent = [];
    buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: (d) => { seenAbsent.push(d); return true; } }) });
    assert.deepEqual(seenAbsent, [rootReal], 'absent farm/deep → the nearest existing ancestor is the project root');
    mkdirSync(farm, { recursive: true });
    const farmReal = realpathSync(farm);
    const seenPresent = [];
    buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: (d) => { seenPresent.push(d); return true; } }) });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(seenPresent, [farmReal], 'a created farm becomes the nearest existing ancestor');
  });

  it('a configured parentDir under a SYMLINK probes the realpathed ancestor (symlink escape resolved)', () => {
    const root = makeProject();
    const real = join(root, 'real-farm');
    mkdirSync(real, { recursive: true });
    const realReal = realpathSync(real);
    symlinkSync(real, join(root, 'link-farm'));
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: join(root, 'link-farm', 'absent') }));
    const seen = [];
    buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: (d) => { seen.push(d); return true; } }) });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(seen, [realReal]);
  });

  it('a malformed worktrees.json is a stated skip, never a guess', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), '{ nope');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: () => false }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'worktrees-dir'));
    assert.ok(skips.some((s) => s.key === 'worktrees-dir' && /malformed JSON/.test(s.reason)));
  });
});

describe('spec:init-project/S40 — the worktrees-dir item by the table', () => {
  it('the harness variant count is seventeen', () => assert.equal(Object.values(need(lanes, 'VARIANT_LANES')).filter((lane) => lane === 'harness').length, 17));
  const makeHarnessProject = () => {
    const root = makeProject();
    const dir = join(root, 'farm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: dir }));
    return { root, home: realpathSync(root), dir: realpathSync(dir) };
  };
  const collectWorktrees = (root, deps = hermeticDeps(root)) => {
    const { items, skips } = buildRecommendations({ cwd: root, deps });
    return {
      items: items.filter((item) => item.key === 'worktrees-dir'),
      skips: skips.filter((skip) => skip.key === 'worktrees-dir'),
    };
  };

  it('an ABSENT configured parent is named in the WHAT while the host probes its existing ancestor', () => {
    const root = makeProject();
    const home = realpathSync(root);
    const dir = join(home, 'farm', 'deep');
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: join(root, 'farm', 'deep') }));
    const seen = [];
    const { items, skips } = collectWorktrees(root, hermeticDeps(root, {
      home, canWriteDir: (path) => { seen.push(path); return undefined; },
    }));
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(seen, [home]);
    assert.deepEqual(skips, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].what, `write access to the worktrees parent dir ${dir} is not confirmed — provision may still stop`);
    assert.equal(items[0].variant, 'worktrees-dir');
    assert.equal(items[0].lane, 'harness');
    assert.equal(items[0].benefit, BENEFITS['worktrees-dir']);
  });

  it('the home, a parent holding it, and a symlinked home render the user step without check, recipe or ack', () => {
    const defaultRoot = makeProject();
    const equalRoot = makeProject();
    const equalHome = join(equalRoot, 'h');
    mkdirSync(equalHome);
    writeFileSync(join(equalRoot, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: equalHome }));
    const real = mkdtempSync(join(tmpdir(), 'recommendations-home-real-'));
    const linkedRoot = join(real, 'repo');
    mkdirSync(join(linkedRoot, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(linkedRoot, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(linkedRoot, 'package.json'), FIXTURE_PACKAGE_JSON);
    const linkedHome = `${real}-home-link`;
    symlinkSync(real, linkedHome);
    const fixtures = [
      { root: defaultRoot, home: defaultRoot, dir: realpathSync(dirname(defaultRoot)), cleanup: [defaultRoot] },
      { root: equalRoot, home: equalHome, dir: realpathSync(equalHome), cleanup: [equalRoot] },
      { root: linkedRoot, home: linkedHome, dir: realpathSync(real), cleanup: [linkedHome, real] },
    ];
    const observed = fixtures.map(({ root, home, dir, cleanup }) => {
      const result = collectWorktrees(root, hermeticDeps(root, { home }));
      for (const path of cleanup) rmSync(path, { recursive: true, force: true });
      return { root, dir, result };
    });
    for (const { root, dir, result } of observed) {
      assert.deepEqual(result.skips, []);
      assert.equal(result.items.length, 1);
      const item = result.items[0];
      assert.equal(item.variant, 'worktrees-dir.home', root);
      assert.equal(item.lane, 'user');
      assert.equal(item.severity, SEVERITY_OPTIONAL);
      assert.equal(item.what, `the worktrees parent dir ${dir} is the home or holds it — the kit grants no write surface there`);
      assert.equal(item.check, null);
      assert.equal(item.detail, null);
      assert.equal(item.apply, 'your own step — point docs/ai/worktrees.json parentDir at a dedicated directory, then run /agent-workflow-kit recommendations');
      assert.deepEqual({ check: item.check, apply: item.apply }, need(lanes, 'applySlot')('worktrees-dir.home', { toolsDir: HERE, root: resolve(root) }));
      assert.equal(item.benefit, BENEFITS['worktrees-dir']);
      const block = formatRecommendations(result);
      assert.doesNotMatch(block, /check:|recipe:|ack-write|worktreesDirAck/u);
    }
  });

  it('a regular-file parentDir is a stated skip instead of an item', () => {
    const root = makeProject();
    const dir = join(root, 'farm-file');
    writeFileSync(dir, 'not a directory\n');
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: dir }));
    const result = collectWorktrees(root, hermeticDeps(root, { home: realpathSync(root) }));
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(result.items, []);
    assert.equal(result.skips.length, 1);
    assert.match(result.skips[0].reason, /parentDir/u);
  });

  it('a trusted yes converges both the harness and home arms without a skip (preserved)', () => {
    const harness = makeHarnessProject();
    const homeRoot = makeProject();
    const observed = [harness, { root: homeRoot, home: homeRoot }].map(({ root, home }) => {
      const result = collectWorktrees(root, hermeticDeps(root, { home, canWriteDir: () => true }));
      rmSync(root, { recursive: true, force: true });
      return result;
    });
    assert.deepEqual(observed, [{ items: [], skips: [] }, { items: [], skips: [] }]);
  });

  it('declarations in either scope and the ack never converge home; a local declaration converges harness', () => {
    const observed = ['settings.json', 'settings.local.json', 'ack', 'harness-local'].map((lane) => {
      const root = lane === 'harness-local' ? makeHarnessProject().root : makeProject();
      const home = realpathSync(root);
      const dir = realpathSync(lane === 'harness-local' ? join(root, 'farm') : dirname(root));
      if (lane === 'ack') {
        writeFileSync(join(root, 'docs', 'ai', 'acks.json'), JSON.stringify({
          worktreesDirAck: recipeFingerprint({ hosts: [], dirs: [dir], home }),
        }));
      } else {
        mkdirSync(join(root, '.claude'), { recursive: true });
        writeFileSync(join(root, '.claude', lane === 'harness-local' ? 'settings.local.json' : lane), JSON.stringify({
          sandbox: { filesystem: { allowWrite: [dir] } },
        }));
      }
      const result = collectWorktrees(root, hermeticDeps(root, { home }));
      rmSync(root, { recursive: true, force: true });
      return { lane, result };
    });
    for (const { lane, result } of observed) {
      assert.deepEqual(result.skips, [], lane);
      assert.deepEqual(result.items.map(({ variant, lane }) => ({ variant, lane })),
        lane === 'harness-local' ? [] : [{ variant: 'worktrees-dir.home', lane: 'user' }], lane);
    }
  });

  it('neither arm renders HAND-APPLY with an absent host signal or a trusted no', () => {
    const observed = [false, undefined].flatMap((signal) => ['harness', 'home'].map((arm) => {
      const root = arm === 'harness' ? makeHarnessProject().root : makeProject();
      const result = collectWorktrees(root, hermeticDeps(root, { home: realpathSync(root), canWriteDir: () => signal }));
      rmSync(root, { recursive: true, force: true });
      return { arm, result };
    }));
    for (const { arm, result } of observed) {
      assert.deepEqual(result.skips, []);
      assert.equal(result.items.length, 1, arm);
      for (const line of formatRecommendations(result).split('\n')) assert.doesNotMatch(line, /HAND-APPLY/u, arm);
    }
  });

  it('a masked settings.local.json is absent and cannot converge the harness item', () => {
    const { root, home, dir } = makeHarnessProject();
    const rel = join('.claude', 'settings.local.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, rel), JSON.stringify({ sandbox: { filesystem: { allowWrite: [dir] } } }));
    const result = collectWorktrees(root, { ...maskingDeps(root, [rel]), home });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(result.skips, []);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].variant, 'worktrees-dir');
    assert.equal(result.items[0].lane, 'harness');
  });

  it('the CLI help names the worktrees-dir ack fallback without hand-apply-first advice', () => {
    const root = makeProject();
    const env = hermeticGitEnv(process.env, root);
    delete env.CLAUDE_CONFIG_DIR;
    const out = execFileSync(process.execPath, [join(HERE, 'recommendations.mjs'), '--help'], { encoding: 'utf8', env });
    rmSync(root, { recursive: true, force: true });
    assert.ok(out.includes('the worktrees-dir ack fallback'));
    assert.doesNotMatch(out, /hand-apply-first/u);
  });
});

// The item's ONLY convergence signal used to be deps.canWriteDir — injectable from tests, never
// supplied in production (main passes `deps: ctx.deps ?? {}`), so it fired forever even once its own
// advice had been applied. Convergence is now a DECLARATION confirmation (an allowWrite entry over
// the probed dir) plus a fingerprint ack for hosts ignoring the key; a host signal still overrides.
describe('recommendations — worktrees-dir convergence lanes (D7)', () => {
  const worktreesProject = (name) => {
    const root = makeProject();
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: dir }));
    return { root, home: realpathSync(root), probed: realpathSync(dir) };
  };
  const writeSettings = (root, data) => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(data));
  };
  const allowWrite = (entries) => ({ sandbox: { filesystem: { allowWrite: entries } } });
  const ackFor = (probed, home) => recipeFingerprint({ hosts: [], dirs: [probed], home });
  const writeAckStore = (root, value) =>
    writeFileSync(join(root, 'docs', 'ai', 'acks.json'), JSON.stringify({ worktreesDirAck: value }));
  const probeItem = (root, home, extra = {}) => {
    const r = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { home, ...extra }) });
    return {
      item: r.items.find((i) => i.key === 'worktrees-dir') ?? null,
      skip: r.skips.find((s) => s.key === 'worktrees-dir') ?? null,
    };
  };

  it('worktrees-dir-converges-on-declared-allowwrite: a declared entry covering the probed dir converges the item', () => {
    const { root, home, probed } = worktreesProject('farm');
    writeSettings(root, allowWrite([probed]));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'the declaration the item itself asks for converges it');
    assert.equal(skip, null, 'convergence is a plain fall-through, never a skip');
  });

  it('worktrees-dir-converges-on-declared-allowwrite: an ANCESTOR entry covers, a DESCENDANT entry does not', () => {
    const a = worktreesProject('farm');
    writeSettings(a.root, allowWrite([a.home]));
    const ancestor = probeItem(a.root, a.home);
    rmSync(a.root, { recursive: true, force: true });
    assert.equal(ancestor.item, null, 'granting an ancestor of the probed dir covers it');

    const b = worktreesProject('farm');
    writeSettings(b.root, allowWrite([join(b.probed, 'inner')]));
    const descendant = probeItem(b.root, b.home);
    rmSync(b.root, { recursive: true, force: true });
    assert.ok(descendant.item, 'granting a CHILD of the probed dir does not grant the parent');
  });

  it('sibling-prefix-does-not-cover: a declared entry that is only a string prefix never converges', () => {
    const { root, home, probed } = worktreesProject('farm');
    writeSettings(root, allowWrite([`${probed}house`]));
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'coverage is path-segment-aware, never a raw string prefix');
  });

  it('tilde-entries-resolve: a `~/…` declared entry resolves against home and converges', () => {
    const { root, home } = worktreesProject('farm');
    writeSettings(root, allowWrite(['~/farm']));
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a tilde entry is expanded against the resolved home before matching');
  });

  it('tilde-entries-resolve: a bare `~` entry covers everything under home', () => {
    const { root, home } = worktreesProject('farm');
    writeSettings(root, allowWrite(['~']));
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a bare tilde is the home dir itself');
  });

  it('converges-on-ack: a fingerprint ack in docs/ai/acks.json converges a managed host', () => {
    const { root, home, probed } = worktreesProject('farm');
    writeAckStore(root, ackFor(probed, home));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'the ack lane converges a host that ignores the settings key');
    assert.equal(skip, null);
  });

  it('ack-rebinds-when-the-dir-changes: an ack minted for the old dir never converges the new one', () => {
    const { root, home, probed } = worktreesProject('farm');
    writeAckStore(root, ackFor(probed, home));
    assert.equal(probeItem(root, home).item, null, 'the freshly-minted ack converges');

    const moved = join(root, 'other-farm');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'worktrees.json'), JSON.stringify({ parentDir: moved }));
    const after = probeItem(root, home);
    const movedReal = realpathSync(moved);
    rmSync(root, { recursive: true, force: true });
    assert.ok(after.item, 'a moved parent dir re-fires — the ack is bound to the dir, not to the item');
    assert.ok(after.item.what.includes(movedReal), 'the re-fired item names the NEW probed dir');
  });

  it('converges-on-ack: a stale or non-string ack value re-fires, never a silent convergence', () => {
    const stale = worktreesProject('farm');
    writeAckStore(stale.root, '0123456789abcdef');
    const staleResult = probeItem(stale.root, stale.home);
    rmSync(stale.root, { recursive: true, force: true });
    assert.ok(staleResult.item, 'a stale fingerprint is not a convergence');
    assert.equal(staleResult.skip, null, 'a stale ack is a plain re-fire, never a skip');

    const typed = worktreesProject('farm');
    writeAckStore(typed.root, 42);
    const typedResult = probeItem(typed.root, typed.home);
    rmSync(typed.root, { recursive: true, force: true });
    assert.ok(typedResult.item, 'a non-string ack value is tolerated on read and re-fires');
  });

  it('canwritedir-precedence-matrix: the host signal overrides both lanes; undefined defers to them', () => {
    const observed = [];
    for (const signal of ['true', 'false', 'undefined']) {
      for (const declared of [false, true]) {
        for (const acked of [false, true]) {
          const { root, home, probed } = worktreesProject('farm');
          if (declared) writeSettings(root, allowWrite([probed]));
          if (acked) writeAckStore(root, ackFor(probed, home));
          const extra = signal === 'undefined' ? {} : { canWriteDir: () => signal === 'true' };
          const { item } = probeItem(root, home, extra);
          rmSync(root, { recursive: true, force: true });
          const expected = signal === 'true' ? false : signal === 'false' ? true : !(declared || acked);
          observed.push({ signal, declared, acked, fired: item !== null, expected });
        }
      }
    }
    assert.equal(observed.length, 12, 'the full 3 × 2 × 2 grid is exercised');
    for (const c of observed) {
      assert.equal(c.fired, c.expected, `canWriteDir=${c.signal} declared=${c.declared} acked=${c.acked}`);
    }
  });

  it('malformed-settings-rides-the-stated-skip-lane: a malformed .claude/settings.json skips with a stated reason', () => {
    const { root, home } = worktreesProject('farm');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{ nope');
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a broken declaration store is never read as "not declared"');
    assert.ok(skip, 'it degrades to a stated skip line');
    assert.match(skip.reason, /settings\.json/, 'the reason names the offending file');
  });

  it('symlinked-ancestor-or-leaf-never-yields-an-offer: a symlinked ack store is a fail-closed skip', () => {
    const { root, home, probed } = worktreesProject('farm');
    const outside = join(root, 'outside-acks.json');
    writeFileSync(outside, JSON.stringify({ worktreesDirAck: ackFor(probed, home) }));
    symlinkSync(outside, join(root, 'docs', 'ai', 'acks.json'));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a symlinked leaf never yields an offer');
    assert.ok(skip, 'it is a fail-closed stated skip — never an ack read from outside the project');
  });

  // The consent-flow executes only the APPLY slot; a HAND-APPLY line is maintainer territory and a
  // recipe: detail is informational. So the runnable ack preview must BE the apply slot, and the
  // grant advice — which no protocol step executes — rides the detail, labeled as the first step.
  it('worktrees-dir-apply-slot-is-the-harness-line-when-the-ack-lane-is-open', () => {
    const { root, home } = worktreesProject('farm');
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'no declaration, no ack → the item fires');
    const expected = worktreesSlot(root);
    assert.equal(item.lane, 'harness');
    assert.deepEqual({ check: item.check, apply: item.apply }, expected);
  });

  it('worktrees-dir-recipe-is-the-ack-fallback-when-the-ack-lane-is-open', () => {
    const { root, home, probed } = worktreesProject('farm');
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'no declaration, no ack → the item fires');
    assert.ok(item.detail, 'the item carries a recipe: detail');
    const label = 'ack fallback, only on your word that this host ignores the settings key, instead of the grant: ';
    const preview = `node ${shellQuoteArg(join(HERE, 'ack-write.mjs'))} --lane worktrees-dir --fingerprint ${ackFor(probed, home)} --cwd ${shellQuoteArg(root)}`;
    assert.ok(item.detail.startsWith(label), 'the recipe opens with the ack fallback label');
    assert.equal(item.detail.slice(label.length), preview);
    assert.doesNotMatch(item.detail, /--apply/u);
    assert.doesNotMatch(item.detail, /[\r\n]/u, 'the detail stays one line');
  });

  it('symlinked-ancestor-or-leaf-never-yields-an-offer: a symlinked settings.json is a fail-closed skip', () => {
    const { root, home, probed } = worktreesProject('farm');
    const outside = join(root, 'outside-settings.json');
    writeFileSync(outside, JSON.stringify(allowWrite([probed])));
    mkdirSync(join(root, '.claude'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', 'settings.json'));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a symlinked declaration store never yields an offer');
    assert.ok(skip, 'a grant is never read THROUGH a link — the probe states a skip');
  });

  it('symlinked-ancestor-or-leaf-never-yields-an-offer: a symlinked .claude ancestor is a fail-closed skip', () => {
    const { root, home, probed } = worktreesProject('farm');
    const outsideDir = join(root, 'outside-claude');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'settings.json'), JSON.stringify(allowWrite([probed])));
    symlinkSync(outsideDir, join(root, '.claude'));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a symlinked ANCESTOR never yields an offer either');
    assert.ok(skip, 'the whole path chain is guarded, not just the leaf');
  });

  it('a NON-REGULAR settings target (a directory at the path) is a fail-closed skip, never a guess', () => {
    const { root, home } = worktreesProject('farm');
    mkdirSync(join(root, '.claude', 'settings.json'), { recursive: true });
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null);
    assert.ok(skip, 'a non-regular declaration store is a stated skip');
  });

  // A declaration that SUPPRESSES a recommendation is never partially trusted: one bad entry
  // invalidates the whole list rather than being filtered away beside a good one.
  const MALFORMED_ALLOWWRITE = /allowWrite must be an array of non-empty strings/;

  it('an EMPTY or whitespace-only allowWrite entry is never a grant of the project root', () => {
    const { root, home } = worktreesProject('farm');
    writeSettings(root, allowWrite(['', '   ']));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'a malformed declaration renders no offer');
    assert.ok(skip, 'it rides the stated-skip lane');
    assert.match(skip.reason, MALFORMED_ALLOWWRITE);
  });

  it('malformed-settings-rides-the-stated-skip-lane: a MIXED array never converges on its valid half', () => {
    const { root, home, probed } = worktreesProject('farm');
    writeSettings(root, allowWrite([probed, 42]));
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null, 'the valid entry does not rescue a malformed list');
    assert.ok(skip, 'one bad entry invalidates the whole declaration');
    assert.match(skip.reason, MALFORMED_ALLOWWRITE);
  });

  it('malformed-settings-rides-the-stated-skip-lane: a NON-ARRAY allowWrite is the same skip, never a silent ignore', () => {
    const { root, home } = worktreesProject('farm');
    writeSettings(root, { sandbox: { filesystem: { allowWrite: 'everything' } } });
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.equal(item, null);
    assert.ok(skip);
    assert.match(skip.reason, MALFORMED_ALLOWWRITE);
  });

  it('an ABSENT allowWrite is nothing declared, never a malformed declaration', () => {
    const { root, home } = worktreesProject('farm');
    writeSettings(root, { sandbox: { filesystem: {} } });
    const { item, skip } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'nothing declared → the item still fires');
    assert.equal(skip, null, 'an absent key is not a shape violation');
  });

  it('json-contract-additive-only: the --json contract keeps its exact top-level and item keys', () => {
    const { root, home } = worktreesProject('farm');
    const r = main(['--cwd', root, '--json'], { deps: hermeticDeps(root, { home }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['items', 'root', 'skips'], 'the top-level shape is unchanged');
    const item = parsed.items.find((i) => i.key === 'worktrees-dir');
    assert.ok(item, 'the item is present in the JSON render');
    assert.equal(item.variant, 'worktrees-dir', 'a base arm reports the item key as its variant');
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

describe('recommendations — the cheap-agents offer (OPT-IN-SHIPS-INVISIBLE)', () => {
  it('a project with no placed subagents is OFFERED them', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.ok(item, 'a shipped opt-in capability must never be invisible');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.match(item.what, /\d+ bundled subagent vehicle\(s\) not placed .* \d+ read-only, \d+ the full-tool executor/u, 'the WHAT counts the read-only vehicles and the executor apart');
    assert.match(item.benefit, /no shell on a read-only vehicle/u, 'the benefit scopes the no-shell property to the read-only vehicles');
    assert.ok(!skips.some((s) => s.key === 'agents'));
  });

  it('the WHAT keeps the preview semantics', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.match(item.what, /PREVIEWS/u, 'and the two-step semantics are stated in the WHAT');
  });

  // `.claude/agents/` is a Claude Code surface — the saving is not universal, and claiming it
  // unconditionally would overstate the benefit on any other harness.
  it('the offer is scoped to Claude Code rather than claiming a universal saving', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.match(`${item.what} ${item.benefit}`, /Claude Code/u, 'the harness scope is stated, not assumed');
  });

  it('names the hidden-mode reconcile follow-up WITHOUT putting it on the apply line', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.ok(item.detail, 'the follow-up is stated');
    assert.match(item.detail, /hide-footprint\.mjs/u);
    assert.match(item.detail, /--reconcile/u);
    assert.match(item.detail, /hidden-mode/u, 'and it is scoped to the deployments it applies to');
    assert.doesNotMatch(item.apply, /hide-footprint/u, 'the follow-up stays off the apply line');
    assert.equal(item.detail, `hidden-mode deployments only: after the --apply the preview prints, run node ${join(HERE, 'hide-footprint.mjs')} --dir ${root} --reconcile so the placed .claude/agents/ stays invisible to git status`);
  });

  // `already-current` is convergence: every kit agent file carrying the body the kit writes for it
  // renders no agents item, neither the offer nor agents.not-current.
  it('a project whose subagents are all placed gets NO offer (converged)', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    for (const name of readdirSync(join(HERE, '..', 'references', 'agents')).filter((f) => f.endsWith('.md'))) {
      writeFileSync(join(root, '.claude', 'agents', name), readFileSync(join(HERE, '..', 'references', 'agents', name), 'utf8'));
    }
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'agents'), 'already placed — do not nag');
  });

  it('a project below the expected lineage becomes a stated skip, never a crash or a doomed apply', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '0.0.1\n');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'agents'), 'no offer whose apply would refuse');
    const skip = skips.find((s) => s.key === 'agents');
    assert.ok(skip, 'the check that could not run says so');
    assert.match(skip.reason, /upgrade/u, 'and names the recovery');
  });

  it('an unreadable docs/ai/vehicles.json makes the offer a stated skip naming the settings file', () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'vehicles.json'), '{ not json');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'agents'), 'no offer whose apply would refuse');
    const skip = skips.find((s) => s.key === 'agents');
    assert.ok(skip, 'the check that could not run says so');
    assert.match(skip.reason, /docs\/ai\/vehicles\.json/u);
    assert.match(skip.reason, /\bunreadable\b/u);
  });
});

describe('spec:init-project/S48 — the advisor attribution, footprint-global and differing executor tables', () => {
  const collect = (root, key, extra = {}) => {
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { planGlobalRemoval: () => null, ...extra }) });
    return { items: built.items.filter((item) => item.key === key), skips: built.skips.filter((skip) => skip.key === key) };
  };
  const assertHarnessItem = async (root, built, variant, severity, lane = 'harness') => {
    assert.equal(built.items.length, 1);
    assert.deepEqual(built.skips, []);
    const [item] = built.items;
    assert.equal(item.variant, variant);
    assert.equal(item.severity, severity);
    assert.equal(item.lane, lane);
    const slot = need(lanes, 'applySlot')(variant, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' });
    assert.deepEqual({ check: item.check, apply: item.apply }, slot);
    assert.equal(item.benefit, BENEFITS[variant]);
    assert.ok(item.what.length <= ITEM_LINE_CAP);
    assert.ok(item.benefit.length <= ITEM_LINE_CAP);
    const rendered = formatRecommendations(built);
    assert.ok(rendered.split('\n').includes(`   check: ${slot.check}`));
    assert.ok(rendered.split('\n').includes(`   apply: ${slot.apply}`));
    assert.doesNotMatch(rendered, /HAND-APPLY/u);
    return item;
  };
  const attributionRows = [
    ['off, no settings', 'off', null, null, 'item'],
    ['off, project includeCoAuthoredBy true', 'off', { includeCoAuthoredBy: true }, null, 'item'],
    ['off, project commit text', 'off', { attribution: { commit: 'credit' } }, null, 'item'],
    ['local includeCoAuthoredBy true', 'off', null, { includeCoAuthoredBy: true }, /\bincludeCoAuthoredBy\b/u],
    ['local commit text', 'off', null, { attribution: { commit: 'credit' } }, /\battribution\b/u],
    ['local wrong attribution type', 'off', null, { attribution: 'wrong' }, /\battribution\b/u],
    ['local wrong includeCoAuthoredBy type', 'off', null, { includeCoAuthoredBy: 'wrong' }, /\bincludeCoAuthoredBy\b/u],
    ['off, auto mode', 'off', { permissions: { defaultMode: 'auto' } }, null, /\bunsafe or unknown permissions\.defaultMode\b/u],
    ['off, hidden object', 'off', { attribution: { commit: '', pr: '', sessionUrl: false } }, null, 'silent'],
    ['off, attribution false', 'off', { attribution: false }, null, 'silent'],
    ['off, includeCoAuthoredBy false alone', 'off', { includeCoAuthoredBy: false }, null, 'silent'],
    ['on', 'on', null, null, 'silent'],
    ['on, auto mode', 'on', { permissions: { defaultMode: 'auto' } }, null, 'silent'],
    ['absent block', '', null, null, 'silent'],
    ['absent AGENTS.md', null, null, null, 'silent'],
  ];
  for (const [label, choice, project, local, expected] of attributionRows) {
    it(`attribution: ${label}`, async (t) => {
      const root = makeProject();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      if (choice !== null) writeFileSync(join(root, 'AGENTS.md'), choice ? `> **Agent attribution: ${choice}** (chosen at setup).\n` : '# Project\n');
      mkdirSync(join(root, '.claude'));
      for (const [file, data] of [['settings.json', project], ['settings.local.json', local]]) {
        if (data !== null) writeFileSync(join(root, '.claude', file), JSON.stringify(data));
      }
      const built = collect(root, 'attribution');
      if (expected === 'item') {
        const item = await assertHarnessItem(root, built, 'attribution', SEVERITY_ATTENTION);
        assert.equal(item.what, WHATS.attribution);
      } else {
        assert.deepEqual(built.items, []);
        if (expected === 'silent') assert.deepEqual(built.skips, []);
        else {
          assert.equal(built.skips.length, 1);
          assert.match(built.skips[0].reason, expected);
          if (local !== null) assert.match(built.skips[0].reason, /\.claude\/settings\.local\.json/u);
        }
      }
      assert.doesNotMatch(formatRecommendations(built), /HAND-APPLY/u);
      assert.equal(SEVERITIES.attribution, SEVERITY_ATTENTION);
    });
  }
  for (const outcome of ['plan', 'null', 'throw']) {
    it(`footprint-global: ${outcome}`, async (t) => {
      const root = makeProject();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const source = join(root, '.gitignore_global');
      const reason = `FOOTPRINT_STOP: cannot read ${source} (EACCES)`;
      const planGlobalRemoval = () => {
        if (outcome === 'throw') throw new Error(reason);
        return outcome === 'null' ? null : { source, before: '/scripts/check-docs-size.mjs\n', after: '', removedLines: ['/scripts/check-docs-size.mjs'] };
      };
      const built = collect(root, 'footprint-global', { planGlobalRemoval });
      if (outcome === 'plan') {
        const item = await assertHarnessItem(root, built, 'footprint-global', SEVERITY_OPTIONAL);
        assert.ok(item.what.includes(source));
      } else {
        assert.deepEqual(built.items, []);
        assert.equal(built.skips.length, outcome === 'throw' ? 1 : 0);
        if (outcome === 'throw') assert.match(built.skips[0].reason, /\bFOOTPRINT_STOP\b/u);
      }
      assert.doesNotMatch(formatRecommendations(built), /HAND-APPLY/u);
      assert.equal(SEVERITIES['footprint-global'], SEVERITY_OPTIONAL);
    });
  }
  // The agents key and the base executor-vehicle arm judged together (spec carriers, part agent-files): a differing
  // executor is a planned file of agents.not-current; a string names the item rendered, a pattern the agents key's skip.
  const KIT_TEXT = ['kit agent file(s) in .claude/agents/ not current — each is written with the body the kit writes for it, with no question', 'currency — each kit agent file carries the body the kit writes for it today, model and effort where docs/ai/vehicles.json names them'];
  const LINKED_LENS = /review-lens-opus-high\.md exists but is not a regular file/u;
  const executorRows = [
    ['customized, no slot', 'customized', false, ['kit']], ['customized, configured slot', 'customized', true, ['kit']],
    ['unusable, configured slot: the base arm yields', 'unusable', true, ['kit']], ['placed, configured slot, the component current', 'placed', true, []],
    ['missing, no slot', 'missing', false, ['offer']], ['missing, configured slot', 'missing', true, ['offer', 'base']],
    ['missing beside a placed vehicle, configured slot', 'missing-beside', true, ['kit']],
    ['symlinked agents, no slot', 'symlink', false, [/\.claude\/agents is a symlink/u]],
    ['symlinked executor, configured slot', 'executor-symlink', true, [/executor\.md exists but is not a regular file/u, 'base']],
    ['configured derived lens whose target is a symlink', 'lens-symlink', false, [LINKED_LENS]],
    ['linked configured derived lens beside a missing executor, configured slot', 'lens-symlink-missing', true, [LINKED_LENS, 'base']],
    ['stale stamp, differing executor', 'stale-differing', false, [/run \/agent-workflow-kit upgrade first/u]],
    ['stale stamp, current component', 'stale-current', false, []],
  ];
  for (const [label, state, configured, expected] of executorRows) {
    it(`executor-vehicle and agents: ${label}`, async (t) => {
      const root = makeProject();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const reader = await import('./cheap-agents-read.mjs');
      const { writeCheapAgents } = await import('./cheap-agents.mjs');
      const config = { routine: { carrier: configured ? 'subagent' : 'solo' } };
      if (state.startsWith('lens-symlink')) config['plan-execution'] = { review: ['review-lens:opus:high'] };
      writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(config));
      const dir = join(root, '.claude', 'agents');
      if (['placed', 'stale-current'].includes(state)) writeCheapAgents({ cwd: root, dryRun: false });
      if (state.startsWith('stale-')) writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.9.0\n');
      for (const path of state === 'symlink' ? [join(root, 'vehicles'), join(root, '.claude')] : [dir]) mkdirSync(path, { recursive: true });
      if (state === 'symlink') symlinkSync(join(root, 'vehicles'), dir);
      const current = reader.executorTemplate(reader.readExecutorPosture(root).posture).content;
      const body = state === 'unusable' ? '---\nname: executor\ntools: Read\n---\nbody\n' : `${current}\ncustom\n`;
      if (['customized', 'unusable', 'symlink', 'lens-symlink', 'stale-differing'].includes(state)) writeFileSync(join(dir, 'executor.md'), body);
      if (state === 'executor-symlink') symlinkSync(join(root, 'nowhere'), join(dir, 'executor.md'));
      if (state === 'missing-beside') writeFileSync(join(dir, 'gate-triage.md'), readFileSync(join(HERE, '..', 'references', 'agents', 'gate-triage.md')));
      if (state.startsWith('lens-symlink')) symlinkSync(join(root, 'docs', 'ai', 'orchestration.json'), join(dir, 'review-lens-opus-high.md'));
      const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { planGlobalRemoval: () => null }) });
      const [items, skips] = [built.items.filter((i) => ['agents', 'executor-vehicle'].includes(i.key)), built.skips.filter((s) => ['agents', 'executor-vehicle'].includes(s.key))];
      const variants = { kit: 'agents.not-current', offer: 'agents', base: 'executor-vehicle' };
      assert.deepEqual(items.map((i) => i.variant), expected.filter((e) => typeof e === 'string').map((e) => variants[e]), JSON.stringify(skips));
      const patterns = expected.filter((e) => e instanceof RegExp);
      assert.deepEqual(skips.map((s) => s.key), patterns.map(() => 'agents'));
      patterns.forEach((pattern, index) => assert.match(skips[index].reason, pattern));
      const kit = items.find((i) => i.variant === variants.kit);
      if (kit) {
        const planned = writeCheapAgents({ cwd: root, dryRun: true }).plan.filter((p) => ['place', 're-derive'].includes(p.action));
        const slot = need(lanes, 'applySlot')(variants.kit, { toolsDir: HERE, root, env: {}, home: root, platform: 'linux' });
        assert.deepEqual([kit.lane, kit.severity, kit.what, kit.benefit, kit.detail, kit.check, kit.apply], ['kit', SEVERITY_OPTIONAL, `${planned.length} ${KIT_TEXT[0]}`, KIT_TEXT[1], `writes: ${planned.map((p) => p.rel).join(', ')}`, slot.check, slot.apply]);
        assert.ok(planned.some((p) => p.rel === '.claude/agents/executor.md'), 'the executor is among the planned files');
      }
      const base = items.find((i) => i.variant === variants.base);
      if (base && patterns.length) assert.ok(base.detail.startsWith('precondition: ') && patterns[0].test(base.detail), base.detail);
      assert.doesNotMatch(formatRecommendations(built), /HAND-APPLY/u);
    });
  }
  it('the harness variant count is seventeen', () => assert.equal(Object.values(need(lanes, 'VARIANT_LANES')).filter((lane) => lane === 'harness').length, 17));
});

describe('spec:init-project/S54 the advisor arms by their tables', () => {
  const builtItems = [];
  const CHECKER = `node "${join(HERE, 'coverage-check.mjs')}" --check`;
  const SOURCE_SIZE = `node "${join(HERE, 'source-size-check.mjs')}" --check`;
  const SQUATTER_STEP = `your own step — in docs/ai/gates.json rename the "source-size" gate to an id of its own, or repoint its cmd at node "${join(HERE, 'source-size-check.mjs')}" --check, then run /agent-workflow-kit recommendations`;
  const NARROW = {
    counts: { assessable: 1, unsupported: 3, 'out-of-domain': 1, 'excluded-test': 0 },
    unsupportedExtensions: ['.ts'],
    verdict: CENSUS_VERDICT.NARROW,
    total: 5,
  };
  const gate = (id, cmd) => ({ id, title: id, cmd });
  const makeRoot = (t) => {
    const root = makeProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };
  const collect = (root, extra = {}) => {
    const deps = hermeticDeps(root, { platform: 'linux', planGlobalRemoval: () => null, ...extra });
    const built = buildRecommendations({ cwd: root, deps });
    builtItems.push(...built.items);
    return {
      ...built,
      env: deps.getenv,
      home: deps.jevHost?.home ?? deps.home,
      platform: deps.jevHost?.platform ?? deps.platform,
    };
  };
  const buildGates = (t, gates, { scripts, narrow = false } = {}) => {
    const root = makeRoot(t);
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates }));
    if (scripts !== undefined) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
    }
    return collect(root, narrow ? { takeCensus: () => NARROW } : {});
  };
  const buildUnfillable = (t) => [
    {
      built: buildGates(t, [gate('coverage-check', CHECKER), gate('lint', 'true')], { scripts: { test: 'node --test' } }),
      detail: CHECKER_NOT_LAST,
    },
    {
      built: buildGates(t, [gate('test', 'true'), gate('coverage-check', CHECKER)], { scripts: { test: 'node --test' } }),
      detail: PRODUCER_COLLISION,
    },
    {
      built: buildGates(t, [gate('lint', 'true'), gate('coverage-check', CHECKER)]),
      detail: NO_PRODUCER,
    },
  ];
  const buildUserFixtures = (t) => {
    const unfillable = buildUnfillable(t).map(({ built }) => built);
    const unrecognized = buildGates(t, [gate('lint', 'true'), gate('coverage-check', CHECKER)], { narrow: true });
    const squatter = buildGates(t, [{ id: 'source-size', title: 'S', cmd: 'true' }]);
    const root = makeRoot(t);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    return [...unfillable, unrecognized, squatter, collect(root)];
  };
  const buildDeclines = (t) => {
    const spec = collect(makeRoot(t));
    const connect = collect(makeRoot(t));
    const root = makeRoot(t);
    const home = mkdtempSync(join(tmpdir(), 's54-jev-home-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const getenv = { PATH: '/nonexistent-path-for-tests', TYPESAFE_API_KEY: 'a-test-key' };
    const skill = collect(root, { getenv, jevHost: { home } });
    const foreign = join(home, '.agents', 'skills', 'typesafe-ai');
    mkdirSync(foreign, { recursive: true });
    const decorated = collect(root, {
      getenv: { ...getenv, WSL_DISTRO_NAME: 'Fixture', CLAUDE_CONFIG_DIR: 'relative' },
      jevHost: { home },
    });
    return { spec, connect, skill, decorated, foreign };
  };
  const buildChatItems = async (t) => {
    const items = buildInventoryFixtures().flatMap((built) => built.items);
    builtItems.push(...items);
    const addBuilt = (built) => items.push(...built.items);
    addBuilt(collect(makeRoot(t)));
    addBuilt(buildGates(t, [gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)], { scripts: { test: 'node --test' } }));
    addBuilt(buildGates(t, [gate('review-state', `node "${join(HERE, 'review-state.mjs')}" --check`)]));
    addBuilt(buildGates(t, [gate('suite', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)], { narrow: true }));
    addBuilt(buildGates(t, [gate('source-size', SOURCE_SIZE)]));
    const draftsRoot = makeRoot(t);
    const specs = join(draftsRoot, 'docs', 'ai', 'specs');
    mkdirSync(specs);
    const drafts = {
      'index.md': ROOT_DOC(['- [a](./a.md)', '- [b](./b.md)']),
      'a.md': specDoc('a').replace('status: live', 'status: draft'),
      'b.md': specDoc('b').replace('status: live', 'status: draft'),
    };
    for (const [name, text] of Object.entries(drafts)) {
      writeFileSync(join(specs, name), text);
    }
    addBuilt(collect(draftsRoot));
    const vendoredRoot = makeRoot(t);
    runFixtureGit(vendoredRoot, ['init', '-q', '-b', 'main']);
    mkdirSync(join(vendoredRoot, 'src'));
    mkdirSync(join(vendoredRoot, 'vendor'));
    writeFileSync(join(vendoredRoot, 'src', 'a.mjs'), 'export const a = 1;\n');
    const copy = join(vendoredRoot, 'vendor', 'source-size-check.mjs');
    writeFileSync(copy, readFileSync(join(HERE, 'source-size-check.mjs')));
    const { SOURCE_SIZE_DEFAULTS } = await import('./source-size-core.mjs');
    writeFileSync(join(vendoredRoot, 'docs', 'ai', 'source-size.json'), JSON.stringify({
      _README: 'fixture',
      schema: 1,
      defaults: { ...SOURCE_SIZE_DEFAULTS },
      roots: ['src'],
      exclude: [],
      extensions: ['.mjs'],
    }));
    writeFileSync(join(vendoredRoot, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [gate('source-size', `node "${copy}" --check`)] }));
    runFixtureGit(vendoredRoot, ['add', '-A']);
    const sourceSize = await import('./source-size-check.mjs');
    const minted = sourceSize.main(['--write-baseline', '--reason', 'initial adoption', '--cwd', vendoredRoot]);
    assert.equal(minted.code, 0, minted.stdout + minted.stderr);
    runFixtureGit(vendoredRoot, ['add', '-A']);
    addBuilt(collect(vendoredRoot));
    const schema1Root = makeRoot(t);
    writeFileSync(join(schema1Root, 'docs', 'ai', 'source-size.json'), JSON.stringify({
      _README: 'fixture',
      schema: 1,
      defaults: { ...SOURCE_SIZE_DEFAULTS },
      roots: ['src'],
      exclude: [],
      extensions: ['.mjs'],
      baseline: {},
      aggregate: { src: { lines: 1, reason: 'fixture' } },
    }));
    addBuilt(collect(schema1Root));
    const pilesRoot = makeRoot(t);
    const fixture = 'fixture';
    writeFileSync(join(pilesRoot, 'docs', 'ai', 'source-size.json'), JSON.stringify({
      schema: 2, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: fixture } },
      layout: { roots: { src: { files: 30, reason: fixture } }, directories: { src: { entries: 30, reason: fixture } } },
    }));
    mkdirSync(join(pilesRoot, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(pilesRoot, 'docs', 'plans', 'queue.md'), '# Queue\n\n### Later\n');
    addBuilt(collect(pilesRoot));
    const { repoFactory, writeFence, stubs, line } = await import('./sandbox-masks-harness.test.mjs');
    const root = repoFactory('s54-mount', { 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` })();
    writeFence(root, '.zshrc');
    const readMountinfo = () => [
      line(1, 0, '8:1', '/', '/'),
      line(2, 1, '8:2', '/wt', root),
      line(3, 2, '0:40', '/tmp/empty', `${root}/.bashrc`),
      '',
    ].join('\n');
    addBuilt(collect(root, { ...stubs({ '.bashrc': 'file' }), readMountinfo }));
    const profile = makeProfileProject({ files: {
      'docs/ai/orchestration.json': '{}\n',
      'docs/ai/gates.json': '{"gates":[]}\n',
    } });
    addBuilt(collect(profile.root, { probes: [probeProfileGaps] }));
    return items;
  };

  it('1 — unfillable has the base attention severity and WHAT', () => {
    assert.equal(SEVERITIES['gates-inert.unfillable'], SEVERITY_ATTENTION);
    assert.equal(WHATS['gates-inert.unfillable'], WHATS['gates-inert']);
  });

  it('2 — the three unfillable declarations render their blocked recipe while a placeable producer keeps the chat preview', (t) => {
    const blocked = buildUnfillable(t);
    const fill = buildGates(t, [gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)], { scripts: { test: 'node --test' } });
    for (const { built, detail } of blocked) {
      const items = built.items.filter((item) => item.key === 'gates-inert');
      assert.equal(items.length, 1);
      const [item] = items;
      assert.equal(item.variant, 'gates-inert.unfillable');
      assert.equal(item.lane, 'user');
      assert.equal(item.check, null);
      assert.equal(item.apply, UNFILLABLE_STEP);
      assert.equal(item.detail, detail);
      assert.ok(formatRecommendations({ items, skips: [] }).split('\n').includes(`   recipe: ${detail}`));
    }
    const items = fill.items.filter((item) => item.key === 'gates-inert');
    assert.equal(items.length, 1);
    assert.equal(items[0].variant, 'gates-inert');
    assert.equal(items[0].lane, 'chat');
    assert.equal(items[0].apply, `node ${shellQuoteArg(join(HERE, 'gates-init.mjs'))} --cwd ${shellQuoteArg(fill.root)} --only test`);
  });

  it('3 — producer-unrecognized and the source-size id squatter render their user steps', (t) => {
    const unrecognized = buildGates(t, [gate('lint', 'true'), gate('coverage-check', CHECKER)], { narrow: true });
    const squatter = buildGates(t, [{ id: 'source-size', title: 'S', cmd: 'true' }]);
    const producerItems = unrecognized.items.filter((item) => item.key === 'gates-inert');
    const squatterItems = squatter.items.filter((item) => item.key === 'source-size');
    assert.equal(producerItems.length, 1);
    assert.equal(squatterItems.length, 1);
    assert.equal(producerItems[0].variant, 'gates-inert.producer-unrecognized');
    assert.equal(producerItems[0].lane, 'user');
    assert.equal(producerItems[0].apply, PRODUCER_UNRECOGNIZED_STEP);
    assert.equal(producerItems[0].detail, PRODUCER_UNRECOGNIZED_DETAIL);
    assert.equal(squatterItems[0].variant, 'source-size.id-squatter');
    assert.equal(squatterItems[0].lane, 'user');
    assert.equal(squatterItems[0].apply, SQUATTER_STEP);
    assert.equal(squatterItems[0].detail, null);
  });

  it('4 — the inventory legacy archive renders no ADR migration item', () => {
    const items = buildInventoryFixtures().flatMap((built) => built.items);
    builtItems.push(...items);
    assert.deepEqual(items.filter((item) => item.key === 'adr-store-migration' || /migrate-adr-store/u.test(item.apply)), []);
  });

  it('5 — decline recipes keep their ack lines and the Jev place, untouched and config-note prefixes', async (t) => {
    const { spec, connect, skill, decorated, foreign } = buildDeclines(t);
    const alternative = need(recommendations, 'DECLINE_ALTERNATIVE');
    const { SKILL_PINS } = await import('./jev-facts.mjs');
    const ack = (lane, fingerprint, root) => `node ${shellQuoteArg(join(HERE, 'ack-write.mjs'))} --lane ${lane} --fingerprint ${fingerprint} --cwd ${shellQuoteArg(root)}`;
    const connectFingerprint = recommendations.factFingerprint('jev-connect:declined');
    const skillFingerprint = recommendations.factFingerprint(`jev-skill:declined:${SKILL_PINS[0].tag}`);
    const rows = [
      [spec, 'spec-adoption', declineFingerprint(), ''],
      [connect, 'jev-connect', connectFingerprint, ''],
      [skill, 'jev-skill', skillFingerprint, ''],
      [decorated, 'jev-skill', skillFingerprint, `run the apply in the WSL distro Fixture terminal; left untouched: ${foreign} — holds no entry; CLAUDE_CONFIG_DIR is set to relative, not an absolute path: the Claude Code target is ${join(decorated.home, '.claude')}; `],
    ];
    for (const [built, key, fingerprint, prefix] of rows) {
      const item = built.items.find((entry) => entry.key === key);
      assert.ok(item, key);
      assert.equal(item.detail, prefix + alternative + ack(key, fingerprint, built.root));
      assert.doesNotMatch(item.detail, /HAND-APPLY/u);
    }
  });

  it('6 — an invalid recipe with a customized executor has exactly one stated skip and no executor item', (t) => {
    const root = makeRoot(t);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), '{ "routine": { "carrier": "bogus" } }');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'executor.md'), '---\nname: executor\ntools: Read, Bash\n---\nmine\n');
    const built = collect(root);
    const skips = built.skips.filter((skip) => skip.key === 'executor-vehicle');
    assert.equal(skips.length, 1, 'executor-vehicle speaks exactly once over the invalid carrier');
    assert.match(skips[0].reason, /bogus/u);
    assert.deepEqual(built.items.filter((item) => item.key === 'executor-vehicle'), []);
  });

  it('7 — every revision-11 user arm renders applySlot with no check line', (t) => {
    const variants = ['gates-inert.unfillable', 'gates-inert.producer-unrecognized', 'source-size.id-squatter', 'review-recipe'];
    const fixtures = buildUserFixtures(t);
    const selected = fixtures.flatMap((built) => built.items
      .filter((item) => variants.includes(item.variant))
      .map((item) => ({ item, built })));
    assert.deepEqual([...new Set(selected.map(({ item }) => item.variant))].sort(), [...variants].sort(), 'every revision-11 user variant renders');
    for (const { item, built } of selected) {
      const { root, env, home, platform } = built;
      assert.equal(item.lane, 'user', item.variant);
      assert.equal(item.apply, need(lanes, 'applySlot')(item.variant, { toolsDir: HERE, root, env, home, platform }).apply, item.variant);
      assert.equal(item.check, null, item.variant);
      assert.ok(!formatRecommendations({ items: [item], skips: [] }).split('\n').some((line) => line.startsWith('   check: ')), item.variant);
    }
  });

  it('8 — every chat variant renders exactly its table writers and the judge rejects missing, unrelated and wrong writers', async (t) => {
    const text = readFileSync(join(KIT_ROOT, 'references', 'advisor-writers.md'), 'utf8');
    const items = (await buildChatItems(t)).filter((item) => item.lane === 'chat');
    assert.ok(items.some((item) => item.variant === 'source-size.piles'), 'the piles fixture renders source-size.piles');
    const variants = Object.entries(need(lanes, 'VARIANT_LANES')).filter(([, lane]) => lane === 'chat').map(([variant]) => variant);
    assert.deepEqual([...new Set(items.map((item) => item.variant))].sort(), [...variants].sort(), 'rendered chat variants equal the lane registry');
    const readTable = (text) => {
      const lines = text.split('\n');
      const separator = lines.findIndex((line) => /^\|\s*---\s*\|\s*---\s*\|\s*---\s*\|\s*$/u.test(line));
      assert.ok(separator >= 0, 'the writer table has its three-column separator');
      return lines.slice(separator + 1)
        .filter((line) => /^\|.*\|$/u.test(line))
        .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
        .map(([variant, lane, writers]) => ({ variant, lane, writers: writers.split(', ') }));
    };
    const judgeChatWriters = (table, items) => {
      const mismatches = [];
      const rendered = new Map();
      for (const item of items) {
        const row = table.find((entry) => entry.variant === item.variant && entry.lane === 'chat');
        if (!row) {
          mismatches.push(`${item.variant}: missing chat row`);
          continue;
        }
        const paths = [...item.apply.matchAll(/\bnode\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/gu)];
        const writers = paths.map((match) => match[1] ?? match[2] ?? match[3]).map((path) => (path.startsWith(`${HERE}/`) ? path.slice(HERE.length + 1) : path));
        const modes = [...item.apply.matchAll(/\/agent-workflow-kit\s+([a-z-]+)/gu)].map((match) => match[1]);
        const named = [...writers, ...modes];
        const union = rendered.get(item.variant) ?? new Set();
        rendered.set(item.variant, union);
        for (const writer of named) {
          union.add(writer);
          if (!row.writers.includes(writer)) {
            mismatches.push(`${item.variant}: apply writer ${writer} is absent from its row`);
          }
        }
      }
      for (const row of table.filter((entry) => entry.lane === 'chat')) {
        const union = rendered.get(row.variant) ?? new Set();
        for (const writer of row.writers) {
          if (!union.has(writer)) {
            mismatches.push(`${row.variant}: row writer ${writer} never renders`);
          }
        }
      }
      return mismatches;
    };
    const table = readTable(text);
    assert.deepEqual(judgeChatWriters(table, items), []);
    const missing = table.map((row) => row.variant === 'profile-gap' ? { ...row, writers: row.writers.filter((writer) => writer !== 'tier-preview.mjs') } : row);
    const unrelated = table.map((row) => row.variant === 'gates-declaration' ? { ...row, writers: [...row.writers, 'ack-write.mjs'] } : row);
    const wrong = table.map((row) => row.variant === 'sandbox-masks' ? { ...row, writers: ['ensure-configs.mjs'] } : row);
    assert.ok(judgeChatWriters(missing, items).some((message) => message.includes('profile-gap: apply writer tier-preview.mjs')));
    assert.ok(judgeChatWriters(unrelated, items).some((message) => message.includes('gates-declaration: row writer ack-write.mjs')));
    assert.ok(judgeChatWriters(wrong, items).some((message) => message.includes('sandbox-masks: apply writer sandbox-masks.mjs')));
    assert.ok(judgeChatWriters(wrong, items).some((message) => message.includes('sandbox-masks: row writer ensure-configs.mjs')));
  });

  it('9 — no built item, inventory render or help line carries the retired marker', async (t) => {
    const help = main(['--help']);
    assert.equal(help.code, 0, help.stderr);
    for (const line of help.stdout.split('\n')) {
      assert.doesNotMatch(line, /HAND-APPLY/u, 'help carries no retired marker');
    }
    buildUserFixtures(t);
    buildDeclines(t);
    await buildChatItems(t);
    const inventory = buildInventoryFixtures().flatMap((built) => built.items);
    for (const item of [...builtItems, ...inventory]) {
      for (const line of formatRecommendations({ items: [item], skips: [] }).split('\n')) {
        assert.doesNotMatch(line, /HAND-APPLY/u, `${item.variant} carries no retired marker`);
      }
    }
  });
});

describe('the executor-vehicle recipe carries the precondition (AD-124 fold)', () => {
  const survey = (state, reason = null) => () => ({ state, reason, rel: '.claude/agents/executor.md' });
  const configured = (root) => writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ routine: { carrier: 'subagent' } }));
  const itemOf = (root, extra) => buildRecommendations({ cwd: root, deps: hermeticDeps(root, extra) }).items.find((i) => i.key === 'executor-vehicle');

  it('an unreadable docs/ai/vehicles.json → the recipe precondition names the settings file before the hidden-mode detail', () => {
    const root = makeProject();
    configured(root);
    writeFileSync(join(root, 'docs', 'ai', 'vehicles.json'), '{ not json');
    const item = itemOf(root, {});
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'the subagent item is rendered');
    assert.match(item.detail, /^precondition: docs\/ai\/vehicles\.json: .* — fix that; hidden-mode deployments only:/u);
    assert.match(item.detail, /\bunreadable\b/u);
    assert.ok(formatRecommendations({ items: [item], skips: [] }).split('\n').includes(`   recipe: ${item.detail}`));
  });

  it('a stale deployment stamp → the upgrade precondition comes first, for a missing vehicle too', () => {
    const root = makeProject();
    configured(root);
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.9.0\n');
    const missing = itemOf(root, { surveyVehicle: survey('missing') });
    const unusable = itemOf(root, { surveyVehicle: survey('unusable', 'tools: Read is read-only') });
    rmSync(root, { recursive: true, force: true });
    for (const item of [missing, unusable]) {
      assert.ok(item.detail.startsWith(`precondition: run /agent-workflow-kit upgrade first (deployment stamp 2.9.0, expected ${EXPECTED_WORKFLOW_VERSION}); hidden-mode deployments only:`), item.detail);
    }
  });

  it('a missing vehicle beside a symlinked read-only vehicle → the writer\'s own refusal is a precondition', () => {
    const root = makeProject();
    configured(root);
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'agents', 'mechanical-sweep.md'));
    const item = itemOf(root, {});
    rmSync(root, { recursive: true, force: true });
    assert.match(item.detail, /^precondition: \[agent-workflow-kit\] \.claude\/agents\/mechanical-sweep\.md exists but is not a regular file — refusing to touch it — fix that; hidden-mode deployments only:/u);
  });

  it('an unusable vehicle whose reason IS the writer\'s refusal → named once', () => {
    const root = makeProject();
    configured(root);
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'agents', 'executor.md'));
    const item = itemOf(root, {});
    rmSync(root, { recursive: true, force: true });
    assert.match(item.detail, /^precondition: /u);
    assert.equal((item.detail.match(/executor\.md/gu) ?? []).length, 1, item.detail);
  });

  it('a current stamp and a missing vehicle → hidden-mode detail without a precondition', () => {
    const root = makeProject();
    configured(root);
    const item = itemOf(root, { surveyVehicle: survey('missing') });
    rmSync(root, { recursive: true, force: true });
    assert.equal(item.detail, `hidden-mode deployments only: after the apply, run node ${join(HERE, 'hide-footprint.mjs')} --dir ${root} --reconcile so the placed .claude/agents/ stays invisible to git status`);
  });
});

const PROFILE_GAP = 'profile-gap';
const PROFILE_GAP_BENEFIT = 'full flow — each difference from the reference profile is previewed by its own writer; a declined one returns only at a lineage step';
const [PLAN_SHAPE_GATE, PROJECT_RULES_GATE] = [['mine', 'plan-shape-cli.mjs', '--check --in-flight'], ['rules', 'project-rules/rules-cli.mjs', '--check']].map(([id, tool, tail]) => ({ id, title: 't', cmd: `node "${join(HERE, tool)}" ${tail}` }));
const QUEUE_SKIP = 'named-queue-row-seed: plans-not-directory';
const PROFILE_FILES = Object.freeze({
  gaps: { 'docs/ai/orchestration.json': '{}\n', 'docs/ai/gates.json': '{"gates":[]}\n' },
  undecidable: { 'docs/ai/orchestration.json': '{}\n', 'docs/ai/gates.json': '{"gates":[]}\n', 'docs/plans': 'not a directory' },
  present: { 'docs/ai/orchestration.json': JSON.stringify({ epic: { author: 'solo', review: 'solo' }, task: { author: 'solo', execute: 'solo' } }),
    'docs/ai/gates.json': JSON.stringify({ gates: [PLAN_SHAPE_GATE, PROJECT_RULES_GATE] }), 'docs/ai/epics': { kind: 'directory' }, 'docs/plans/queue.md': '# Queue\n' },
});
const profileRoot = (kind) => makeProfileProject({ files: PROFILE_FILES[kind] }).root;
const profileProbe = () => probeProfileGaps ?? (() => { throw new Error('probeProfileGaps is absent'); });
const screenOf = (root) => (composeProfileGapScreen ?? (() => { throw new Error('composeProfileGapScreen is absent'); }))({ root, deps: {} });
const aloneDeps = () => ({ probes: [profileProbe()] });
const expectedItem = ({ what, apply }) => ({ key: PROFILE_GAP, variant: PROFILE_GAP, severity: SEVERITY_OPTIONAL, lane: 'chat', what, benefit: PROFILE_GAP_BENEFIT, apply, detail: null });
const omitCheckField = (items) => items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'check')));
const numberedLines = (text) => text.split('\n').filter((line) => /^\d+\. /.test(line));

describe('recommendations — the profile-gap probe (spec:gap-screen/S7)', () => {
  it('runs last in PROBES', () => {
    const probes = readFileSync(join(HERE, 'recommendations.mjs'), 'utf8').match(/const PROBES = Object\.freeze\(\[([^\]]*)\]\)/)[1];
    assert.equal(probes.split(',').map((name) => name.trim()).filter(Boolean).at(-1), 'probeProfileGaps');
  });
  it('hands each gap to add and each skip reason to skip under the profile-gap key', () => {
    const root = profileRoot('undecidable');
    const calls = [];
    profileProbe()({ root, deps: {}, add: (...call) => calls.push(['add', ...call]), skip: (key, err) => calls.push(['skip', key, err.message]) });
    const { gaps } = screenOf(root);
    assert.deepEqual([gaps.length, calls], [3, [...gaps.map(({ what, apply }) => ['add', PROFILE_GAP, what, apply]), ['skip', PROFILE_GAP, QUEUE_SKIP]]]);
  });
  it('makes each gap an optional item with the registry benefit, the leaf what and apply and no detail', () => {
    const root = profileRoot('gaps');
    const { items, skips } = buildRecommendations({ cwd: root, deps: aloneDeps() });
    const expected = screenOf(root).gaps.map(expectedItem);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual([items.length, skips], [4, []]);
    assert.deepEqual(omitCheckField(items), expected);
  });
  it('turns a throw inside the probe into one profile-gap skip', () => {
    const throwing = Object.defineProperty(aloneDeps(), 'readFileSync', { enumerable: true, get: () => { throw new Error('injected getter failure'); } });
    const { items, skips } = buildRecommendations({ cwd: profileRoot('gaps'), deps: throwing });
    assert.deepEqual([items, skips], [[], [{ key: PROFILE_GAP, reason: 'injected getter failure' }]]);
  });
  it('carries the row in the registries', () => {
    assert.deepEqual(
      [SEVERITIES[PROFILE_GAP], WHATS[PROFILE_GAP], BENEFITS[PROFILE_GAP], RISK_NOTED_KEYS.includes(PROFILE_GAP), OPT_IN_CAPABILITIES.filter(({ advisorKey }) => advisorKey === PROFILE_GAP)],
      [SEVERITY_OPTIONAL, '{what}', PROFILE_GAP_BENEFIT, true, [{ id: 'full-flow-profile', mode: 'upgrade', advisorKey: PROFILE_GAP }]],
    );
  });
});

describe('recommendations — the rendered profile-gap screen (spec:gap-screen/S8)', () => {
  const render = (kind, args = [], root = profileRoot(kind)) => ({ root, run: main(['--cwd', root, ...args], { deps: aloneDeps() }) });
  it('renders only profile gaps under the optional verdict line', () => {
    const { root, run } = render('gaps');
    assert.equal(run.stdout.split('\n')[2], composeVerdict({ attention: 0, optional: 4, skipped: 0 }));
    assert.deepEqual(numberedLines(run.stdout), screenOf(root).gaps.map(({ what }, index) => `${index + 1}. optional: ${what}`));
  });
  it('adds the skipped-item line for an undecidable entry and withholds flow optimal and nothing is broken', () => {
    const { stdout } = render('undecidable').run;
    assert.equal(stdout.split('\n')[2], composeVerdict({ attention: 0, optional: 3, skipped: 1 }));
    assert.ok(stdout.split('\n').includes(`  ⚠ skipped item profile-gap — probe failed: ${QUEUE_SKIP}`));
    assert.ok(!stdout.includes(VERDICT_NOTHING_BROKEN) && !stdout.includes(RECOMMENDATIONS_EMPTY_LINE));
  });
  it('renders the empty-state line alone when every entry is present', () => {
    assert.equal(render('present').run.stdout, `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });
  it('carries the items and the skips as --json data', () => {
    const { root, run } = render('undecidable', ['--json']);
    const { items, skips } = JSON.parse(run.stdout);
    const expected = screenOf(root).gaps.map(expectedItem);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual([omitCheckField(items), skips], [expected, [{ key: PROFILE_GAP, reason: QUEUE_SKIP }]]);
  });
  it('renders the profile gaps after every attention item, last in probe order, in the full chain', () => {
    const { root } = makeProfileProject({ files: { ...PROFILE_FILES.gaps, 'docs/ai/gates.json': JSON.stringify({ gates: [PLAN_SHAPE_GATE, PROJECT_RULES_GATE] }) } });
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    const first = items.findIndex(({ key }) => key === PROFILE_GAP);
    assert.ok(items.some(({ severity }) => severity === SEVERITY_ATTENTION), 'the fixture fires an attention item');
    assert.ok(first > 0 && items.slice(first).every(({ key }) => key === PROFILE_GAP), 'the profile gaps close the probe order');
    const numbered = numberedLines(formatRecommendations({ items, skips }));
    assert.deepEqual(numbered.slice(-3), screenOf(root).gaps.map(({ what }, index) => `${numbered.length - 2 + index}. optional: ${what}`));
  });
});
