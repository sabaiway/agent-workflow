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
export const NAMES = { shape: 'shape', grouping: 'grouping', row: 'row', story: 'story', reads: 'reads', binding: 'binding',
  plan: 'binding-plan', read: 'binding-read', checkpoint: 'binding-checkpoint', stale: 'checkpoint-stale',
  head: 'head', boundHead: 'binding-head', dispatch: 'dispatch-inputs', environment: 'environment' };
const HANDED_UP = ['stem', 'sequence', 'no-checkpoint'];
const MEMBERS = new Set([...Object.values(NAMES), ...HANDED_UP]);
const NAME_SEPARATOR = ': ';
const LINE_BREAKS = /[\r\n]/g;
const ESCAPED_BREAKS = { '\r': '\\r', '\n': '\\n' };
const SLICE_NAMES = ['Plan', 'Row', 'Grouping', 'Files:'];
const STALE_REMEDY = 'mint a fresh checkpoint, then stamp the brief again';
const USAGE_TEXT = 'usage: task-brief stamp <brief> | check <brief> [--dispatch <file>]';
const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;

const refuse = (reason, code = REFUSE) => ({ ok: false, code, reason });
const reject = (name, detail) => { throw new Error(`${name}${NAME_SEPARATOR}${detail}`); };
const computeDigest = (bytes) => createHash(HASH).update(bytes).digest(HEX);
const matchLine = (pattern, line, rule) => {
  const match = pattern.exec(line ?? EMPTY);
  if (match === null) reject(NAMES.shape, line === undefined ? `${rule} is absent` : `${rule}: ${line}`);
  return match.slice(ONE);
};
const checkMembers = (found, expected, label) => {
  const faults = [[found.find((item) => !expected.includes(item)), 'is foreign'],
    [found.find((item, index) => found.indexOf(item) !== index), 'is repeated'], [expected.find((item) => !found.includes(item)), 'is absent']];
  const [item, fault] = faults.find(([candidate]) => candidate !== undefined) ?? [];
  if (item !== undefined) reject(NAMES.shape, `${label} ${item} ${fault}`);
};
const checkSliceField = (pattern, line, index) => {
  const name = SLICE_NAMES[index];
  if (line === undefined || !line.startsWith(name)) reject(NAMES.shape, `## Slice field ${name} is absent before: ${line ?? 'the section end'}`);
  return matchLine(pattern, line, `## Slice field ${name} is malformed`);
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
    if (typeof text !== STRING) return refuse(`${NAMES.shape}${NAME_SEPARATOR}the brief is not text`);
    const document = splitBindingBlocks(text);
    const lines = document.lines;
    const [title] = matchLine(TITLE_RE, lines[START], 'the title is not "# Task: <name>"');
    const headings = lines.flatMap((line, index) => HEADING_RE.test(line) ? [{ text: line, index }] : []);
    const storyLines = lines.slice(ONE, headings[ONE]?.index ?? lines.length);
    const stray = storyLines.find((line) => !line.startsWith(STORY_PREFIX));
    if (stray !== undefined) reject(NAMES.shape, `a line before ## Slice is not a Story line: ${stray}`);
    const found = headings.slice(ONE).map(({ text }) => text);
    checkMembers(found, HEADINGS, 'heading');
    if (HEADINGS.some((text, index) => found[index] !== text)) reject(NAMES.shape, `headings out of order: ${found.join(', ')}`);
    const sections = HEADINGS.map((heading, index) => lines.slice(headings[index + ONE].index + ONE, headings[index + BASIC_ARGS]?.index ?? lines.length));
    const [slice, reads, acceptance, negative, budget] = sections;
    const [[planPath], [rowId], [grouping]] = SLICE_FIELDS.map((pattern, index) => checkSliceField(pattern, slice[index], index));
    const files = slice.slice(SLICE_FIELDS.length).map((line) => {
      const [path, tag] = matchLine(PAIR_RE, line, 'a Files: line is not "- <path> :: <tag>"');
      return { path, tag };
    });
    const budgets = budget.map((line) => {
      const [path, count] = matchLine(PAIR_RE, line, 'a ## Budget line is not "- <path> :: <lines>"');
      if (!INTEGER_RE.test(count) || !Number.isSafeInteger(Number(count))) reject(NAMES.shape, `a ## Budget count is not a positive integer: ${line}`);
      return { path, maxLines: Number(count) };
    });
    if (files.length === START) reject(NAMES.shape, 'Files: lists no path');
    checkMembers(budgets.map(({ path }) => path), [...new Set(files.map(({ path }) => path))], '## Budget path');
    if (acceptance.length === START) reject(NAMES.shape, '## Acceptance lists no line');
    if (negative.length === START) reject(NAMES.shape, '## Negative cases lists no line');
    return { ok: true, title, storyLines, planPath, rowId, grouping, files, budgets,
      reads: reads.map((line) => matchLine(BULLET_RE, line, 'a ## Reads line is not a bullet')[START]),
      acceptance: acceptance.map((line) => matchLine(PAIR_RE, line, 'an ## Acceptance line is not "- <command> :: <outcome>"')),
      negative: negative.map((line) => matchLine(BULLET_RE, line, 'a ## Negative cases line is not a bullet')[START]),
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
  const foreign = brief.files.find(({ tag }) => !TAGS.includes(tag));
  if (foreign !== undefined) reject(NAMES.grouping, `${foreign.path} carries the tag ${foreign.tag}, not test, impl or pin`);
  const expected = TAGS.filter((tag) => brief.files.some((file) => file.tag === tag)).join(GROUP_SEPARATOR);
  if (brief.grouping !== expected) reject(NAMES.grouping, `Grouping: ${brief.grouping} differs from the Files tags ${expected}`);
  const pins = brief.files.filter(({ tag }) => tag === PIN);
  if (row && posix.basename(row.path) === PIN_FILE) {
    if (pins.length !== ONE || pins[START].path !== row.path) reject(NAMES.grouping, `a pin row tags only its own path ${row.path} pin`);
  } else if (pins.length !== START) reject(NAMES.grouping, `the pin tag belongs to a ${PIN_FILE} row only`);
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
  const bases = implementations.length > START ? implementations : allowed;
  if (tests.some(({ path }) => TEST_RE.test(row.path) ? path !== row.path : !bases.some((impl) => {
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
  if (story === null) reject(NAMES.story, `${brief.planPath} carries no single Story line`);
  if (selectStory(brief.storyLines) !== story) reject(NAMES.story, `the brief's Story line differs from the plan's ${story}`);
  return { ok: true, file, brief, plan };
};
const checkBlockCount = (brief, required) => {
  if (brief.unclosed) reject(NAMES.binding, `the ${BRIEF_BINDING_INFO_STRING} block never closes`);
  if (brief.blocks.length > ONE) reject(NAMES.binding, `more than one ${BRIEF_BINDING_INFO_STRING} block`);
  if (required && brief.blocks.length !== ONE) reject(NAMES.binding, `no ${BRIEF_BINDING_INFO_STRING} block: stamp the brief first`);
};
const hasClosedKeys = (value, keys) => value !== null && typeof value === OBJECT && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isFileBinding = (value) => hasClosedKeys(value, FILE_KEYS) && typeof value.path === STRING && typeof value.sha256 === STRING && SHA_RE.test(value.sha256);
const readBinding = (brief) => {
  checkBlockCount(brief, true);
  let value;
  try {
    value = JSON.parse(brief.blocks[START].source);
  } catch (error) { reject(NAMES.binding, error.message); }
  if (!hasClosedKeys(value, BINDING_KEYS) || value.schema !== SCHEMA || !isFileBinding(value.plan)
    || !Array.isArray(value.reads) || !value.reads.every(isFileBinding) || typeof value.checkpoint !== STRING
    || !OID_RE.test(value.checkpoint) || typeof value.head !== STRING || !OID_RE.test(value.head)) reject(NAMES.binding, `the block is not a schema ${SCHEMA} binding`);
  return value;
};
const readHead = (context, name) => {
  let oid;
  try {
    oid = readGit(context, HEAD_ARGS);
  } catch (error) { reject(name, error.message); }
  if (!OID_RE.test(oid)) reject(name, `HEAD resolves to ${oid}, not an object id`);
  return oid;
};
const stale = (cause) => reject(NAMES.stale, `${cause}; ${STALE_REMEDY}`);
const bindFile = ({ path, sha256 }) => ({ path, sha256 });
const checkDispatch = (context, dispatchPath, briefPath, digest) => {
  const file = readInside(context, dispatchPath, NAMES.dispatch);
  const parsed = parseDispatchContract(file.bytes.toString(UTF8));
  if (!parsed.ok) reject(NAMES.dispatch, `${dispatchPath}: ${parsed.reason}`);
  const inputs = parsed.contract.inputs;
  if (typeof inputs !== STRING || !inputs.includes(briefPath) || !inputs.includes(`${SHA_PREFIX}${digest}`)) reject(NAMES.dispatch, `${dispatchPath} inputs do not name ${briefPath} at ${SHA_PREFIX}${digest}`);
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
  if (binding.plan.path !== brief.planPath || binding.plan.sha256 !== plan.sha256) reject(NAMES.plan, `${brief.planPath} changed since the stamp`);
  if (binding.reads.length !== reads.length) reject(NAMES.read, `## Reads lists ${reads.length} files, the stamp bound ${binding.reads.length}`);
  const moved = reads.find((entry, index) => entry.path !== binding.reads[index].path || entry.sha256 !== binding.reads[index].sha256);
  if (moved !== undefined) reject(NAMES.read, `${moved.path} changed since the stamp`);
  if (binding.checkpoint !== newest.oid) reject(NAMES.checkpoint, `the stamp bound checkpoint ${binding.checkpoint}, the newest is ${newest.oid}`);
  const verified = verifyCheckpoint(cwd, binding.checkpoint, context.io);
  if (!verified.ok) return verified;
  if (!verified.clean) {
    const changed = runBaseDiff(context.top, { kind: CHECKPOINT_KIND, treeOid: binding.checkpoint }, CHANGED_PATH_ARGS, context.io);
    if (changed === null) stale(`the tree differs from checkpoint ${binding.checkpoint}`);
    const paths = changed.toString(UTF8).split(NUL).filter(Boolean);
    const ledger = readDelegationLedger(context.cwd, context.env);
    if (ledger.state === READ_ERROR) stale(ledger.reason);
    const claimed = new Set(ledger.state === READ_OK
      ? claimedPaths(ledger.records, binding.checkpoint, ledger.head, isThreadTerminalRecord) : []);
    const ownFiles = new Set(brief.files.map(({ path }) => path));
    const unclaimed = paths.filter((path) => !claimed.has(path) || ownFiles.has(path));
    if (unclaimed.length > START) stale(`${unclaimed.join(', ')} changed since checkpoint ${binding.checkpoint}`);
  }
  const head = readHead(context, NAMES.boundHead);
  if (binding.head !== head) reject(NAMES.boundHead, `the stamp bound HEAD ${binding.head}, HEAD is now ${head}`);
  if (dispatchPath !== undefined) checkDispatch(context, dispatchPath, briefPath, file.sha256);
  return { ok: true, digest: file.sha256 };
});

const nameReason = (reason) => {
  const text = String(reason).replace(LINE_BREAKS, (byte) => ESCAPED_BREAKS[byte]);
  const cut = text.indexOf(NAME_SEPARATOR);
  const named = cut > START && MEMBERS.has(text.slice(START, cut)) && text.slice(cut + NAME_SEPARATOR.length).trim() !== EMPTY;
  return named ? text : `${NAMES.environment}${NAME_SEPARATOR}${text}`;
};
const formatResult = (result) => result.ok
  ? { code: ACCEPT, stdout: `${DIGEST_LINE} ${SHA_PREFIX}${result.digest}${NL}`, stderr: EMPTY }
  : { code: result.code, stdout: EMPTY, stderr: `${result.code === REFUSE ? nameReason(result.reason) : result.reason}${NL}` };
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
