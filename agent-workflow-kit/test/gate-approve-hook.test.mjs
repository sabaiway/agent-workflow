// gate-approve-hook.test.mjs — acceptance spec for the PreToolUse gate-approval hook
// (references/hooks/gate-approve.mjs). Hermetic: the ladder is exercised through `runHook` with
// injected env/realpath/readFile; the stdin/stdout/exit contract through REAL child-process
// spawns in a scratch project. Monorepo-only (test/ is not shipped).
//
// The load-bearing claims pinned here:
//   • approval is byte-exact + root-invariant + mode-fenced — the whole AD-021 vulnerability
//     class (append/prepend/normalize/subdir variants) never yields an `allow`;
//   • validation parity with run-gates.mjs in BOTH directions (template + live declaration
//     accepted; the runner's invalid matrix approves nothing);
//   • the residual guard asks on every documented residual form over the seeded core;
//   • the fail-safe is DECOUPLED: a broken declaration darkens only ladder (a), never (b);
//   • NO anomaly path ever exits 2 (exit 2 is an immediate block).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ALLOW_PERMISSION_MODES,
  BASH_TOOL_NAME,
  DECISION_ALLOW,
  DECISION_ASK,
  GATES_REL,
  LANES_REL,
  READ_LANE_KEY,
  HOOK_EVENT_NAME,
  RESIDUAL_CLASS_OUTPUT_FLAG,
  RESIDUAL_CLASS_REDIRECTION,
  RESIDUAL_CLASS_SUBSTITUTION,
  RESIDUAL_FORMS,
  decideBashCall,
  detectResidualClasses,
  formatDecision,
  isReadLaneCommand,
  matchSeededCorePrefix,
  readDeclarationGates,
  readReadLaneEnabled,
  runHook,
  validateDeclarationShape,
} from '../references/hooks/gate-approve.mjs';
import { validateDeclaration as runnerValidateDeclaration } from '../tools/run-gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, '..', 'references', 'hooks', 'gate-approve.mjs');
const TEMPLATE_PATH = join(HERE, '..', 'references', 'templates', 'gates.json');

// This repo's live 10-gate declaration, embedded as a FIXTURE (docs/ai is hidden/machine-local
// here — the test must stay green on a checkout without it). Kept verbatim, `_README` included:
// the validation-parity claim covers real declarations, not synthetic minimal ones.
const LIVE_DECLARATION = {
  _README:
    "This repo's gate declaration (machine-local — docs/ai is hidden here). Run all: node agent-workflow-kit/tools/run-gates.mjs (or /agent-workflow-kit gates); one: --only <id>. Each cmd is ONE bash command line (the unit-test matrix needs brace+glob expansion). Declares WHAT to check, never who executes it.",
  gates: [
    {
      id: 'unit-tests',
      title: 'Unit tests — full package matrix (node --test)',
      cmd: 'node --test agent-workflow-memory/{scripts,references/scripts,bin}/*.test.mjs agent-workflow-kit/{tools,tools/manifest,references/scripts,bin}/*.test.mjs agent-workflow-kit/test/*.test.mjs agent-workflow-engine/test/*.test.mjs antigravity-cli-bridge/bin/*.test.mjs codex-cli-bridge/bin/*.test.mjs scripts/release/*.test.mjs scripts/sync-mirrors.test.mjs',
    },
    {
      id: 'manifest-validate',
      title: 'Family manifest validate (--strict, 5 dirs)',
      cmd: 'node agent-workflow-kit/tools/manifest/validate.mjs --strict agent-workflow-memory agent-workflow-kit codex-cli-bridge antigravity-cli-bridge agent-workflow-engine',
    },
    {
      id: 'release-skill-exists',
      title: 'Local release-cycle skill present (release-scan silently skips absent targets)',
      cmd: 'test -f .claude/skills/release-cycle/SKILL.md',
    },
    {
      id: 'release-scan',
      title: 'Release scan — no AI attribution (5 dirs + workflows + root README/CHANGELOG + release scripts + mirror-sync pair + local release skill)',
      cmd: 'node agent-workflow-kit/tools/release-scan.mjs agent-workflow-memory agent-workflow-kit codex-cli-bridge antigravity-cli-bridge agent-workflow-engine .github/workflows README.md CHANGELOG.md scripts/release scripts/sync-mirrors*.mjs .claude/skills/release-cycle',
    },
    { id: 'docs-caps', title: 'Docs frontmatter caps', cmd: 'node scripts/check-docs-size.mjs' },
    { id: 'docs-index', title: 'Docs index freshness', cmd: 'node scripts/check-docs-size.mjs --check-index' },
    { id: 'changelog-rotation', title: 'Changelog rotation headroom (--check)', cmd: 'node scripts/archive-changelog.mjs --check' },
    { id: 'issues-rotation', title: 'Known-issues rotation headroom (--check)', cmd: 'node scripts/archive-issues.mjs --check' },
    { id: 'decisions-rotation', title: 'ADR cascade headroom, 3 tiers (--check)', cmd: 'node scripts/archive-decisions.mjs --check' },
    {
      id: 'review-state',
      title: 'Review receipts current for the uncommitted tree (AD-038)',
      cmd: 'node agent-workflow-kit/tools/review-state.mjs --check',
    },
  ],
};

const ROOT = '/proj';
const SUBDIR = '/proj/sub';
const ENOENT_ERROR = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

// Hermetic deps: identity realpath, an env pinning the project root, a readFile serving exactly
// one declaration (an `undefined` declaration = a missing gates.json).
const hookDeps = (declaration) => ({
  env: { CLAUDE_PROJECT_DIR: ROOT },
  realpath: (path) => path,
  readFile: (path) => {
    if (path === join(ROOT, GATES_REL) && declaration !== undefined) {
      return typeof declaration === 'string' ? declaration : JSON.stringify(declaration);
    }
    throw ENOENT_ERROR();
  },
});

// Like hookDeps, but also serves docs/ai/lanes.json (the opt-in read-lane config). `laneConfig`
// undefined = the file is ABSENT (lane dark, the 1.47.0 characterization); a string is served raw
// (malformed-JSON cases); an object is JSON-stringified.
const hookDepsLane = (declaration, laneConfig) => ({
  env: { CLAUDE_PROJECT_DIR: ROOT },
  realpath: (path) => path,
  readFile: (path) => {
    if (path === join(ROOT, GATES_REL) && declaration !== undefined) {
      return typeof declaration === 'string' ? declaration : JSON.stringify(declaration);
    }
    if (path === join(ROOT, LANES_REL) && laneConfig !== undefined) {
      return typeof laneConfig === 'string' ? laneConfig : JSON.stringify(laneConfig);
    }
    throw ENOENT_ERROR();
  },
});

const bashPayload = (command, over = {}) =>
  JSON.stringify({ tool_name: BASH_TOOL_NAME, tool_input: { command }, cwd: ROOT, permission_mode: 'default', ...over });

const decisionOf = (result) => result?.permissionDecision ?? null;

// ── ladder (a): declared-gate exact match ─────────────────────────────────────────────

describe('declared-gate exact match approves (byte-exact, trim-only tolerance)', () => {
  for (const gate of LIVE_DECLARATION.gates) {
    it(`approves the live "${gate.id}" gate cmd byte-exact`, () => {
      const result = runHook(bashPayload(gate.cmd), hookDeps(LIVE_DECLARATION));
      assert.equal(decisionOf(result), DECISION_ALLOW);
      assert.match(result.permissionDecisionReason, new RegExp(`"${gate.id}"`, 'u'));
    });
  }

  it('tolerates leading/trailing whitespace ONLY (trim, no other normalization)', () => {
    const cmd = LIVE_DECLARATION.gates[0].cmd;
    const result = runHook(bashPayload(`  ${cmd}\t`), hookDeps(LIVE_DECLARATION));
    assert.equal(decisionOf(result), DECISION_ALLOW);
  });

  it('an undeclared command gets NO decision', () => {
    assert.equal(runHook(bashPayload('node scripts/undeclared.mjs'), hookDeps(LIVE_DECLARATION)), null);
  });
});

// ── the AD-021 vulnerability class: never an allow ────────────────────────────────────

describe('the vulnerability class is REJECTED — no allow emitted', () => {
  const cmd = 'node --test agent-workflow-kit/test/*.test.mjs';
  const declaration = { gates: [{ id: 'a', title: 'A', cmd }] };
  const variants = [
    ['appended `; rm -rf /`', `${cmd}; rm -rf /`],
    ['appended `> pwned`', `${cmd} > pwned`],
    ['appended `>> pwned`', `${cmd} >> pwned`],
    ['appended `$(evil)`', `${cmd} $(evil)`],
    ['appended backticks', `${cmd} \`evil\``],
    ['appended `&& git push`', `${cmd} && git push`],
    ['prepended `env X=1 `', `env X=1 ${cmd}`],
    ['inner whitespace collapsed', cmd.replace('node --test', 'node  --test')],
    ['case-changed', cmd.replace('node', 'Node')],
  ];
  for (const [name, variant] of variants) {
    it(`${name} → not approved`, () => {
      const result = runHook(bashPayload(variant), hookDeps(declaration));
      assert.notEqual(decisionOf(result), DECISION_ALLOW);
    });
  }

  it('the byte-exact declared cmd from a SUBDIRECTORY of the project root → not approved', () => {
    const result = runHook(bashPayload(cmd, { cwd: SUBDIR }), hookDeps(declaration));
    assert.notEqual(decisionOf(result), DECISION_ALLOW);
  });
});

// ── validation parity with run-gates.mjs, BOTH directions ────────────────────────────

describe('declaration validation parity with run-gates.mjs', () => {
  const shippedTemplate = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  const runnerAccepts = (parsed) => {
    try {
      runnerValidateDeclaration(parsed);
      return true;
    } catch {
      return false;
    }
  };

  it('the shipped references/templates/gates.json is VALID (carries _README)', () => {
    assert.equal(typeof shippedTemplate._README, 'string');
    assert.equal(validateDeclarationShape(shippedTemplate).ok, true);
  });

  it("this repo's live 10-gate declaration is VALID (carries _README)", () => {
    const validated = validateDeclarationShape(LIVE_DECLARATION);
    assert.equal(validated.ok, true);
    assert.equal(validated.gates.length, 10);
  });

  // The run-gates.test.mjs invalid-declaration matrix, mirrored: a declaration the runner
  // rejects never auto-approves anything.
  const invalidMatrix = [
    ['a non-object top level', []],
    ['an unknown top-level key', { gates: [], lanes: {} }],
    ['a non-string _README', { _README: 42, gates: [] }],
    ['a missing gates array', { _README: 'x' }],
    ['a non-object gate entry', { gates: ['nope'] }],
    ['an unknown gate key', { gates: [{ id: 'a', title: 'A', cmd: 'x', model: 'haiku' }] }],
    ['a missing cmd', { gates: [{ id: 'a', title: 'A' }] }],
    ['an empty title', { gates: [{ id: 'a', title: '  ', cmd: 'x' }] }],
    ['a non-kebab id', { gates: [{ id: 'Unit_Tests', title: 'A', cmd: 'x' }] }],
    ['an embedded newline in cmd', { gates: [{ id: 'a', title: 'A', cmd: 'echo x\nrm -rf y' }] }],
    ['a duplicate id', { gates: [{ id: 'a', title: 'A', cmd: 'x' }, { id: 'a', title: 'B', cmd: 'y' }] }],
  ];
  for (const [name, parsed] of invalidMatrix) {
    it(`rejects ${name} — and approves nothing from it`, () => {
      assert.equal(validateDeclarationShape(parsed).ok, false);
      assert.notEqual(decisionOf(runHook(bashPayload('x'), hookDeps(parsed))), DECISION_ALLOW);
    });
  }

  // The OPTIONAL lcovProducer marker: the two validators must land on the SAME verdict per row, or
  // a marker-carrying declaration the runner runs happily would silently lose auto-approval here
  // (hook stricter) — or a malformed marker the runner refuses would still approve commands (hook
  // looser). Both directions are the point, so every row asserts both sides.
  const MARKED_CMD = 'pnpm vitest run --coverage';
  const marked = (marker) => ({ gates: [{ id: 'suite', title: 'Suite', cmd: MARKED_CMD, lcovProducer: marker }] });
  const markerMatrix = [
    ['the literal true', marked(true), true],
    ['the literal false', marked(false), true],
    ['a string "true"', marked('true'), false],
    ['a null marker', marked(null), false],
    ['a numeric marker', marked(1), false],
    ['the marker beside an unknown key', { gates: [{ id: 'suite', title: 'Suite', cmd: MARKED_CMD, lcovProducer: true, model: 'haiku' }] }, false],
  ];
  for (const [name, parsed, accepted] of markerMatrix) {
    it(`lcovProducer — ${name}: runner and hook agree (${accepted ? 'accepted' : 'rejected'})`, () => {
      assert.equal(runnerAccepts(parsed), accepted, 'the runner side of the row');
      assert.equal(validateDeclarationShape(parsed).ok, accepted, 'the hook side of the row');
    });
  }

  it('a marker-carrying declaration still AUTO-APPROVES its byte-exact declared cmd', () => {
    // Parity as a boolean is not the whole claim: the accepted declaration must still reach ladder
    // (a) and approve, or the marker would cost the project its velocity tier in practice.
    assert.equal(decisionOf(runHook(bashPayload(MARKED_CMD), hookDeps(marked(true)))), DECISION_ALLOW);
    assert.notEqual(decisionOf(runHook(bashPayload(MARKED_CMD), hookDeps(marked('true')))), DECISION_ALLOW);
  });

  // D8 — the cost of the marker being FORWARD-ONLY, characterized rather than assumed. A placed hook
  // that predates a gate key treats it as unknown and goes DARK: auto-approval off, every gate
  // prompting again, no error anywhere. That silence is exactly why the advisor carries a
  // marker-scoped reseed arm — this pins the mechanism the arm exists for.
  it('a key this hook does not know darkens ladder (a) SILENTLY — auto-approval off, exit 0, no crash', () => {
    const fromTheFuture = { gates: [{ id: 'suite', title: 'Suite', cmd: MARKED_CMD, lcovProducerV2: true }] };
    assert.equal(validateDeclarationShape(fromTheFuture).ok, false, 'an unknown gate key is not a shape this hook can honor');
    assert.equal(readDeclarationGates('/anywhere', { readFile: () => JSON.stringify(fromTheFuture) }), null, 'so the declaration reads as none at all');
    // NULL, not a block: the hook emits no decision at all, so the host falls back to its ordinary
    // prompt. A darkened declaration must never become an exit-2 refusal of the user's own command.
    assert.equal(runHook(bashPayload(MARKED_CMD), hookDeps(fromTheFuture)), null, 'the cmd the runner runs happily stops auto-approving');
    // The decoupling still holds: ladder (b) keeps running over a darkened declaration, so the
    // failure mode really is "quietly less velocity", never "quietly less safety".
    assert.equal(decisionOf(runHook(bashPayload('cat x > y'), hookDeps(fromTheFuture))), DECISION_ASK);
  });

  it('accepts/rejects EXACTLY where the runner does (shared-fixture cross-check)', () => {
    const fixtures = [
      shippedTemplate,
      LIVE_DECLARATION,
      { gates: [{ id: 'a', title: 'A', cmd: 'x' }] },
      { _README: 'doc', gates: [] },
      ...invalidMatrix.map(([, parsed]) => parsed),
      ...markerMatrix.map(([, parsed]) => parsed),
    ];
    for (const fixture of fixtures) {
      assert.equal(validateDeclarationShape(fixture).ok, runnerAccepts(fixture));
    }
  });
});

// ── ladder (b): the residual guard ────────────────────────────────────────────────────

describe('residual guard asks on seeded-core commands carrying the documented residual', () => {
  const noDeclaration = hookDeps(undefined);

  for (const form of RESIDUAL_FORMS.writeRedirections) {
    it(`write redirection \`${form}\` over a seeded-core command → ask`, () => {
      const result = runHook(bashPayload(`grep pattern file ${form} out`), noDeclaration);
      assert.equal(decisionOf(result), DECISION_ASK);
      assert.match(result.permissionDecisionReason, /output redirection/u);
    });
  }

  it('command substitution `$(…)` → ask', () => {
    const result = runHook(bashPayload('cat $(evil) file'), noDeclaration);
    assert.equal(decisionOf(result), DECISION_ASK);
    assert.match(result.permissionDecisionReason, /command substitution/u);
  });

  it('command substitution via backticks → ask', () => {
    assert.equal(decisionOf(runHook(bashPayload('cat `evil` file'), noDeclaration)), DECISION_ASK);
  });

  it('process substitution `<(…)` over a seeded-core command → ask (it RUNS a nested command)', () => {
    const result = runHook(bashPayload('cat <(touch pwned)'), noDeclaration);
    assert.equal(decisionOf(result), DECISION_ASK);
    assert.match(result.permissionDecisionReason, /command substitution/u);
  });

  it('the bounded --output= write flag → ask', () => {
    const result = runHook(bashPayload('git log --output=stolen.txt'), noDeclaration);
    assert.equal(decisionOf(result), DECISION_ASK);
    assert.match(result.permissionDecisionReason, /--output/u);
  });

  it('the bare --output <file> form → ask', () => {
    assert.equal(decisionOf(runHook(bashPayload('git diff --output stolen.txt'), noDeclaration)), DECISION_ASK);
  });

  it('a QUOTED --output flag still asks (the hook sees the pre-shell string; quotes must not hide it)', () => {
    // The shell strips the quotes and git gets a real write flag — a whitespace-token check would
    // miss `"--output=out"`; the substring scan must not.
    assert.equal(decisionOf(runHook(bashPayload('git log "--output=out"'), noDeclaration)), DECISION_ASK);
    assert.equal(decisionOf(runHook(bashPayload("git diff '--output' out"), noDeclaration)), DECISION_ASK);
    assert.equal(decisionOf(runHook(bashPayload('git show \\--output=out'), noDeclaration)), DECISION_ASK);
  });

  it('a DECLARED gate whose cmd contains metachars still gets allow (ladder order a > b)', () => {
    const declaration = { gates: [{ id: 'grep-gate', title: 'G', cmd: 'grep -r "todo" . > /dev/null' }] };
    const result = runHook(bashPayload('grep -r "todo" . > /dev/null'), hookDeps(declaration));
    assert.equal(decisionOf(result), DECISION_ALLOW);
  });

  it('a non-core, non-gate command with metachars → NO decision', () => {
    assert.equal(runHook(bashPayload('node build.js > out.log'), noDeclaration), null);
  });

  it('a kit-tool invocation with a residual byte INSIDE a quoted argument → NO decision, while the same byte in a core command asks', () => {
    // Characterization of EXISTING behaviour (green from the start, never a red-first test): rung (b)
    // is gated on seeded-core membership — `matchSeededCorePrefix` runs BEFORE
    // `detectResidualClasses` — so a kit tool never reaches the residual scan whatever bytes its
    // arguments carry. THIS test is the evidence for that claim; a dispatched command is not, because
    // an approved prompt and a never-prompted command are indistinguishable from the caller's side.
    const kitToolCall = 'node agent-workflow-kit/tools/release-scan.mjs "a>b"';
    assert.equal(matchSeededCorePrefix(kitToolCall), null, 'a kit tool must never be a seeded-core prefix');
    assert.equal(runHook(bashPayload(kitToolCall), noDeclaration), null);
    // The contrast IS the point — the identical byte in a seeded-core command asks, which is the
    // mechanism behind the quoted-pattern firings. Quoting protects nothing: the scan also runs over
    // a copy with quote characters stripped.
    assert.equal(decisionOf(runHook(bashPayload('grep -n "a>b" file'), noDeclaration)), DECISION_ASK);
  });

  it('a seeded-core command WITHOUT residual → NO decision (the guard never blanket-asks)', () => {
    assert.equal(runHook(bashPayload('grep -r pattern .'), noDeclaration), null);
  });

  it('core matching is word-boundary token matching, not string prefix', () => {
    assert.equal(matchSeededCorePrefix('grep -r x .'), 'grep');
    assert.equal(matchSeededCorePrefix('grepx -r x .'), null);
    assert.equal(matchSeededCorePrefix('git branch --list'), 'git branch --list');
    assert.equal(matchSeededCorePrefix('git push origin main'), null);
  });
});

// ── mode fencing ──────────────────────────────────────────────────────────────────────

describe('mode fencing — allow only under default/acceptEdits', () => {
  const cmd = LIVE_DECLARATION.gates[0].cmd;

  for (const mode of ['plan', 'bypassPermissions', 'weird-future-mode']) {
    it(`permission_mode "${mode}" → never allow`, () => {
      const result = runHook(bashPayload(cmd, { permission_mode: mode }), hookDeps(LIVE_DECLARATION));
      assert.notEqual(decisionOf(result), DECISION_ALLOW);
    });
  }

  for (const mode of ALLOW_PERMISSION_MODES) {
    it(`permission_mode "${mode}" → allow`, () => {
      const result = runHook(bashPayload(cmd, { permission_mode: mode }), hookDeps(LIVE_DECLARATION));
      assert.equal(decisionOf(result), DECISION_ALLOW);
    });
  }

  it('the residual guard is NOT mode-fenced (an ask never loosens): asks under plan too', () => {
    const result = runHook(bashPayload('grep x file > f', { permission_mode: 'plan' }), hookDeps(undefined));
    assert.equal(decisionOf(result), DECISION_ASK);
  });
});

// ── fail-safe: decoupled per function ─────────────────────────────────────────────────

describe('fail-safe — a declaration anomaly darkens ONLY ladder (a)', () => {
  const anomalies = [
    ['missing gates.json', undefined],
    ['malformed JSON', '{ nope'],
    ['schema-invalid declaration', { gates: [{ id: 'a', title: 'A', cmd: 'x', model: 'haiku' }] }],
  ];
  for (const [name, declaration] of anomalies) {
    it(`${name}: a declared-looking cmd gets NO decision, the residual guard STILL asks`, () => {
      assert.equal(runHook(bashPayload('x'), hookDeps(declaration)), null);
      assert.equal(decisionOf(runHook(bashPayload('grep x file > f'), hookDeps(declaration))), DECISION_ASK);
    });
  }

  it('readDeclarationGates: no project root → null (no declaration, ladder (a) dark)', () => {
    assert.equal(readDeclarationGates(null, {}), null);
    assert.equal(readDeclarationGates('', {}), null);
  });

  it('input anomalies darken the WHOLE hook: non-Bash tool, missing/blank command, bad shapes', () => {
    assert.equal(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { command: 'x' }, cwd: ROOT }), hookDeps(LIVE_DECLARATION)), null);
    assert.equal(runHook(JSON.stringify({ tool_name: BASH_TOOL_NAME, cwd: ROOT }), hookDeps(LIVE_DECLARATION)), null);
    assert.equal(runHook(bashPayload('   '), hookDeps(LIVE_DECLARATION)), null);
    assert.equal(runHook('not json at all', hookDeps(LIVE_DECLARATION)), null);
    assert.equal(runHook(JSON.stringify(['array']), hookDeps(LIVE_DECLARATION)), null);
  });
});

// ── the stdin/stdout/exit contract (real child-process spawns) ────────────────────────

describe('spawned hook — decision shape, exit codes, never exit 2', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gate-hook-spec-'));
  const toyGate = { id: 'toy-gate', title: 'Toy', cmd: 'echo gate-ok' };
  mkdirSync(join(scratch, dirname(GATES_REL)), { recursive: true });
  mkdirSync(join(scratch, 'sub'), { recursive: true });
  writeFileSync(join(scratch, GATES_REL), JSON.stringify({ _README: 'toy', gates: [toyGate] }));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const spawnHook = (input, { env = { CLAUDE_PROJECT_DIR: scratch }, cwd = scratch } = {}) => {
    const cleanEnv = { ...process.env, ...env };
    if (!('CLAUDE_PROJECT_DIR' in env)) delete cleanEnv.CLAUDE_PROJECT_DIR;
    return spawnSync(process.execPath, [HOOK_PATH], { input, cwd, env: cleanEnv, encoding: 'utf8' });
  };

  const payload = (command, over = {}) =>
    JSON.stringify({ tool_name: BASH_TOOL_NAME, tool_input: { command }, cwd: scratch, permission_mode: 'default', ...over });

  it('emits the exact contract JSON for an allow (the decision-shape fixture)', () => {
    const res = spawnHook(payload(toyGate.cmd));
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), {
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT_NAME,
        permissionDecision: DECISION_ALLOW,
        permissionDecisionReason: `agent-workflow gates: byte-exact match of declared gate "${toyGate.id}" (${GATES_REL}), invoked from the project root`,
      },
    });
  });

  it('formatDecision matches the contract fixture shape', () => {
    const parsed = JSON.parse(formatDecision({ permissionDecision: DECISION_ASK, permissionDecisionReason: 'r' }));
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  });

  it('emits an ask for a residual-carrying core command', () => {
    const res = spawnHook(payload('grep x file > exfil'));
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, DECISION_ASK);
  });

  it('stays silent (exit 0, no output) on a no-decision command', () => {
    const res = spawnHook(payload('ls -la'));
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('the declared cmd from a subdirectory cwd → silent (the position invariant, live)', () => {
    const res = spawnHook(payload(toyGate.cmd, { cwd: join(scratch, 'sub') }));
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('falls back to the stdin cwd as project root when CLAUDE_PROJECT_DIR is absent', () => {
    const res = spawnHook(payload(toyGate.cmd), { env: {} });
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, DECISION_ALLOW);
  });

  it('NO anomaly path ever exits 2: garbage stdin, non-Bash tool, broken declaration', () => {
    const broken = mkdtempSync(join(tmpdir(), 'gate-hook-broken-'));
    mkdirSync(join(broken, dirname(GATES_REL)), { recursive: true });
    writeFileSync(join(broken, GATES_REL), '{ nope');
    after(() => rmSync(broken, { recursive: true, force: true }));

    const garbage = spawnHook('not json');
    assert.equal(garbage.status, 0);
    assert.equal(garbage.stdout, '');

    const nonBash = spawnHook(JSON.stringify({ tool_name: 'Read', tool_input: {}, cwd: scratch }));
    assert.equal(nonBash.status, 0);
    assert.equal(nonBash.stdout, '');

    const brokenDeclared = spawnHook(
      JSON.stringify({ tool_name: BASH_TOOL_NAME, tool_input: { command: toyGate.cmd }, cwd: broken, permission_mode: 'default' }),
      { env: { CLAUDE_PROJECT_DIR: broken }, cwd: broken },
    );
    assert.equal(brokenDeclared.status, 0);
    assert.equal(brokenDeclared.stdout, '');

    const brokenGuard = spawnHook(
      JSON.stringify({ tool_name: BASH_TOOL_NAME, tool_input: { command: 'grep x file > f' }, cwd: broken, permission_mode: 'default' }),
      { env: { CLAUDE_PROJECT_DIR: broken }, cwd: broken },
    );
    assert.equal(brokenGuard.status, 0);
    assert.equal(JSON.parse(brokenGuard.stdout).hookSpecificOutput.permissionDecision, DECISION_ASK);
  });
});

// ── ladder (c): the opt-in read-lane (docs/ai/lanes.json) ──────────────────────────────

describe('read-lane config read — live, fail-closed (docs/ai/lanes.json; Decisions 5)', () => {
  it('readLane: true → the lane is enabled', () => {
    assert.equal(readReadLaneEnabled(ROOT, hookDepsLane(undefined, { readLane: true })), true);
  });

  const off = [
    ['absent lanes.json', undefined],
    ['readLane: false', { readLane: false }],
    ['readLane missing (other keys only)', { _README: 'x' }],
    ['readLane the STRING "true" (non-boolean)', { readLane: 'true' }],
    ['readLane the number 1 (non-boolean)', { readLane: 1 }],
    ['malformed JSON', '{ nope'],
    ['a non-object root (array)', ['readLane']],
    ['a non-object root (null literal)', 'null'],
  ];
  for (const [name, config] of off) {
    it(`${name} → lane dark`, () => {
      assert.equal(readReadLaneEnabled(ROOT, hookDepsLane(undefined, config)), false);
    });
  }

  it('no project root → false (never throws)', () => {
    assert.equal(readReadLaneEnabled(null, {}), false);
    assert.equal(readReadLaneEnabled('', {}), false);
  });

  it('the lane lives in a SEPARATE file/key from gates.json — the gates schema is untouched', () => {
    assert.notEqual(LANES_REL, GATES_REL);
    assert.equal(LANES_REL, 'docs/ai/lanes.json');
    assert.equal(READ_LANE_KEY, 'readLane');
    // gates.json validation still REJECTS a lane field (the run-gates-parity schema is unchanged).
    assert.equal(validateDeclarationShape({ gates: [], readLane: true }).ok, false);
  });
});

describe('read-lane rung (c) — approves core-read compounds ONLY when the lane is on', () => {
  const laneOn = hookDepsLane(undefined, { readLane: true });
  const approve = [
    ['&& chain', 'git status && git diff'],
    ['|| chain', 'cat a.txt || cat b.txt'],
    ['; chain', 'grep foo file ; ls -la'],
    ['| pipe of two core reads', 'ls -la | grep foo'],
    ['|& pipe of two core reads', 'grep x file |& cat'],
    ['newline-separated', 'git log\ngit status'],
    ['three segments, mixed separators', 'ls ; grep x f && wc -l f'],
    ['leading/trailing whitespace tolerated', '   git status && git diff\t'],
    ['a single core read (trivially in-lane)', 'grep -rn pattern .'],
    ['multi-token core prefixes', 'git branch --list && git tag --list'],
  ];
  for (const [name, cmd] of approve) {
    it(`${name} → allow`, () => {
      const result = runHook(bashPayload(cmd), laneOn);
      assert.equal(decisionOf(result), DECISION_ALLOW);
      assert.match(result.permissionDecisionReason, /read-lane/u);
    });
  }

  it('a core-read compound from a SUBDIRECTORY cwd → still allow (rung (c) is cwd-agnostic)', () => {
    assert.equal(decisionOf(runHook(bashPayload('git status && git diff', { cwd: SUBDIR }), laneOn)), DECISION_ALLOW);
  });

  it('characterization: with lanes.json ABSENT the hook byte-behaves as 1.47.0 — the same compounds get NO decision', () => {
    for (const [, cmd] of approve) {
      assert.equal(runHook(bashPayload(cmd), hookDepsLane(undefined, undefined)), null);
    }
  });

  it('lane on but mode outside the fence (plan / bypassPermissions) → NO allow', () => {
    for (const mode of ['plan', 'bypassPermissions']) {
      assert.notEqual(decisionOf(runHook(bashPayload('git status && git diff', { permission_mode: mode }), laneOn)), DECISION_ALLOW);
    }
  });

  it('lane readLane:false / malformed → the same compound gets NO allow', () => {
    assert.notEqual(decisionOf(runHook(bashPayload('git status && git diff'), hookDepsLane(undefined, { readLane: false }))), DECISION_ALLOW);
    assert.notEqual(decisionOf(runHook(bashPayload('git status && git diff'), hookDepsLane(undefined, '{ nope'))), DECISION_ALLOW);
  });
});

describe('read-lane rung (c) — the adversarial no-allow battery (lane ON; never allow, never deny)', () => {
  const laneOn = hookDepsLane(undefined, { readLane: true });
  // LITERAL named cases (NOT an iteration over the frozen list — an anti-shrink guard). Each MUST
  // NOT be auto-approved by rung (c); some ASK via rung (b) (a core prefix carrying a residual), the
  // rest get NO decision — but NEVER an allow, and NEVER a deny.
  const battery = [
    ['backtick substitution', 'cat `evil` file'],
    ['$(…) substitution', 'cat $(evil) file'],
    ['<(…) process substitution', 'cat <(touch pwned)'],
    ['> redirection', 'grep x file > out'],
    ['>> redirection', 'grep x file >> out'],
    ['--output write flag', 'git log --output=stolen'],
    ['pipe to sh', 'grep x file | sh'],
    ['pipe to tee', 'grep x file | tee out'],
    ['pipe to xargs', 'grep x file | xargs rm'],
    ['pipe to node', 'grep x file | node app.js'],
    ['git push segment', 'git status && git push'],
    ['git commit segment', 'git status && git commit -m x'],
    ['rm segment', 'ls -la && rm -rf /'],
    ['git -c global option (leading-token mismatch)', 'git -c core.pager=cat log'],
    ['git -C global option (leading-token mismatch)', 'git -C /other/repo log'],
    ['quoted argv0 (double)', '"grep" x file'],
    ['quoted argv0 (single)', "'grep' x file"],
    ['absolute-path argv0', '/bin/grep x file'],
    ['quoted separator inside an arg (quote-blind over-split)', 'grep "a;b" file'],
    ['quote-splice reconstructing --output', 'git log --out"put"=x'],
    ['backslash splice', 'cat fi\\le'],
    ['brace expansion', 'grep --{a,b} file'],
    ['glob pathname expansion', 'grep x *.mjs && ls'],
    ['$VAR expansion', 'grep $VAR file'],
    ['${VAR} expansion', 'grep ${VAR} file'],
    ['$((arith))', 'grep $((1+1)) file'],
    ['funsub ${ …; }', 'grep ${ ls; } file'],
    ['funsub ${| …; }', 'grep ${| ls; } file'],
    ['env prefix on a core read', 'PATH=/x grep foo file'],
    ['env prefix on git', 'FOO=bar git log'],
    ['bare & backgrounding', 'ls -la & grep x file'],
    ['trailing empty segment', 'grep x file ; '],
    ['leading empty segment', '; grep x file'],
    ['adjacent empty segments', 'grep x file ;; ls'],
  ];
  for (const [name, cmd] of battery) {
    it(`${name} → never allow, never deny`, () => {
      const result = runHook(bashPayload(cmd), laneOn);
      assert.notEqual(decisionOf(result), DECISION_ALLOW);
      // the hook never emits deny — a non-null decision is only ever an ask.
      if (result !== null) assert.equal(result.permissionDecision, DECISION_ASK);
    });
  }

  // An ask is answered by the HUMAN and its reason never reaches the caller that composed the
  // command, so for two months the guard has known the right lane and had no way to say it. Probed
  // live 2026-07-28: `additionalContext` is delivered to the model on allow, on ask, and on no
  // decision alike. It rides the ASK here — the refusal-shaped channel is what seven withdrawn
  // mechanisms were chasing, and this one refuses nothing. A host that ignores the field degrades to
  // exactly today's behaviour: silence.
  describe('the ask teaches the caller, not only the human', () => {
    const noDeclaration = hookDeps(undefined);

    it('a residual on a seeded-core read carries a lane hint addressed to the caller', () => {
      const result = runHook(bashPayload('wc -l a b c 2>/dev/null'), noDeclaration);
      assert.equal(decisionOf(result), DECISION_ASK);
      assert.match(result.additionalContext, /path-inventory/u);
    });

    it('a residual on a scanned kit tool names THAT tool\'s out-of-band lane to the caller', () => {
      const result = runHook(bashPayload('node agent-workflow-kit/tools/repo-search.mjs --pattern "a>b"'), noDeclaration);
      assert.equal(decisionOf(result), DECISION_ASK);
      assert.match(result.additionalContext, /--pattern-file/u);
    });

    // A command naming BOTH scanned tools must not be advised about whichever sits earlier in the
    // registry — the residual may belong to the other one.
    it('a command naming two scanned tools is advised about BOTH', () => {
      const cmd = 'node agent-workflow-kit/tools/repo-search.mjs --pattern-file p.txt --path "$(node agent-workflow-kit/tools/path-inventory.mjs --path src)"';
      const result = runHook(bashPayload(cmd), noDeclaration);
      assert.equal(decisionOf(result), DECISION_ASK);
      assert.match(result.additionalContext, /--pattern-file/u);
      assert.match(result.additionalContext, /path-inventory/u);
      assert.match(result.permissionDecisionReason, /repo-search/u);
      assert.match(result.permissionDecisionReason, /path-inventory/u);
    });

    it('an ALLOW carries no hint — a command that is already right has nothing to be taught', () => {
      const laneOn = hookDepsLane(undefined, { readLane: true });
      const allowed = runHook(bashPayload('git status && ls -la'), laneOn);
      assert.equal(decisionOf(allowed), DECISION_ALLOW);
      assert.equal(allowed.additionalContext, undefined);
    });

    it('the hint is carried in the emitted JSON, not merely computed', () => {
      const result = runHook(bashPayload('wc -l a b c 2>/dev/null'), noDeclaration);
      const emitted = JSON.parse(formatDecision(result));
      assert.match(emitted.hookSpecificOutput.additionalContext, /path-inventory/u);
      assert.equal(emitted.hookSpecificOutput.hookEventName, HOOK_EVENT_NAME);
    });
  });

  it('anti-shrink: RESIDUAL_FORMS still carries backtick + $( (rung (b) coverage cannot silently thin)', () => {
    assert.ok(RESIDUAL_FORMS.commandSubstitutions.includes('`'));
    assert.ok(RESIDUAL_FORMS.commandSubstitutions.includes('$('));
  });

  it('subset invariant: every segment of a lane-ALLOWED compound is itself a seeded-core read', () => {
    const allowed = 'git status && grep foo file ; ls -la';
    assert.equal(decisionOf(runHook(bashPayload(allowed), laneOn)), DECISION_ALLOW);
    for (const seg of allowed.split(/&&|;|\|\||\|/)) {
      assert.notEqual(matchSeededCorePrefix(seg.trim()), null);
    }
    // a compound with ONE non-core segment is refused — the lane adds no per-command exposure.
    assert.notEqual(decisionOf(runHook(bashPayload('git status && rm -rf /'), laneOn)), DECISION_ALLOW);
  });
});

describe('rung (b) funsub extension (Decisions 8) — a settings-allowed SINGLE', () => {
  const noLane = hookDeps(undefined);
  it('funsub `${ cmd; }` (space blank) on a core single → ask', () => {
    assert.equal(decisionOf(runHook(bashPayload('grep ${ ls; } file'), noLane)), DECISION_ASK);
  });
  it('funsub `${| cmd; }` on a core single → ask', () => {
    assert.equal(decisionOf(runHook(bashPayload('grep ${| ls; } file'), noLane)), DECISION_ASK);
  });
  it('funsub with a newline blank on a core single → ask', () => {
    assert.equal(decisionOf(runHook(bashPayload('grep ${\n ls; } file'), noLane)), DECISION_ASK);
  });
  it('ordinary `${VAR}` on a core single → NO decision (stays rung-(b)-silent, both directions)', () => {
    assert.equal(runHook(bashPayload('grep ${VAR} file'), noLane), null);
  });
  it('ordinary `$VAR` on a core single → NO decision', () => {
    assert.equal(runHook(bashPayload('grep $VAR file'), noLane), null);
  });
});

// ── council round-1 folds (AD-055 Part II) ─────────────────────────────────────────────

describe('read-lane rung (c) — glob brackets close the lane (council B1)', () => {
  const laneOn = hookDepsLane(undefined, { readLane: true });
  it('glob character-class `[`/`]` takes a command OUT of the lane (splice-reconstruction of --output)', () => {
    // `--outpu[t]=target` glob-reconstructs `--output=target` past the raw --output substring scan; if a
    // file so named exists the shell writes. `[`/`]` must be forbidden like `*`/`?`/`{`/`}`.
    assert.notEqual(decisionOf(runHook(bashPayload('git log --outpu[t]=target && git status'), laneOn)), DECISION_ALLOW);
    assert.equal(isReadLaneCommand('git log --outpu[t]=target && git status'), false);
    assert.equal(isReadLaneCommand('grep x [abc].txt'), false);
    assert.equal(isReadLaneCommand('grep x [abc].txt && ls'), false);
  });
});

describe('residual guard — backslash-newline splice + funsub CR (council B3 + agy nit1)', () => {
  const noLane = hookDeps(undefined);
  it('a backslash-newline line-continuation splice on a settings-allowed SINGLE → ask', () => {
    // bash removes `\<newline>` and splices the words: `--outp\<LF>ut=f` becomes `--output=f`, past the
    // raw --output scan; `${\<LF> ls; }` becomes the funsub `${ ls; }`. Both must ASK.
    assert.equal(decisionOf(runHook(bashPayload('git log --outp\\\nut=f'), noLane)), DECISION_ASK);
    assert.equal(decisionOf(runHook(bashPayload('grep ${\\\n ls; } file'), noLane)), DECISION_ASK);
  });
  it('funsub with a CR blank `${\\r …; }` on a settings-allowed SINGLE → ask (CRLF completeness)', () => {
    assert.equal(decisionOf(runHook(bashPayload('grep ${\r ls; } file'), noLane)), DECISION_ASK);
  });
  it('rung (c) also rejects a spliced compound', () => {
    const laneOn = hookDepsLane(undefined, { readLane: true });
    assert.notEqual(decisionOf(runHook(bashPayload('git log --outp\\\nut=f && ls'), laneOn)), DECISION_ALLOW);
  });
});

describe('residual guard — word-construction reconstructs --output on a SINGLE (council R2-M1)', () => {
  const noLane = hookDeps(undefined);
  // The literal --output scan is defeated by quoting/backslash/bracket/brace splicing that Bash
  // collapses back to --output on a settings-allowed single. The de-spliced re-scan must ASK.
  const cases = [
    ['quote-splice', 'git log --out"put"=target'],
    ['single-quote splice', "git log --out'put'=target"],
    ['backslash splice', 'git log --out\\put=target'],
    ['glob-bracket splice', 'git log --outpu[t]=target'],
    ['brace splice', 'git log --out{put}=target'],
  ];
  for (const [name, cmd] of cases) {
    it(`${name}: reconstructs --output → ask`, () => {
      assert.equal(decisionOf(runHook(bashPayload(cmd), noLane)), DECISION_ASK);
    });
  }
});

// ── pure-helper sanity the ladder relies on ───────────────────────────────────────────

describe('decideBashCall — ladder order and invariants as a pure function', () => {
  const gates = [{ id: 'g', title: 'G', cmd: 'echo ok' }];

  it('all three (a)-invariants must hold at once', () => {
    const base = { command: 'echo ok', permissionMode: 'default', cwdIsProjectRoot: true, gates };
    assert.equal(decideBashCall(base).permissionDecision, DECISION_ALLOW);
    assert.equal(decideBashCall({ ...base, cwdIsProjectRoot: false }), null);
    assert.equal(decideBashCall({ ...base, permissionMode: 'plan' }), null);
    assert.equal(decideBashCall({ ...base, gates: null }), null);
  });

  it('rung (c): allows a core compound only with readLaneOn AND a fenced mode; cwd-agnostic', () => {
    const base = { command: 'git status && git diff', permissionMode: 'default', cwdIsProjectRoot: false, gates: null, readLaneOn: true };
    assert.equal(decideBashCall(base).permissionDecision, DECISION_ALLOW); // cwdIsProjectRoot false is OK for (c)
    assert.match(decideBashCall(base).permissionDecisionReason, /read-lane/u);
    assert.equal(decideBashCall({ ...base, readLaneOn: false }), null);
    assert.equal(decideBashCall({ ...base, readLaneOn: undefined }), null); // defaults to off
    assert.equal(decideBashCall({ ...base, permissionMode: 'plan' }), null); // mode-fenced
    assert.equal(decideBashCall({ ...base, command: 'git status && rm -rf /' }), null); // a non-core segment
  });

  it('isReadLaneCommand — the pure classifier', () => {
    assert.equal(isReadLaneCommand('git status && git diff'), true);
    assert.equal(isReadLaneCommand('grep x . | ls'), true);
    assert.equal(isReadLaneCommand('grep -rn pattern .'), true);
    assert.equal(isReadLaneCommand('git status && rm -rf /'), false); // non-core segment
    assert.equal(isReadLaneCommand('grep x > f'), false); // residual
    assert.equal(isReadLaneCommand('grep ${VAR} f'), false); // any $
    assert.equal(isReadLaneCommand('ls -la & grep x'), false); // bare &
    assert.equal(isReadLaneCommand(';'), false); // empty segments
    assert.equal(isReadLaneCommand('   '), false); // empty
  });

  it('detectResidualClasses names every class present', () => {
    assert.deepEqual(detectResidualClasses('grep x'), []);
    assert.equal(detectResidualClasses('grep x > f').length, 1);
    assert.equal(detectResidualClasses('git log --output=f $(x) > y').length, 3);
  });
});


describe("residual guard — the guard's real value is UNCHANGED (characterization, green before and after)", () => {
  const stillAsks = [
    'cat a > b',
    'grep x f >> out',
    'grep x f > "$TARGET"',
    'cat a >| b',
    'git log --output=f',
    'git log --out"put"=f',
    'cat $(rm x)',
    'cat `rm x`',
    'cat <(rm x)',
    'cat >(rm x)',
    'git log ${ rm x; }',
    'grep -rn "never deny\\|never \\`deny\\`\\|NEVER emits" agent-workflow-kit --output=f',
  ];
  for (const command of stillAsks) {
    it(`still asks: ${command}`, () => {
      assert.ok(detectResidualClasses(command).length > 0);
      assert.equal(decisionOf(runHook(bashPayload(command), hookDeps(undefined))), DECISION_ASK);
    });
  }
});


describe('residual guard — the UNMODELED constructs keep today\'s behaviour (pinned, not wished)', () => {
  it('an expansion-assembled write flag is silent TODAY and stays silent (pre-existing gap, named in the plan)', () => {
    assert.deepEqual(detectResidualClasses('git log "${AW_GUARD_A:---out}${AW_GUARD_B:-put=/tmp/owned}"'), []);
  });

  it('an ANSI-C assembled write flag is silent TODAY and stays silent (pre-existing gap)', () => {
    assert.deepEqual(detectResidualClasses("git log $'--out\\x70ut=/tmp/owned'"), []);
  });

  it('the deliberate write-flag SUBSTRING over-ask survives', () => {
    assert.deepEqual(detectResidualClasses('git diff --output-indicator-new=X'), [RESIDUAL_CLASS_OUTPUT_FLAG]);
  });

  it('a redirect inside a comment over-asks like any other inert byte', () => {
    assert.deepEqual(detectResidualClasses('grep needle file # 2>/dev/null'), [RESIDUAL_CLASS_REDIRECTION]);
    assert.deepEqual(detectResidualClasses('grep needle file # > out'), [RESIDUAL_CLASS_REDIRECTION]);
  });
});

describe('read-lane rung (c) — a redirection byte still closes the lane (I6 characterization)', () => {
  const laneOn = hookDepsLane(undefined, { [READ_LANE_KEY]: true });
  const outside = [
    ['a discard in the FIRST segment', 'grep x f 2>/dev/null | head'],
    ['a discard in a LATER segment', 'ls | grep x 2>/dev/null'],
    ['an input redirection', 'grep needle < f'],
    ['a write redirection', 'cat a > b'],
  ];
  for (const [name, command] of outside) {
    it(`${name} → never a lane allow`, () => {
      assert.equal(isReadLaneCommand(command), false);
      assert.notEqual(decisionOf(runHook(bashPayload(command), laneOn)), DECISION_ALLOW);
    });
  }
});

// ── the quote-aware reading that was BUILT and REMOVED (AD-079, diff round 1) ──────────
// A quote/escape-aware active view would have stopped a `>` inside a search pattern being read as
// an operator. It was removed when the council named a construct that defeats it, on a stop rule
// declared before the round. These tests pin BOTH halves of that outcome so neither can drift: the
// counterexample must keep asking, and the false-ASK class it forced us to leave open is recorded
// here at its real value rather than a wished one.

describe('the three removed mechanisms — each counterexample must keep ASKING', () => {
  // 2. The fd-DUPLICATION exemption: `>&word` duplicates only when the word is a bare number, so
  //    bash writes the FILE `12file` here. A pattern without a token boundary deleted the prefix.
  it('the fd-duplication counterexample ASKS — a removal never hides a real write', () => {
    assert.deepEqual(detectResidualClasses('grep x f >&12file'), [RESIDUAL_CLASS_REDIRECTION]);
    assert.equal(decisionOf(runHook(bashPayload('grep x f >&12file'), hookDeps(undefined))), DECISION_ASK);
  });

  // 3. The NULL-DEVICE exemption, boundary and all: JavaScript `\s` counts U+00A0 as a boundary and
  //    bash does not, so the target word here is the FILE `/dev/null sink`.
  it('the no-break-space counterexample ASKS — JS and bash disagree on word boundaries', () => {
    const command = `grep x f >/dev/null${String.fromCodePoint(0x00a0)}sink`;
    assert.deepEqual(detectResidualClasses(command), [RESIDUAL_CLASS_REDIRECTION]);
    assert.equal(decisionOf(runHook(bashPayload(command), hookDeps(undefined))), DECISION_ASK);
  });

  it('no span-removal helper is exported (a re-introduction needs its own council round)', async () => {
    const hook = await import('../references/hooks/gate-approve.mjs');
    assert.equal(hook.stripNonWritingRedirections, undefined);
  });
});

describe('the quote-aware reading is ABSENT — its counterexample is the reason', () => {
  // A heredoc body is not shell code. Two quotes inside two bodies flip a quote-state walker twice,
  // so it never unbalances and never falls back — and the `$(…)` between them reads as quoted text
  // while bash runs it. `cat` is a frozen-core prefix, so this is exactly rung (b)'s territory.
  const heredocCounterexample = ["cat <<A", "'", 'A', '$(touch owned)', 'cat <<B', "'", 'B'].join('\n');

  it('the heredoc counterexample ASKS — a nested command is never silently allowed', () => {
    assert.deepEqual(detectResidualClasses(heredocCounterexample), [RESIDUAL_CLASS_SUBSTITUTION]);
    assert.equal(decisionOf(runHook(bashPayload(heredocCounterexample), hookDeps(undefined))), DECISION_ASK);
  });

  it('no quote-aware reading is exported (a re-introduction must come with its own council round)', async () => {
    const hook = await import('../references/hooks/gate-approve.mjs');
    assert.equal(hook.buildActiveCommandView, undefined);
  });
});

describe('KNOWN OPEN — the false-ASK class the removal leaves behind (recorded, not fixed)', () => {
  const stillAsksAndShouldNot = [
    ['a redirection byte inside a quoted search PATTERN (corpus firing 29)', 'grep -rln "2>/dev/null" agent-workflow-kit'],
    ['the JavaScript arrow token as a search pattern', 'grep -rn "=>" src'],
    ['an fd duplication (corpus firings 27 and 28)', 'grep -rn "x" dirs 2>&1 | head -20'],
    ['an fd duplication on its own', 'ls 1>&2'],
  ];
  for (const [name, command] of stillAsksAndShouldNot) {
    it(`still asks, and that is the open defect: ${name}`, () => {
      assert.deepEqual(detectResidualClasses(command), [RESIDUAL_CLASS_REDIRECTION]);
      assert.equal(decisionOf(runHook(bashPayload(command), hookDeps(undefined))), DECISION_ASK);
    });
  }

  // The release's ONLY behaviour change, pinned by the class it must produce — a `length > 0` check
  // would have passed before it too, because the `>` alone already matched the redirection class.
  it('`>(…)` is reported as a SUBSTITUTION, not only as a redirection', () => {
    assert.ok(detectResidualClasses('cat >(rm x)').includes(RESIDUAL_CLASS_SUBSTITUTION));
    assert.ok(RESIDUAL_FORMS.commandSubstitutions.includes('>('));
  });
});

// ── the repo-search lane's scanned prefix (RED until the rung (b) change lands) ──────
// The search tool is deliberately NOT in the seeded read-only core (so it never inherits the
// rung (c) read-lane allow), but its invocation prefix joins a SEPARATE scanned list that rung (b)
// checks before running the UNCHANGED detectResidualClasses. That buys back the coverage a plain
// non-core tool would not have: a real substitution or redirection ON THE INVOCATION still asks,
// while the pattern itself travels by file and never reaches the command string at all.
//
// Asserted at the BEHAVIOUR level on purpose: importing a not-yet-existing symbol would throw at
// module load and redden the whole file, destroying the signal these cases carry.
describe('repo-search scanned prefix — rung (b) covers the tool without coring it', () => {
  const noDeclaration = hookDeps(undefined);
  const TOOL = 'node agent-workflow-kit/tools/repo-search.mjs';

  it('an inline pattern carrying a residual byte ASKS, and the reason names the file lane', () => {
    const result = runHook(bashPayload(`${TOOL} --pattern "a>b" --path src`), noDeclaration);
    assert.equal(decisionOf(result), DECISION_ASK);
    assert.match(result.permissionDecisionReason, /--pattern-file/u);
  });

  it('the same search through the file lane gets NO decision (the bytes never enter the command)', () => {
    assert.equal(runHook(bashPayload(`${TOOL} --pattern-file .aw-search-7f3a.txt --path src`), noDeclaration), null);
  });

  it('a REAL write redirection on the tool invocation still ASKS', () => {
    assert.equal(decisionOf(runHook(bashPayload(`${TOOL} --pattern-file p.txt > out.log`), noDeclaration)), DECISION_ASK);
  });

  it('a REAL command substitution on the tool invocation still ASKS', () => {
    assert.equal(decisionOf(runHook(bashPayload(`${TOOL} --pattern-file $(evil) --path src`), noDeclaration)), DECISION_ASK);
  });

  it('the tool is never a seeded-core prefix — it must not inherit the rung (c) read-lane allow', () => {
    assert.equal(matchSeededCorePrefix(`${TOOL} --pattern foo`), null);
    assert.equal(isReadLaneCommand(`${TOOL} --pattern foo`), false);
  });

  // Both reviewers found the first matcher under-inclusive in different ways. An invocation the
  // matcher misses is WORSE than one it over-matches: a miss silently restores the unscanned
  // behaviour on exactly the surface this change exists to cover.
  it('node FLAGS before the script do not hide the invocation from the scan', () => {
    const cmd = `node --no-warnings agent-workflow-kit/tools/repo-search.mjs --pattern "a>b"`;
    assert.equal(decisionOf(runHook(bashPayload(cmd), noDeclaration)), DECISION_ASK);
  });

  it('a residual operator ATTACHED to the script path does not hide the invocation', () => {
    const cmd = `node agent-workflow-kit/tools/repo-search.mjs>out --pattern-file p.txt`;
    assert.equal(decisionOf(runHook(bashPayload(cmd), noDeclaration)), DECISION_ASK);
  });

  it('an ABSOLUTE and a Windows-separated path both match', () => {
    const abs = `node /opt/x/agent-workflow-kit/tools/repo-search.mjs --pattern "a>b"`;
    const win = `node C:\\x\\agent-workflow-kit\\tools\\repo-search.mjs --pattern "a>b"`;
    assert.equal(decisionOf(runHook(bashPayload(abs), noDeclaration)), DECISION_ASK);
    assert.equal(decisionOf(runHook(bashPayload(win), noDeclaration)), DECISION_ASK);
  });

  // Matching on the BASENAME alone would pull an unrelated script of the same name into rung (b2),
  // turning a pre-existing NO decision into an ASK — a change to someone else's decision path that
  // this release has no business making. The match is on the kit-qualified suffix.
  it('a FOREIGN script that merely shares the basename keeps its previous NO decision', () => {
    const cmd = `node /somewhere/else/repo-search.mjs --pattern "a>b"`;
    assert.equal(runHook(bashPayload(cmd), noDeclaration), null);
  });

  // The recovery the reason names is the rung's whole value. It was written as the literal string
  // `--pattern-file` when repo-search was the only scanned tool, which made it wrong twice the moment
  // a second tool joined: wrong for a tool that has no such flag, and incomplete for repo-search
  // itself once its TARGET half got a lane. The reason is derived per tool, so it cannot drift.
  it('the recovery reason names the lanes of the tool that was actually matched', () => {
    const search = runHook(bashPayload(`${TOOL} --pattern "a>b"`), noDeclaration);
    assert.match(search.permissionDecisionReason, /--pattern-file/u);
    assert.match(search.permissionDecisionReason, /--paths-file/u);
  });
});

describe('path-inventory scanned prefix — the inventory lane carries the same residual coverage', () => {
  const noDeclaration = hookDeps(undefined);
  const INVENTORY = 'node agent-workflow-kit/tools/path-inventory.mjs';

  it('a target carrying a residual byte ASKS, and the reason names the file lane it does have', () => {
    const result = runHook(bashPayload(`${INVENTORY} --path "a>b"`), noDeclaration);
    assert.equal(decisionOf(result), DECISION_ASK);
    assert.match(result.permissionDecisionReason, /--paths-file/u);
    assert.doesNotMatch(result.permissionDecisionReason, /--pattern-file/u,
      'advising a flag this tool does not have is worse than not advising at all');
  });

  it('a clean invocation still takes NO decision — the settings allow rule is what approves it', () => {
    assert.equal(runHook(bashPayload(`${INVENTORY} --paths-file t.lst --json`), noDeclaration), null);
  });

  it('a REAL write redirection on the invocation ASKS', () => {
    assert.equal(decisionOf(runHook(bashPayload(`${INVENTORY} --path src > out.log`), noDeclaration)), DECISION_ASK);
  });

  it('the tool is never a seeded-core prefix — it must not inherit the rung (c) read-lane allow', () => {
    assert.equal(matchSeededCorePrefix(`${INVENTORY} --path src`), null);
    assert.equal(isReadLaneCommand(`${INVENTORY} --path src`), false);
  });

  it('a FOREIGN script sharing the basename keeps its previous NO decision', () => {
    assert.equal(runHook(bashPayload(`node /somewhere/else/path-inventory.mjs --path "a>b"`), noDeclaration), null);
  });
});
