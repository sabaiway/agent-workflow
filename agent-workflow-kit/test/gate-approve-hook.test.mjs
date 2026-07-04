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
  HOOK_EVENT_NAME,
  RESIDUAL_FORMS,
  decideBashCall,
  detectResidualClasses,
  formatDecision,
  matchSeededCorePrefix,
  readDeclarationGates,
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

  it('accepts/rejects EXACTLY where the runner does (shared-fixture cross-check)', () => {
    const fixtures = [
      shippedTemplate,
      LIVE_DECLARATION,
      { gates: [{ id: 'a', title: 'A', cmd: 'x' }] },
      { _README: 'doc', gates: [] },
      ...invalidMatrix.map(([, parsed]) => parsed),
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

  it('detectResidualClasses names every class present', () => {
    assert.deepEqual(detectResidualClasses('grep x'), []);
    assert.equal(detectResidualClasses('grep x > f').length, 1);
    assert.equal(detectResidualClasses('git log --output=f $(x) > y').length, 3);
  });
});
