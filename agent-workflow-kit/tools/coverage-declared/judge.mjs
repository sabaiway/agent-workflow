import { join } from 'node:path';
import { COVERAGE_DECLARED_REL, parseDeclaredList } from './config.mjs';
import { probeRegularFileNoFollow } from '../fs-read-nofollow.mjs';
import { listGitNamedPaths } from '../tracked-tree-census.mjs';

export const DECLARED_LINE_PREFIX = 'coverage-check: declared list — ';
export const DECLARED_MOVED_FAILURE = 'the declared coverage list moved under the final run';

const ABSENT = 'absent';
const UNREADABLE = 'unreadable';
const FOREIGN = 'foreign';
const ERROR = 'error';
const UTF8 = 'utf8';
const ZERO = 0;
const ASCII_FIRST = 32;
const ASCII_LAST = 126;
const HEX_RADIX = 16;
const ESCAPE_WIDTH = 4;
const ESCAPE_PADDING = '0';
const EMPTY_TEXT = '';
const CONFIG_FAILURE_PREFIX = `coverage-check: FAIL — ${COVERAGE_DECLARED_REL}: `;
const PASS_LINE = 'coverage-check: PASS — every changed Node line is covered';

const makeResult = (configFailure = null) => ({ configFailure, notJudged: [], lines: [], failures: [] });
const makeConfigFailure = (defect) => makeResult(`${CONFIG_FAILURE_PREFIX}${defect}`);
const renderAsciiLine = (value) => Array.from(String(value), (character) => {
  const codePoint = character.codePointAt(ZERO);
  return codePoint >= ASCII_FIRST && codePoint <= ASCII_LAST
    ? character : `\\u{${codePoint.toString(HEX_RADIX).padStart(ESCAPE_WIDTH, ESCAPE_PADDING)}}`;
}).join(EMPTY_TEXT);

export const judgeDeclaredList = ({ top, read, changed, spawn }) => {
  if (read.state === ABSENT) return makeResult();
  if (read.state === UNREADABLE) return makeConfigFailure(read.defect);
  const parsed = parseDeclaredList(read.bytes);
  if (!parsed.ok) return makeConfigFailure(parsed.defect);
  const entries = parsed.entries;
  if (entries.length === ZERO) return makeResult();
  const listed = (() => {
    try {
      return { paths: listGitNamedPaths(top, { untracked: true, spawn }) };
    } catch (error) {
      return { failure: makeConfigFailure(renderAsciiLine(error.message)) };
    }
  })();
  if (listed.failure) return listed.failure;
  const result = makeResult();
  const unchanged = [];
  for (const entry of entries) {
    const entryBytes = Buffer.from(entry.path, UTF8);
    const named = listed.paths.some((name) => name.equals(entryBytes));
    const probe = named ? probeRegularFileNoFollow(join(top, entry.path)) : { outcome: ABSENT };
    if (probe.outcome === ABSENT) {
      result.lines.push(`${DECLARED_LINE_PREFIX}names no file of this tree: ${entry.path}`);
      continue;
    }
    if (probe.outcome === FOREIGN || probe.outcome === ERROR) {
      result.failures.push(`${entry.path}: listed in ${COVERAGE_DECLARED_REL} but not a regular file`);
      continue;
    }
    if (changed === null) continue;
    if (!changed.has(entry.path)) {
      unchanged.push(entry.path);
      continue;
    }
    const lineMap = changed.get(entry.path);
    const executed = lineMap !== undefined && [...lineMap.values()].some((hits) => hits > ZERO);
    if (executed) {
      result.lines.push(`${DECLARED_LINE_PREFIX}did not apply, the coverage data shows an executed line: ${entry.path}`);
    } else {
      result.notJudged.push(entry.path);
      result.lines.push(`${DECLARED_LINE_PREFIX}not judged, no executed line in the coverage data: ${entry.path} — ${entry.reason}`);
    }
  }
  if (changed === null) {
    result.lines.push(`${DECLARED_LINE_PREFIX}no coverage data was read, so no entry applied (${entries.length} listed)`);
  } else if (unchanged.length > ZERO) {
    result.lines.push(`${DECLARED_LINE_PREFIX}${unchanged.length} listed file(s) unchanged, not looked up`);
  }
  return result;
};

export const declaredPassLine = (count) => count > ZERO
  ? `coverage-check: PASS — ${count} listed file(s) not judged; every other changed Node line is covered`
  : PASS_LINE;

export const declaredStartRefusal = (read) =>
  `[run-gates] --final: ${COVERAGE_DECLARED_REL} is not readable (${read.defect}) — the declared coverage list cannot be bound; nothing was recorded`;
