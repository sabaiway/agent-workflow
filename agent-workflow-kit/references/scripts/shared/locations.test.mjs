// locations.test.mjs — docs/ai/specs/memory/locations.md
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

const MODULE_URL = new URL('./locations.mjs', import.meta.url);
const PINNED_NAMES = `
  DOCS SCRIPTS CLAUDE_DIR GIT_DIR PACKAGE_JSON AGENTS_FILE CLAUDE_FILE MCP_FILE GITIGNORE GITATTRIBUTES DOT_AGENTS NPM_LOCK
  PNPM_LOCK YARN_LOCK BUN_LOCKB BUN_LOCK PNPM_WORKSPACE PNPM_WORKSPACE_YML LERNA_JSON NODE_MODULES CODEX_LAST_SESSION
  VSCODE_DIR CURSOR_DIR CURSORRULES CODEIUM_DIR WINDSURF_DIR WINDSURFRULES GEMINI_FILE ANTIGRAVITY_FILE GITHUB_DIR
  AIDER_CONF AIDER_CHAT_HISTORY AIDER_INPUT_HISTORY CONTINUE_DIR
  DOCS_TREE PLANS QUEUE
  KIT_FOLDER LOCAL_HOOK SYNC_MIRRORS KIT_COMMAND
  AGENTS_SKILLS VSCODE_SETTINGS CURSOR_RULES
  SETTINGS SETTINGS_LOCAL AGENTS_DIR HOOKS_DIR SKILLS_DIR GATE_HOOK STOP_HOOK
  GIT_CONFIG GIT_HOOKS GIT_EXCLUDE PRE_COMMIT
  INDEX HANDOVER AGENT_RULES CHANGELOG CHANGELOG_LEGACY KNOWN_ISSUES DECISIONS HISTORY ADR_STORE SPEC_STORE EPIC_STORE
  RULES WORKFLOW_STAMP MEMORY_STAMP GATES LANES ORCHESTRATION AUTONOMY VEHICLES WORKTREES SOURCE_SIZE SPEC_COVERAGE
  COVERAGE_DECLARED PROFILE_DECLINES ACKS
  RECENT CONDENSED_INDEX ISSUES_RESOLVED CHANGELOG_CARRY DECISIONS_ARCHIVE DECISIONS_ARCHIVE_EARLY
  ADR_LOG SPEC_STORE_INDEX EPIC_STORE_SEED RULES_LOCAL RULES_EFFECTIVE RULES_RECORD
`.trim().split(/\s+/);
const PINNED_NAME_COUNT = 92;

const findLoadProblem = (source) => {
  const code = source.replace(/('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//gu,
    (_match, quotedString) => (quotedString === undefined ? ' ' : '""'));
  const importSyntax = code.match(/(?<![.$\p{ID_Continue}])import(?![$\p{ID_Continue}])\s*(?=[("*{$_\\\p{ID_Start}])/u);
  const reExportSyntax = code.match(/\bexport\s*(?:\*|\{[^}]*\}\s*from\s*")/u);
  return importSyntax?.[0] ?? reExportSyntax?.[0] ?? null;
};

const findNameProblems = (names) => [
  ...names.filter((name) => !PINNED_NAMES.includes(name)).map((name) => `unexpected export ${name}`),
  ...PINNED_NAMES.filter((name) => !names.includes(name)).map((name) => `missing export ${name}`),
];

const findCanonicalProblem = (value) => {
  if (typeof value !== 'string') return `${inspect(value, { customInspect: false })} is not a string`;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(segments[0])) {
    return `${JSON.stringify(value)} is not a canonical location`;
  }
  return null;
};

describe('spec:locations/S1 the definition over the canon: the module\'s own exported names equal exactly the set the suite pins, a name it exports beyond that set or one of it it lacks failing the suite; every value is a string the suite\'s canonical judge accepts; and the module loads no other module: no static import, dynamic import or re-export from another module', () => {
  it('loads no other module and exports exactly the pinned names with canonical string values', async () => {
    const source = readFileSync(MODULE_URL, 'utf8');
    assert.equal(findLoadProblem(source), null);
    const definition = await import(MODULE_URL.href);
    const names = Object.keys(definition);
    assert.deepEqual(findNameProblems(names), []);
    for (const name of names) {
      const problem = findCanonicalProblem(definition[name]);
      assert.equal(problem, null, `${name}: ${problem}`);
    }
  });

  it('the load judge refuses static imports, dynamic imports and re-exports, and accepts derived constants', () => {
    const refusedSources = [
      "import { A } from './a.mjs';",
      "import './a.mjs';",
      "await import('./a.mjs')",
      "import ('./a.mjs')",
      "export * from './a.mjs';",
      "export * as B from './a.mjs';",
      "export { A } from './a.mjs';",
    ];
    for (const source of refusedSources) assert.notEqual(findLoadProblem(source), null, source);
    const acceptedSource = ["export const DOCS = 'docs';", 'export const DOCS_TREE = `${DOCS}/ai`;'].join('\n');
    assert.equal(findLoadProblem(acceptedSource), null, acceptedSource);
  });

  it('the pin has 92 unique names and the names judge reports a stray default and a missing DOCS', () => {
    assert.equal(PINNED_NAMES.length, PINNED_NAME_COUNT);
    assert.equal(new Set(PINNED_NAMES).size, PINNED_NAME_COUNT);
    assert.deepEqual(findNameProblems(PINNED_NAMES), []);
    assert.deepEqual(findNameProblems([...PINNED_NAMES, 'default']), ['unexpected export default']);
    assert.deepEqual(findNameProblems(PINNED_NAMES.filter((name) => name !== 'DOCS')), ['missing export DOCS']);
  });
});

describe('spec:locations/S2 the canonical judge, the one S1 uses, over literal values refuses each of an empty value, a leading /, a trailing /, an empty segment, a . or .. segment in the middle and at either edge, a backslash, a NUL and the drive forms C: and C:relative, each with the value named, and accepts docs/ai/history/changelog.carry and .git/info/exclude', () => {
  it('the canonical judge names every refused literal and accepts both canonical literals', () => {
    const refusedValues = [
      '', '/docs', 'docs/', 'docs//ai', 'docs/./ai', 'docs/../ai', './docs', 'docs/.', '../docs', 'docs/..',
      'docs\\ai', 'docs\0ai', 'C:', 'C:relative',
    ];
    for (const value of refusedValues) {
      const namedValue = JSON.stringify(value);
      const problem = findCanonicalProblem(value);
      assert.ok(problem?.includes(namedValue), `${namedValue}: ${problem}`);
    }
    const acceptedValues = ['docs/ai/history/changelog.carry', '.git/info/exclude'];
    for (const value of acceptedValues) assert.equal(findCanonicalProblem(value), null, value);
  });
});
