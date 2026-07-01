import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, extractSection, CONFIG_REL } from './procedures.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';

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

describe('procedures CLI — --json schema (§2.0)', () => {
  it('emits activity, section, per-slot resolution, configSource, warnings', () => {
    const r = run(['plan-execution', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), ['activity', 'configSource', 'reviewLoop', 'section', 'slots', 'warnings'].sort());
    assert.equal(j.activity, 'plan-execution');
    assert.match(j.section, /## plan-execution/);
    for (const slot of ['execute', 'review']) {
      assert.ok(j.slots[slot], `slot ${slot} present`);
      assert.deepEqual(Object.keys(j.slots[slot]).sort(), ['backends', 'degradedFrom', 'reason', 'recipe', 'source'].sort());
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

describe('procedures CLI — --help is read-only and exits 0', () => {
  it('prints usage naming both activities and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-authoring/);
    assert.match(r.stdout, /plan-execution/);
    assert.match(r.stdout, /never commits/);
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
