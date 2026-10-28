#!/usr/bin/env node
// The kit block — the composition root's only mutation of a deployed AGENTS.md. ONE block between two
// marker lines holds the precedence line, the read line, the installed engine's three fragments (read
// LIVE, no bundled copy) and the rules-themes table. The block is written current on every run with no
// question and no copy kept; outside it nothing is written or found. An absent or invalid engine is a
// STOP; malformed marker lines are refused with their line numbers. Pure string functions plus one
// return-code entry point; dependency-free, Node >= 22. Contract: docs/ai/specs/kit/install/entry-pointers.md.

import { isDirectRun } from './direct-run.mjs';
import { normalizeCanonical } from './orchestration-config.mjs';
import { PRECEDENCE_LINE, THEMES, themePaths } from './project-rules/index.mjs';
import {
  AUTONOMY_FRAGMENT_REL, ENGINE_FRAGMENT_REL, ORCHESTRATION_FRAGMENT_REL, detectEngine, readEngineFragment, resolveEngineDir,
} from './engine-source.mjs';

export const BLOCK_START = '<!-- workflow:kit:start -->';
export const BLOCK_END = '<!-- workflow:kit:end -->';
export const READ_LINE = 'Read `docs/ai/index.md` after this file; read `docs/ai/agent_rules.md` before any code change.';
export const SKIP_PREFIX = 'Kit text not supplied by the installed engine:';
export const BLOCK_ROUTE = "text of your own goes outside the two workflow:kit comment lines; a change to a kit rule goes in its theme's file under docs/ai/rules/local/";

const LF = '\n';
const CRLF = '\r\n';
const BOM = '\uFEFF';
const INSTALL = 'npx @sabaiway/agent-workflow-engine@latest init';
const TAG = '[inject-methodology]';

// The three engine fragments in block order; a valid engine lacking one but methodology leaves a skip line.
const FRAGMENTS = Object.freeze([
  Object.freeze({ id: 'methodology', rel: ENGINE_FRAGMENT_REL }),
  Object.freeze({ id: 'orchestration', rel: ORCHESTRATION_FRAGMENT_REL, name: 'the orchestration recipes' }),
  Object.freeze({ id: 'autonomy', rel: AUTONOMY_FRAGMENT_REL, name: 'the autonomy policy' }),
]);
const themeName = (name) => `the ${name} rules theme`;

// ── the finder: marker lines outside closed fences ───────────────────────────────────────────────

// The fence opener and closer rules of references/scripts/markdown-blocks.mjs, applied here.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const matchable = (line) => line.replace(/\s+$/u, '');
const opensFence = (line) => {
  const match = FENCE_RE.exec(matchable(line));
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], length: match[1].length };
};
const closesFence = (line, open) => {
  const match = FENCE_RE.exec(matchable(line));
  return Boolean(match) && match[1][0] === open.char && match[1].length >= open.length && match[2].trim() === '';
};

// markerLines(lines) → [{ index, marker }] for every start or end marker line; a closed fence hides its
// lines, an opener no later line closes fences nothing.
const markerLines = (lines) => {
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = opensFence(lines[index]);
    if (open) {
      const close = lines.findIndex((line, at) => at > index && closesFence(line, open));
      if (close !== -1) index = close;
      continue;
    }
    const content = lines[index].replace(/\r$/u, '').trim();
    if (content === BLOCK_START || content === BLOCK_END) found.push({ index, marker: content });
  }
  return found;
};

// findKitBlock(text) → { state: 'ok', start, end } | { state: 'absent' } | { state: 'malformed', lines }.
export const findKitBlock = (text) => {
  const found = markerLines(text.split(LF));
  if (found.length === 0) return { state: 'absent' };
  const [first, second] = found;
  if (found.length === 2 && first.marker === BLOCK_START && second.marker === BLOCK_END) {
    return { state: 'ok', start: first.index + 1, end: second.index + 1 };
  }
  return { state: 'malformed', lines: found.map(({ index }) => index + 1) };
};

// ── the composer and the judgement (pure) ────────────────────────────────────────────────────────

const skipLine = (name) => `${SKIP_PREFIX} ${name} — refresh it with ${INSTALL}`;
const effectiveOf = (theme) => themePaths(theme.name).effective;

// composeKitBlock({ fragments, themes, lacking? }) → the block in LF form; a fragment that is not a
// string, and a theme named in lacking, each leave a skip line.
export const composeKitBlock = ({ fragments, themes, lacking = [] }) => {
  const texts = FRAGMENTS.map(({ id, name }) => (typeof fragments[id] === 'string'
    ? fragments[id].replace(/\r\n/gu, LF).trim()
    : skipLine(name)));
  const rows = themes.filter((theme) => !lacking.includes(theme.name))
    .map((theme) => `| [\`${effectiveOf(theme)}\`](./${effectiveOf(theme)}) | ${theme.readWhen} |`);
  const table = ['| Rules theme | Read when |', '|---|---|', ...rows].join(LF);
  const skips = themes.filter((theme) => lacking.includes(theme.name)).map((theme) => skipLine(themeName(theme.name)));
  return [BLOCK_START, PRECEDENCE_LINE, READ_LINE, ...texts, table, ...skips, BLOCK_END].join(LF + LF);
};

// The byte offset where 1-based line n starts, and where its content ends (before its CR and LF).
const lineStart = (text, n) => {
  let offset = 0;
  for (let line = 1; line < n; line += 1) offset = text.indexOf(LF, offset) + 1;
  return offset;
};
const contentEnd = (text, n) => {
  const start = lineStart(text, n);
  const eol = text.indexOf(LF, start);
  const end = eol === -1 ? text.length : eol;
  return text[end - 1] === '\r' ? end - 1 : end;
};

// reconcileKitBlock(text, block) → { status: 'current' | 'written' | 'inserted', text } | { status: 'refused', text, lines }.
export const reconcileKitBlock = (text, block) => {
  const bom = text.startsWith(BOM) ? BOM : '';
  const firstEol = text.indexOf(LF);
  const eol = firstEol > 0 && text[firstEol - 1] === '\r' ? CRLF : LF;
  const composed = block.split(LF).join(eol);
  const found = findKitBlock(text);
  if (found.state === 'malformed') return { status: 'refused', text, lines: found.lines };
  if (found.state === 'absent') return { status: 'inserted', text: `${bom}${composed}${eol}${eol}${text.slice(bom.length)}` };
  const from = Math.max(lineStart(text, found.start), bom.length);
  const to = contentEnd(text, found.end);
  if (normalizeCanonical(text.slice(from, to)) === normalizeCanonical(block)) return { status: 'current', text };
  return { status: 'written', text: `${text.slice(0, from)}${composed}${text.slice(to)}` };
};

// ── the command ──────────────────────────────────────────────────────────────────────────────────

const EXIT = Symbol('inject-methodology.exit');
const OUTCOME = {
  current: `${TAG} kit block: already current — nothing to do (zero-diff).`,
  written: `${TAG} kit block: written with the current kit text; ${BLOCK_ROUTE}.`,
  inserted: `${TAG} kit block: added at the start of the file; ${BLOCK_ROUTE}.`,
};
const refusalLine = (lines) => `${TAG} kit block refused — the workflow:kit comment lines must be exactly one start line before one end line (found on lines ${lines.join(', ')}); fix them, then re-run; ${BLOCK_ROUTE}.`;
const noteLine = (name) => `${TAG} note: ${name} was not written — the installed engine does not supply it; refresh it with ${INSTALL}.`;

// readEngineParts({ env, home }) → { fragments, lacking }, or a throw tagged with exit 1 after the STOP
// line: the methodology fragment is required; a missing later fragment or engine-homed theme is a skip.
const readEngineParts = ({ env, home, logError }) => {
  const { dir, source } = resolveEngineDir({ env, home });
  const read = (rel) => {
    try {
      return readEngineFragment(dir, { source, rel });
    } catch (err) {
      logError(`${TAG} reconcile STOP — ${err.message}`);
      throw Object.assign(new Error('exit 1'), { [EXIT]: 1 });
    }
  };
  const fragments = {};
  for (const { id, rel, name } of FRAGMENTS) {
    if (name === undefined || detectEngine(dir, { source, rel }).ok) fragments[id] = read(rel);
  }
  const lacking = THEMES.filter((theme) => theme.home === 'engine' && !detectEngine(dir, { source, rel: theme.template }).ok)
    .map((theme) => theme.name);
  return { fragments, lacking };
};

// runCli(argv, { env, home }) → { code, stdout, stderr }; never exits. `reconcile <AGENTS.md>` is the one form.
export const runCli = async (argv, deps = {}) => {
  const { readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const stdoutLines = [];
  const stderrLines = [];
  const log = (line) => stdoutLines.push(line);
  const logError = (line) => stderrLines.push(line);
  const result = (code) => ({
    code,
    stdout: stdoutLines.length > 0 ? `${stdoutLines.join(LF)}${LF}` : '',
    stderr: stderrLines.length > 0 ? `${stderrLines.join(LF)}${LF}` : '',
  });
  if (argv.length !== 2 || argv[0] !== 'reconcile') {
    logError('usage: inject-methodology.mjs reconcile <path/to/AGENTS.md>');
    return result(2);
  }
  const target = resolve(argv[1]);
  const writeAtomic = async (out) => {
    const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await writeFile(tmp, out, 'utf8');
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };
  try {
    const text = await readFile(target, 'utf8');
    const { fragments, lacking } = readEngineParts({ env, home, logError });
    const block = composeKitBlock({ fragments, themes: THEMES, lacking });
    const judged = reconcileKitBlock(text, block);
    if (judged.status === 'refused') {
      logError(refusalLine(judged.lines));
      return result(1);
    }
    if (judged.status !== 'current') await writeAtomic(judged.text);
    log(OUTCOME[judged.status]);
    const skipped = [...FRAGMENTS.filter(({ id }) => typeof fragments[id] !== 'string').map(({ name }) => name), ...lacking.map(themeName)];
    skipped.forEach((name) => log(noteLine(name)));
    return result(0);
  } catch (err) {
    if (err[EXIT] !== undefined) return result(err[EXIT]);
    throw err;
  }
};

if (isDirectRun(import.meta.url)) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
