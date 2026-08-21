// agy-review-await-guard.test.mjs — the source-level guard that makes the agy-review suite's
// asynchronous dispatch lane self-checking.
//
// Why this exists, and why it is a SEPARATE FILE.
//
// `agy-review.test.mjs` drives a bash wrapper. Every dispatch used to be a blocking `spawnSync`,
// which pinned the whole file to one core: 208 test points in one serial chain, 91.4s solo at
// 103% CPU while the rest of the machine idled. The dispatch helpers are asynchronous now, so the
// file's describes overlap — and that turns a MISSING `await` into a real hazard.
//
// The tempting claim is that a missing `await` announces itself: an assertion against a Promise
// never matches a status. That claim is FALSE here, and one site proves it — a dispatch whose
// RESULT IS DISCARDED (`run(sb, {...});` as a bare statement, the receipt read on the next line).
// Un-awaited, that test reads the fixture before the wrapper has written it and tears the sandbox
// down underneath a live child. Nothing in the suite can catch that; only the source can.
//
// It is a separate FILE rather than a describe inside the suite because the repo's survivor-corpus
// checker (`scripts/suite-parity.mjs`) binds each SURVIVING file's assert-call-site COUNT, and
// `--accept-rewrites` exempts the assertion-expression hash only, never the count. A guard added
// to `agy-review.test.mjs` itself would fail the very acceptance it exists to serve; a NEW file is
// counted separately and is never a parity failure.
//
// Dependency-free, Node >= 22. No side effects on import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE_REL = 'agy-review.test.mjs';
const SUITE_PATH = join(HERE, SUITE_REL);

// A CALL, not a definition and not prose: the callee name, `(`, then an identifier start. A
// definition reads `const run = (`, and a comment's `run()` carries no argument, so neither
// matches. Keying on the ARGUMENT NAME instead would be a trap — the suite's sandboxes are called
// `sb`, `single`, `fedSb`, `utf8`, and a pattern pinned to `sb` silently skips the rest (it did,
// and the suite failed on exactly those sites).
const DISPATCH_CALL = /\b(?:run|fedRun|runAsync)\(\s*[A-Za-z_${]/g;

// A call site is DISCHARGED when the code immediately before it hands the promise on. Two rules,
// and they are NOT the same rule — reading the raw prefix for either keyword is a false green in
// the one guard that exists to prevent false greens:
//   • `return` counts ONLY on the call's own line. ASI ends a bare `return` at the newline, so
//     `return\n  run(...)` returns undefined and leaves the dispatch unheld.
//   • `await` and an arrow head may sit on an earlier line, so those are read across newlines —
//     but only after TRAILING PROSE is dropped, because a comment line ending in the word "await"
//     or "return" looks exactly like the keyword to a suffix test.
// The keyword must come from CODE. A line-oriented prose filter is not enough — `previous(); //
// await` is a code line whose tail is a comment — so comment and string bodies are masked to
// spaces in one pass first. Newlines survive the mask so the per-line `return` rule still sees
// them. Not a parser: it tracks the states a JS prefix can be in, and every ambiguity it cannot
// resolve leaves MORE text masked, which can only make the guard stricter.
// Mask ONE line: a comment tail and every string body become spaces, so no keyword can come from
// prose. Per LINE on purpose — a whole-file scan accumulates state, and one quote inside a regex
// leaves it "in a string" for the rest of the file (measured: 21 real call sites reported as
// un-awaited). A `'`/`"` string cannot span a newline and neither can a `//` comment, so a
// line-scoped mask resynchronises at every newline and cannot desync at all.
// Stated residual: a line INSIDE a multi-line template literal or block comment is read as code.
export const maskLine = (line) => {
  if (/^\s*\*/.test(line)) return ' '.repeat(line.length);
  const out = [...line];
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === null) {
      if (ch === '/' && line[i + 1] === '/') { for (let j = i; j < line.length; j += 1) out[j] = ' '; break; }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      continue;
    }
    if (ch === '\\') { out[i] = ' '; if (i + 1 < line.length) out[i + 1] = ' '; i += 1; continue; }
    if (ch === quote) { quote = null; continue; }
    out[i] = ' ';
  }
  return out.join('');
};

// Two rules, and they are NOT the same rule:
//   • `return` counts ONLY on the call's own line — ASI ends a bare `return` at the newline, so
//     `return\n  run(...)` returns undefined and leaves the dispatch unheld;
//   • `await` and an arrow head may sit on an earlier line, so the walk skips blank and
//     fully-masked lines to find the nearest line that carries code.
// Neither keyword counts when it is part of a longer name or a member access (`x.await`).
const RETURNED_HERE = /(?<![.$\w])return[ \t]*$/;
const HANDED_ON = /(?:(?<![.$\w])await|=>)\s*$/;

export const isDischarged = (rawPrefix) => {
  const lines = rawPrefix.split('\n').map(maskLine);
  if (RETURNED_HERE.test(lines[lines.length - 1])) return true;
  let at = lines.length - 1;
  while (at >= 0 && /^\s*$/.test(lines[at])) at -= 1;
  return at >= 0 && HANDED_ON.test(lines[at]);
};

const sourceOf = () => readFileSync(SUITE_PATH, 'utf8');

export const dispatchSites = (source) => {
  const sites = [];
  for (const match of source.matchAll(DISPATCH_CALL)) {
    const before = source.slice(0, match.index);
    sites.push({
      line: before.split('\n').length,
      call: match[0],
      discharged: isDischarged(before),
    });
  }
  return sites;
};

describe('agy-review suite — every wrapper dispatch is awaited (concurrency guard)', () => {
  // A guard that matches nothing passes for the wrong reason. The suite carried 188 dispatch call
  // sites when this guard was written; the floor is deliberately below that so ordinary editing
  // does not trip it, and far above zero so a broken pattern cannot read as "all clear".
  it('the guard really finds the suite dispatch sites (never a vacuous pass)', () => {
    const sites = dispatchSites(sourceOf());
    assert.ok(sites.length >= 150, `only ${sites.length} dispatch call site(s) matched — the pattern stopped seeing the suite`);
  });

  it('no dispatch call site is left un-awaited', () => {
    const loose = dispatchSites(sourceOf()).filter((site) => !site.discharged);
    assert.deepEqual(
      loose.map((site) => `${SUITE_REL}:${site.line} ${site.call}`),
      [],
      'each listed site starts a dispatch whose promise nothing holds — prefix it with await',
    );
  });

  // The predicate must be able to REPORT a violation, or the green above proves nothing. Two
  // fixtures, one per arm, run through the same exported function the assertions above use.
  it('the predicate reports a bare dispatch and accepts a discharged one', () => {
    assert.deepEqual(
      dispatchSites('  run(sb, { args: [] });\n').map((site) => site.discharged),
      [false],
      'a bare statement dispatch must be reported',
    );
    assert.deepEqual(
      dispatchSites('  const r = await run(sb, {});\n  return fedRun(sb);\n  const f = (sb) =>\n    runAsync(sb, {});\n')
        .map((site) => site.discharged),
      [true, true, true],
      'await, return and an arrow body all discharge the promise',
    );
    // The three shapes that LOOK discharged to a prefix test and are not. Each fixture really ends
    // in the keyword — a fixture whose comment trails off into another word tests nothing.
    assert.deepEqual(
      dispatchSites('  // do not await\n  run(sb, {});\n').map((site) => site.discharged),
      [false],
      'a comment ending in await is prose, not a discharge',
    );
    assert.deepEqual(
      dispatchSites('  // early return\n  run(sb, {});\n').map((site) => site.discharged),
      [false],
      'a comment ending in return is prose, not a discharge',
    );
    assert.deepEqual(
      dispatchSites('  return\n  run(sb, {});\n').map((site) => site.discharged),
      [false],
      'ASI ends a bare return at the newline, so the next call is NOT returned',
    );
    assert.deepEqual(
      dispatchSites('  previous(); // await\n  run(sb, {});\n').map((site) => site.discharged),
      [false],
      'a CODE line whose tail is a comment ending in await is still prose',
    );
    assert.deepEqual(
      dispatchSites('  const x = thing.await\n  run(sb, {});\n').map((site) => site.discharged),
      [false],
      'a member access named await is not the operator',
    );
    assert.deepEqual(
      dispatchSites("  const s = 'await ';\n  run(sb, {});\n").map((site) => site.discharged),
      [false],
      'a string whose body ends in await is not the operator',
    );
  });
});
