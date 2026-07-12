// kit-readonly-tools.test.mjs — drift guards for the opt-in `velocity --kit-tools` tier (AD-040).
//
// Three families:
//   (a) tier ↔ catalog partition: every mode-backed tier tool maps to a catalog mode whose kind is
//       read-only or project-exec — run-gates.mjs the ONLY project-exec member — via a
//       hand-maintained frozen tool→mode map (commands.mjs is mode-keyed; a tool cannot be looked
//       up there directly, so the map is the pinned bridge and goes red on any repartition).
//   (b) the 2 non-mode-backed tools (manifest/validate.mjs, release-scan.mjs — no catalog entry
//       exists) get a dedicated writes-nothing read-only assertion over their sources instead.
//   (c) dead-rule prevention (Decision 5): a seeded tier entry equals its documented dispatch line
//       in references/modes/velocity.md with ${CLAUDE_SKILL_DIR} replaced by the resolved skill dir
//       (and ${PROJECT_ROOT} into the run-gates --cwd slot), UNQUOTED — prefix for the wildcard
//       class, equality for the exact class. A spelling mismatch (quoting, relative-vs-absolute)
//       makes a rule silently dead; this test is the mechanism that catches it.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_REVIEW_WRAPPERS,
  KIT_READONLY_TOOLS,
  KIT_RUN_GATES_TOOL,
  KIT_WRITER_PREVIEW_TOOLS,
  deriveBridgeTierAllowlist,
  deriveKitToolsAllowlist,
} from '../tools/velocity-profile.mjs';
import { kindOf, READ_ONLY, WRITER, PROJECT_EXEC } from '../tools/commands.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VELOCITY_MODE = readFileSync(join(kitRoot, 'references', 'modes', 'velocity.md'), 'utf8');
const SKILL_DIR_VAR = '${CLAUDE_SKILL_DIR}';
const PROJECT_ROOT_VAR = '${PROJECT_ROOT}';

// ── (a) the hand-maintained frozen tool→mode partition map ──────────────────
// 8 mode-backed tier tools; the 2 validator/scanner tools have no catalog entry (checked in (b)).
const MODE_BACKED_TOOL_TO_MODE = Object.freeze({
  'tools/recipes.mjs': 'recipes',
  'tools/procedures.mjs': 'procedures',
  'tools/family-registry.mjs': 'status',
  'tools/detect-backends.mjs': 'backends',
  'tools/commands.mjs': 'help',
  'tools/review-state.mjs': 'review-state',
  'tools/recommendations.mjs': 'recommendations',
  'tools/run-gates.mjs': 'gates',
});
const NON_MODE_BACKED = Object.freeze(['tools/manifest/validate.mjs', 'tools/release-scan.mjs']);
// Writer previews are exact BECAUSE these are writers — the map pins that they stay writers.
const PREVIEW_TOOL_TO_MODE = Object.freeze({
  'tools/velocity-profile.mjs': 'velocity',
  'tools/cheap-agents.mjs': 'agents',
  'tools/gate-hook.mjs': 'hook',
});

describe('kit-tools tier ↔ commands.mjs catalog partition', () => {
  it('the tier is exactly the 8 mode-backed tools + the 2 non-mode-backed validators (set equality)', () => {
    const expected = [...Object.keys(MODE_BACKED_TOOL_TO_MODE), ...NON_MODE_BACKED].sort();
    assert.deepEqual([...KIT_READONLY_TOOLS].sort(), expected);
  });

  it('every mode-backed tier tool maps to a read-only or project-exec catalog mode', () => {
    for (const [tool, mode] of Object.entries(MODE_BACKED_TOOL_TO_MODE)) {
      const kind = kindOf(mode);
      assert.ok(
        kind === READ_ONLY || kind === PROJECT_EXEC,
        `${tool} → mode "${mode}" has kind "${kind}" — a tier tool must be read-only or project-exec`,
      );
    }
  });

  it('run-gates.mjs is the ONLY project-exec member of the tier', () => {
    const projectExec = Object.entries(MODE_BACKED_TOOL_TO_MODE).filter(([, mode]) => kindOf(mode) === PROJECT_EXEC);
    assert.deepEqual(projectExec, [[KIT_RUN_GATES_TOOL, 'gates']]);
  });

  it('every preview tool maps to a WRITER catalog mode (previews are exact because these write)', () => {
    assert.deepEqual([...KIT_WRITER_PREVIEW_TOOLS].sort(), Object.keys(PREVIEW_TOOL_TO_MODE).sort());
    for (const [tool, mode] of Object.entries(PREVIEW_TOOL_TO_MODE)) {
      assert.equal(kindOf(mode), WRITER, `${tool} → mode "${mode}" must be a writer`);
    }
  });
});

// ── (b) the non-mode-backed tools: writes-nothing read-only assertion ───────
describe('non-mode-backed tier tools write nothing', () => {
  const WRITE_API_PATTERN =
    /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream|copyFileSync|node:child_process/u;

  for (const rel of NON_MODE_BACKED) {
    it(`${rel} carries no write/exec API`, () => {
      const source = readFileSync(join(kitRoot, rel), 'utf8');
      assert.doesNotMatch(source, WRITE_API_PATTERN, `${rel} must stay a pure reader`);
    });
  }
});

// ── (c) dead-rule prevention: documented dispatch line ⇄ seeded byte-form ───
describe('dead-rule prevention — velocity.md tier dispatch lines match the seeded byte-forms', () => {
  const PROJECT_ROOT = '/tmp/kit-readonly-tools-fixture';
  const derived = deriveKitToolsAllowlist({ projectDir: PROJECT_ROOT });

  // The tier subsection is the single checkable documented-invocation source (Decision 5).
  const sectionStart = VELOCITY_MODE.indexOf('--kit-tools` tier');
  assert.notEqual(sectionStart, -1, 'velocity.md must carry the --kit-tools tier subsection');
  const sectionEnd = VELOCITY_MODE.indexOf('**Invariants:**', sectionStart);
  const tierSection = VELOCITY_MODE.slice(sectionStart, sectionEnd === -1 ? VELOCITY_MODE.length : sectionEnd);
  const documentedLines = [...tierSection.matchAll(/`(node \$\{CLAUDE_SKILL_DIR\}[^`]*)`/gu)].map((m) => m[1]);
  const substitute = (line) => line.replaceAll(SKILL_DIR_VAR, kitRoot).replaceAll(PROJECT_ROOT_VAR, PROJECT_ROOT);
  const linesFor = (rel) => documentedLines.filter((line) => line.includes(`/${rel}`));

  it('documents exactly one covered dispatch line per tier tool + per preview tool', () => {
    for (const rel of [...KIT_READONLY_TOOLS, ...KIT_WRITER_PREVIEW_TOOLS]) {
      assert.equal(linesFor(rel).length, 1, `velocity.md tier subsection must document exactly one line for ${rel}`);
    }
  });

  it('each wildcard-class documented line starts with the seeded prefix at a word boundary', () => {
    for (const rel of KIT_READONLY_TOOLS) {
      if (rel === KIT_RUN_GATES_TOOL) continue;
      const prefix = `node ${join(kitRoot, rel)}`;
      assert.equal(derived.includes(`Bash(${prefix}:*)`), true, `seeded wildcard entry for ${rel}`);
      const line = substitute(linesFor(rel)[0]);
      assert.ok(
        line === prefix || (line.startsWith(prefix) && line[prefix.length] === ' '),
        `${rel}: documented "${line}" must start with the seeded prefix "${prefix}"`,
      );
    }
  });

  it('the run-gates documented line equals the seeded exact root-pinned byte-string', () => {
    const line = substitute(linesFor(KIT_RUN_GATES_TOOL)[0]);
    assert.equal(line, `node ${join(kitRoot, KIT_RUN_GATES_TOOL)} --cwd ${PROJECT_ROOT}`);
    assert.equal(derived.includes(`Bash(${line})`), true, 'the exact run-gates entry matches its documented line');
  });

  it('each preview documented line equals its seeded exact byte-string', () => {
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) {
      const line = substitute(linesFor(rel)[0]);
      assert.equal(line, `node ${join(kitRoot, rel)}`, `${rel}: the preview byte-form is the arg-free dry-run`);
      assert.equal(derived.includes(`Bash(${line})`), true, rel);
    }
  });

  it('documented lines are UNQUOTED (a quoted invocation is a different byte string — a dead rule)', () => {
    for (const line of documentedLines) {
      assert.doesNotMatch(line, /["']/u, `quoted spelling in "${line}" would seed a dead rule`);
    }
  });
});

// ── (c2) dead-rule prevention, bridge tier (AD-044 Plan 4): documented byte-form ⇄ seeded form ──
// A SEPARATE pin from (c): the bridge subsection lives OUTSIDE the kit-tools extraction range (the
// quoted grounding form is accepted ONLY here — the kit-tools UNQUOTED invariant above stays
// untouched). Every seeded bridge byte-form must appear verbatim in the velocity.md bridge
// subsection — a mismatched documented spelling would teach users a silently-dead rule.
describe('dead-rule prevention — velocity.md bridge-tier byte-forms match the seeded forms', () => {
  const sectionStart = VELOCITY_MODE.indexOf('`--bridge-tier`');
  assert.notEqual(sectionStart, -1, 'velocity.md must carry the --bridge-tier subsection');
  const bridgeSection = VELOCITY_MODE.slice(sectionStart);
  const derived = deriveBridgeTierAllowlist({ findWrapper: () => true });

  it('the bridge subsection sits AFTER the kit-tools Invariants (outside the (c) extraction range)', () => {
    assert.ok(sectionStart > VELOCITY_MODE.indexOf('**Invariants:**'), 'the quoted grounding line must never enter the kit-tools UNQUOTED scan');
  });

  it('each seeded code-mode wrapper rule appears verbatim, and each wrapper name is documented for excludedCommands', () => {
    for (const wrapper of BRIDGE_REVIEW_WRAPPERS) {
      assert.ok(bridgeSection.includes(`\`Bash(${wrapper} code:*)\``), `documented allow byte-form for ${wrapper}`);
      assert.ok(bridgeSection.includes(`\`${wrapper}\` in \`sandbox.excludedCommands\``), `documented excludedCommands entry for ${wrapper}`);
      assert.ok(derived.allow.includes(`Bash(${wrapper} code:*)`), `the seeded form matches for ${wrapper}`);
      assert.ok(!derived.allow.includes(`Bash(${wrapper}:*)`), `the BARE prefix (covers plan/diff file args) is never seeded for ${wrapper}`);
    }
  });

  it('the documented grounding byte-form (with ${CLAUDE_SKILL_DIR} substituted) equals the seeded rule', () => {
    const documented = `Bash(node "${SKILL_DIR_VAR}/tools/grounding.mjs":*)`;
    assert.ok(bridgeSection.includes(`\`${documented}\``), 'velocity.md documents the quoted grounding byte-form');
    const substituted = documented.replaceAll(SKILL_DIR_VAR, kitRoot);
    assert.ok(derived.allow.includes(substituted), 'the seeded grounding rule equals the documented spelling');
  });

  it('the non-review wrappers are documented as excluded and never seeded', () => {
    assert.match(bridgeSection, /codex-exec/, 'the boundary is stated in the docs');
    assert.match(bridgeSection, /agy-run/, 'the boundary is stated in the docs');
    for (const entry of derived.allow) assert.doesNotMatch(entry, /codex-exec|agy-run/);
  });
});
