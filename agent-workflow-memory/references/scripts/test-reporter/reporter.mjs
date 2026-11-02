// reporter.mjs — the kit test reporter (spec test-reporter): a `node --test --test-reporter=<this file>`
// run prints each failing test's block and one totals line, read from the runner's own events, never its text.
//
// The default export alone: an async generator over the runner's event stream that yields text. Each event is
// rendered under its own guard and the totals line always closes the output, so the reporter never throws and
// never ends the run; it sets no exit code. Dependency-free, Node >= 22. No side effects on import.

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const QUIET_FAILURES = new Set(['subtestsFailed', 'cancelledByParent']);
const TOTAL_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const CLOSING_KEYS = new Set([...TOTAL_KEYS, 'suites', 'duration_ms']);
const ERROR_HEAD = /^[A-Za-z_$][\w$]*(?: \[[\w$]+\])?: /;
const FRAME = /^\s*at (?:.*?\()?(.+?):(\d+):(\d+)\)?$/;
const VALUE_CAP = 500;

const isObject = (value) => typeof value === 'object' && value !== null;
const firstLine = (value) => String(value ?? '').split('\n')[0];
const toPath = (file) => (String(file).startsWith('file:') ? fileURLToPath(String(file)) : String(file));
const absolute = (file) => resolve(toPath(file ?? ''));
const shown = (file) => (file === undefined || file === null ? '?' : relative(process.cwd(), absolute(file)));

// An error's first line, or its fallback when the error's own cannot be read.
const errorLine = (error) => {
  try {
    return firstLine(isObject(error) ? error.message ?? String(error) : error);
  } catch {
    return 'an unreadable error';
  }
};

// One line by util.inspect, cut at the cap with an ellipsis.
const show = (value) => {
  const text = inspect(value, { breakLength: Infinity }).replace(/\n\s*/g, ' ');
  return text.length > VALUE_CAP ? `${text.slice(0, VALUE_CAP)}…` : text;
};

// The first frame inside the working directory and under no node_modules, with its source text when readable.
const codeLine = (stack) => {
  for (const frame of String(stack ?? '').split('\n')) {
    const match = FRAME.exec(frame);
    if (!match || !(match[1].startsWith('file:') || isAbsolute(match[1]))) continue;
    const file = absolute(match[1]);
    const inside = relative(process.cwd(), file);
    if (!inside || isAbsolute(inside) || inside.split(sep).some((part) => part === '..' || part === 'node_modules')) continue;
    let text = '';
    try {
      text = readFileSync(file, 'utf8').split(/\r?\n/)[Number(match[2]) - 1]?.trim() ?? '';
    } catch { /* the location alone */ }
    return `  at ${inside}:${match[2]}:${match[3]}${text ? `  ${text}` : ''}`;
  }
  return null;
};

// The error-head line of a file's standard error, else its first non-blank line.
const stderrLine = (chunks) => {
  const lines = chunks.join('').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => ERROR_HEAD.test(line) && !line.startsWith('at ')) ?? lines[0];
};

const renderFailure = (data, names, stderr) => {
  const error = data.details?.error;
  const cause = error?.cause ?? error;
  const path = [...Array.from({ length: data.nesting ?? 0 }, (_, at) => names[at] ?? '?'), data.name].join(' > ');
  const klass = isObject(cause) && typeof cause.name === 'string' && cause.name ? `${cause.name}: ` : '';
  const lines = [`FAIL ${shown(data.file)}:${data.line ?? '?'} ${path}`, `  ${error?.failureType ?? '?'}: ${klass}${firstLine(isObject(cause) ? cause.message : cause)}`];
  if (isObject(cause) && Object.hasOwn(cause, 'expected') && Object.hasOwn(cause, 'actual')) {
    lines.push(`  expected: ${show(cause.expected)}`, `  actual:   ${show(cause.actual)}`);
  }
  const at = isObject(cause) ? codeLine(cause.stack) : null;
  if (at) lines.push(at);
  const fileLevel = (data.nesting ?? 0) === 0 && typeof data.name === 'string' && absolute(data.name) === absolute(data.file);
  const line = fileLevel && stderr ? stderrLine(stderr) : undefined;
  if (line) lines.push(`  stderr: ${line}`);
  return `${lines.join('\n')}\n`;
};

export default async function* testReporter(source) {
  const names = new Map();
  const stderr = new Map();
  const totals = {};
  const kept = [];
  let green = null;
  let failed = false;
  const read = (event) => {
    const { type, data } = event ?? {};
    if (type === 'test:start') {
      const key = absolute(data.file);
      names.set(key, names.get(key) ?? []).get(key)[data.nesting] = data.name;
    } else if (type === 'test:stderr') {
      const key = absolute(data.file);
      stderr.set(key, stderr.get(key) ?? []).get(key).push(String(data.message ?? ''));
    } else if (type === 'test:summary') {
      if (data.file === undefined) green = data.success === true;
    } else if (type === 'test:diagnostic') {
      const [key, value] = String(data.message ?? '').split(' ');
      if (data.file === undefined && CLOSING_KEYS.has(key)) {
        if (TOTAL_KEYS.includes(key)) totals[key] = value;
      } else {
        kept.push(`diagnostic: ${firstLine(data.message)}\n`);
      }
    } else if (type === 'test:fail' && !data.todo && !data.skip && !QUIET_FAILURES.has(data.details?.error?.failureType)) {
      failed = true;
      return renderFailure(data, names.get(absolute(data.file)) ?? [], stderr.get(absolute(data.file)));
    }
    return null;
  };
  try {
    for await (const event of source) {
      let text;
      try {
        text = read(event);
      } catch (error) {
        text = `reporter: an event could not be rendered (${errorLine(error)})\n`;
      }
      if (text) yield text;
    }
  } catch (error) {
    yield `reporter: the event stream ended with an error (${errorLine(error)})\n`;
  }
  const red = green === null ? Number(totals.fail) > 0 || Number(totals.cancelled) > 0 : !green;
  if (red) {
    yield* kept;
    if (!failed && kept.length === 0) yield 'reporter: the run failed and no test reported a failure\n';
  }
  yield `${TOTAL_KEYS.map((key) => `${key} ${totals[key] ?? '?'}`).join(' · ')}\n`;
}
