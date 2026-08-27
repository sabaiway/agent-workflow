// recommendations.test.mjs — the read-only upgrade Recommendations advisor (AD-044 Plan 4 +
// REC-UX-REWORK/AD-053). Pins: the verdict-first D1 state matrix over the frozen severity registry,
// the D2 shape gate (one-line char-capped registry strings, banned tokens, the add() runtime
// backstop, capped skip reasons), the present-even-when-empty section contract, --cwd explicitness
// (subdir-proof), cwd-independent apply one-liners, the fact-true frozen benefit registry (bridge
// tier claims velocity ONLY; the dual security wording rides only the real-security-delta items;
// posture/risk prose lives in the mode-doc notes at the consent moment, never inline in registry
// strings, D3), the sandbox-lane fingerprint-ack convergence (D4/D6), honest probe degradation (a
// failed probe = a stated skipped-item line, never a crash or a fabricated item), read-only nature.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
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
  ACKS_FILE,
  ACKS_LANE_KEY,
  LANES_FILE,
  SANDBOX_LANE_ACK_PARENT,
  SANDBOX_LANE_ACK_KEY,
  RISK_NOTED_KEYS,
  probeAdrStore,
} from './recommendations.mjs';
// The producer body is READ from the shared vocabulary leaf, never re-typed: the inert-declaration
// item decides through that predicate, so a fixture spelling its own body would drift off it.
import { COVERAGE_PRODUCER_BODY } from './coverage-producer.mjs';
// The inert item's cause-A apply is a PREVIEW of this fill, so its non-vacuity is the fill's own
// consented apply run against the rendered selection — the real writer, never a re-implementation.
import { applyFill } from './gates-init.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
// The registration fixtures are built from the LEAF's own constants and derived rules — a fixture
// spelling its own server path or allow rules would drift off the thing the probe actually reads.
import { DEFAULT_SERVER_PATH, ENABLED_KEY, MCP_JSON_REL, SERVER_NAME, SETTINGS_REL, allowRulesFor } from './mcp-registration.mjs';
// The decline fact is the leaf's own derivation, and the store fixtures are the spec-check harness's
// document builders — a fixture spelling either here would drift off what the probe reads. Dynamic:
// the suite must LOAD against the pre-fix tree (no leaf, no probe export) so the red proof observes it.
const { declineFingerprint } = await import('./spec-adoption.mjs').catch(() => ({}));
const { probeSpecAdoption } = await import('./recommendations.mjs');
import { ROOT_DOC, specDoc } from './spec-check-harness.test.mjs';

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
  writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
  return root;
};

// A FINAL-run-capable declaration: both canonical core checks as quoted absolute paths to the
// kit's OWN tools (realpath-matched by run-gates), the coverage checker LAST.
const finalCapableGatesJson = () => JSON.stringify({
  gates: [
    { id: 'review-state', title: 'Review state', cmd: `node "${join(HERE, 'review-state.mjs')}" --check` },
    { id: 'coverage-check', title: 'Coverage', cmd: `node "${join(HERE, 'coverage-check.mjs')}" --check` },
  ],
});

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

describe('recommendations — section contract', () => {
  it('renders PRESENT-EVEN-WHEN-EMPTY with the exact empty-state line', () => {
    const out = formatRecommendations({ items: [], skips: [] });
    assert.equal(out, `${RECOMMENDATIONS_SECTION_HEADER}\n\n${RECOMMENDATIONS_EMPTY_LINE}`);
  });

  it('an item with a `detail` renders a `recipe:` line BETWEEN benefit and apply', () => {
    const out = formatRecommendations({ items: [{ key: 'sandbox-lane', severity: SEVERITY_OPTIONAL, what: 'w', benefit: 'b', apply: 'a', detail: 'egress hosts [h1, h2]' }], skips: [] });
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

  it('--help names the empty-state line, the hand-apply boundary, and the optional `recipe:` line', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(RECOMMENDATIONS_EMPTY_LINE));
    assert.match(r.stdout, /HAND-APPLY/);
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
    // Base keys == BENEFITS keys exactly; `<key>.<variant>` entries are allowed (a per-site arm
    // may carry its own class — e.g. `read-lane.stale`) and each names a real item key.
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

// ── the ADR-store crossing item ───────────────────────────────────────────────────
// This mode used to declare it had NO advisor capability, so `upgrade` ended with "flow optimal" for
// a project sitting on the retired layout. The probe reads the STRICT layout survey on purpose: the
// lenient one turns an unreadable tree into "nothing here", the one answer a failure must never give.

describe('recommendations — the ADR-store crossing offer', () => {
  // The probe reads the survey, so drive it through the survey's own dep shape: a tree whose files
  // are declared by the fixture. Simpler and truer than stubbing the survey itself.
  // A tree is declared as {suffix: contents}; a null value declares a DIRECTORY.
  const treeDeps = (files) => ({
    probes: [probeAdrStore],
    statPath: (p) => {
      const hit = Object.keys(files).find((k) => p.endsWith(k));
      if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[hit] === null ? 'dir' : 'file';
    },
    readFile: (p) => {
      const hit = Object.keys(files).find((k) => p.endsWith(k));
      if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[hit];
    },
  });
  const itemsFor = (files) => buildRecommendations({ cwd: HERE, deps: treeDeps(files) });

  const OLD_ROTATOR = "export const HOT_REL = 'docs/ai/decisions.md';\n";
  const NEW_ROTATOR = `${OLD_ROTATOR}export const ADR_DIR_REL = 'docs/ai/adr';\n`;

  it('fires on a legacy archive file still on disk', () => {
    const { items } = itemsFor({ 'docs/ai/history/decisions-archive.md': '' });
    assert.equal(items.length, 1);
    assert.equal(items[0].key, 'adr-store-migration');
    assert.match(items[0].what, /legacy archive file is still on disk/);
  });

  it('fires on a deployed rotation script that predates the store', () => {
    const { items } = itemsFor({ 'docs/ai/decisions.md': '', 'scripts/archive-decisions.mjs': OLD_ROTATOR });
    assert.equal(items.length, 1);
    assert.match(items[0].what, /predates the store/);
  });

  it('is SILENT once migrated', () => {
    const { items, skips } = itemsFor({ 'docs/ai/decisions.md': '', 'docs/ai/adr': null, 'scripts/archive-decisions.mjs': NEW_ROTATOR });
    assert.deepEqual([items.length, skips.length], [0, 0]);
  });

  it('is SILENT for a project whose NEW rotator already reds its own gate, and for one with no rotator', () => {
    assert.equal(itemsFor({ 'docs/ai/decisions.md': '', 'scripts/archive-decisions.mjs': NEW_ROTATOR }).items.length, 0);
    assert.equal(itemsFor({ 'docs/ai/decisions.md': '' }).items.length, 0);
  });

  it('an UNREADABLE layout becomes a stated skip — never silence, and the verdict withholds the optimality claim', () => {
    const { items, skips } = buildRecommendations({
      cwd: HERE,
      deps: { probes: [probeAdrStore], statPath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
    });
    assert.equal(items.length, 0);
    assert.equal(skips.length, 1, 'the failure is REPORTED, not swallowed into "nothing here"');
    assert.equal(skips[0].key, 'adr-store-migration');
    assert.match(formatRecommendations({ items, skips }), /NOT attested/, 'optimality is not claimed over a probe that could not run');
  });

  it('the apply lane is HAND-APPLY and previews — the consent flow never auto-runs a tree-mutating crossing', () => {
    const { items } = itemsFor({ 'docs/ai/history/decisions-archive.md': '' });
    assert.match(items[0].apply, /^HAND-APPLY: /);
    assert.match(items[0].apply, /fresh consent/);
    // The RUNNABLE half — everything before the prose that follows the em dash — must be the
    // preview. The mutation may only be NAMED in the prose, never handed over ready to run.
    const runnable = items[0].apply.split(' — ')[0];
    assert.match(runnable, /--dry-run/);
    assert.doesNotMatch(runnable, /--apply/, 'the runnable half is the PREVIEW, never the mutation');
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

  it('an absent store is ONE optional offer: the ensure applies it, the decline is a NAMED hand-apply alternative on the recipe line', () => {
    const { items, skips } = advise(makeProject());
    assert.deepEqual([items.length, skips.length], [1, 0]);
    // Both arms are OFFERS: the layer is opt-in, and the frozen registry reserves attention for a
    // configured declaration that is broken.
    assert.deepEqual([items[0].key, items[0].variant, items[0].severity], ['spec-adoption', 'spec-adoption', SEVERITY_OPTIONAL]);
    assert.deepEqual([SEVERITIES['spec-adoption'], SEVERITIES['spec-adoption.adopting']], [SEVERITY_OPTIONAL, SEVERITY_OPTIONAL]);
    assert.match(items[0].what, /feature-spec store absent \(docs\/ai\/specs\)/);
    assert.ok(items[0].apply.startsWith('node ') && items[0].apply.includes('ensure-configs.mjs'), items[0].apply);
    assert.ok(items[0].apply.includes('--reconcile --only specs --cwd '), items[0].apply);
    // The alternative is exclusive of the apply and is never run by the consent flow — the label says so.
    assert.ok(items[0].detail.startsWith('HAND-APPLY alternative (instead of the apply, never after it):'), items[0].detail);
    assert.ok(items[0].detail.includes('ack-write.mjs'), items[0].detail);
    assert.ok(items[0].detail.includes(`--lane spec-adoption --fingerprint ${declineFingerprint()}`), items[0].detail);
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

  it('a valid one-line item passes through unchanged (the backstop green arm)', () => {
    const { items, skips } = run(({ add }) => add('velocity-core', 'a one-line WHAT', 'node /x.mjs'));
    assert.equal(skips.length, 0);
    // `detail` is null for an item without a recipe line (only sandbox-lane carries one); `variant`
    // defaults to the item key, which is what a base arm reports as its machine-readable outcome.
    assert.deepEqual(items, [{ key: 'velocity-core', variant: 'velocity-core', severity: SEVERITIES['velocity-core'], what: 'a one-line WHAT', benefit: BENEFITS['velocity-core'], apply: 'node /x.mjs', detail: null }]);
  });

  it('the VARIANT identifier is the machine-readable outcome — a per-site arm reports its own, not the base key', () => {
    // The human render says which ITEM fired; only this field says which ARM did. A consumer asserting
    // an exact outcome (the pre-publish smoke) would else pattern-match prose the registry may reword.
    const { items } = run(({ add }) => add('read-lane', 'w', 'HAND-APPLY: x', 'read-lane.stale'));
    assert.equal(items[0].key, 'read-lane', 'the base key still names the item');
    assert.equal(items[0].variant, 'read-lane.stale', 'and the variant names the arm');
    assert.equal(items[0].severity, SEVERITIES['read-lane.stale'], 'severity still resolves through the variant');
  });

  it('a multi-line recipe detail is a stated shape violation (the backstop covers the recipe line too)', () => {
    const { items, skips } = run(({ add }) => add('sandbox-lane', 'a one-line WHAT', 'node /x.mjs', 'sandbox-lane', 'line1\nline2'));
    assert.equal(items.length, 0);
    assert.ok(skips.some((s) => /recipe detail is not a single line/u.test(s.reason)));
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
  // (2) placed-but-unseeded bridges: bridge-tier.
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
  writeFileSync(join(root6, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
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
  // (7) wired gate hook with the read-lane off: read-lane.
  const root7 = makeProject();
  mkdirSync(join(root7, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(root7, '.claude', 'hooks', 'agent-workflow-gates.mjs'), '// placed hook\n');
  writeFileSync(
    join(root7, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] }] } }),
  );
  results.push(buildRecommendations({ cwd: root7, deps: hermeticDeps(root7) }));
  rmSync(root7, { recursive: true, force: true });
  // (8) final-run-capable declaration, deployed installer, no hook yet: commit-guard.
  const root8 = makeProject();
  writeFileSync(join(root8, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
  mkdirSync(join(root8, 'scripts'), { recursive: true });
  writeFileSync(join(root8, 'scripts', 'install-git-hooks.mjs'), '// deployed installer stand-in\n');
  results.push(buildRecommendations({ cwd: root8, deps: hermeticDeps(root8, { gitHooksPath: () => join(root8, 'hooks') }) }));
  rmSync(root8, { recursive: true, force: true });
  // (9) an unwritable worktrees parent dir: worktrees-dir.
  const root9 = makeProject();
  results.push(buildRecommendations({ cwd: root9, deps: hermeticDeps(root9, { canWriteDir: () => false }) }));
  rmSync(root9, { recursive: true, force: true });
  // (10) a project still carrying a retired ADR archive file: adr-store-migration.
  const root10 = makeProject();
  mkdirSync(join(root10, 'docs', 'ai', 'history'), { recursive: true });
  writeFileSync(join(root10, 'docs', 'ai', 'history', 'decisions-archive.md'), '# retired archive\n');
  results.push(buildRecommendations({ cwd: root10, deps: hermeticDeps(root10) }));
  rmSync(root10, { recursive: true, force: true });
  // (11) a config naming the subagent carrier with no vehicle placed: executor-vehicle.
  const root11 = makeProject();
  writeFileSync(join(root11, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ routine: { carrier: 'subagent' } }));
  results.push(buildRecommendations({ cwd: root11, deps: hermeticDeps(root11) }));
  rmSync(root11, { recursive: true, force: true });
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

  // The advisor used to OFFER to arm AGY_REVIEW_ALLOW_ADDDIR ("large reviews — an oversized agy code
  // review offloads to a staging dir instead of refusing"). That lane is retired: headless agy
  // auto-denies its own read_file, so the offload could return a confident fabrication. The
  // withdrawal is a CHECKED registry deletion (advisor-coverage's orphan guard fails on an add() key
  // no capability claims, its set-equality on a declaration with no row) — never a silent one.
  it('a placed agy-review NEVER offers the retired add-dir knob, in any configuration', () => {
    const root = makeProject();
    mkdirSync(join(root, '.config', 'agent-workflow'), { recursive: true });
    const configurations = [
      hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }),
      hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: 'yes' } }),
      hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { AGY_REVIEW_ALLOW_ADDDIR: '' } }),
      hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review', getenv: { XDG_CONFIG_HOME: join(root, '.config') } }),
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
    // allowedDomains/allowWrite entry must never double as an acknowledgement.
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
    const freshFp = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: ['/opt/codex-home'], home: root });
    assert.ok(item.apply.includes(freshFp), 'the apply carries the CURRENT recipe fingerprint (which encodes the resolved override dir)');
    assert.ok(!item.apply.includes(staleFp), 'the stale fingerprint is gone — the recipe changed');
  });

  it('D6 resolution arms: unset → default; EMPTY ≡ unset; tilde/absolute as-given; relative anchors to --cwd', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['codex-review'] }, permissions: { allow: ['Bash(codex-review code:*)'] } }));
    // The apply is now the pure ack-write one-liner (Decisions 4); dir resolution is verified via the
    // FINGERPRINT it carries (the convergence-relevant value), not a literal dir in the command.
    const laneFingerprint = (getenv) => {
      const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'codex-review', getenv: { PATH: '/nonexistent-path-for-tests', ...getenv } });
      const { items } = buildRecommendations({ cwd: root, deps });
      const item = items.find((i) => i.key === 'sandbox-lane');
      assert.ok(item, 'the wired fixture fires the item');
      const m = item.apply.match(/--fingerprint ([0-9a-f]{16})/u);
      assert.ok(m, 'the apply carries a 16-hex fingerprint');
      return m[1];
    };
    const fpFor = (dir) => recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [dir], home: root });
    assert.equal(laneFingerprint({}), fpFor(CODEX_DIRS[0].default), 'env unset → the manifest default');
    assert.equal(laneFingerprint({ CODEX_HOME: '' }), fpFor(CODEX_DIRS[0].default), 'an EMPTY env value ≡ unset (the ${VAR:-default} form)');
    assert.equal(laneFingerprint({ CODEX_HOME: '~/.codex-alt' }), fpFor('~/.codex-alt'), 'a tilde-form override rides as-given');
    assert.equal(laneFingerprint({ CODEX_HOME: '/abs/codex-state' }), fpFor('/abs/codex-state'), 'an absolute override rides as-given');
    // The wrapper's case-arms treat ONLY `~`, `~/…` and `/…` as-given; every other form —
    // including `~user/state` — anchors like a relative path (a `~`-prefix heuristic would
    // misclassify `~user/…` as a home path the wrapper never resolves).
    assert.equal(laneFingerprint({ CODEX_HOME: '~user/state' }), fpFor(resolve(root, '~user/state')), 'a ~user/… form anchors like a relative path, never as a home path');
    // A RELATIVE env value anchors to the TARGET PROJECT ROOT (the pinned --cwd), never the
    // shell cwd — exercised with process.cwd() deliberately different from --cwd.
    const prev = process.cwd();
    process.chdir(join(root, 'docs'));
    try {
      const fp = laneFingerprint({ CODEX_HOME: 'state/codex' });
      assert.equal(fp, fpFor(resolve(root, 'state/codex')), 'a relative override anchors to the named root');
      assert.notEqual(fp, fpFor(resolve(join(root, 'docs'), 'state/codex')), 'never the shell cwd');
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

  it('the sandbox-lane item is a WRITER-class ack (the ack-write preview one-liner), fires only for WIRED wrappers', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }));
    const deps = hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' });
    const { items } = buildRecommendations({ cwd: root, deps });
    const item = items.find((i) => i.key === 'sandbox-lane');
    const expectedFp = recipeFingerprint({ hosts: AGY_HOSTS, dirs: [AGY_DIRS[0].default], home: root });
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'fires when a placed review wrapper is wired into excludedCommands');
    // The apply is now the ack writer's PREVIEW one-liner — a PURE executable command (Decisions 4):
    // absolute tool path, the CURRENT fingerprint, a pinned --cwd, NO trailing --apply (preview form).
    assert.equal(item.apply, `node ${join(HERE, 'ack-write.mjs')} --fingerprint ${expectedFp} --cwd ${root}`);
    // It relocates OFF the host settings schema: no hand-apply prose, no security-key mention, and
    // no `agentWorkflow.sandboxLaneAck` settings namespace anywhere in the command.
    assert.doesNotMatch(item.apply, /HAND-APPLY/u, 'no longer hand-apply — it joins the consent-gated writer class');
    assert.doesNotMatch(item.apply, /allowedDomains|allowWrite/u, 'the apply never asks the user to touch a security key');
    assert.doesNotMatch(item.apply, new RegExp(`${SANDBOX_LANE_ACK_PARENT}|settings\\.json`, 'u'), 'the ack no longer lives in the host settings namespace');
    // The absence of --apply proves ONLY that the apply is the PREVIEW form (per §3 it still runs only
    // AFTER confirmation, under the SAME consent). A no---apply MUTATION (family-freshness's
    // `npx … init`) is a DIFFERENT item; the direct --apply form is pinned by gate-hook's own test.
    assert.doesNotMatch(item.apply, /--apply/u, 'the sandbox-lane apply is the PREVIEW form (no --apply); it still runs only after confirmation');
    // The LIVE recipe rides a SEPARATE `recipe:` detail line — the apply stays a pure command; the
    // recipe: line is the fill source for the mode-doc lane-(2) hand-apply block.
    assert.ok(item.detail, 'the item carries a rendered recipe: detail line');
    for (const h of AGY_HOSTS) assert.ok(item.detail.includes(h), `the wired bridge's manifest host ${h} rides the recipe line`);
    assert.ok(item.detail.includes(AGY_DIRS[0].default), "the wired bridge's writable state dir rides the recipe line");
    for (const h of CODEX_HOSTS) assert.ok(!item.detail.includes(h), `un-wired bridge host ${h} must not ride the recipe`);
    assert.doesNotMatch(item.apply, /googleapis|\.goog/u, 'the recipe hosts do NOT ride the pure-command apply');
    // The wired-vs-unwired discrimination rides the FINGERPRINT: an un-wired codex host would change it.
    assert.notEqual(expectedFp, recipeFingerprint({ hosts: [...AGY_HOSTS, ...CODEX_HOSTS], dirs: [AGY_DIRS[0].default], home: root }), 'un-wired codex hosts do not ride the fingerprint');
  });

  // ── Part I (AD-055): the family-owned acks.json store + one legacy deprecation window ──────────
  // A two-surface wired agy fixture (no ack anywhere) — the shared starting point for the store tests.
  const wiredAgyProject = () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { excludedCommands: ['agy-review'] }, permissions: { allow: ['Bash(agy-review code:*)'] } }),
    );
    return root;
  };
  const agyFingerprint = (root) => recipeFingerprint({ hosts: AGY_HOSTS, dirs: [AGY_DIRS[0].default], home: root });
  const writeAcks = (root, value) => writeFileSync(join(root, ACKS_FILE), JSON.stringify({ [ACKS_LANE_KEY]: value }));

  it('acks.json-only convergence: the family-owned store silences the item with NO legacy key', () => {
    const root = wiredAgyProject();
    writeAcks(root, agyFingerprint(root));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'the acks.json ack converges the item');
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'a present, valid acks.json is not a skip');
  });

  it('acks.json CURRENT + a STALE legacy key → converges (the discriminating store-precedence case)', () => {
    const root = wiredAgyProject();
    const staleFp = recipeFingerprint({ hosts: CODEX_HOSTS, dirs: [CODEX_DIRS[0].default], home: root });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['agy-review'] },
        permissions: { allow: ['Bash(agy-review code:*)'] },
        [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: staleFp },
      }),
    );
    writeAcks(root, agyFingerprint(root));
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a fresh acks.json ack converges even beside a stale legacy key');
  });

  it('a STALE acks.json is IGNORED when a legacy key matches — either store may carry the live ack', () => {
    const root = wiredAgyProject();
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { excludedCommands: ['agy-review'] },
        permissions: { allow: ['Bash(agy-review code:*)'] },
        [SANDBOX_LANE_ACK_PARENT]: { [SANDBOX_LANE_ACK_KEY]: agyFingerprint(root) },
      }),
    );
    writeAcks(root, 'deadbeefdeadbeef');
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a live legacy key converges despite a stale acks.json');
  });

  it('an ABSENT acks.json (the normal not-yet-acked state) fires the item with ZERO skip lines', () => {
    const root = wiredAgyProject(); // makeProject creates docs/ai but no acks.json
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    // Also exercise the absent-PARENT-dir path — same ENOENT branch, no skip either.
    rmSync(join(root, 'docs', 'ai'), { recursive: true, force: true });
    const noDir = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.some((i) => i.key === 'sandbox-lane'), 'no ack anywhere → the item fires');
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'an absent acks.json is the normal state, never a skip');
    assert.ok(noDir.items.some((i) => i.key === 'sandbox-lane') && !noDir.skips.some((s) => s.key === 'sandbox-lane'), 'an absent docs/ai dir behaves identically');
  });

  it('a parse-error on an EXISTING acks.json is a stated skip — never a crash, never a silent converge', () => {
    const root = wiredAgyProject();
    writeFileSync(join(root, ACKS_FILE), '{ not valid json');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a malformed acks.json never fabricates an item');
    assert.ok(skips.some((s) => s.key === 'sandbox-lane'), 'a malformed EXISTING acks.json states a skip');
  });

  it('a valid-JSON NON-OBJECT root (e.g. []) is a fail-closed SKIP, never a silent converge', () => {
    // Branch D: readAcksLane throws on a non-object root — the probe catch states a skip (removing
    // the guard would flip a `[]` root from SKIP to a silent FIRE via undefined→null).
    const root = wiredAgyProject();
    writeFileSync(join(root, ACKS_FILE), '[]');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'a non-object root never fabricates an item');
    assert.ok(skips.some((s) => s.key === 'sandbox-lane'), 'a non-object acks.json root is a stated skip (fail-closed)');
  });

  it('a NON-STRING sandboxLaneAck value is tolerated → the item FIRES with ZERO skip (re-fires)', () => {
    // Branch E: readAcksLane returns null for a non-string value — the item re-fires, never a skip
    // (a regression throwing on non-string would silently flip re-fire→skip).
    const root = wiredAgyProject();
    writeFileSync(join(root, ACKS_FILE), JSON.stringify({ sandboxLaneAck: 123 }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.some((i) => i.key === 'sandbox-lane'), 'a non-string ack value is not a match → the item re-fires');
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'a non-string value is tolerated, never a skip');
  });

  it('a SYMLINKED or NON-REGULAR acks.json is a fail-closed SKIP — never read (no FIFO hang, no dangling-symlink misfire)', () => {
    // readAcksLane lstat-guards the target — a symlink (incl. dangling) or non-regular node is a
    // stated skip, never a not-yet-acked FIRE and never a blocking read.
    const root = wiredAgyProject();
    symlinkSync(join(root, 'nonexistent-ack-target'), join(root, ACKS_FILE)); // a DANGLING symlink
    const a = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    assert.ok(!a.items.some((i) => i.key === 'sandbox-lane'), 'a symlinked acks.json never fires the item');
    assert.ok(a.skips.some((s) => s.key === 'sandbox-lane'), 'a symlinked acks.json is a stated skip');
    rmSync(join(root, ACKS_FILE));
    mkdirSync(join(root, ACKS_FILE)); // a NON-REGULAR target (a dir where the file should be; a FIFO hits the same guard)
    const b = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!b.items.some((i) => i.key === 'sandbox-lane'), 'a non-regular acks.json never fires the item');
    assert.ok(b.skips.some((s) => s.key === 'sandbox-lane'), 'a non-regular acks.json is a stated skip');
  });

  it('a SYMLINKED ANCESTOR (docs/ai) is a fail-closed SKIP — the reader never reads an ack from OUTSIDE the project', () => {
    // readAcksLane guards the WHOLE path chain, not just the leaf. A symlinked docs/ai pointing at
    // an out-of-tree dir with a MATCHING ack must NOT silently converge (the writer refuses such a
    // deployment too) — without the ancestor guard the reader would follow it.
    const root = wiredAgyProject();
    const outside = mkdtempSync(join(tmpdir(), 'recommendations-outside-'));
    writeFileSync(join(outside, 'acks.json'), JSON.stringify({ sandboxLaneAck: agyFingerprint(root) }));
    rmSync(join(root, 'docs', 'ai'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'docs', 'ai'));
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.ok(skips.some((s) => s.key === 'sandbox-lane'), 'a symlinked docs/ai ancestor is a stated skip, never a silent out-of-project converge');
    assert.ok(!items.some((i) => i.key === 'sandbox-lane'), 'and the item does not render');
  });

  it('a STALE acks.json ALONE (no legacy key) RE-FIRES — a stale PRIMARY ack does not converge', () => {
    // The earlier stale-acks.json case rode ALONGSIDE a matching legacy ack; this pins that a stale
    // primary ack by itself does not converge (present, valid read → item fires, zero skip).
    const root = wiredAgyProject(); // settings.json carries NO legacy ack
    writeAcks(root, 'deadbeefdeadbeef');
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { findWrapper: (cmd) => cmd === 'agy-review' }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(items.some((i) => i.key === 'sandbox-lane'), 'a stale primary ack alone does not converge → the item re-fires');
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'a present-but-stale acks.json is a valid read, never a skip');
  });

  it('a FRESH advisor process converges from docs/ai/acks.json ALONE — both settings scopes lack the legacy key (restart-independence, acceptance 2)', () => {
    const root = wiredAgyProject();
    // A bin dir with an executable agy-review shim so the SUBPROCESS's real findOnPath sees it placed.
    const bin = join(root, 'fake-bin');
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'agy-review');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
    // HOME=root so the subprocess resolves the ~/.gemini default under the fixture home; PATH carries
    // only the shim dir; env is otherwise minimal so nothing outside the fixture leaks in.
    const spawn = () => execFileSync(process.execPath, [join(HERE, 'recommendations.mjs'), '--cwd', root], { encoding: 'utf8', env: { PATH: bin, HOME: root } });
    const withoutAck = spawn(); // control: no ack in ANY store → the item fires (wrapper detected as wired)
    writeAcks(root, agyFingerprint(root));
    const withAck = spawn();
    rmSync(root, { recursive: true, force: true });
    // The item's WHAT is the robust marker (the apply is now a bare ack-write command); "session-sandbox
    // recipe" renders only when the item FIRES, never on convergence.
    const MARKER = /session-sandbox recipe/u;
    assert.match(withoutAck, MARKER, 'control: with NO ack the item fires — the wrapper IS detected as wired');
    assert.doesNotMatch(withAck, MARKER, 'the family-owned acks.json alone converges the item in a fresh process — no settings-load dependence');
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
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
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

// This item exists because its ABSENCE fired: kit 3.14.0 shipped the state-block detector with a mode
// doc, a catalog row and a README row but NO advisor entry, so `upgrade` told a user who did not have
// it that «nothing is broken». Filed as OPT-IN-SHIPS-INVISIBLE.
describe('recommendations — the state-block-guard offer (AD-075)', () => {
  const stopWiring = (command) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  const flatStopWiring = (command) => JSON.stringify({ hooks: { Stop: [{ type: 'command', command }] } });

  it('a project with no Stop hook is OFFERED the detector, with a hand-apply pointing at the mode doc', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'state-block');
    assert.ok(item, 'a shipped opt-in capability must never be invisible');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.match(item.apply, /^HAND-APPLY: /u, 'there is no writer — the apply is an honest hand-edit pointer');
    assert.match(item.apply, /references\/modes\/state-block-guard\.md/u, 'and it names where the exact block lives');
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
    assert.ok(!items.some((i) => i.key === 'state-block'), 'a working wiring must never be nagged');
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
      assert.ok(!items.some((i) => i.key === 'state-block'), 'already watching — do not nag');
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
  // (default false) writes a STALE placeholder; true copies the real bundle (byte-current).
  const wiredHookProject = ({ lanes, hookCurrent = false } = {}) => {
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

  it('readLane: true + a STALE placed hook → ATTENTION with a delete-to-reseed recovery [B7]', () => {
    const root = wiredHookProject({ lanes: JSON.stringify({ readLane: true }), hookCurrent: false });
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'read-lane');
    assert.ok(item, 'a stale hook under an enabled lane fires the item (it is a silent no-op otherwise)');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.match(item.apply, /HAND-APPLY.*rm .*agent-workflow-gates\.mjs/);
    assert.match(item.apply, /gate-hook\.mjs --apply/);
  });

  it('a hook that VANISHES between the survey and the currency read renders the place recovery, never a reseed of nothing', () => {
    // The survey saw it placed; by the time the currency read runs it is gone. The stale arm's
    // recovery starts with `rm <that file>`, which would hand the reader a command whose first half
    // is a no-op and whose diagnosis is wrong — the file is not stale, it is absent.
    const root = wiredHookProject({ lanes: JSON.stringify({ readLane: true }), hookCurrent: false });
    const { items, skips } = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { readRegularFileNoFollow: () => ({ outcome: 'absent' }) }),
    });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'read-lane');
    assert.ok(item, 'a dark lane is still reported');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.match(item.what, /placed file is missing/, item.what);
    assert.match(item.apply, /gate-hook\.mjs --apply --cwd /, 'the recovery PLACES one');
    assert.doesNotMatch(item.apply, /^HAND-APPLY: rm /, 'never the reseed line, whose rm targets nothing');
    assert.ok(!skips.some((s) => s.key === 'read-lane'), 'and a race is answered, not degraded to a probe failure');
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

  it('a wired hook whose placed FILE is MISSING → ATTENTION place-first (never a silent dark lane) [R2-M2]', () => {
    const root = makeProject();
    mkdirSync(join(root, '.claude'), { recursive: true }); // settings wired, but NO .claude/hooks file placed
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_CMD }] }] } }),
    );
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'read-lane');
    assert.ok(item, 'a wired-but-missing hook fires the item (the lane is silently dark otherwise)');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.match(item.apply, /gate-hook\.mjs --apply/);
  });

  it('the stale reseed recovery names an ABSOLUTE rm path, never cwd-relative (council R2-M3)', () => {
    const root = wiredHookProject({ lanes: JSON.stringify({ readLane: true }), hookCurrent: false });
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    const item = items.find((i) => i.key === 'read-lane');
    rmSync(root, { recursive: true, force: true });
    assert.ok(item);
    assert.match(item.apply, /rm \/[^\s,]*\.claude\/hooks\/agent-workflow-gates\.mjs/);
    assert.doesNotMatch(item.apply, /rm \.claude\/hooks/);
  });
});

// ── the typed-channel registration offer ──────────────────────────────────────────
// The offer's shape is unusual on purpose and each property is pinned here: a registration is a
// command the MCP client will RUN, so the rendered apply is the mode's FLAGLESS preview and `--apply`
// stays a separate step taken after reading the entry. Two arms are HAND-APPLY (a differing entry, a
// sandbox-masked file); the arm that must NOT render is the unreadable file with a complete settings
// half.

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
  // Delegates to the REAL lstat for every other path, so masking `.mcp.json` cannot silently change
  // what any other probe in the same run sees.
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
  const build = (root, deps) => {
    const r = buildRecommendations({ cwd: root, deps: deps ?? hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return r;
  };

  it('unregistered → an OPTIONAL offer whose apply is the mode PREVIEW, with no --apply in the line', () => {
    const root = makeProject();
    const { items, skips } = build(root);
    const item = items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'a project with no registration gets the offer');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.equal(item.apply, `node ${join(HERE, 'mcp.mjs')} --cwd ${root}`, 'an absolute tool path and a pinned --cwd (cwd-independent)');
    assert.doesNotMatch(item.apply, /--apply/u, 'the offer is the PREVIEW — the entry is read before it is declared');
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

  it('a DIFFERING entry → ATTENTION and HAND-APPLY: the kit never repoints a declared server', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/elsewhere/mcp-server.mjs'] } } });
    const item = build(root).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'a differing entry is reported');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.match(item.apply, /^HAND-APPLY: /u, 'the remedy is the maintainer\'s edit, never a command the flow runs');
    assert.match(item.apply, /\.mcp\.json/u, 'and it names the file to edit');
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

  it('a MASKED .mcp.json with the settings half INCOMPLETE → HAND-APPLY (the kit cannot write through a device node)', () => {
    const root = makeProject();
    const item = build(root, maskingDeps(root)).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'something IS missing regardless of what the masked file says');
    assert.match(item.apply, /^HAND-APPLY: /u);
    assert.match(item.apply, /mcp\.mjs --cwd /u, 'the line still runs the mode — it prints the text to paste');
  });

  it('a MASKED .mcp.json with the settings half COMPLETE → a stated SKIP, never the offer again', () => {
    const root = mcpProject({ settings: registeredSettings });
    const { items, skips } = build(root, maskingDeps(root));
    assert.ok(!items.some((i) => i.key === 'mcp-channel'), 'a registration already made is not offered again');
    const skip = skips.find((s) => s.key === 'mcp-channel');
    assert.ok(skip, 'what cannot be observed is a stated skip — optimality is withheld, not claimed');
    assert.match(skip.reason, /mask/iu, 'the reason names the cause');
    // A skip that states an unknown and hands over nothing is honest but inert. The reason carries
    // the one action that resolves it — no new item, no new mechanism, and nothing that re-offers a
    // registration this project may well already have.
    assert.match(skip.reason, /outside the sandbox/iu, 'and it names the check that would settle it');
  });

  // The HAND-APPLY arm renders the mode's own preview, so it may only fire where that command can
  // actually run. The writer refuses a masked settings.json outright — offering it there would hand
  // the maintainer a command that exits 1, which is worse than saying nothing.
  it('fold: a masked settings.json is a SKIP — never a HAND-APPLY the writer would refuse', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: OUR_ENTRY } });
    const { items, skips } = build(root, maskingDeps(root, [SETTINGS_REL]));
    assert.ok(!items.some((i) => i.key === 'mcp-channel'), 'no offer for a path the mode refuses');
    assert.ok(skips.some((s) => s.key === 'mcp-channel'), 'a stated skip instead');
  });

  // An unreadable settings half says nothing about the .mcp.json half, which may be perfectly
  // observable AND wrong. Returning on the settings mask first hid a real attention-class state.
  it('fold: a DIFFERING entry is reported even when the settings half is masked', () => {
    const root = mcpProject({ servers: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/elsewhere/mcp-server.mjs'] } } });
    const item = build(root, maskingDeps(root, [SETTINGS_REL])).items.find((i) => i.key === 'mcp-channel');
    assert.ok(item, 'the .mcp.json half is fully observable, so its verdict stands on its own');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    assert.equal(item.variant, 'mcp-channel.differing');
    assert.match(item.apply, /^HAND-APPLY: /u);
    assert.doesNotMatch(item.apply, /mcp\.mjs --cwd/u, 'and it appends no preview the writer would refuse on this tree');
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

  it('fold: BOTH targets masked is a SKIP — completeness is unknowable from in here', () => {
    const root = makeProject();
    const { items, skips } = build(root, maskingDeps(root, [MCP_JSON_REL, SETTINGS_REL]));
    assert.ok(!items.some((i) => i.key === 'mcp-channel'));
    assert.ok(skips.some((s) => s.key === 'mcp-channel'));
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
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
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
    if (vehicle !== undefined) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'executor.md'), vehicle); }
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    return { ...built, root, found: built.items.filter((i) => i.key === 'executor-vehicle') };
  };
  it('configured + missing: exactly ONE attention item, counted, applied by the agents writer', () => {
    const { found, items, root } = run(JSON.stringify({ 'plan-execution': { execute: 'subagent' }, routine: { carrier: 'subagent' } }));
    assert.equal(found.length, 1, `one item, never one per slot: ${JSON.stringify(items.map((i) => i.key))}`);
    assert.equal(found[0].severity, SEVERITY_ATTENTION);
    assert.equal(found[0].what, '2 slot(s) configured subagent but the executor vehicle is missing — every such slot runs solo until it is usable');
    assert.equal(found[0].apply, `node ${join(HERE, 'cheap-agents.mjs')} --apply --cwd ${root}`);
    assert.match(found[0].detail, /hidden-mode deployments only:.*--reconcile/u, 'the reconcile rides the detail, never the apply');
  });
  it('configured + unusable: the survey reason rides the text', () => {
    const { found } = run(CARRIER, '---\nname: executor\ntools: Read\n---\nbody\n');
    assert.equal(found.length, 1);
    assert.equal(found[0].what, '1 slot(s) configured subagent but the executor vehicle is unusable: tools: Read is read-only — every such slot runs solo until it is usable');
  });
  it('placed, customized and no subagent slot: NOTHING — the rest of the list is untouched', () => {
    const placed = run(CARRIER, BUNDLED);
    const unconfigured = run(JSON.stringify({ routine: { carrier: 'solo' } }), BUNDLED);
    const cases = { placed, customized: run(CARRIER, '---\nname: executor\ntools: Read, Bash\n---\nmine\n'), unconfigured };
    for (const [label, r] of Object.entries(cases)) assert.deepEqual(r.found, [], `${label} raises no item`);
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
    // HAND-APPLY because this fixture offers NO producer — the project declares no scripts at all,
    // so there is nothing for the fill to place and the edit really is the maintainer's. The
    // rendered line must never look like something the consent flow can run.
    assert.ok(item.apply.startsWith('HAND-APPLY:'), `cause A is maintainer territory here: ${item.apply}`);
    assert.match(item.apply, /BEFORE coverage-check/);
    assert.match(item.apply, /no offerable producer exists here/);
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
    assert.ok(item.apply.startsWith('HAND-APPLY:'), `the only offerable producer collides on its id: ${item.apply}`);
  });

  it('cause A: a checker that is NOT last states THAT cause — never "no offerable producer" over a producer that exists', () => {
    // Two different situations reach the same HAND-APPLY branch, and they need different sentences:
    // here a producer is offerable AND already declared — what blocks the fill is the checker's
    // POSITION, which the fill may not change. Saying no producer exists would be plainly false.
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [gate('coverage-check', CHECKER), gate('lint', 'npm exec -- eslint .')],
    }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'a checker with nothing before it is inert whatever follows it');
    assert.ok(item.apply.startsWith('HAND-APPLY:'), item.apply);
    assert.doesNotMatch(item.apply, /no offerable producer/, `a producer IS offerable here: ${item.apply}`);
    assert.match(item.apply, /not the LAST/, `the real cause is the checker's position: ${item.apply}`);
  });

  it('cause A with an OFFERABLE producer and the checker LAST renders the fill preview, not HAND-APPLY', () => {
    const root = makeProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [gate('lint', 'npm exec -- eslint .'), gate('coverage-check', CHECKER)] }));
    const built = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = built.items.find((i) => i.key === 'gates-inert');
    assert.ok(item, 'the inert pair still fires — the offer does not fix anything by existing');
    assert.doesNotMatch(item.apply, /^HAND-APPLY/, `the fill can place the producer here: ${item.apply}`);
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
    assert.match(item.apply, /declare or MOVE a suite gate/, 'the remedy names the reorder, since the fill cannot do it');
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
    assert.match(item.apply, /a recognized body under another name/, `and the apply names the gap: ${item.apply}`);
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

describe('recommendations — the commit-guard item (the D10 consumer surface)', () => {
  // A final-run-capable project with the installer deployed and a fixture hooks dir (injected —
  // the probe never spawns git in these tests).
  const guardProject = () => {
    const root = makeProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), finalCapableGatesJson());
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'install-git-hooks.mjs'), '// deployed installer stand-in\n');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    return root;
  };
  const guardDeps = (root, extra = {}) => hermeticDeps(root, { gitHooksPath: () => join(root, 'hooks'), ...extra });
  const MANAGED_GUARDLESS = '#!/usr/bin/env bash\n# fixture:install-git-hooks.mjs\nset -e\nnode scripts/check.mjs\n';

  it('an ABSENT pre-commit hook under a final-capable declaration fires the consented installer one-liner', () => {
    const root = guardProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'commit-guard');
    assert.ok(item, 'an absent hook gets the offer too — the installer creates it armed');
    assert.match(item.apply, /^node .*install-git-hooks\.mjs --commit-guard /u);
    assert.ok(item.apply.endsWith(join(HERE, 'commit-guard.mjs')), `the apply names the kit's own resolved guard tool: ${item.apply}`);
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

  it('an UNMANAGED pre-commit hook is a stated skip (manual merge — never an overwrite offer)', () => {
    const root = guardProject();
    writeFileSync(join(root, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'commit-guard'));
    assert.ok(skips.some((s) => s.key === 'commit-guard' && /UNMANAGED.*by hand/u.test(s.reason)));
  });

  it('a declaration that is NOT final-run-capable gets NO offer and NO skip (an armed guard there would refuse every commit)', () => {
    const root = guardProject();
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit', title: 'T', cmd: 'node --test' }] }));
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'commit-guard'));
    assert.ok(!skips.some((s) => s.key === 'commit-guard'));
  });

  it('a final-capable declaration WITHOUT the deployed installer is a stated skip naming the recovery', () => {
    const root = guardProject();
    rmSync(join(root, 'scripts', 'install-git-hooks.mjs'));
    const { items, skips } = buildRecommendations({ cwd: root, deps: guardDeps(root) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'commit-guard'));
    assert.ok(skips.some((s) => s.key === 'commit-guard' && /install-git-hooks\.mjs.*upgrade/u.test(s.reason)));
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
    // --clear (Segment B).
    const root = mkdtempSync(join(tmpdir(), 'recommendations-stalereal-'));
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
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
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
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
    // could diagnose the WRONG project from a subdirectory (Segment B).
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
    const expectedFp = recipeFingerprint({ hosts: AGY_HOSTS, dirs: [AGY_DIRS[0].default], home: root });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!skips.some((s) => s.key === 'sandbox-lane'), 'ENOTDIR on a stray file must not skip the item');
    const item = items.find((i) => i.key === 'sandbox-lane');
    assert.ok(item, 'the item still renders from the real bridge manifests');
    // The recipe rides the FINGERPRINT (the apply is the pure ack-write one-liner); the stray file
    // did not thin it — the fingerprint still equals the full agy manifest recipe.
    assert.ok(item.apply.includes(expectedFp), 'the real agy manifest recipe still rides the fingerprint despite the stray file');
  });

  it('the direct CLI run renders the section and exits 0 (the spawn covers the emit tail)', () => {
    const root = makeProject();
    const out = execFileSync(process.execPath, [join(HERE, 'recommendations.mjs'), '--cwd', root], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.ok(out.startsWith(RECOMMENDATIONS_SECTION_HEADER));
  });
});

describe('recommendations — the worktrees-dir arming item', () => {
  it('quiet only when a trusted host signal confirms the resolved parent dir writable', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root, { canWriteDir: () => true }) });
    rmSync(root, { recursive: true, force: true });
    assert.ok(!items.some((i) => i.key === 'worktrees-dir'));
    assert.ok(!skips.some((s) => s.key === 'worktrees-dir'));
  });

  it('worktrees-dir-apply-slot-stays-hand-apply-against-a-trusted-no: the probed dir in the WHAT, no ack lane', () => {
    const root = makeProject();
    const probed = realpathSync(dirname(resolve(root)));
    const seen = [];
    const { items } = buildRecommendations({
      cwd: root,
      deps: hermeticDeps(root, { canWriteDir: (d) => { seen.push(d); return false; } }),
    });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'worktrees-dir');
    assert.ok(item, 'fires when host capability does not confirm the parent dir writable');
    assert.deepEqual(seen, [probed], 'the probed dir is the canonical existing ancestor of the default parent');
    assert.ok(item.what.includes(probed), `the WHAT names the probed dir: ${item.what}`);
    assert.match(item.apply, /^HAND-APPLY: add ".+" to sandbox\.filesystem\.allowWrite in \.claude\/settings\.json/);
    assert.ok(item.apply.includes(probed), 'the HAND-APPLY names the same probed dir');
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
  it('worktrees-dir-apply-slot-is-the-runnable-ack-preview-when-the-ack-lane-is-open', () => {
    const { root, home, probed } = worktreesProject('farm');
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'no declaration, no ack → the item fires');
    assert.match(item.apply, /^node /, 'the apply slot is a runnable one-liner, never maintainer territory');
    assert.match(item.apply, /ack-write\.mjs/, 'the apply names the consent-gated ack writer');
    assert.match(item.apply, /--lane worktrees-dir/, 'the apply pins the ack lane');
    assert.ok(item.apply.includes(ackFor(probed, home)), 'the apply carries the dir-bound fingerprint');
    assert.doesNotMatch(item.apply, /--apply/, 'the slot is the dry-run preview — it prints the exact --apply the flow then runs');
  });

  it('worktrees-dir-detail-carries-the-grant-advice-when-the-ack-lane-is-open', () => {
    const { root, home, probed } = worktreesProject('farm');
    const { item } = probeItem(root, home);
    rmSync(root, { recursive: true, force: true });
    assert.ok(item, 'no declaration, no ack → the item fires');
    assert.ok(item.detail, 'the item carries a recipe: detail');
    assert.match(item.detail, /^HAND-APPLY FIRST: /, 'the grant advice is labeled as the step to perform first');
    assert.ok(item.detail.includes(probed), 'the grant advice names the probed dir');
    assert.match(item.detail, /allowWrite/, 'the grant advice names the settings key');
    assert.match(item.detail, /terminal fallback/, 'the harness-managed fallback stays stated');
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
    assert.deepEqual(
      Object.keys(item).sort(),
      ['apply', 'benefit', 'detail', 'key', 'severity', 'variant', 'what'],
      'no item key renamed — the public contract stays additive (`variant` joined it, nothing moved)',
    );
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

// The cheap-agents offer. Unlike every other item here, this one was NOT found by an incident — the
// opt-in coverage registry surfaced it: `agents` is the family's second `.claude/` writer and the
// `help` Tune tail advertises it, yet the advisor had no entry, so a user who never ran `help` never
// learned it existed.
describe('recommendations — the cheap-agents offer (OPT-IN-SHIPS-INVISIBLE)', () => {
  it('a project with no placed subagents is OFFERED them, with a runnable consent-gated apply', () => {
    const root = makeProject();
    const { items, skips } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.ok(item, 'a shipped opt-in capability must never be invisible');
    assert.equal(item.severity, SEVERITY_OPTIONAL);
    assert.match(item.apply, /cheap-agents\.mjs/u, 'the apply runs the writer that owns the placement');
    assert.match(item.what, /\d+ bundled subagent vehicle\(s\) not placed .* \d+ read-only, \d+ the full-tool executor/u, 'the WHAT counts the read-only vehicles and the executor apart');
    assert.match(item.benefit, /no shell on a read-only vehicle/u, 'the benefit scopes the no-shell property to the read-only vehicles');
    assert.ok(!skips.some((s) => s.key === 'agents'));
  });

  // The writer's contract is «--dry-run first, ALWAYS» (references/modes/agents.md invariants), so the
  // rendered line must be the PREVIEW. Rendering --apply would skip the per-vehicle plan the user sees
  // BEFORE consenting — «already current» vs «customized, preserved» is what that plan discloses.
  it('renders the PREVIEW, never a bare --apply that would skip the mandated dry-run', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.doesNotMatch(item.apply, /--apply/u, 'the dry-run default must not be bypassed');
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

  // The apply PLACES; in a hidden-mode deployment the placed dir then needs the reconcile or it
  // surfaces in `git status` — and the item would already read as converged. The reconcile must NOT
  // ride the apply line (it is wrong to run on a visible deployment), so it rides the detail.
  it('names the hidden-mode reconcile follow-up WITHOUT putting it on the apply line', () => {
    const root = makeProject();
    const { items } = buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
    rmSync(root, { recursive: true, force: true });
    const item = items.find((i) => i.key === 'agents');
    assert.ok(item.detail, 'the follow-up is stated');
    assert.match(item.detail, /hide-footprint\.mjs/u);
    assert.match(item.detail, /--reconcile/u);
    assert.match(item.detail, /hidden-mode/u, 'and it is scoped to the deployments it applies to');
    assert.doesNotMatch(item.apply, /hide-footprint/u, 'the apply stays the placement command alone');
  });

  // `already-current` is convergence and `customized-preserved` is the user's own edit, which the
  // writer never clobbers — neither is a gap, and nagging about either would be a defect.
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

  // The writer refuses below the expected lineage, so rendering its command would hand the user a
  // guaranteed failure. The honest surface is a stated skip naming the recovery — never a crash.
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
});

describe('the executor-vehicle apply follows the actual cause (AD-124 fold)', () => {
  const survey = (state, reason = null) => () => ({ state, reason, rel: '.claude/agents/executor.md' });
  const configured = (root) => writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ routine: { carrier: 'subagent' } }));
  const itemOf = (root, extra) => buildRecommendations({ cwd: root, deps: hermeticDeps(root, extra) }).items.find((i) => i.key === 'executor-vehicle');

  it('unusable → the HAND-APPLY precondition quotes the survey reason, then the writer', () => {
    const root = makeProject();
    configured(root);
    const item = itemOf(root, { surveyVehicle: survey('unusable', '.claude/agents is a symlink — refusing to write through it') });
    rmSync(root, { recursive: true, force: true });
    assert.match(item.apply, /^HAND-APPLY: \.claude\/agents is a symlink — refusing to write through it — fix that, then run: node .*cheap-agents\.mjs --apply --cwd /u);
  });

  it('a stale deployment stamp → the upgrade precondition comes first, for a missing vehicle too', () => {
    const root = makeProject();
    configured(root);
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '2.9.0\n');
    const missing = itemOf(root, { surveyVehicle: survey('missing') });
    const unusable = itemOf(root, { surveyVehicle: survey('unusable', 'tools: Read is read-only') });
    rmSync(root, { recursive: true, force: true });
    assert.match(missing.apply, /^HAND-APPLY: run \/agent-workflow-kit upgrade first \(deployment stamp 2\.9\.0, expected 3\.0\.0\), then run: node /u);
    assert.match(unusable.apply, /^HAND-APPLY: run \/agent-workflow-kit upgrade first \(deployment stamp 2\.9\.0, expected 3\.0\.0\); tools: Read is read-only — fix that, then run: node /u);
  });

  it('a missing vehicle beside a symlinked read-only vehicle → the writer\'s own refusal is a precondition', () => {
    const root = makeProject();
    configured(root);
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'agents', 'mechanical-sweep.md'));
    const item = itemOf(root, {});
    rmSync(root, { recursive: true, force: true });
    assert.match(item.apply, /^HAND-APPLY: \[agent-workflow-kit\] \.claude\/agents\/mechanical-sweep\.md exists but is not a regular file — refusing to touch it — fix that, then run: node /u);
  });

  it('an unusable vehicle whose reason IS the writer\'s refusal → named once', () => {
    const root = makeProject();
    configured(root);
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'agents', 'executor.md'));
    const item = itemOf(root, {});
    rmSync(root, { recursive: true, force: true });
    assert.match(item.apply, /^HAND-APPLY: /u);
    assert.equal((item.apply.match(/executor\.md/gu) ?? []).length, 1, item.apply);
  });

  it('a current stamp and a missing vehicle → the direct apply, no precondition', () => {
    const root = makeProject();
    configured(root);
    const item = itemOf(root, { surveyVehicle: survey('missing') });
    rmSync(root, { recursive: true, force: true });
    assert.match(item.apply, /^node .*cheap-agents\.mjs --apply --cwd /u);
  });
});
