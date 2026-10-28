// The engine fixture and the expected kit block shared by the kit block suites and the engine-homed theme
// suite; it holds no case. Contract: docs/ai/specs/kit/install/entry-pointers.md.
import { after } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const inject = await import('../inject-methodology.mjs');
export const rules = await import('../project-rules/index.mjs');
export const LF = '\n';
export const CRLF = '\r\n';
export const INSTALL = 'npx @sabaiway/agent-workflow-engine@latest init';

export const PARTS = Object.freeze([
  Object.freeze({ id: 'methodology', file: 'references/methodology-slot.md', text: '> **Workflow methodology (fixture)** — plan, execute, review.' }),
  Object.freeze({ id: 'orchestration', file: 'references/orchestration-slot.md', text: '> **Orchestration recipes (fixture)** — pick one with `/agent-workflow-kit recipes`.', name: 'the orchestration recipes' }),
  Object.freeze({ id: 'autonomy', file: 'references/autonomy-slot.md', text: '> **Autonomy policy (fixture)** — read `docs/ai/autonomy.json` at session start.\n> Its second line.', name: 'the autonomy policy' }),
]);
export const LENS_FILE = 'references/rules/lens.md';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
export const tempDir = (prefix) => tmpDirs[tmpDirs.push(mkdtempSync(join(tmpdir(), prefix))) - 1];
const HOME = tempDir('kit-block-home-');

// makeEngine({ omit, files, unreadable, kind }) → a valid engine dir; omit drops a part id or 'lens', files
// replaces a file's bytes by its path, unreadable makes a present file unreadable, kind breaks the manifest.
export const makeEngine = ({ omit = [], files = {}, unreadable = [], kind = 'methodology-engine' } = {}) => {
  const dir = tempDir('kit-block-engine-');
  const manifest = { family: 'agent-workflow', schema: 1, name: 'agent-workflow-engine', kind, version: '1.0.0', available: true, provides: ['plan'], roles: {} };
  writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: agent-workflow-engine', 'metadata:', "  version: '1.0.0'", '---', '# engine', ''].join(LF));
  const lens = ['---', 'maxLines: 80', '---', '', '# Planning, review and process-fidelity invariants', '', String(rules.PRECEDENCE_LINE), '', '- A lens bullet.', ''].join(LF);
  const bytes = { ...Object.fromEntries(PARTS.map((part) => [part.file, `${LF}${part.text}${LF}${LF}`])), [LENS_FILE]: lens, ...files };
  for (const [rel, text] of Object.entries(bytes)) {
    const id = PARTS.find((part) => part.file === rel)?.id ?? (rel === LENS_FILE ? 'lens' : rel);
    if (omit.includes(id)) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    if (unreadable.includes(rel)) chmodSync(join(dir, rel), 0o000);
  }
  return dir;
};
export const NO_ENGINE = join(tempDir('kit-block-none-'), 'absent-engine');

// skipLine(name) and noteLine(name) → the two lines a text the engine does not supply leaves behind.
export const skipLine = (name) => `${inject.SKIP_PREFIX} ${name} — refresh it with ${INSTALL}`;
export const noteLine = (name) => `[inject-methodology] note: ${name} was not written — the installed engine does not supply it; refresh it with ${INSTALL}.`;

// expectedBlock({ omit, eol, texts }) → the block the command composes over makeEngine({ omit }), texts replacing
// a part's text by its id.
export const expectedBlock = ({ omit = [], eol = LF, texts = {} } = {}) => {
  const themePath = (theme) => rules.themePaths(theme.name).effective;
  const shipped = (theme) => theme.home !== 'engine' || !omit.includes(theme.name);
  const table = ['| Rules theme | Read when |', '|---|---|',
    ...rules.THEMES.filter(shipped).map((theme) => `| [\`${themePath(theme)}\`](./${themePath(theme)}) | ${theme.readWhen} |`)].join(LF);
  const lacking = rules.THEMES.filter((theme) => !shipped(theme)).map((theme) => skipLine(`the ${theme.name} rules theme`));
  const parts = [inject.BLOCK_START, rules.PRECEDENCE_LINE, inject.READ_LINE,
    ...PARTS.map((part) => (omit.includes(part.id) ? skipLine(part.name) : (texts[part.id] ?? part.text))), table, ...lacking, inject.BLOCK_END];
  return parts.join(LF + LF).split(LF).join(eol);
};

// reconcile(text, { engine, path }) → the command's result over an AGENTS.md holding text, the bytes after it
// and the names beside it.
export const reconcile = async (text, { engine = makeEngine(), path = join(tempDir('kit-block-'), 'AGENTS.md') } = {}) => {
  writeFileSync(path, text);
  const result = await inject.runCli(['reconcile', path], { env: { AGENT_WORKFLOW_ENGINE_DIR: engine }, home: HOME });
  return { ...result, path, after: readFileSync(path, 'utf8'), names: readdirSync(dirname(path)).sort() };
};
