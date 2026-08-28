import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, extractSection, CONFIG_REL, FLOW_ARMED_HALVES_HEADER, DECLARED_PRACTICE_HEADER, defaultFlowProbe, FOLD_SCOPE_TOOL } from './procedures.mjs';
import { shellQuoteArg, isSeedablePathToken } from './repo-lex.mjs';
import { readRegistration, mergeMcpJson, mergeSettings, formatJson, MCP_JSON_REL, SETTINGS_REL } from './mcp-registration.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import { allowedLabel } from './bridge-settings-read.mjs';
import { SOURCE_SIZE_CONFIG_REL, SOURCE_SIZE_WHY } from './source-size-core.mjs';

// Host-independent fixtures: a temp cwd for the config + the REPO's OWN engine via
// AGENT_WORKFLOW_ENGINE_DIR (it ships references/procedures.md, so the live read is deterministic) +
// an INJECTED detection and vehicle survey, so no resolved recipe depends on the test host.
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
// Run main() with the repo engine + an injected detection and vehicle survey; config from the temp cwd.
const vehicle = (state) => () => ({ state, reason: state === 'unusable' ? 'a symlink' : null, rel: '.claude/agents/executor.md' });
const run = (argv, { codex = READY, agy = READY, executor = 'missing' } = {}, extra = {}) =>
  main(argv, { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(codex, agy), surveyVehicle: vehicle(executor), ...extra });

describe('procedures CLI — happy path (section verbatim + resolved recipe)', () => {
  it('plan-authoring prints the canon section + the resolved review recipe, exit 0', () => {
    const r = run(['plan-authoring'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /## plan-authoring/);
    assert.match(r.stdout, /Slots: author, fold, review/);
    assert.match(r.stdout, /resolved recipes for "plan-authoring"/);
    assert.match(r.stdout, /fold: solo — computed default/);
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

  it('schema-invalid (recipe not allowed for the slot) → loud `path: invalid value …`, exit 1', () => {
    writeConfig(JSON.stringify({ 'plan-authoring': { review: 'delegated' } }));
    const r = run(['plan-authoring']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid value "delegated" for review slot of "plan-authoring"/);
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
    // A broken config symlink is a present-but-broken config — surfaced loudly, never fallen through to defaults; lstat sees the link, readFileSync follows it to a missing target.
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
    assert.match(r.stderr, /--override must be <slot>=<value>/);
  });

  it('--override with an unknown slot for the activity → exit 2', () => {
    const r = run(['plan-authoring', '--override', 'execute=delegated']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown slot "execute" for activity "plan-authoring"/);
  });

  it('--override with a recipe invalid for the slot → exit 2', () => {
    const r = run(['plan-authoring', '--override', 'review=delegated']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid value "delegated" for review slot/);
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

// spec:carriers/S5 — the dispatch form per subagent slot, the four routine parallel x carrier cells, today's lines for solo and delegated, and an --override that writes nothing.
describe('procedures CLI — the dispatch form and the routine switch', () => {
  const FORM = (state, slice) => [slice, `dispatch: the executor vehicle (.claude/agents/executor.md — ${state}), in the background`, 'the orchestrator verifies every returned slice by running its suites itself', 'the subagent is never told to commit, never a review backend, never a bridge substitute', 'honest limit: a Claude Code lane — on a host that cannot dispatch the vehicle, follow this form by hand and say so'].map((l) => `      ${l}`);
  const EXECUTE_SLICE = 'a slice is a set of file-disjoint ledger rows; wording is copied verbatim where wording is a red line';
  const carried = (activity, slot, executor = 'placed') => {
    writeConfig(JSON.stringify({ [activity]: { [slot]: 'subagent' } }));
    return run([activity], { executor });
  };
  const lines = (r) => r.stdout.split('\n');

  it('a subagent slot prints its activity slice sentence + the four dispatch lines carrying the surveyed state, and never the one-liner', () => {
    const exec = carried('plan-execution', 'execute');
    assert.equal(exec.code, 0, exec.stderr);
    assert.match(exec.stdout, /execute: subagent — from docs\/ai\/orchestration\.json/);
    for (const line of FORM('placed', EXECUTE_SLICE)) assert.ok(lines(exec).includes(line), line);
    assert.doesNotMatch(exec.stdout, /the placed subagent vehicle/, 'the form REPLACES the one-liner, it never rides beside it');
    const author = carried('plan-authoring', 'author', 'customized');
    for (const line of FORM('customized', 'a slice is a brief naming the goal, the governing spec(s) and the ledger constraints; the subagent drafts the plan or the contract from it, and the orchestrator reviews the draft as its own')) assert.ok(lines(author).includes(line), line);
    assert.ok(!lines(author).includes(`      ${EXECUTE_SLICE}`), 'the slice noun is the activity own');
    const fold = carried('plan-authoring', 'fold');
    for (const line of FORM('placed', "a slice is the round's findings with their dispositions; the subagent edits the plan or the contract in place and returns; the orchestrator runs the self-consistency read itself")) assert.ok(lines(fold).includes(line), line);
  });
  it('routine renders all four parallel x carrier cells', () => {
    for (const [carrier, argv, line] of [
      ['subagent', [], '  parallel: on — file-disjoint slices dispatch concurrently — computed default'],
      ['subagent', ['--override', 'parallel=off'], '  parallel: off — one slice at a time — from --override'],
      ['solo', [], '  parallel: on (no effect while the carrier is solo) — computed default'],
      ['solo', ['--override', 'parallel=off'], '  parallel: off — one slice at a time (no effect while the carrier is solo) — from --override'],
    ]) {
      writeConfig(JSON.stringify({ routine: { carrier } }));
      assert.ok(lines(run(['routine', ...argv], { executor: 'placed' })).includes(line), `carrier ${carrier} ${argv.join(' ')}`);
    }
  });
  it('solo, delegated and a missing vehicle render today lines, and an --override leaves the config byte-identical', () => {
    const gone = carried('routine', 'carrier', 'missing');
    assert.match(gone.stdout, /carrier: solo — from docs\/ai\/orchestration\.json \(requested subagent → degraded\)/);
    assert.match(gone.stdout, /↳ .*executor/);
    writeConfig(JSON.stringify({ 'plan-execution': { execute: 'delegated', review: 'solo' } }));
    const bridged = run(['plan-execution'], { executor: 'placed' });
    assert.match(bridged.stdout, /execute: delegated — from docs\/ai\/orchestration\.json → codex-exec/);
    assert.match(bridged.stdout, /codex-exec — driving contract/);
    assert.match(bridged.stdout, /review: solo — from docs\/ai\/orchestration\.json/);
    writeConfig(JSON.stringify({ 'plan-execution': { execute: 'subagent' } }));
    const digest = () => createHash('sha256').update(readFileSync(join(cwd, CONFIG_REL))).digest('hex');
    const before = digest();
    const solo = run(['plan-execution', '--override', 'execute=solo'], { executor: 'placed' });
    assert.equal(solo.code, 0, solo.stderr);
    assert.match(solo.stdout, /execute: solo — from --override/);
    assert.equal(digest(), before, 'a per-run override never touches the config file');
    for (const r of [gone, bridged, solo]) assert.doesNotMatch(r.stdout, /dispatch: the executor vehicle/, 'no form outside a resolved subagent slot');
  });
});

describe('procedures CLI — a backend-detection failure does NOT break activity resolution', () => {
  // A corrupt bridge can make the detector throw. Readiness is SECONDARY, so a throw floors resolution at Solo and warns — never a config/engine error (exit 1).
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
    assert.match(r.stdout, /node "[^"]*grounding\.mjs" --constraints --autonomy --plan "docs\/plans\/my-feature\.md" --out/);
    assert.match(r.stdout, /agy-review code --facts @/);
    assert.doesNotMatch(r.stdout, /plan discovery:/, 'a unique plan needs no discovery caveat');
  });

  it('ZERO plans in flight → the explicit --plan <path> placeholder + a one-line discovery caveat', () => {
    councilConfig();
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /grounding\.mjs" --constraints --autonomy --plan <path> --out/);
    assert.match(r.stdout, /plan discovery: no plan in flight/);
    assert.match(r.stdout, /drop --plan for constraints\+autonomy facts/, 'the no-plan caveat names the constraints+autonomy fallback');
  });

  it('SEVERAL plans in flight → the placeholder + the pick-one caveat naming them', () => {
    councilConfig();
    addPlan('feature-a.md');
    addPlan('feature-b.md');
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /grounding\.mjs" --constraints --autonomy --plan <path> --out/);
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

// The bare byte-form is the kit-tools tier's own (velocity-profile.test.mjs pins the parity).
const RUN_LINE = /run: node \S*repo-search\.mjs --pattern <the literal> \(a pattern carrying a shell-significant byte goes through --pattern-file <f> instead\)/u;
const USE_LINE = /use: repo_search \{"pattern": "<the literal>"\}/u;
describe('procedures CLI — the plan-authoring readers sweep', () => {
  it('renders before review under solo, either single reviewer, and council', () => {
    for (const [argv, readiness] of [
      [['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }],
      [['plan-authoring'], { codex: READY, agy: NEEDS_SKILL }],
      [['plan-authoring'], { codex: NEEDS_SKILL, agy: READY }],
      [['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY }],
    ]) {
      const r = run(argv, readiness);
      for (const pattern of [/Readers sweep \(before the first review\)/u, RUN_LINE, /ledger row.*stated non-goal.*unchanged with its proof/u]) assert.match(r.stdout, pattern);
      assert.doesNotMatch(r.stdout, /use: repo_search/u, 'an unregistered project is never pointed at the MCP tool');
    }
  });
  // Two names, both record-bound: an intermediate rename orphaned the second, and a red-proof record
  // only re-observes under a test whose name matches byte-for-byte.
  const registered = () => main(['plan-authoring'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(READY, READY), surveyVehicle: vehicle('missing'), readRegistration: () => ({ registered: true }) });
  it('adds the typed repo_search form above the command when the project registration is complete', () => {
    const r = registered();
    assert.match(r.stdout, USE_LINE);
    assert.ok(r.stdout.indexOf('use: repo_search') < r.stdout.indexOf('--pattern <the literal>'), 'the typed form precedes the command');
  });
  it('adds the typed repo_search form above the bare command when the project registration is complete', () => {
    assert.match(registered().stdout, RUN_LINE, 'the bare command stays as the fallback for a session where the tool is not loaded');
  });
  it('the DEFAULT registration probe reads a real .mcp.json + settings.json pair (non-vacuity)', () => {
    const registration = readRegistration(cwd);
    writeFileSync(join(cwd, MCP_JSON_REL), formatJson(mergeMcpJson(registration), '\n'));
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, SETTINGS_REL), formatJson(mergeSettings(registration), '\n'));
    assert.equal(readRegistration(cwd).registered, true, 'the fixture IS a complete registration');
    assert.match(run(['plan-authoring']).stdout, USE_LINE);
  });
  it('a lens-only roster still renders the review-loop block with the consult line', () => {
    writeConfig(JSON.stringify({ 'plan-authoring': { review: ['review-lens'] } }));
    const reviewLoop = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout).reviewLoop;
    assert.ok(reviewLoop.some((line) => line.includes('Before every fold')), 'the consult line renders for a roster');
    assert.ok(reviewLoop.some((line) => line.includes('Each round MUST emit')), 'the round emission renders for a roster');
  });
  // The render and the seeder share ONE predicate; the expected spellings are LITERAL, never recomputed.
  const NON_ASCII = `/home/jos${String.fromCharCode(0x65, 0x301)}/kit/tools/repo-search.mjs`;
  const SPACED = '/home/my kit/tools/repo-search.mjs';
  const METACHAR = '/kit$(touch x)/tools/repo-search.mjs';
  it('a seedable non-ASCII kit path renders BARE — the tier seeds that path bare, so a quoted render would be a dead rule', () => {
    assert.equal(isSeedablePathToken(NON_ASCII), true, 'the SEEDER accepts it — the case an ASCII allowlist gets wrong');
    assert.ok(run(['plan-authoring'], {}, { repoSearchTool: NON_ASCII }).stdout.includes(`run: node ${NON_ASCII} --pattern <the literal>`));
  });
  it('an unseedable path renders SINGLE-QUOTED — no rule covers it, and a double-quoted paste would still expand', () => {
    for (const path of [SPACED, METACHAR]) {
      assert.equal(isSeedablePathToken(path), false, path);
      assert.ok(run(['plan-authoring'], {}, { repoSearchTool: path }).stdout.includes(`run: node '${path}' --pattern <the literal>`), path);
    }
  });
  it('is structured in JSON and absent from plan-execution', () => {
    assert.ok(JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout).readersSweep.some((line) => /Readers sweep/.test(line)));
    assert.deepEqual(JSON.parse(run(['plan-execution', '--json'], { codex: READY, agy: READY }).stdout).readersSweep, []);
  });
});
describe('procedures CLI — --json schema (§2.0)', () => {
  it('emits activity, section, per-slot resolution, configSource, warnings', () => {
    const r = run(['plan-execution', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    // The unarmed JSON key set stays byte-exact to the pre-flow shape — flowHalves is CONDITIONAL on a flow block, unlike the unconditional additive keys.
    assert.deepEqual(Object.keys(j).sort(), ['activity', 'autonomy', 'configSource', 'costLanes', 'declaredPractice', 'foldScope', 'groundingPreStep', 'readersSweep', 'reviewLoop', 'section', 'slots', 'specCheck', 'warnings'].sort());
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
  it('the consult order renders for both review-backed activities', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const reviewLoop = JSON.parse(run([activity, '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout).reviewLoop;
      const consult = reviewLoop.find((line) => line.includes('Before every fold')) ?? '';
      for (const token of ['raised by a review member (a bridge backend or a placed lens)', 'ASK', 'WAIT', 'READ', 'accepted or corrected', 'agy-review --continue --decided @f --focus "Finding: <finding>. Proposed fold: <exact fold>. Does this proposed fold solve the finding and add no new problem? Reply accept, or correct with exact replacement text."', 'codex: fresh codex-review plan <consult-brief>', 'a placed lens: re-dispatch the same lens vehicle with the finding and the proposed fold', 'A self-review finding, or any finding when no review member ran, is folded directly']) assert.ok(consult.includes(token), `${activity} consult line names ${token}`);
      assert.ok(consult.indexOf('ASK') < consult.indexOf('WAIT') && consult.indexOf('WAIT') < consult.indexOf('READ') && consult.indexOf('READ') < consult.indexOf('accepted or corrected'), `${activity} consult order`);
    }
  });
});
describe('procedures CLI — activity-aware instrument pointer: plan-execution names the D3 loop, plan-authoring never does', () => {
  it('plan-execution (council) names the D3 instruments (red-proof / --final / commit-guard)', () => {
    // The structured reviewLoop is the assertion target: the verbatim canon section names the instruments too, so a bare stdout match could stay green with the bullet deleted.
    const j = JSON.parse(run(['plan-execution', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    const instrumentLine = j.reviewLoop.find((l) => l.includes('run-gates --final'));
    assert.ok(instrumentLine, 'plan-execution reviewLoop carries the computed-instrument line');
    for (const token of ['red-proof', 'degrade', 'commit-guard --check', 'core-evidence summary']) {
      assert.ok(instrumentLine.includes(token), `the instrument line carries "${token}"`);
    }
  });

  it('plan-authoring (council) does NOT name the plan-execution instruments', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('run-gates --final'), 'plan-authoring must not point at the plan-execution loop instruments');
  });

  it('BOTH activities carry the triage classification vocabulary (fixable-bug / inherent-layer-residual / escalate)', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const j = JSON.parse(run([activity, '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
      for (const token of ['fixable-bug', 'inherent-layer-residual', 'escalate']) {
        assert.ok(j.reviewLoop.some((l) => l.includes(token)), `${activity} reviewLoop carries the classification token "${token}"`);
      }
    }
  });

  it('solo omits the instrument pointer and the classification bullet with the whole block (non-vacuous)', () => {
    // The canon SECTION legitimately names the instruments for plan-execution — the solo invariant lives in the structured ADVICE block, which must be empty.
    const r = JSON.parse(run(['plan-execution', '--override', 'review=solo', '--json'], { codex: READY, agy: READY }).stdout);
    assert.deepEqual(r.reviewLoop, [], 'solo → empty reviewLoop (no instrument pointer, no classification bullet)');
  });

  it('--json reviewLoop mirrors the activity split (instrument line present for plan-execution, absent for plan-authoring)', () => {
    const exec = JSON.parse(run(['plan-execution', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    assert.ok(exec.reviewLoop.some((l) => /run-gates --final/.test(l)), 'plan-execution reviewLoop carries the instrument line');
    const auth = JSON.parse(run(['plan-authoring', '--override', 'review=council', '--json'], { codex: READY, agy: READY }).stdout);
    assert.ok(!auth.reviewLoop.some((l) => /run-gates --final/.test(l)), 'plan-authoring reviewLoop carries no instrument line');
    assert.ok(auth.reviewLoop.some((l) => /fixable-bug/.test(l)), 'plan-authoring reviewLoop keeps the classification line');
  });
});

describe('procedures CLI — cost-lane advisory block (cost-tiered execution): unconditional, canon-token-guarded', () => {
  const SENTINEL = /Cost lanes \(orchestration\.md §5\)/;
  // The distinctive tokens shared with the canon (orchestration.md §5) — pinned on BOTH sides so the
  // advisor paraphrase and the canon cannot drift. The last five are the D7 prompt-economy invariants
  // (REC-UX-REWORK), ONE token each, also pinned on the lens side.
  const CANON_TOKENS = [
    'cheapest adequate executor', 'no named guardrail', 'L0', 'L1', 'L2', 'L3', 'red lines never move',
    'forbidden lane downgrade', 'plain pipeline per call', 'vehicle mandate a host cannot satisfy',
    'stay at the frontier lane', 'no deterministic gate classifies a dispatch',
    // writer economy (D6 batch verb) + sandbox lanes (host-diff + nested-sandbox honesty), AD-054
    'one writer call at a time', 'host-diff', 'nested inside a harness sandbox',
  ];

  it('PRINTS for a review-backed activity (council) with the canon tokens', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SENTINEL);
    for (const token of CANON_TOKENS) assert.ok(r.stdout.includes(token), `advisor carries the canon token "${token}"`);
  });

  it('the advisor RENDERS bridge contract.notes (a typed key that must not silently disappear — AD-054)', () => {
    // agy review contract note (host-diff) renders under a council review
    const council = run(['plan-execution', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.match(council.stdout, /note: pre-dispatch host-diff/, 'agy review contract.notes renders in the advisor');
    // codex execute contract note (nested-sandbox) renders under delegated execution
    const delegated = run(['plan-execution', '--override', 'execute=delegated'], { codex: READY, agy: READY });
    assert.match(delegated.stdout, /note: nested-sandbox limit/, 'codex execute contract.notes renders in the advisor');
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

  it('carries the D4 sandbox-lane bullet (AD-044 Plan 4) — surface classification + the two driving rules', () => {
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /Sandbox lanes \(under an OS sandbox\)/, 'the bullet names its scope');
    assert.match(r.stdout, /genuinely unsandboxed \(network\)/, 'the bridge wrappers are honestly classified');
    assert.match(r.stdout, /COMMAND-SHAPE dependent/, 'npm-cache commands are shape-classified, not blanket-moved');
    assert.match(r.stdout, /Move ONLY the failing command out of the sandbox, never its class/, 'driving rule 1');
    assert.match(r.stdout, /BATCH consecutive unsandboxed calls/, 'driving rule 2');
  });

  // The SECOND Decision-5 point of use (AD-044 Plan 4): the L0 checker tools each state their
  // sandbox-lane contract line on their own HELP/header surface (the canon-side twin is the engine's).
  it('the four L0 checker tools carry the sandbox-lane contract line on their own surfaces', () => {
    for (const rel of ['run-gates.mjs', 'review-state.mjs', 'core-evidence.mjs', 'coverage-check.mjs']) {
      const src = readFileSync(join(HERE, rel), 'utf8');
      assert.match(src, /Sandbox-safe/, `${rel} states its sandbox-lane contract line`);
    }
  });
});

describe('procedures CLI — the finding-scope block: plan-execution ONLY, unconditional across recipes', () => {
  const SENTINEL = /Finding scope \(procedures\.md plan-execution step 5\)/;
  const FLOW = { schema: 1, preset: 'council', councilRounds: 3, kitMinVersion: '5.1.0', debtQueue: 'docs/debt.md' };
  const foldScopeOf = (argv, setup) => JSON.parse(run([...argv, '--json'], setup).stdout).foldScope;

  it('PRINTS under solo, reviewed AND council — the rule routes every finding, review-backed or not', () => {
    for (const [recipe, setup] of [['solo', { codex: NEEDS_SKILL, agy: NEEDS_SKILL }], ['reviewed', { codex: READY, agy: NEEDS_SKILL }], ['council', { codex: READY, agy: READY }]]) {
      const r = run(['plan-execution', '--override', `review=${recipe}`], setup);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, SENTINEL, `review=${recipe} still prints the finding-scope block`);
    }
  });

  // The canon section is printed VERBATIM directly above this block, so a paraphrase of the three arms
  // duplicates text on one screen and a stdout token assertion would pass on the canon alone — the
  // WHOLE structured block is compared instead.
  const expectedBlock = (plan, queue, register) => [
    'Finding scope (procedures.md plan-execution step 5) — the rule is the section above; this is the checker it names:',
    `  • node ${shellQuoteArg(FOLD_SCOPE_TOOL)} --class '<in-scope|new-invariant|blocking>' --claim '<the invariant>' --plan ${shellQuoteArg(plan)} --queue ${shellQuoteArg(queue)}`,
    `  • --queue is ${register}. Advisory: nothing records that it ran, so a skipped or late call is indistinguishable from a pre-edit declaration.`,
  ];

  it('carries ONLY what the canon cannot: the populated checker command and the register it chose', () => {
    const lines = foldScopeOf(['plan-execution', '--override', 'review=solo'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.deepEqual(lines, expectedBlock('<plan-file>', 'docs/plans/queue.md', 'docs/plans/queue.md, the planning lifecycle queue (no flow.debtQueue is declared)'));
    for (const paraphrased of ['fold here', 'NARROW fix', 'never queued', 'WRITE/REMOVE', 'SUBTRACTION']) {
      assert.ok(!lines.some((l) => l.includes(paraphrased)), `the block must not re-state the canon token "${paraphrased}"`);
    }
  });

  // The rendered command is meant to be PASTED, so every operand goes through the family's shell quoter: the placeholders are shell syntax, and a plan filename may carry `$`.
  it('renders a shell-safe command — placeholders inert, a metacharacter plan path quoted', () => {
    const nasty = 'a$plan`x.md';
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'plans', nasty), '# Plan: x\n');
    const lines = foldScopeOf(['plan-execution'], { codex: READY, agy: READY });
    assert.deepEqual(lines, expectedBlock(`docs/plans/${nasty}`, 'docs/plans/queue.md', 'docs/plans/queue.md, the planning lifecycle queue (no flow.debtQueue is declared)'));
    assert.ok(lines[1].includes(`'docs/plans/a$plan\`x.md'`), 'the metacharacter path is single-quoted, so $ and the backtick are inert');
    assert.ok(!lines[1].includes('--class <in-scope'), 'the class placeholder is never bare shell syntax');
  });

  it('plan-authoring prints NEITHER the block nor the checker (non-vacuous — the same tokens flip)', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!SENTINEL.test(r.stdout), 'the rule is plan-execution-scoped');
    assert.ok(!r.stdout.includes('fold-scope-cli.mjs'), 'and so is its checker command');
  });

  it('populates --queue from a declared flow.debtQueue and NAMES that register', () => {
    writeConfig(JSON.stringify({ flow: FLOW }));
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /--queue docs\/debt\.md$/m, 'the command is populated, never a placeholder');
    assert.match(r.stdout, /docs\/debt\.md, the declared flow\.debtQueue/, 'which register was chosen is stated');
  });

  it('falls back to the planning lifecycle queue when none is declared, and names THAT', () => {
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /--queue docs\/plans\/queue\.md$/m);
    assert.match(r.stdout, /no flow\.debtQueue is declared/, 'the fallback is named, never silently assumed');
    assert.deepEqual(foldScopeOf(['plan-authoring'], { codex: READY, agy: READY }), [], 'plan-authoring carries no structured block');
  });
});

// Reached through the module NAMESPACE: a static named import of an export that does not exist yet is a link error, and a suite that cannot load cannot be observed red.
const { SPEC_CHECK_TOOL } = await import('./procedures.mjs');

describe('procedures CLI — the spec-check block: plan-execution ONLY, unconditional across recipes', () => {
  const SENTINEL = /Spec store \(the feature-spec layer\)/;
  const REGISTER = 'docs/plans/spec-ops.list';
  const specCheckOf = (argv, setup) => JSON.parse(run([...argv, '--json'], setup).stdout).specCheck;

  it('PRINTS under solo, reviewed AND council — the store is judged whoever reviews the change', () => {
    for (const [recipe, setup] of [['solo', { codex: NEEDS_SKILL, agy: NEEDS_SKILL }], ['reviewed', { codex: READY, agy: NEEDS_SKILL }], ['council', { codex: READY, agy: READY }]]) {
      const r = run(['plan-execution', '--override', `review=${recipe}`], setup);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, SENTINEL, `review=${recipe} still prints the spec-check block`);
    }
  });

  // The WHOLE structured block is compared, so neither a paraphrase nor an extra line rides along unnoticed — the bar the finding-scope block is held to.
  const expectedBlock = () => [
    'Spec store (the feature-spec layer) — state what this session changed, then let the checker judge the store against it:',
    `  • node ${shellQuoteArg(SPEC_CHECK_TOOL)} --ops-file ${shellQuoteArg(REGISTER)}   (or --op '<add|modify|remove>=docs/ai/specs/<slug>.md', repeatable; rename=<old>:<new>)`,
    `  • node ${shellQuoteArg(SPEC_CHECK_TOOL)} --all — the whole store instead: unlisted child vs orphan, acyclicity, store-wide slug uniqueness, module overlap.`,
    `  • ${REGISTER} is SESSION SCRATCH: this session writes it, the plan's Cleanup deletes it. It is never defaulted — an unnamed register would attest a post-state nobody declared. Advisory: nothing records that it ran.`,
  ];

  it('carries the populated commands and NAMES the session register it chose', () => {
    assert.deepEqual(specCheckOf(['plan-execution', '--override', 'review=solo'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }), expectedBlock());
  });

  it('renders a shell-safe command — the op placeholder is inert, never bare shell syntax', () => {
    const lines = specCheckOf(['plan-execution'], { codex: READY, agy: READY });
    assert.ok(lines[1].includes(`'${REGISTER}'`) || lines[1].includes(REGISTER), 'the register is rendered through the shell quoter');
    assert.ok(!lines[1].includes('--op <add'), 'the op placeholder is quoted, so < and | are inert');
    assert.ok(!lines.some((l) => l.includes('`')), 'no backtick reaches a line meant to be pasted');
  });

  it('the rendered tool path is ABSOLUTE and self-locating — it runs from any cwd', () => {
    const fromElsewhere = mkdtempSync(join(tmpdir(), 'procedures-other-cwd-'));
    try {
      mkdirSync(join(fromElsewhere, 'docs', 'ai'), { recursive: true });
      const lines = JSON.parse(main(['plan-execution', '--json'], { cwd: fromElsewhere, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(READY, READY) }).stdout).specCheck;
      assert.deepEqual(lines, expectedBlock(), 'the block does not depend on the cwd it was rendered from');
      assert.equal(SPEC_CHECK_TOOL, join(HERE, 'spec-check-cli.mjs'), 'the tool locates itself beside procedures.mjs');
      assert.equal(readFileSync(SPEC_CHECK_TOOL, 'utf8').length > 0, true, 'and the rendered path really is a file');
    } finally {
      rmSync(fromElsewhere, { recursive: true, force: true });
    }
  });

  it('plan-authoring prints NEITHER the block nor the checker (non-vacuous — the same tokens flip)', () => {
    const r = run(['plan-authoring', '--override', 'review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!SENTINEL.test(r.stdout), 'the block is plan-execution-scoped');
    assert.ok(!r.stdout.includes('spec-check-cli.mjs'), 'and so is its checker command');
    assert.deepEqual(specCheckOf(['plan-authoring'], { codex: READY, agy: READY }), [], 'the structured key is empty, never absent');
  });

  it('the JSON key set stays ADDITIVE — specCheck joins the others, none is dropped or renamed', () => {
    const json = JSON.parse(run(['plan-execution', '--json'], { codex: READY, agy: READY }).stdout);
    for (const key of ['activity', 'section', 'slots', 'reviewLoop', 'groundingPreStep', 'costLanes', 'foldScope', 'specCheck', 'autonomy', 'declaredPractice']) {
      assert.ok(key in json, `the --json contract keeps "${key}"`);
    }
    assert.ok(Array.isArray(json.specCheck), 'specCheck is an array of lines, like its siblings');
  });
});

describe('procedures CLI — the per-activity autonomy block (AD-044 Plan 4)', () => {
  it('renders the computed-defaults origin honestly when no policy file exists', () => {
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Autonomy for "plan-execution" \(computed defaults — no docs\/ai\/autonomy\.json\): prompt — every non-allowlisted command prompts/);
    assert.match(r.stdout, /red-lines \(always\): commit=ask, push=ask, publish=ask, network=deny, credentials=deny, fs_outside_repo=deny/);
    assert.match(r.stdout, /commit\/push\/publish keep their maintainer asks regardless of level/);
  });

  it('renders the DECLARED level for THIS activity from the policy file (never a retyped constant)', () => {
    writeFileSync(join(cwd, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /Autonomy for "plan-execution" \(from docs\/ai\/autonomy\.json\): sandbox — the OS sandbox confines and auto-allows/);
    const auth = run(['plan-authoring'], { codex: READY, agy: READY });
    assert.match(auth.stdout, /Autonomy for "plan-authoring" \(from docs\/ai\/autonomy\.json\): prompt/, 'an undeclared activity floors at prompt');
  });

  it('the SPARSE defaults-equivalent seed reads as computed defaults — never as a declared policy', () => {
    writeFileSync(join(cwd, 'docs', 'ai', 'autonomy.json'), '{ "_README": "note" }');
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.match(r.stdout, /Autonomy for "plan-execution" \(computed defaults — docs\/ai\/autonomy\.json is the sparse defaults-equivalent seed\): prompt/);
  });

  it('a MALFORMED policy surfaces LOUDLY in the block AND flips the exit code (config error)', () => {
    writeFileSync(join(cwd, 'docs', 'ai', 'autonomy.json'), '{ not json');
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 1, 'a scripted caller must not read a malformed policy as success');
    assert.match(r.stdout, /Autonomy \(docs\/ai\/autonomy\.json\): MALFORMED — .*STOP and fix the policy file, never guess/);
    assert.match(r.stderr, /malformed docs\/ai\/autonomy\.json/, 'stderr names the config error');
    assert.match(r.stdout, /resolved recipes for "plan-execution"/, 'the recipes/contracts still render — only the exit code flips');
  });

  it('--json carries the ADDITIVE structured autonomy counterpart', () => {
    const j = JSON.parse(run(['plan-execution', '--json'], { codex: READY, agy: READY }).stdout);
    assert.ok(Array.isArray(j.autonomy) && j.autonomy.length > 0, 'autonomy block present + non-empty');
    assert.ok(j.autonomy.some((l) => /Autonomy for "plan-execution"/.test(l)));
  });
});

describe('procedures CLI — --help is read-only and exits 0', () => {
  it('prints usage naming every activity, slot and accepted value FROM the table, and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Activities: plan-authoring, plan-execution, routine/);
    assert.match(r.stdout, /plan-authoring → author, fold, review;  plan-execution → execute, review;  routine → carrier, parallel/);
    assert.match(r.stdout, /carrier accepts solo\|subagent/);
    assert.match(r.stdout, /switch accepts on\|off/);
    assert.match(r.stdout, /the read-only backend detector plus the executor-vehicle survey/, 'readiness names BOTH sources');
    assert.match(r.stdout, /never commits/);
  });
});

describe('procedures CLI — point-of-use driving contract: verbatim, manifest-drift-guarded (non-vacuous)', () => {
  const REPO_ROOT = join(HERE, '..', '..');
  const manifestContract = (bridge, role) =>
    JSON.parse(readFileSync(join(REPO_ROOT, bridge, 'capability.json'), 'utf8')).roles[role].contract;
  // The host-level settings knobs a wrapper cmd honors, DERIVED from the manifest (drift-guarded both ways vs the advisor's read — a new knob or an appliesTo edit fails here).
  const manifestSettings = (bridge, cmd) =>
    (JSON.parse(readFileSync(join(REPO_ROOT, bridge, 'capability.json'), 'utf8')).settings ?? [])
      .filter((s) => (s.appliesTo ?? []).includes(cmd))
      .map((s) => ({ key: s.key, allowed: allowedLabel(s), retired: s.retired ?? null }));
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  // The advisor region below the verbatim canon section — the descriptor parse is scoped to it, so a canon edit naming a wrapper never leaks into the set-equality.
  const adviceRegion = (stdout) => stdout.slice(stdout.indexOf('resolved recipes for'));
  // The exact descriptor lines rendered for one wrapper (block header excluded): they set-EQUAL the manifest invocations ∪ continue — a MISSING or STALE EXTRA descriptor fails.
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
    // agy: the FULL contract renders — flags set-EQUAL the manifest descriptors, the grounding note is verbatim, and the round-2 delta is surfaced at the point of use.
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
    // A RETIRED key renders as clear-only, never as an ordinary settable knob — this surface points at the writer, and the writer refuses to set it.
    assert.match(human, /AGY_REVIEW_ALLOW_ADDDIR — RETIRED: recognized but arms nothing/);
    assert.match(human, /--unset clears an existing line/);
  });

  it('solo: no contract block in human output; contracts empty in --json (solo-omits holds)', () => {
    const r = run(['plan-authoring'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.match(r.stdout, /review: solo/);
    assert.ok(!/driving contract/.test(r.stdout), 'solo dispatches nothing — no contract to drive');
    const j = JSON.parse(run(['plan-authoring', '--json'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL }).stdout);
    assert.deepEqual(j.slots.review.contracts, []);
  });
});

// §4.0 — an installed engine too old to ship references/procedures.md must FAIL LOUDLY (exit 1, an
// "upgrade the engine" message), never a cryptic read error; the fixture models one.
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

  it('a canon whose Slots line differs from the registry WARNS at exit 0; a section without one stays silent', () => {
    const skewed = makeOldEngine();
    const canon = readFileSync(join(ENGINE_DIR, 'references', 'procedures.md'), 'utf8');
    const renderWith = () => main(['plan-authoring', '--json'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: skewed }, detect: detect(READY, READY), surveyVehicle: vehicle('missing') });
    const skewWarnings = (r) => JSON.parse(r.stdout).warnings.filter((w) => w.includes('canon lists slots'));
    try {
      writeFileSync(join(skewed, 'references', 'procedures.md'), canon.replace('Slots: author, fold, review', 'Slots: author, review'));
      const r = renderWith();
      assert.equal(r.code, 0, r.stderr);
      assert.equal(skewWarnings(r).length, 1);
      for (const token of ['canon lists slots (author, review) for plan-authoring', 'registry names (author, fold, review)', 'out of step', 'upgrade that one']) assert.ok(skewWarnings(r)[0].includes(token), token);
      writeFileSync(join(skewed, 'references', 'procedures.md'), canon.replace('Slots: author, fold, review\n', ''));
      const silent = renderWith();
      assert.equal(silent.code, 0, silent.stderr);
      assert.deepEqual(skewWarnings(silent), [], 'no Slots line — a customized canon, never a skew claim');
      assert.deepEqual(skewWarnings(run(['plan-authoring', '--json'])), [], 'the repo engine matches the registry');
    } finally {
      rmSync(skewed, { recursive: true, force: true });
    }
  });

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

describe('procedures CLI — the flow armed-halves block (P8)', () => {
  const FLOW_BLOCK = {
    schema: 1, preset: 'council', councilRounds: 3, kitMinVersion: '5.1.0',
    debtQueue: 'docs/debt.md', convergenceSummary: 'docs/convergence.md', convergenceSummaryExcluded: true,
  };
  const runWithProbe = (argv, probe) => {
    const calls = [];
    const r = main(argv, {
      cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(READY, READY),
      flowProbe: (probeCwd) => { calls.push(probeCwd); return probe; },
    });
    return { ...r, calls };
  };

  it('no flow block → byte-neutral: no armed-halves header and NO store probe', () => {
    const r = runWithProbe(['plan-execution'], { present: false, armed: false, broken: null });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(FLOW_ARMED_HALVES_HEADER), 'an unarmed config renders no flow block');
    assert.deepEqual(r.calls, [], 'the store probe never runs without a flow block');
  });

  it('a flow block renders the three halves — config, chain (probe-driven), bookkeeping tracked/declared-excluded', () => {
    writeConfig(JSON.stringify({ flow: FLOW_BLOCK }));
    const r = runWithProbe(['plan-execution'], { present: false, armed: false, broken: null });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(FLOW_ARMED_HALVES_HEADER));
    assert.match(r.stdout, /config: ARMED — preset council · councilRounds 3 · kitMinVersion 5\.1\.0/);
    assert.match(r.stdout, /chain: UNARMED — no flow store file yet \(plan adoption arms it: flow-writer adoption <plan-file>\)/);
    assert.match(r.stdout, /bookkeeping\.debtQueue: docs\/debt\.md — declared non-excluded \(the tracked-file floor verifies on the set-flow arming path, #37\)/);
    assert.match(r.stdout, /bookkeeping\.convergenceSummary: docs\/convergence\.md — DECLARED-EXCLUDED \(loud, #31\)/);
    assert.deepEqual(r.calls, [cwd], 'the probe runs exactly once, on the config cwd');
  });

  it('the chain half tracks the probe: armed, unadopted, and fail-closed BROKEN wordings', () => {
    writeConfig(JSON.stringify({ flow: FLOW_BLOCK }));
    assert.match(runWithProbe(['plan-execution'], { present: true, armed: true, broken: null }).stdout,
      /chain: ARMED — the flow store carries an adoption record/);
    assert.match(runWithProbe(['plan-execution'], { present: true, armed: false, broken: null }).stdout,
      /chain: UNARMED — a store file exists but no chain is adopted \(semantic arms stay inert, #52\)/);
    assert.match(runWithProbe(['plan-execution'], { present: true, armed: false, broken: '2 malformed line(s)' }).stdout,
      /chain: store BROKEN — 2 malformed line\(s\); every composed checker fails closed on it/);
  });
  it('the pre-fold attestation sequence renders only for an armed chain', () => {
    writeConfig(JSON.stringify({ flow: FLOW_BLOCK }));
    const sequence = JSON.parse(runWithProbe(['plan-execution', '--json'], { present: true, armed: true, broken: null }).stdout).reviewLoop.find((line) => line.includes('consult-attestation')) ?? '';
    for (const token of ['for a bridge-raised finding', 'round is open', 'nonce', 'WAIT', 'READ', 'accepted or corrected', 'flow-writer consult-attestation', '--proposed-fix-digest', 'then edit', 'A lens-raised finding re-dispatches the lens without a nonce']) assert.ok(sequence.includes(token), `armed sequence names ${token}`);
    const lensBranch = sequence.slice(sequence.indexOf('A lens-raised finding'));
    assert.ok(!lensBranch.includes('consult-attestation') && lensBranch.includes('no attestation'), 'the lens branch mints nothing');
    for (const probe of [{ present: false, armed: false, broken: null }, { present: true, armed: false, broken: null }, { present: true, armed: false, broken: 'malformed' }]) {
      const reviewLoop = JSON.parse(runWithProbe(['plan-execution', '--json'], probe).stdout).reviewLoop;
      assert.ok(!reviewLoop.some((line) => line.includes('consult-attestation')), JSON.stringify(probe));
    }
  });

  it('the DEFAULT probe reads the real store on the checker path — absent, armed, and broken lanes', () => {
    const root = mkdtempSync(join(tmpdir(), 'procedures-probe-'));
    const g = (...args) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    g('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, CONFIG_REL), JSON.stringify({ flow: FLOW_BLOCK }));
    const probeRun = () => main(['plan-execution'], { cwd: root, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(READY, READY) });
    assert.match(probeRun().stdout, /chain: UNARMED — no flow store file yet/, 'absent store → the no-store lane');
    const store = join(root, '.git', 'agent-workflow-flow.jsonl');
    writeFileSync(store, 'not json\n');
    assert.match(probeRun().stdout, /chain: store BROKEN — 1 malformed line/, 'malformed store → the fail-closed lane');
    const adoption = {
      schema: 1, kind: 'chain', purpose: 'adoption', planId: 'p1', cycle: 1, round: 0, commitEpoch: 0,
      owner: 'main', base: null, timestamp: '2026-08-01T00:00:00.000Z', stepId: null,
      fingerprint: 'a1'.repeat(32), planLabel: 'p1', createdAt: '2026-08-01T00:00:00.000Z', planDigest: '1a'.repeat(32),
    };
    writeFileSync(store, `${JSON.stringify(adoption)}\n`);
    assert.match(probeRun().stdout, /chain: ARMED — the flow store carries an adoption record/, 'adopted store → the armed lane');
    const unstatable = defaultFlowProbe(root, () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    assert.deepEqual(unstatable, { present: true, armed: false, broken: 'the store leaf cannot be stat-ed (fail closed)' }, 'a non-ENOENT stat failure reads as present-but-broken (fail closed)');
    rmSync(root, { recursive: true, force: true });
  });

  it('--json carries the structured flowHalves (empty without a flow block)', () => {
    const empty = runWithProbe(['plan-execution', '--json'], { present: false, armed: false, broken: null });
    assert.equal('flowHalves' in JSON.parse(empty.stdout), false, 'no flow block → no flowHalves key (unarmed JSON neutrality)');
    writeConfig(JSON.stringify({ flow: FLOW_BLOCK }));
    const armed = runWithProbe(['plan-execution', '--json'], { present: true, armed: true, broken: null });
    const halves = JSON.parse(armed.stdout).flowHalves;
    assert.equal(halves[0], FLOW_ARMED_HALVES_HEADER);
    assert.equal(halves.length, 5, 'header + config + chain + two bookkeeping lines');
  });
});

describe('procedures CLI — the declared source-size practice (D-17 U1)', () => {
  const AUTHORED = {
    _README: 'fixture',
    schema: 1,
    defaults: { maxLines: 400, maxLineBytes: 1000 },
    roots: ['src', 'scripts'],
    exclude: [],
    extensions: ['.mjs'],
  };
  const BASELINE = { 'src/big.mjs': { lines: 900, reason: 'initial adoption' } };
  const AGGREGATE = { src: { lines: 1200, reason: 'initial adoption' }, scripts: { lines: 40, reason: 'initial adoption' } };
  const MINTED = { ...AUTHORED, baseline: BASELINE, aggregate: AGGREGATE };
  const writePractice = (value) => writeFileSync(join(cwd, SOURCE_SIZE_CONFIG_REL), typeof value === 'string' ? value : JSON.stringify(value));

  it('render-declared-practice-with-config: a MINTED declaration renders caps and record on BOTH activities, never a rival layout rung', () => {
    writePractice(MINTED);
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const r = run([activity], { codex: READY, agy: READY });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes(DECLARED_PRACTICE_HEADER), `${activity} renders the declared practice`);
      assert.match(r.stdout, /caps: 400 lines · 1000 bytes per line, over 2 declared root\(s\)\./);
      assert.match(r.stdout, /recorded: 1 file\(s\) carry a recorded size \(debt, not permission\) · aggregate 1240 line\(s\), EXACT — growth takes a reasoned bump, never free headroom\./);
      // The plan-time layout is the planning canon's Module ledger — the advisor states facts only.
      assert.doesNotMatch(r.stdout, /at plan time:/, 'no advisor-side copy of the layout rung');
    }
  });

  it('render-authored-not-minted-line: the pre-mint state says nothing is recorded, never a zero record', () => {
    writePractice(AUTHORED);
    const r = run(['plan-authoring'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /caps: 400 lines · 1000 bytes per line, over 2 declared root\(s\)\./, 'the declared caps still bind before the mint');
    assert.match(r.stdout, /recorded: NOTHING YET — the caps are declared but no size is recorded/);
    assert.doesNotMatch(r.stdout, /0 file\(s\) carry a recorded size/, '"nothing recorded" must never read as "recorded as zero"');
  });

  it('render-incomplete-states-the-partial-record: a half-written record is neither "nothing" nor a minted one', () => {
    // The machine half is baseline + aggregate together; a file carrying one was hand-edited into that
    // PRE-mint state. Its half is not the tree's debt, and "no size is recorded" is untrue — name it.
    writePractice({ ...AUTHORED, baseline: BASELINE });
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recorded: PARTIAL — the machine record is half-written \(missing "aggregate"\), so the ratchet holds nothing yet/);
    assert.doesNotMatch(r.stdout, /1 file\(s\) carry a recorded size/, 'a half record is never rendered as the whole tree’s debt');
    assert.doesNotMatch(r.stdout, /no size is recorded/, 'a half-written record is not "nothing recorded"');
  });

  it('render-silent-without-config: a project declaring no practice is handed no invented limits', () => {
    const r = run(['plan-authoring'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(DECLARED_PRACTICE_HEADER), 'no declaration → no block');
    // Scoped BELOW the verbatim canon section: the canon's own rung names the practice conditionally, and that text is printed for every project.
    assert.doesNotMatch(r.stdout.slice(r.stdout.indexOf('resolved recipes for')), /source-size/i, 'the advisor states nothing about a practice this project never declared');
    assert.deepEqual(JSON.parse(run(['plan-authoring', '--json'], { codex: READY, agy: READY }).stdout).declaredPractice, []);
  });

  it('render-malformed-config-loud-line: an unreadable declaration is LOUD in-band and the render still completes', () => {
    for (const [label, value] of [
      ['malformed JSON', '{ not json'],
      ['unknown key', JSON.stringify({ ...MINTED, surprise: 1 })],
      ['a refused placeholder', JSON.stringify({ ...AUTHORED, roots: ['<a directory this practice covers>'] })],
    ]) {
      writePractice(value);
      const r = run(['plan-execution'], { codex: READY, agy: READY });
      assert.equal(r.code, 0, `${label}: the practice's own checker owns the exit code for its config, not this advisor`);
      assert.match(r.stdout, /Declared source-size practice: UNREADABLE — .*a declared practice is never guessed around\./, label);
      assert.match(r.stdout, /resolved recipes for "plan-execution"/, `${label}: the render still completes`);
      assert.ok(!r.stdout.includes(DECLARED_PRACTICE_HEADER), `${label}: an unreadable declaration renders no facts`);
    }
  });

  it('render-dangling-symlink-loud: a BROKEN declaration link takes the loud lane, never the silent one', () => {
    // The path HOLDS an entry, so the practice is declared — merely unreadable; silence would state "this project declares no practice" about a project that does.
    symlinkSync(join(cwd, 'nowhere.json'), join(cwd, SOURCE_SIZE_CONFIG_REL));
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Declared source-size practice: UNREADABLE — /);
    assert.ok(!r.stdout.includes(DECLARED_PRACTICE_HEADER), 'an unreadable declaration renders no facts');
  });

  it('render-json-parity: the structured field IS the human block — never a second rendering of it', () => {
    for (const value of [MINTED, AUTHORED, '{ not json']) {
      writePractice(value);
      const human = run(['plan-execution'], { codex: READY, agy: READY });
      const structured = JSON.parse(run(['plan-execution', '--json'], { codex: READY, agy: READY }).stdout).declaredPractice;
      assert.ok(structured.length > 0, 'the state renders something');
      assert.ok(human.stdout.includes(structured.join('\n')), `the human render carries the same lines, contiguously:\n${human.stdout}`);
    }
  });

  it('render-unreadable-line-stays-one-line: a project-controlled string can never forge a second render line', () => {
    // The refusal interpolates values the PROJECT controls — a JSON key may carry any character, a newline included — and the block promises exactly ONE loud line.
    writePractice(JSON.stringify({ ...MINTED, 'evil\nDeclared source-size practice: caps 9999 lines': 1 }));
    const r = run(['plan-execution'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    const structured = JSON.parse(run(['plan-execution', '--json'], { codex: READY, agy: READY }).stdout).declaredPractice;
    assert.equal(structured.length, 1, `the unreadable state renders exactly one line, got:\n${structured.join('\n')}`);
    assert.doesNotMatch(r.stdout, /^Declared source-size practice: caps 9999 lines/m, 'no forged line reaches the render');
  });

  it('help-and-mode-doc-document-the-declared-practice: both public contracts name the new output', () => {
    const help = run(['--help']).stdout;
    assert.match(help, /source-size/, '--help names the declared practice it now reads');
    assert.match(help, /declaredPractice/, '--help names the JSON field');
    const modeDoc = readFileSync(join(HERE, '..', 'references', 'modes', 'procedures.md'), 'utf8');
    assert.match(modeDoc, /declaredPractice/, 'the mode doc names the JSON field');
    assert.match(modeDoc, /UNREADABLE/, 'the mode doc states the in-band unreadable lane');
    assert.match(modeDoc, /INCOMPLETE/, 'the mode doc states the four config states');
    // The execution unit is the ledger ROW (the planning canon): the mode doc must not keep the retired per-Step model alive beside the live canon it points at.
    assert.match(modeDoc, /commits per ledger row/, 'the mode doc commits per ledger row');
    assert.doesNotMatch(modeDoc, /per Step/, 'no retired per-Step execution model in the mode doc');
  });

  it('render-why-sentence-verbatim: the ONE canonical sentence, byte-exact on every surface', () => {
    // Pinned as a LITERAL: a test comparing the render against the constant would follow any rewording, and the sentence is canon (D-17) because it never varies.
    const CANONICAL = 'A module you can hold whole is the unit of review, test pairing and safe edit; the caps turn size drift into recorded, reasoned debt instead of invisible growth.';
    assert.equal(SOURCE_SIZE_WHY, CANONICAL, 'the practice exports the canonical sentence');
    writePractice(MINTED);
    assert.ok(run(['plan-authoring'], { codex: READY, agy: READY }).stdout.includes(`  why: ${CANONICAL}`));
  });
});

describe('the procedures mode doc mirrors the registry (AD-124)', () => {
  it('names every activity, every slot and every value set of the live table', async () => {
    const { readFileSync } = await import('node:fs');
    const { ACTIVITIES, SLOT_RECIPES } = await import('./recipes.mjs');
    const doc = readFileSync(new URL('../references/modes/procedures.md', import.meta.url), 'utf8');
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      assert.ok(doc.includes(`\`${activity}\``), `the mode doc names ${activity}`);
      for (const slot of Object.keys(def.slots)) assert.ok(doc.includes(`\`${slot}\``), `the mode doc names the ${slot} slot`);
    }
    for (const values of Object.values(SLOT_RECIPES)) assert.ok(doc.includes(values.join(' | ')), `the mode doc names ${values.join(' | ')}`);
    assert.ok(!/two v1 activities/u.test(doc), 'the two-activity wording is gone');
  });
});

describe('the procedures mode doc never keeps the two-value execute list (AD-124)', () => {
  it('every execute value list in the mode doc names subagent', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../references/modes/procedures.md', import.meta.url), 'utf8');
    assert.doesNotMatch(doc, /solo \| delegated`(?! \| subagent)|solo\|delegated`(?!\|subagent)/u);
    assert.match(doc, /Subagent → Solo when the executor vehicle is missing or unusable/u);
  });
});
