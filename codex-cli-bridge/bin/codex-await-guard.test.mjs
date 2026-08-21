// codex-await-guard.test.mjs — the source-level guard that makes this bridge's asynchronous
// dispatch lane self-checking. Twin of the antigravity bridge's guard; a bridge dir ships WHOLE and
// is placed on its own, so neither guard can read the other's suite and the rule lives once per
// bundle rather than once per family.
//
// Why it exists. Both suites drive a bash wrapper, and every dispatch used to be a blocking
// `spawnSync` that pinned the file to one core. The dispatches are awaited now so a describe can
// declare concurrency — which turns a MISSING `await` into a real hazard.
//
// The tempting claim is that a missing `await` announces itself, because an assertion against a
// Promise never matches a status. That claim is FALSE at the sites where the dispatch's RESULT IS
// DISCARDED (`run(sb, {...});` as a bare statement, the capture read on the next line). Un-awaited,
// such a test reads the fixture before the wrapper has written it and tears the sandbox down under
// a live child. Nothing in the suites can catch that; only the source can.
//
// It is a separate FILE rather than a describe inside a suite because the repo's survivor-corpus
// checker (`scripts/suite-parity.mjs`) binds each SURVIVING file's assert-call-site COUNT and
// `--accept-rewrites` exempts only the assertion-expression hash, never the count. A guard added to
// a suite would fail the very acceptance it exists to serve; a NEW file is counted separately.
//
// Dependency-free, Node >= 22. No side effects on import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = Object.freeze(['codex-exec.test.mjs', 'codex-review.test.mjs']);

// A CALL, not a definition and not prose: the callee name, `(`, then an identifier or object start.
// A definition reads `const run = (`, and a comment's `run()` carries no argument, so neither
// matches. Keying on the ARGUMENT NAME instead would be a trap — the sandboxes are called `sb`,
// `single`, `nested`, and a pattern pinned to one name silently skips the rest.
const DISPATCH_CALL = /\b(?:run|runAsync)\(\s*[A-Za-z_${]/g;

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
// leaves it "in a string" for the rest of the file (measured: 29 real call sites reported as
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

describe('codex bridge suites — every wrapper dispatch is awaited (concurrency guard)', () => {
  // A guard that matches nothing passes for the wrong reason. The two suites carried 262 dispatch
  // call sites when this guard was written; the floor sits well below that so ordinary editing does
  // not trip it, and far above zero so a broken pattern cannot read as "all clear".
  it('the guard really finds the suite dispatch sites (never a vacuous pass)', () => {
    const total = SUITES.reduce((n, rel) => n + dispatchSites(readFileSync(join(HERE, rel), 'utf8')).length, 0);
    assert.ok(total >= 200, `only ${total} dispatch call site(s) matched — the pattern stopped seeing the suites`);
  });

  it('no dispatch call site is left un-awaited', () => {
    const loose = SUITES.flatMap((rel) => dispatchSites(readFileSync(join(HERE, rel), 'utf8'))
      .filter((site) => !site.discharged)
      .map((site) => `${rel}:${site.line} ${site.call}`));
    assert.deepEqual(loose, [], 'each listed site starts a dispatch whose promise nothing holds — prefix it with await');
  });

  // The predicate must be able to REPORT a violation, or the green above proves nothing.
  it('the predicate reports a bare dispatch and accepts a discharged one', () => {
    assert.deepEqual(dispatchSites('  run(sb, { args: [] });\n').map((s) => s.discharged), [false]);
    assert.deepEqual(
      dispatchSites('  const r = await run(sb, {});\n  return runAsync(nested);\n  const f = (sb) =>\n    run(sb, {});\n').map((s) => s.discharged),
      [true, true, true],
    );
    // The three shapes that LOOK discharged to a prefix test and are not. Each fixture really ends
    // in the keyword — a fixture whose comment trails off into another word tests nothing.
    assert.deepEqual(
      dispatchSites('  // do not await\n  run(sb, {});\n').map((s) => s.discharged),
      [false],
      'a comment ending in await is prose, not a discharge',
    );
    assert.deepEqual(
      dispatchSites('  // early return\n  run(sb, {});\n').map((s) => s.discharged),
      [false],
      'a comment ending in return is prose, not a discharge',
    );
    assert.deepEqual(
      dispatchSites('  return\n  run(sb, {});\n').map((s) => s.discharged),
      [false],
      'ASI ends a bare return at the newline, so the next call is NOT returned',
    );
    assert.deepEqual(
      dispatchSites('  previous(); // await\n  run(sb, {});\n').map((s) => s.discharged),
      [false],
      'a CODE line whose tail is a comment ending in await is still prose',
    );
    assert.deepEqual(
      dispatchSites('  const x = thing.await\n  run(sb, {});\n').map((s) => s.discharged),
      [false],
      'a member access named await is not the operator',
    );
    assert.deepEqual(
      dispatchSites("  const s = 'await ';\n  run(sb, {});\n").map((s) => s.discharged),
      [false],
      'a string whose body ends in await is not the operator',
    );
  });
});
