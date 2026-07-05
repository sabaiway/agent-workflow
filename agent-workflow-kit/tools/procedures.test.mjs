import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, extractSection, CONFIG_REL } from './procedures.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import { allowedLabel } from './bridge-settings-read.mjs';

// Host-independent fixtures: a temp cwd for the config + the REPO's OWN engine via
// AGENT_WORKFLOW_ENGINE_DIR (it ships references/procedures.md, so the live read is deterministic and
// needs no separate engine fixture) + an INJECTED synthetic detection (ctx.detect) so the resolved
// recipe never depends on which backends the test host happens to have installed.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', 'agent-workflow-engine');
const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const detect = (codex, agy) => () => [
  { name: CODEX, readiness: codex },
  { name: AGY, readiness: agy },
];

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'procedures-cwd-'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const writeConfig = (json) => writeFileSync(join(cwd, CONFIG_REL), json);
// Run main() with the repo engine + an injected detection; config comes from the temp cwd.
const run = (argv, { codex = READY, agy = READY } = {}) =>
  main(argv, { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(codex, agy) });

describe('procedures CLI — happy path (section verbatim + resolved recipe)', () => {
  it('plan-authoring prints the canon section + the resolved review recipe, exit 0', () => {
    const r = run(['plan-authoring'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /## plan-authoring/);
    assert.match(r.stdout, /Slots: review/);
    assert.match(r.stdout, /resolved recipes for "plan-authoring"/);
    assert.match(r.stdout, /review: reviewed — computed default/);
  });

  it('plan-execution resolves BOTH slots (execute then review)', () => {
    const r = run(['plan-execution'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /## plan-execution/);
    assert.match(r.stdout, /Slots: execute, review/);
    assert.match(r.stdout, /execute: solo — computed default/);
    assert.match(r.stdout, /review: reviewed — computed default/);
  });

  it('section extraction is scoped to the requested activity (no sibling section bleeds in)', () => {
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.ok(r.stdout.includes('## plan-execution'));
    assert.ok(!r.stdout.includes('## plan-authoring'), 'only the requested activity section is printed');
  });
});

describe('procedures CLI — config IO (§2.2)', () => {
  it('absent config → computed defaults, stated as configSource:none', () => {
    const r = run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.configSource, 'none');
    assert.equal(j.slots.review.source, 'default');
    assert.equal(j.slots.review.recipe, 'solo', 'no ready backend → review defaults to solo');
  });

  it('a valid config drives the slot (execute=delegated honoured when codex is ready)', () => {
    writeConfig(JSON.stringify({ _README: 'composition-root config', 'plan-execution': { execute: 'delegated' } }));
    const r = run(['plan-execution', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.configSource, CONFIG_REL);
    assert.equal(j.slots.execute.recipe, 'delegated');
    assert.equal(j.slots.execute.source, 'config');
  });

  it('malformed JSON → loud `path: malformed JSON …`, exit 1', () => {
    writeConfig('{ not valid json');
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${CONFIG_REL}: malformed JSON`));
  });

  it('schema-invalid (recipe not allowed for the slot) → loud `path: invalid recipe …`, exit 1', () => {
    writeConfig(JSON.stringify({ 'plan-authoring': { review: 'delegated' } }));
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid recipe "delegated" for review slot of "plan-authoring"/);
  });

  it('schema-invalid (unknown activity) → exit 1', () => {
    writeConfig(JSON.stringify({ 'plan-foo': { review: 'reviewed' } }));
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown activity "plan-foo"/);
  });

  it('schema-invalid (unknown slot) → exit 1', () => {
    writeConfig(JSON.stringify({ 'plan-authoring': { execute: 'solo' } }));
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown slot "execute" for activity "plan-authoring"/);
  });

  it('unreadable config (a directory in its place → EISDIR) → loud `path: unreadable …`, exit 1', () => {
    mkdirSync(join(cwd, CONFIG_REL)); // orchestration.json IS a dir → readFileSync throws
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${CONFIG_REL}: unreadable`));
  });

  it('a DANGLING symlink at the config path is unreadable (exit 1), NOT silently treated as absent', () => {
    // A broken config symlink is a present-but-broken config — surface it loudly, never fall through to
    // defaults (no-silent-failures). lstat sees the link; readFileSync follows it to a missing target.
    symlinkSync(join(cwd, 'nowhere.json'), join(cwd, CONFIG_REL));
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${CONFIG_REL}: unreadable`));
  });
});

describe('procedures CLI — usage errors → exit 2', () => {
  it('unknown <activity> → exit 2', () => {
    const r = run(['plan-foo']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown activity "plan-foo"/);
  });

  it('missing <activity> → exit 2', () => {
    const r = run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing <activity>/);
  });

  it('a bare --override <recipe> (no slot) → exit 2', () => {
    const r = run(['plan-authoring', '--override', 'council']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--override must be <slot>=<recipe>/);
  });

  it('--override with an unknown slot for the activity → exit 2', () => {
    const r = run(['plan-authoring', '--override', 'execute=delegated']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown slot "execute" for activity "plan-authoring"/);
  });

  it('--override with a recipe invalid for the slot → exit 2', () => {
    const r = run(['plan-authoring', '--override', 'review=delegated']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid recipe "delegated" for review slot/);
  });

  it('a duplicate --override for the same slot → exit 2', () => {
    const r = run(['plan-execution', '--override', 'review=council', '--override', 'review=solo']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /duplicate override for slot "review"/);
  });
});

describe('procedures CLI — override resolution (degrades loudly, still exit 0)', () => {
  it('an UNSATISFIABLE explicit override degrades loudly and exits 0 with a warning', () => {
    // council needs two ready reviewers; only codex is ready → degrade to reviewed, flagged loud.
    const r = run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.slots.review.recipe, 'reviewed');
    assert.equal(j.slots.review.degradedFrom, 'council');
    assert.equal(j.slots.review.source, 'override');
    assert.equal(j.warnings.length, 1, 'an unsatisfiable override is surfaced as a loud warning');
    assert.match(j.warnings[0], /could not be satisfied/);
  });

  it('the same override in human mode prints a ⚠ warning line', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /warnings:/);
    assert.match(r.stdout, /⚠/);
  });

  it('a satisfiable override holds with no warning (exit 0)', () => {
    const r = run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: READY });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.slots.review.recipe, 'council');
    assert.equal(j.warnings.length, 0);
  });
});

describe('procedures CLI — a backend-detection failure does NOT break activity resolution', () => {
  // A corrupt / unreadable bridge can make the detector throw. Detection is a SECONDARY input (it only
  // refines the recipe), so a throw must NOT surface as a config/engine error (exit 1) — resolution
  // floors at Solo and the failure is a loud warning, exit 0.
  const throwingDetect = () => {
    throw Object.assign(new Error('corrupt bridge manifest (EISDIR)'), { code: 'EISDIR' });
  };

  it('detect() throwing → exit 0, a warning, and every slot floors at solo', () => {
    const r = main(['plan-execution', '--json'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: throwingDetect });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.slots.execute.recipe, 'solo');
    assert.equal(j.slots.review.recipe, 'solo');
    assert.ok(j.warnings.some((w) => /backend detection failed/.test(w)), 'the detection failure is surfaced as a warning');
  });

  it('the same failure in human mode prints a ⚠ warning, still exit 0', () => {
    const r = main(['plan-authoring'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: throwingDetect });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /backend detection failed/);
    assert.match(r.stdout, /review: solo/);
  });
});

describe('procedures CLI — grounding pre-step population (AD-038, all three discovery branches)', () => {
  const councilConfig = () => writeConfig(JSON.stringify({ 'plan-execution': { review: 'council' } }));
  const addPlan = (name) => {
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'plans', name), '# plan\n');
  };

  it('exactly ONE plan in flight → the grounding invocation renders POPULATED with that path', () => {
    councilConfig();
    addPlan('queue.md');
    addPlan('my-feature.md');
    addPlan('EXECUTE-my-feature.md'); // scratch — excluded by the naming convention
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Grounding pre-step \(agy is dispatched/);
    // Path arguments render shell-QUOTED (a skill dir / plan name with a space stays copy-pasteable).
    assert.match(r.stdout, /node "[^"]*grounding\.mjs" --constraints --plan "docs\/plans\/my-feature\.md" --out/);
    assert.match(r.stdout, /agy-review code --facts @/);
    assert.doesNotMatch(r.stdout, /plan discovery:/, 'a unique plan needs no discovery caveat');
  });

  it('ZERO plans in flight → the explicit --plan <path> placeholder + a one-line discovery caveat', () => {
    councilConfig();
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /grounding\.mjs" --constraints --plan <path> --out/);
    assert.match(r.stdout, /plan discovery: no plan in flight/);
  });

  it('SEVERAL plans in flight → the placeholder + the pick-one caveat naming them', () => {
    councilConfig();
    addPlan('feature-a.md');
    addPlan('feature-b.md');
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /grounding\.mjs" --constraints --plan <path> --out/);
    assert.match(r.stdout, /plan discovery: 2 plans in flight .*feature-a\.md, feature-b\.md/);
  });

  it('agy NOT dispatched (codex-only reviewed / solo) → no grounding pre-step at all', () => {
    const reviewed = run(['plan-execution'], { codex: READY, agy: NEEDS_SKILL });
    assert.doesNotMatch(reviewed.stdout, /Grounding pre-step/, 'codex grounds automatically — no agy pre-step');
    const solo = run(['plan-execution'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.doesNotMatch(solo.stdout, /Grounding pre-step/);
  });

  it('plan-authoring renders the plan-mode --facts form — POPULATED with the unique in-flight plan; --json carries the structured block additively', () => {
    writeConfig(JSON.stringify({ 'plan-authoring': { review: 'council' } }));
    addPlan('my-feature.md');
    const r = run(['plan-authoring'], { codex: READY, agy: READY });
    assert.match(r.stdout, /agy-review plan "docs\/plans\/my-feature\.md" --facts @/, 'a known plan path never renders a placeholder');
    const zeroPlans = main(['plan-authoring', '--override', 'review=council'], { cwd: mkdtempSync(join(tmpdir(), 'proc-noplan-')), env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(READY, READY) });
    assert.match(zeroPlans.stdout, /agy-review plan <plan-file> --facts @/, 'zero plans → the placeholder stays');
    const j = JSON.parse(run(['plan-authoring', '--json'], { codex: READY, agy: READY }).stdout);
    assert.ok(Array.isArray(j.groundingPreStep) && j.groundingPreStep.length > 0);
    assert.ok(j.groundingPreStep.some((l) => /--plan "docs\/plans\/my-feature\.md"/.test(l)), 'the populated path rides in --json too');
    const solo = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(solo.groundingPreStep, [], 'solo → empty grounding pre-step');
  });
});

describe('procedures CLI — --json schema (§2.0)', () => {
  it('emits activity, section, per-slot resolution, configSource, warnings', () => {
    const r = run(['plan-execution', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), ['activity', 'configSource', 'costLanes', 'groundingPreStep', 'reviewLoop', 'section', 'slots', 'warnings'].sort());
    assert.equal(j.activity, 'plan-execution');
    assert.match(j.section, /## plan-execution/);
    for (const slot of ['execute', 'review']) {
      assert.ok(j.slots[slot], `slot ${slot} present`);
      assert.deepEqual(Object.keys(j.slots[slot]).sort(), ['backends', 'contracts', 'degradedFrom', 'reason', 'recipe', 'source'].sort());
    }
    assert.ok(Array.isArray(j.warnings));
  });
});

describe('procedures CLI — backend-set aid (§2.1): the explicit wrapper set beside the recipe', () => {
  it('council prints BOTH dispatched wrappers (codex-review + agy-review) with the every-round reminder', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /review: council .*→ run every backend every round: codex-review \+ agy-review/);
  });

  it('reviewed prints the single dispatched wrapper (codex-review), no every-round reminder', () => {
    const r = run(['plan-authoring'], { codex: READY, agy: NEEDS_SKILL }); // computed default = reviewed
    assert.match(r.stdout, /review: reviewed — computed default → codex-review/);
    assert.ok(!/run every backend every round/.test(r.stdout), 'a single-backend recipe carries no every-round set');
  });

  it('delegated prints the codex-exec executor wrapper', () => {
    const r = run(['plan-execution', '--override', 'execute=delegated'], { codex: READY, agy: NEEDS_SKILL });
    assert.match(r.stdout, /execute: delegated .*→ codex-exec/);
  });

  it('solo prints NO backend set (nothing dispatched)', () => {
    const r = run(['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }); // review = solo
    assert.match(r.stdout, /^  review: solo — computed default$/m, 'the solo recipe line carries no wrapper label');
  });

  it('--json carries the per-slot wrapper set, drift-guarded to the bridge manifests (non-vacuous)', () => {
    const council = JSON.parse(run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    assert.deepEqual(council.slots.review.backends, ['codex-review', 'agy-review']);
    const delegated = JSON.parse(run(['plan-execution', '--override', 'execute=delegated', '--json'], { codex: READY, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(delegated.slots.execute.backends, ['codex-exec']);
    const solo = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(solo.slots.review.backends, [], 'solo → empty backend set');
  });

  it('a council degraded to reviewed prints only the surviving wrapper (set follows the EFFECTIVE recipe)', () => {
    const r = run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: NEEDS_SKILL });
    const j = JSON.parse(r.stdout);
    assert.equal(j.slots.review.recipe, 'reviewed', 'council degraded to reviewed (only codex ready)');
    assert.deepEqual(j.slots.review.backends, ['codex-review'], 'the set reflects the dispatched, effective recipe');
  });
});

describe('procedures CLI — review-loop economics block (§2.2, M1/M6): prints for reviewed|council, omits solo', () => {
  const SENTINEL = /Review-loop economics/;

  it('PRINTS the block for council (carries the ≤2-round cap, divergence stop, and the M6 emission)', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SENTINEL);
    assert.match(r.stdout, /≤2 rounds/);
    assert.match(r.stdout, /backend divergence/i);
    assert.match(r.stdout, /finding-origin tally/);
    assert.match(r.stdout, /diff-review/);
    assert.match(r.stdout, /self-consistency/);
  });

  it('PRINTS the block for reviewed (single-backend review still runs the loop economics)', () => {
    const r = run(['plan-authoring'], { codex: READY, agy: NEEDS_SKILL }); // computed default = reviewed
    assert.match(r.stdout, /review: reviewed/);
    assert.match(r.stdout, SENTINEL);
  });

  it('OMITS the block for solo (non-vacuous — the same activity flips when review resolves solo)', () => {
    const r = run(['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }); // review = solo
    assert.match(r.stdout, /review: solo/);
    assert.ok(!SENTINEL.test(r.stdout), 'solo omits the review-loop economics block');
  });

  it('--json carries the structured reviewLoop counterpart (present for council, empty for solo)', () => {
    const council = JSON.parse(run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    assert.ok(Array.isArray(council.reviewLoop) && council.reviewLoop.length > 0, 'council carries a non-empty reviewLoop');
    assert.ok(council.reviewLoop.some((l) => /finding-origin/.test(l)), 'the M6 per-round emission is in the structured block');
    const solo = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(solo.reviewLoop, [], 'solo → empty reviewLoop');
  });

  it('prints for plan-execution too when its review slot resolves council (not only plan-authoring)', () => {
    const r = run(['plan-execution', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.match(r.stdout, SENTINEL);
  });
});

describe('procedures CLI — cost-lane advisory block (cost-tiered execution): unconditional, canon-token-guarded', () => {
  const SENTINEL = /Cost lanes \(orchestration\.md §5\)/;
  // The distinctive tokens shared with the canon (orchestration.md §5) — pinned on BOTH sides so
  // the advisor paraphrase and the canon cannot silently drift apart.
  const CANON_TOKENS = ['cheapest adequate executor', 'no named guardrail', 'L0', 'L1', 'L2', 'L3', 'red lines never move'];

  it('PRINTS for a review-backed activity (council) with the canon tokens', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SENTINEL);
    for (const token of CANON_TOKENS) assert.ok(r.stdout.includes(token), `advisor carries the canon token "${token}"`);
  });

  it('PRINTS for solo too — the block is UNCONDITIONAL (lanes route every step, review-backed or not)', () => {
    const r = run(['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }); // review = solo
    assert.match(r.stdout, /review: solo/);
    assert.match(r.stdout, SENTINEL, 'solo still gets the cost-lane advisory (unlike the review-loop block)');
  });

  it('names the kit\'s own generic L0 surfaces (gates + rotation checks) and the L1 vehicles, never project publish mechanics', () => {
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /\/agent-workflow-kit gates/, 'points at the batched gate runner');
    assert.match(r.stdout, /archive-decisions --check/, 'points at the rotation checks');
    assert.match(r.stdout, /\/agent-workflow-kit agents/, 'points at the cheap-lane vehicle writer');
    assert.ok(!/dispatch-publish|smoke-init|version-sync/.test(r.stdout), 'stays project-agnostic — no publish mechanics');
  });

  it('--json carries the ADDITIVE structured costLanes counterpart (present for every activity)', () => {
    for (const setup of [{ codex: READY, agy: READY }, { codex: NEEDS_SKILL, agy: NEEDS_SKILL }]) {
      const j = JSON.parse(run(['plan-execution', '--json'], setup).stdout);
      assert.ok(Array.isArray(j.costLanes) && j.costLanes.length > 0, 'costLanes present + non-empty');
      assert.ok(j.costLanes.some((l) => /cheapest adequate executor/.test(l)), 'the routing rule is in the structured block');
    }
  });
});

describe('procedures CLI — --help is read-only and exits 0', () => {
  it('prints usage naming both activities and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-authoring/);
    assert.match(r.stdout, /plan-execution/);
    assert.match(r.stdout, /never commits/);
  });
});

describe('procedures CLI — point-of-use driving contract: verbatim, manifest-drift-guarded (non-vacuous)', () => {
  const REPO_ROOT = join(HERE, '..', '..');
  const manifestContract = (bridge, role) =>
    JSON.parse(readFileSync(join(REPO_ROOT, bridge, 'capability.json'), 'utf8')).roles[role].contract;
  // The host-level settings knobs a wrapper cmd honors, DERIVED from the manifest (drift-guarded both
  // ways vs the advisor's own manifest read — a new/removed knob or an appliesTo edit fails here).
  const manifestSettings = (bridge, cmd) =>
    (JSON.parse(readFileSync(join(REPO_ROOT, bridge, 'capability.json'), 'utf8')).settings ?? [])
      .filter((s) => (s.appliesTo ?? []).includes(cmd))
      .map((s) => ({ key: s.key, allowed: allowedLabel(s) }));
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  // The advisor region below the verbatim canon section — scope the descriptor parse to it so a
  // canon edit mentioning a wrapper name can never leak into the set-equality.
  const adviceRegion = (stdout) => stdout.slice(stdout.indexOf('resolved recipes for'));
  // The exact descriptor lines rendered for one wrapper (its block-header line excluded): these must
  // set-EQUAL the manifest invocations ∪ continue — a MISSING descriptor and a STALE EXTRA both fail.
  const cmdLines = (stdout, cmd) =>
    adviceRegion(stdout).split('\n').map((l) => l.trim())
      .filter((l) => l.startsWith(`${cmd} `) && !l.includes('— driving contract'))
      .map(norm);
  const descriptorSet = (contract) => [...contract.invocations, ...(contract.continue ?? [])].map(norm).sort();
  // One wrapper's whole rendered contract block (header + its deeper-indented body lines).
  const contractBlock = (stdout, cmd) => {
    const lines = stdout.split('\n');
    const start = lines.findIndex((l) => l.trim().startsWith(`${cmd} — driving contract`));
    assert.notEqual(start, -1, `${cmd} contract block present`);
    const out = [lines[start]];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (!lines[i].trim() || /^\s{0,6}\S/.test(lines[i])) break; // next slot/block/blank ends it
      out.push(lines[i]);
    }
    return out.join('\n');
  };

  it('council (both READY): each backend\'s exact descriptors render, set-EQUAL to its manifest', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    const agy = manifestContract(AGY, 'review');
    const codex = manifestContract(CODEX, 'review');
    assert.ok(agy.invocations.length && codex.invocations.length, 'manifest descriptor sets are non-empty');
    assert.deepEqual(cmdLines(r.stdout, 'agy-review').sort(), descriptorSet(agy), 'agy-review descriptors ⟷ manifest');
    assert.deepEqual(cmdLines(r.stdout, 'codex-review').sort(), descriptorSet(codex), 'codex-review descriptors ⟷ manifest');
    // agy: the FULL contract renders in the block — flags set-EQUAL the manifest descriptors,
    // the grounding note is verbatim, and the round-2 delta is surfaced at the point of use.
    const agyBlock = contractBlock(r.stdout, 'agy-review');
    const agyFlagLines = agyBlock.split('\n').map((l) => norm(l)).filter((l) => l.startsWith('--'));
    assert.deepEqual(agyFlagLines.sort(), agy.flags.map(norm).sort(), 'rendered flag lines ⟷ manifest flags');
    assert.ok(norm(agyBlock).includes(norm(agy.grounding)), 'the agy grounding note renders verbatim');
    assert.match(agyBlock, /agy-review --continue/);
    // codex-review: grounding is automatic, one-shot — no grounding flags, no continue line.
    const codexBlock = contractBlock(r.stdout, 'codex-review');
    assert.ok(norm(codexBlock).includes(norm(codex.grounding)), 'the codex grounding note renders verbatim');
    assert.doesNotMatch(codexBlock, /--facts|--decided|--continue/);
  });

  it('delegated (a NON-review recipe) renders the codex-exec contract incl. resume — not gated by the review set', () => {
    const r = run(['plan-execution', '--override', 'execute=delegated'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const exec = manifestContract(CODEX, 'execute');
    assert.deepEqual(cmdLines(r.stdout, 'codex-exec').sort(), descriptorSet(exec), 'codex-exec descriptors ⟷ manifest');
    const block = contractBlock(r.stdout, 'codex-exec');
    assert.match(block, /codex-exec --resume-last/);
    assert.match(block, /passthrough after '--' is guarded/);
    assert.ok(norm(block).includes(norm(exec.grounding)), 'the exec grounding note renders verbatim');
    // Both passthrough TIERS render in full — every manifest tier pattern appears in the block.
    for (const p of [...exec.passthrough.blocked, ...exec.passthrough.probeRelaxed]) {
      assert.ok(block.includes(p), `passthrough pattern ${p} renders`);
    }
  });

  it('--json: the ADDITIVE contracts field deep-equals the manifests; backends keeps the stable shape', () => {
    const j = JSON.parse(run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    assert.deepEqual(j.slots.review.backends, ['codex-review', 'agy-review'], 'the pre-existing backends shape is unchanged');
    assert.deepEqual(j.slots.review.contracts, [
      { backend: CODEX, role: 'review', cmd: 'codex-review', contract: manifestContract(CODEX, 'review'), settings: manifestSettings(CODEX, 'codex-review') },
      { backend: AGY, role: 'review', cmd: 'agy-review', contract: manifestContract(AGY, 'review'), settings: manifestSettings(AGY, 'agy-review') },
    ], 'the surfaced contract + settings deep-equal the bridge manifests (drift-guarded, both directions)');
    const d = JSON.parse(run(['plan-execution', '--override', 'execute=delegated', '--json'], { codex: READY, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(d.slots.execute.contracts, [
      { backend: CODEX, role: 'execute', cmd: 'codex-exec', contract: manifestContract(CODEX, 'execute'), settings: manifestSettings(CODEX, 'codex-exec') },
    ]);
    // The human render surfaces the same knobs, fact-only, under the wrapper's contract block.
    const human = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY }).stdout;
    assert.match(human, /host settings \(survive kit upgrades/);
    assert.match(human, /CODEX_SERVICE_TIER — "priority"/);
    assert.match(human, /AGY_REVIEW_ALLOW_ADDDIR — "0" \| "1"/);
  });

  it('solo: no contract block in human output; contracts empty in --json (solo-omits holds)', () => {
    const r = run(['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.match(r.stdout, /review: solo/);
    assert.ok(!/driving contract/.test(r.stdout), 'solo dispatches nothing — no contract to drive');
    const j = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(j.slots.review.contracts, []);
  });
});

// §4.0 — an installed engine too old to ship references/procedures.md must FAIL LOUDLY (exit 1 with a
// clear "upgrade the engine" message), never a cryptic read error. A temp fixture models a VALID
// methodology-engine that ships every fragment EXCEPT procedures.md (i.e. engine < 1.3.0).
describe('procedures CLI — engine too old (no procedures.md) → loud exit 1', () => {
  const makeOldEngine = () => {
    const dir = mkdtempSync(join(tmpdir(), 'old-engine-'));
    const manifest = {
      family: 'agent-workflow',
      schema: 1,
      name: 'agent-workflow-engine',
      kind: 'methodology-engine',
      version: '1.2.0',
      available: true,
      provides: ['plan'],
      roles: {},
    };
    writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(dir, 'SKILL.md'), "---\nname: agent-workflow-engine\nmetadata:\n  version: '1.2.0'\n---\n# engine\n");
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'methodology-slot.md'), '> methodology fragment\n');
    // deliberately NO references/procedures.md
    return dir;
  };

  it('exits 1 with an upgrade-the-engine message (not a cryptic fs error)', () => {
    const oldEngine = makeOldEngine();
    try {
      const r = main(['plan-authoring'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: oldEngine }, detect: detect(READY, READY) });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /procedures\.md/, 'the error names the missing fragment');
      assert.match(r.stderr, /upgrade the engine|@latest init/i, 'the error tells the user to upgrade the engine');
    } finally {
      rmSync(oldEngine, { recursive: true, force: true });
    }
  });
});

describe('extractSection (unit) — boundary + verbatim', () => {
  const FIXTURE = ['# Title', '', '## plan-authoring', '', 'Slots: review', '', 'step one', '', '## plan-execution', '', 'Slots: execute, review', '', 'step two', ''].join('\n');

  it('returns the requested section, heading-to-next-heading', () => {
    const sec = extractSection(FIXTURE, 'plan-authoring');
    assert.match(sec, /## plan-authoring/);
    assert.match(sec, /Slots: review/);
    assert.match(sec, /step one/);
    assert.ok(!sec.includes('plan-execution'), 'stops before the next ## heading');
  });

  it('extracts the LAST section to EOF', () => {
    const sec = extractSection(FIXTURE, 'plan-execution');
    assert.match(sec, /step two/);
    assert.ok(!sec.includes('plan-authoring'));
  });

  it('throws (engine-too-old) when the activity section is absent', () => {
    assert.throws(() => extractSection(FIXTURE, 'plan-nope'), /has no "## plan-nope" section/);
  });
});
