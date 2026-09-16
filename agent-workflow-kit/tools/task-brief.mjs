// spec:checkpoint — docs/ai/specs/kit/checkpoint/task-brief.md
import { writeFileSync, realpathSync, constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileBytesNoFollow } from './fs-read-nofollow.mjs';
import { parseLedger, isSweep, PLAN_HEADINGS } from './plan-shape.mjs';
import { expandSweepPaths } from './plan-shape-facts.mjs';
import { readStoryLine, PIN_FILE } from './plan-shape-ownership.mjs';
import { parseDispatchContract, isThreadTerminalRecord } from './dispatch-record.mjs';
import { runBaseDiff } from './dispatch-baseline.mjs';
import { readDelegationLedger } from './dispatch-store-read.mjs';
import { claimedPaths } from './task-thread.mjs';
import { newestCheckpoint, verifyCheckpoint } from './checkpoint.mjs';
import { withRepository, readGit } from './checkpoint-core.mjs';
import { isDirectRun } from './direct-run.mjs';

export const BRIEF_BINDING_INFO_STRING = 'aw-task-binding';
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const START = 0;
const ONE = 1;
const EMPTY = '';
const NL = '\n';
const NUL = '\0';
const CR_END = /\r$/;
const UTF8 = 'utf8';
const STRING = 'string';
const OBJECT = 'object';
const HASH = 'sha256';
const HEX = 'hex';
const SHA_PREFIX = 'sha256:';
const DIGEST_LINE = 'task-brief digest';
const FENCE = '```';
const FENCE_RE = /^(`{3,})(.*)$/;
const TITLE_RE = /^# Task: (\S.*)$/;
const HEADING_RE = /^#{1,2} /;
const STORY_PREFIX = 'Story:';
const HEADINGS = ['## Slice', '## Reads', '## Acceptance', '## Negative cases', '## Budget'];
const SLICE_FIELDS = [/^Plan: (docs\/plans\/[^/]+\.md)$/, /^Row: (\S+)$/, /^Grouping: (.*)$/, /^Files:$/];
const PAIR_RE = /^- (\S(?:.*\S)?) :: (\S(?:.*\S)?)$/;
const BULLET_RE = /^- (\S.*)$/;
const INTEGER_RE = /^[1-9]\d*$/;
const TEST_RE = /(?:^|\/)[^/]+\.test(?:\.mjs$|\/[^/].*$)/;
const EXTENSION_RE = /\.[^/.]+$/;
const TEST_SUFFIX = '.test.mjs';
const TEST_DIRECTORY = '.test/';
const TEST = 'test';
const IMPL = 'impl';
const PIN = 'pin';
const TAGS = [TEST, IMPL, PIN];
const GROUP_SEPARATOR = ', ';
const PARENT = '..';
const CURRENT = '.';
const READ_OK = 'ok';
const READ_ERROR = 'error';
const CHECKPOINT_KIND = 'checkpoint';
const CHANGED_PATH_ARGS = ['--name-only', '--no-renames', '-z'];
const SCHEMA = 1;
const BINDING_KEYS = ['schema', 'plan', 'reads', 'checkpoint', 'head'];
const FILE_KEYS = ['path', 'sha256'];
const SHA_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEAD_ARGS = ['rev-parse', '--verify', 'HEAD^{commit}'];
const STAMP = 'stamp';
const CHECK = 'check';
const DISPATCH_FLAG = '--dispatch';
const BASIC_ARGS = 2;
const DISPATCH_ARGS = 4;
const ARGV_OFFSET = 2;
const NAMES = { shape: 'shape', grouping: 'grouping', row: 'row', story: 'story', reads: 'reads', binding: 'binding',
  plan: 'binding-plan', read: 'binding-read', checkpoint: 'binding-checkpoint', stale: 'checkpoint-stale',
  head: 'head', boundHead: 'binding-head', dispatch: 'dispatch-inputs' };
const USAGE_TEXT = 'usage: task-brief stamp <brief> | check <brief> [--dispatch <file>]';
const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;

const refuse = (reason, code = REFUSE) => ({ ok: false, code, reason });
const reject = (name, detail = EMPTY) => { throw new Error(`${name}: ${detail}`); };
const computeDigest = (bytes) => createHash(HASH).update(bytes).digest(HEX);
const matchLine = (pattern, line) => {
  const match = pattern.exec(line ?? EMPTY);
  if (match === null) reject(NAMES.shape, line);
  return match.slice(ONE);
};
const splitBindingBlocks = (text) => {
  const raw = text.split(NL);
  const lines = raw.map((line) => line.replace(CR_END, EMPTY));
  const state = lines.reduce((state, line, index) => {
    const fence = FENCE_RE.exec(line);
    if (fence === null) return state;
    const ticks = fence[ONE].length;
    const info = fence[BASIC_ARGS].trim();
    if (state.open === null) return { ...state, open: { ticks, info, start: index } };
    if (info !== EMPTY || ticks < state.open.ticks) return state;
    const blocks = state.open.info === BRIEF_BINDING_INFO_STRING
      ? [...state.blocks, { start: state.open.start, end: index, source: lines.slice(state.open.start + ONE, index).join(NL) }]
      : state.blocks;
    return { open: null, blocks };
  }, { open: null, blocks: [] });
  const unclosed = state.open?.info === BRIEF_BINDING_INFO_STRING;
  const blocks = unclosed ? [...state.blocks, { start: state.open.start, end: lines.length, source: null }] : state.blocks;
  const outside = (index) => !blocks.some(({ start, end }) => index >= start && index <= end);
  return { blocks, unclosed, body: raw.filter((line, index) => outside(index)).join(NL),
    lines: lines.filter((line, index) => outside(index) && line.trim() !== EMPTY) };
};
export const parseBrief = (text) => {
  try {
    if (typeof text !== STRING) return refuse(NAMES.shape);
    const document = splitBindingBlocks(text);
    const lines = document.lines;
    const [title] = matchLine(TITLE_RE, lines[START]);
    const headings = lines.flatMap((line, index) => HEADING_RE.test(line) ? [{ text: line, index }] : []);
    if (headings.length !== HEADINGS.length + ONE || HEADINGS.some((text, index) => headings[index + ONE]?.text !== text)) reject(NAMES.shape);
    const sections = HEADINGS.map((heading, index) => lines.slice(headings[index + ONE].index + ONE, headings[index + BASIC_ARGS]?.index ?? lines.length));
    const storyLines = lines.slice(ONE, headings[ONE].index);
    if (storyLines.some((line) => !line.startsWith(STORY_PREFIX))) reject(NAMES.shape);
    const [slice, reads, acceptance, negative, budget] = sections;
    const [[planPath], [rowId], [grouping]] = SLICE_FIELDS.map((pattern, index) => matchLine(pattern, slice[index]));
    const files = slice.slice(SLICE_FIELDS.length).map((line) => {
      const [path, tag] = matchLine(PAIR_RE, line);
      return { path, tag };
    });
    const budgets = budget.map((line) => {
      const [path, count] = matchLine(PAIR_RE, line);
      if (!INTEGER_RE.test(count) || !Number.isSafeInteger(Number(count))) reject(NAMES.shape, line);
      return { path, maxLines: Number(count) };
    });
    const filePaths = new Set(files.map(({ path }) => path));
    if (files.length === START || budgets.length !== filePaths.size || new Set(budgets.map(({ path }) => path)).size !== filePaths.size
      || budgets.some(({ path }) => !filePaths.has(path)) || acceptance.length === START || negative.length === START) reject(NAMES.shape);
    return { ok: true, title, storyLines, planPath, rowId, grouping, files, budgets,
      reads: reads.map((line) => matchLine(BULLET_RE, line)[START]),
      acceptance: acceptance.map((line) => matchLine(PAIR_RE, line)), negative: negative.map((line) => matchLine(BULLET_RE, line)[START]),
      blocks: document.blocks, unclosed: document.unclosed, body: document.body };
  } catch (error) { return refuse(error.message); }
};
const isInside = (top, path) => {
  const rel = relative(top, path);
  return !isAbsolute(rel) && rel !== PARENT && !rel.startsWith(`${PARENT}${sep}`);
};
const readInside = (context, path, name = NAMES.reads) => {
  try {
    if (typeof path !== STRING || path === EMPTY || isAbsolute(path)) reject(name, path);
    const absolute = resolve(context.cwd, path);
    if (!isInside(context.top, absolute) || !isInside(realpathSync(context.top), realpathSync(dirname(absolute)))) reject(name, path);
    const result = readFileBytesNoFollow(absolute, context.io);
    if (result.outcome !== READ_OK) reject(name, `${path}: ${result.code ?? result.className ?? result.outcome}`);
    return { path, absolute, bytes: result.bytes, sha256: computeDigest(result.bytes) };
  } catch (error) { reject(name, `${path}: ${error.message}`); }
};
const checkGrouping = (brief, row) => {
  if (brief.files.some(({ tag }) => !TAGS.includes(tag))
    || brief.grouping !== TAGS.filter((tag) => brief.files.some((file) => file.tag === tag)).join(GROUP_SEPARATOR)) reject(NAMES.grouping);
  const pins = brief.files.filter(({ tag }) => tag === PIN);
  if (row && posix.basename(row.path) === PIN_FILE) {
    if (pins.length !== ONE || pins[START].path !== row.path) reject(NAMES.grouping);
  } else if (pins.length !== START) reject(NAMES.grouping);
};
const checkRow = (context, brief, row) => {
  if (!row?.valid) reject(NAMES.row, brief.rowId);
  const files = brief.files.map((file) => {
    const path = posix.normalize(file.path);
    if (path !== file.path || path === CURRENT || path.startsWith(PARENT) || posix.isAbsolute(path)) reject(NAMES.row, file.path);
    return { ...file, path };
  });
  const implementations = files.filter(({ tag }) => tag === IMPL).map(({ path }) => path);
  const allowed = isSweep(row.path) ? expandSweepPaths(context.top, [row.path])[row.path] : [row.path];
  if (implementations.some((path) => !allowed.includes(path))) reject(NAMES.row, row.id);
  const tests = files.filter(({ tag }) => tag === TEST);
  if (tests.some(({ path }) => TEST_RE.test(row.path) ? path !== row.path : !implementations.some((impl) => {
    const stem = impl.replace(EXTENSION_RE, EMPTY);
    return path === `${stem}${TEST_SUFFIX}` || path.startsWith(`${stem}${TEST_DIRECTORY}`);
  }))) reject(NAMES.row, row.id);
};
const selectStory = (lines) => {
  const entries = lines.map((text, index) => ({ text, line: index + ONE }));
  const result = readStoryLine(entries);
  return result.story && result.findings.length === START ? lines[result.story.line - ONE] : null;
};
const readGrammar = (context, briefPath) => {
  const file = readInside(context, briefPath);
  const brief = parseBrief(file.bytes.toString(UTF8));
  if (!brief.ok) return brief;
  const plan = readInside(context, brief.planPath);
  const ledger = parseLedger(plan.bytes.toString(UTF8));
  const row = ledger.rows.find(({ id }) => id === brief.rowId);
  checkGrouping(brief, row);
  checkRow(context, brief, row);
  const goal = ledger.document.headings.find(({ text }) => text === PLAN_HEADINGS[START]);
  const end = ledger.document.headings.find(({ index }) => index > goal?.index);
  const story = goal ? selectStory(ledger.document.lines.slice(goal.index + ONE, end?.index)) : null;
  if (story === null || selectStory(brief.storyLines) !== story) reject(NAMES.story);
  return { ok: true, file, brief, plan };
};
const checkBlockCount = (brief, required) => {
  if (brief.unclosed || brief.blocks.length > ONE || (required && brief.blocks.length !== ONE)) reject(NAMES.binding);
};
const hasClosedKeys = (value, keys) => value !== null && typeof value === OBJECT && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isFileBinding = (value) => hasClosedKeys(value, FILE_KEYS) && typeof value.path === STRING && typeof value.sha256 === STRING && SHA_RE.test(value.sha256);
const readBinding = (brief) => {
  checkBlockCount(brief, true);
  try {
    const value = JSON.parse(brief.blocks[START].source);
    if (!hasClosedKeys(value, BINDING_KEYS) || value.schema !== SCHEMA || !isFileBinding(value.plan)
      || !Array.isArray(value.reads) || !value.reads.every(isFileBinding) || typeof value.checkpoint !== STRING
      || !OID_RE.test(value.checkpoint) || typeof value.head !== STRING || !OID_RE.test(value.head)) reject(NAMES.binding);
    return value;
  } catch (error) { reject(NAMES.binding, error.message); }
};
const readHead = (context, name) => {
  try {
    const oid = readGit(context, HEAD_ARGS);
    if (!OID_RE.test(oid)) reject(name);
    return oid;
  } catch (error) { reject(name, error.message); }
};
const bindFile = ({ path, sha256 }) => ({ path, sha256 });
const checkDispatch = (context, dispatchPath, briefPath, digest) => {
  const file = readInside(context, dispatchPath, NAMES.dispatch);
  const parsed = parseDispatchContract(file.bytes.toString(UTF8));
  if (!parsed.ok || typeof parsed.contract.inputs !== STRING || !parsed.contract.inputs.includes(briefPath)
    || !parsed.contract.inputs.includes(`${SHA_PREFIX}${digest}`)) reject(NAMES.dispatch);
};

export const stampBrief = (cwd, briefPath, io = {}) => withRepository(cwd, io, (context) => {
  const grammar = readGrammar(context, briefPath);
  if (!grammar.ok) return grammar;
  const { file, brief, plan } = grammar;
  checkBlockCount(brief, false);
  const reads = brief.reads.map((path) => bindFile(readInside(context, path)));
  const newest = newestCheckpoint(cwd, brief.planPath, context.io);
  if (!newest.ok) return newest;
  const binding = { schema: SCHEMA, plan: bindFile(plan), reads, checkpoint: newest.oid, head: readHead(context, NAMES.head) };
  const bytes = Buffer.from(`${brief.body.trimEnd()}${NL}${NL}${FENCE}${BRIEF_BINDING_INFO_STRING}${NL}${JSON.stringify(binding)}${NL}${FENCE}${NL}`, UTF8);
  writeFileSync(file.absolute, bytes, { flag: WRITE_FLAGS });
  return { ok: true, digest: computeDigest(bytes) };
});

export const checkBrief = (cwd, briefPath, { dispatchPath } = {}, io = {}) => withRepository(cwd, io, (context) => {
  const grammar = readGrammar(context, briefPath);
  if (!grammar.ok) return grammar;
  const { file, brief, plan } = grammar;
  const binding = readBinding(brief);
  const newest = newestCheckpoint(cwd, brief.planPath, context.io);
  if (!newest.ok) return newest;
  const reads = brief.reads.map((path) => bindFile(readInside(context, path)));
  if (binding.plan.path !== brief.planPath || binding.plan.sha256 !== plan.sha256) reject(NAMES.plan);
  if (binding.reads.length !== reads.length || reads.some((entry, index) =>
    entry.path !== binding.reads[index].path || entry.sha256 !== binding.reads[index].sha256)) reject(NAMES.read);
  if (binding.checkpoint !== newest.oid) reject(NAMES.checkpoint);
  const verified = verifyCheckpoint(cwd, binding.checkpoint, context.io);
  if (!verified.ok) reject(NAMES.stale, verified.reason);
  if (!verified.clean) {
    const changed = runBaseDiff(context.top, { kind: CHECKPOINT_KIND, treeOid: binding.checkpoint }, CHANGED_PATH_ARGS, context.io);
    if (changed === null) reject(NAMES.stale, verified.reason);
    const paths = changed.toString(UTF8).split(NUL).filter(Boolean);
    const ledger = readDelegationLedger(context.cwd, context.env);
    if (ledger.state === READ_ERROR) reject(NAMES.stale, ledger.reason);
    const claimed = new Set(ledger.state === READ_OK
      ? claimedPaths(ledger.records, binding.checkpoint, ledger.head, isThreadTerminalRecord) : []);
    const ownFiles = new Set(brief.files.map(({ path }) => path));
    if (!paths.every((path) => claimed.has(path) && !ownFiles.has(path))) reject(NAMES.stale, verified.reason);
  }
  if (binding.head !== readHead(context, NAMES.boundHead)) reject(NAMES.boundHead);
  if (dispatchPath !== undefined) checkDispatch(context, dispatchPath, briefPath, file.sha256);
  return { ok: true, digest: file.sha256 };
});

const formatResult = (result) => result.ok
  ? { code: ACCEPT, stdout: `${DIGEST_LINE} ${SHA_PREFIX}${result.digest}${NL}`, stderr: EMPTY }
  : { code: result.code, stdout: EMPTY, stderr: `${result.reason}${NL}` };
export const main = (argv = process.argv.slice(ARGV_OFFSET), deps = {}) => {
  try {
    const [verb, path, flag, dispatchPath] = argv;
    if (!path || !(verb === STAMP || verb === CHECK) || !(argv.length === BASIC_ARGS
      || (verb === CHECK && argv.length === DISPATCH_ARGS && flag === DISPATCH_FLAG && dispatchPath))) return formatResult(refuse(USAGE_TEXT, USAGE));
    const cwd = deps.cwd ?? process.cwd();
    return formatResult(verb === STAMP ? stampBrief(cwd, path, deps) : checkBrief(cwd, path, { dispatchPath }, deps));
  } catch (error) { return formatResult(refuse(error.message)); }
};

if (isDirectRun(import.meta.url)) {
  const result = main();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
