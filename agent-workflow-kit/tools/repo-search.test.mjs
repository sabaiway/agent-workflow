// repo-search.test.mjs — acceptance spec for the promptless repository search lane.
//
// The load-bearing claims pinned here:
//   • LITERAL search only — no regex dialect, so no catastrophic-backtracking class exists;
//   • the four outcomes are DISTINGUISHABLE and never collapse into each other: matches / no
//     matches / incomplete (a bound fired, named) / invalid input / I-O failure;
//   • a bound NEVER yields a silent empty or silently truncated result — it names the bound;
//   • the pattern is echoed as a digest + byte length, never as a first content line (a first line
//     cannot separate two multiline patterns sharing it, and is unsafe for NUL/control bytes);
//   • only REGULAR files are read — a FIFO/device/socket would hang the walk and defeat every bound;
//   • --pattern-file carries bytes the command string never sees; it is the lane for shell-
//     significant patterns and it is read verbatim, trailing newline stripped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  EXIT_INCOMPLETE,
  HARD_MAX_TARGETS,
  assertNameableTarget,
  requiresDirectory,
  main,
  patternDigest,
  resolvePattern,
  search,
} from './repo-search.mjs';

const TOOL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'repo-search.mjs');

const scratch = () => mkdtempSync(join(tmpdir(), 'aw-repo-search-'));

const seed = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

const run = (argv, cwd) => main(argv, { cwd });

describe('repo-search — outcomes are distinguishable', () => {
  it('matches found → EXIT_OK and every hit is reported with file and line', () => {
    const root = seed(scratch(), { 'a.txt': 'alpha\nbeta\n', 'sub/b.txt': 'beta\n' });
    const r = run(['--pattern', 'beta', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 2);
    assert.ok(r.result.matches.every((m) => typeof m.file === 'string' && m.line > 0));
    rmSync(root, { recursive: true, force: true });
  });

  it('NO matches → still EXIT_OK, an explicitly empty result, never confused with incomplete', () => {
    const root = seed(scratch(), { 'a.txt': 'alpha\n' });
    const r = run(['--pattern', 'zeta', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 0);
    assert.equal(r.result.incomplete, null);
    rmSync(root, { recursive: true, force: true });
  });

  it('a result-count bound → EXIT_INCOMPLETE and the bound is NAMED, results still returned', () => {
    const root = seed(scratch(), { 'a.txt': 'x\nx\nx\nx\n' });
    const r = run(['--pattern', 'x', '--path', '.', '--max', '2'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.matches.length, 2);
    assert.equal(r.result.incomplete.bound, 'max-results');
    rmSync(root, { recursive: true, force: true });
  });

  it('invalid input → EXIT_USAGE, and it is not an I/O failure', () => {
    assert.equal(run(['--pattern'], scratch()).code, EXIT_USAGE);
    assert.equal(run(['--pattern', 'x', '--max', 'not-a-number'], scratch()).code, EXIT_USAGE);
    assert.equal(run([], scratch()).code, EXIT_USAGE);
  });

  it('both --pattern and --pattern-file → EXIT_USAGE (the lane must be unambiguous)', () => {
    const root = seed(scratch(), { 'p.txt': 'x' });
    assert.equal(run(['--pattern', 'x', '--pattern-file', 'p.txt'], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  it('an unreadable --path → EXIT_ERROR, loudly, never an empty success', () => {
    const root = scratch();
    const r = run(['--pattern', 'x', '--path', 'does-not-exist'], root);
    assert.equal(r.code, EXIT_ERROR);
    assert.match(r.stderr, /does-not-exist/u);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('repo-search — the pattern travels by file and is echoed as a digest', () => {
  it('--pattern-file carries shell-significant bytes the command string never sees', () => {
    const root = seed(scratch(), {
      'pat.txt': '$(x) > y && `z`\n',
      'code.txt': 'literal $(x) > y && `z` here\n',
    });
    const r = run(['--pattern-file', 'pat.txt', '--path', 'code.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('the pattern file never matches ITSELF — excluded by resolved path, not by name', () => {
    // It necessarily lives inside the search root (a target outside it is refused), so without an
    // identity exclusion every exotic query would report a spurious self-hit.
    const root = seed(scratch(), { 'pat.txt': 'needle\n', 'code.txt': 'needle\n' });
    const r = run(['--pattern-file', 'pat.txt', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(r.result.matches.map((m) => m.file), ['code.txt']);
    rmSync(root, { recursive: true, force: true });
  });

  it('the echo is a digest + byte length, and two multiline patterns sharing a first line differ', () => {
    const a = patternDigest('same\nfirst\n');
    const b = patternDigest('same\nsecond\n');
    assert.notEqual(a.digest, b.digest);
    assert.equal(a.bytes, Buffer.byteLength('same\nfirst\n'));
    // A NUL byte must not break the echo.
    assert.ok(patternDigest('a\0b').digest.length > 0);
  });

  it('an EMPTY pattern is refused — it would match every line of every file', () => {
    const root = seed(scratch(), { 'p.txt': '' });
    assert.equal(run(['--pattern', ''], root).code, EXIT_USAGE);
    assert.equal(run(['--pattern-file', 'p.txt'], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  it('resolvePattern strips exactly ONE trailing newline, never interior bytes', () => {
    assert.equal(resolvePattern('a>b\n'), 'a>b');
    assert.equal(resolvePattern('a>b\n\n'), 'a>b\n');
    assert.equal(resolvePattern('a\nb'), 'a\nb');
  });
});

describe('repo-search — the search is LITERAL, never a regex', () => {
  it('regex metacharacters match themselves and nothing else', () => {
    const root = seed(scratch(), { 'a.txt': 'a.c\nabc\n' });
    const r = run(['--pattern', 'a.c', '--path', '.'], root);
    assert.equal(r.result.matches.length, 1, 'a.c must not match abc');
    rmSync(root, { recursive: true, force: true });
  });

  it('a pattern that would hang a backtracking engine is just bytes here', () => {
    const root = seed(scratch(), { 'a.txt': `${'a'.repeat(200)}\n` });
    const r = run(['--pattern', '(a+)+$', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('repo-search — containment and bounds (the council REWORK set)', () => {
  it('a symlinked ANCESTOR does not smuggle a path out of the root', () => {
    // The lexical `..` check passes here — the escape is in what the component RESOLVES to, which
    // is why containment has to be decided on the real path, not on the string.
    const root = scratch();
    const outside = mkdtempSync(join(tmpdir(), 'aw-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'needle\n');
    symlinkSync(outside, join(root, 'link'));
    const r = run(['--pattern', 'needle', '--path', 'link/secret.txt'], root);
    assert.equal(r.code, EXIT_ERROR);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('a --pattern-file reached through a symlink out of the root is refused', () => {
    const root = scratch();
    const outside = mkdtempSync(join(tmpdir(), 'aw-outside-'));
    writeFileSync(join(outside, 'pat.txt'), 'needle\n');
    symlinkSync(join(outside, 'pat.txt'), join(root, 'pat.txt'));
    const r = run(['--pattern-file', 'pat.txt', '--path', '.'], root);
    assert.equal(r.code, EXIT_ERROR);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('the per-file byte cap is an INCOMPLETE outcome, never a silent skip that reads as no-matches', () => {
    const root = seed(scratch(), { 'big.txt': `${'needle\n'.repeat(500)}` });
    const r = run(['--pattern', 'needle', '--path', '.', '--max-bytes', '10'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, 'max-file-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  it('a count that would become Infinity is invalid input, not an unbounded search', () => {
    const root = seed(scratch(), { 'a.txt': 'x\n' });
    assert.equal(run(['--pattern', 'x', '--max', '1e999'], root).code, EXIT_USAGE);
    assert.equal(run(['--pattern', 'x', '--max', '9'.repeat(400)], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  it('a MULTILINE pattern can actually match — the contract promised it and the first cut could not', () => {
    const root = seed(scratch(), { 'a.txt': 'alpha\nbeta\ngamma\n' });
    const r = run(['--pattern', 'alpha\nbeta', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    assert.equal(r.result.matches[0].line, 1, 'the hit reports the line the match STARTS on');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('repo-search — reporting edges found in the diff council', () => {
  it('a snippet always CONTAINS the text that matched — including newline-leading and multiline patterns', () => {
    // The first version of this test only asserted a non-empty snippet, and a real bug slipped
    // through underneath it: the snippet was cut at the match's FIRST newline, so `\nbeta` reported
    // "alpha" — non-empty, and missing the match entirely. Assert containment, not emptiness.
    const root = seed(scratch(), { 'a.txt': 'alpha\nbeta\ngamma\n', 'b.txt': '\n\nbeta\n' });
    const nl = run(['--pattern', '\nbeta', '--path', 'a.txt'], root);
    assert.equal(nl.result.matches.length, 1);
    assert.ok(nl.result.matches[0].text.includes('beta'), `snippet lost the match: ${JSON.stringify(nl.result.matches[0].text)}`);

    const multi = run(['--pattern', 'alpha\nbeta', '--path', 'a.txt'], root);
    assert.ok(multi.result.matches[0].text.includes('beta'), 'a multiline match must not be cut at its own first newline');

    const blank = run(['--pattern', '\nbeta', '--path', 'b.txt'], root);
    assert.ok(blank.result.matches[0].text.includes('beta'), 'an empty preceding line must not yield an empty snippet');
    rmSync(root, { recursive: true, force: true });
  });

  it('a CRLF-written pattern file matches LF content — the trailing \\r is not part of the pattern', () => {
    const root = seed(scratch(), { 'pat.txt': 'needle\r\n', 'code.txt': 'a needle here\n' });
    const r = run(['--pattern-file', 'pat.txt', '--path', 'code.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('an EXPLICIT --path into a normally-pruned directory is searched, not silently emptied', () => {
    const root = seed(scratch(), { 'node_modules/pkg/a.txt': 'needle\n' });
    const explicit = run(['--pattern', 'needle', '--path', 'node_modules'], root);
    assert.equal(explicit.result.matches.length, 1, 'an explicit target overrides the default prune');
    const implicit = run(['--pattern', 'needle', '--path', '.'], root);
    assert.equal(implicit.result.matches.length, 0, 'but a sweep from the root still prunes it');
    rmSync(root, { recursive: true, force: true });
  });

  it('a snippet from a very long line is TRUNCATED — output stays bounded on minified content', () => {
    // A 2 MiB single-line file with many hits would otherwise store the whole line per match and
    // blow memory long before any documented bound applied.
    const line = `${'x'.repeat(50000)}needle${'y'.repeat(50000)}needle${'z'.repeat(50000)}`;
    const root = seed(scratch(), { 'min.js': line });
    const r = run(['--pattern', 'needle', '--path', '.'], root);
    assert.equal(r.result.matches.length, 2);
    for (const m of r.result.matches) {
      assert.ok(m.text.length <= 512, `snippet must stay bounded, got ${m.text.length}`);
      assert.ok(m.text.includes('needle'), 'the truncated snippet still shows the match');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('a HUGE pattern is bounded too — the cap is on the whole snippet, not only its context', () => {
    // Windowing the context alone still let the match itself ride into every stored snippet, so a
    // large --pattern-file matched in many places accumulated without limit.
    const huge = 'q'.repeat(20000);
    const root = seed(scratch(), { 'a.txt': `${huge}\n${huge}\n${huge}\n` });
    const r = run(['--pattern', huge, '--path', '.'], root);
    assert.equal(r.result.matches.length, 3);
    for (const m of r.result.matches) assert.ok(m.text.length <= 512, `got ${m.text.length}`);
    rmSync(root, { recursive: true, force: true });
  });

  it('many matches in one file stay linear — the line number is carried, not recomputed', () => {
    const root = seed(scratch(), { 'a.txt': `${'needle\n'.repeat(5000)}` });
    const r = run(['--pattern', 'needle', '--path', '.', '--max', '5000'], root);
    assert.equal(r.result.matches.length, 5000);
    assert.equal(r.result.matches[4999].line, 5000, 'the last hit still reports its true line');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('repo-search — the failure branches are exercised, not merely written', () => {
  // A counted skip that no test ever reaches is indistinguishable from a silent one, which is the
  // exact failure mode this tool's contract forbids.
  it('an unknown argument is usage, not a crash', () => {
    assert.equal(run(['--pattern', 'x', '--bogus'], scratch()).code, EXIT_USAGE);
  });

  it('a --pattern-file that is a DIRECTORY is refused as not a regular file', () => {
    const root = scratch();
    mkdirSync(join(root, 'dir'));
    const r = run(['--pattern-file', 'dir'], root);
    assert.equal(r.code, EXIT_ERROR);
    assert.match(r.stderr, /regular file/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('the walk budget produces a NAMED incomplete rather than a quiet short sweep', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n', 'b.txt': 'needle\n', 'c.txt': 'needle\n' });
    const r = search({ root, pattern: 'needle', paths: ['.'], max: 100, maxBytes: 1024, walkBudget: 2 });
    assert.equal(r.incomplete.bound, 'walk-budget');
    rmSync(root, { recursive: true, force: true });
  });

  it('an entry that vanishes between listing and stat is a counted unreadable skip', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const io = { lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    const r = search({ root, pattern: 'needle', paths: ['.'], max: 100, maxBytes: 1024, io });
    assert.equal(r.matches.length, 0);
    assert.equal(r.skipped.unreadable, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('an unopenable DIRECTORY is a counted unreadable skip, not a crash', () => {
    const root = seed(scratch(), { 'sub/a.txt': 'needle\n' });
    const io = { opendir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    const r = search({ root, pattern: 'needle', paths: ['.'], max: 100, maxBytes: 1024, io });
    assert.equal(r.skipped.unreadable, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a symlink refused by O_NOFOLLOW (ELOOP) counts as a symlink skip, not as unreadable', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const io = { open: () => { throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }); } };
    const r = search({ root, pattern: 'needle', paths: ['a.txt'], max: 100, maxBytes: 1024, io });
    assert.equal(r.skipped.symlinks, 1);
    assert.equal(r.skipped.unreadable, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it('an unopenable FILE is a counted unreadable skip', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const io = { open: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    const r = search({ root, pattern: 'needle', paths: ['a.txt'], max: 100, maxBytes: 1024, io });
    assert.equal(r.skipped.unreadable, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a file TRUNCATED between fstat and read is unreadable — never a partial buffer read as complete', () => {
    const root = seed(scratch(), { 'a.txt': 'needle needle needle\n' });
    // The short read is the whole point: returning what was read would report a confident
    // "no matches" for a file that simply shrank.
    const io = { read: () => 0 };
    const r = search({ root, pattern: 'needle', paths: ['a.txt'], max: 100, maxBytes: 1024, io });
    assert.equal(r.matches.length, 0);
    assert.equal(r.skipped.unreadable, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a mid-read failure is caught and counted', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const io = { read: () => { throw new Error('EIO'); } };
    const r = search({ root, pattern: 'needle', paths: ['a.txt'], max: 100, maxBytes: 1024, io });
    assert.equal(r.skipped.unreadable, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('the CLI entry point emits stdout and the exit code (the direct-run path)', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const r = spawnSync(process.execPath, [TOOL_PATH, '--pattern', 'needle', '--path', '.'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, EXIT_OK);
    assert.match(r.stdout, /a\.txt:1/u);
    const bad = spawnSync(process.execPath, [TOOL_PATH, '--bogus'], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, EXIT_USAGE);
    assert.match(bad.stderr, /repo-search:/u);
    rmSync(root, { recursive: true, force: true });
  });
});

// ONE closed acceptance predicate replaced seven checks that had been found one review round at a
// time. They were all the same defect: a caller string reaches `path.resolve()` before it is checked,
// and `resolve()`'s semantics differ from the operating system's, so the tool could answer about a
// DIFFERENT object than the string denotes. This table IS the surface — an accepted case that should
// be refused, or a refused case that should be accepted, goes red here rather than in round eleven.
describe('the target acceptance predicate — the closed rule set, in one table', () => {
  const REFUSED = [
    ['empty', '', /must not be empty/u],
    ['a NUL byte', 'a\0b', /NUL/u],
    ['a `..` component', 'note.txt/../a.txt', /\.\./u],
    ['a leading `..`', '../outside', /\.\./u],
    ['a bare `..`', '..', /\.\./u],
  ];
  const ACCEPTED = [
    ['an ordinary relative path', 'sub/a.txt'],
    ['a trailing separator, which asserts a directory rather than being invalid', 'sub/'],
    ['a trailing `.`, the same assertion in the other spelling', 'sub/.'],
    ['a `.` component, which the OS resolves the same way', './sub/a.txt'],
    ['repeated separators, which the OS collapses the same way', 'sub//a.txt'],
    ['edge whitespace, which is a legal name', ' spaced '],
    ['a backtick, which is a legal name', 'we`ird'],
    ['a backslash, which on POSIX is an ordinary name byte', '\\..'],
    ['a name that merely CONTAINS dots', 'a..b'],
  ];
  // A trailing separator or `.` is an ASSERTION, checked after resolution — not a rejection. Both
  // directions are pinned: the assertion must hold for a directory and must fail for a file.
  const DIRECTORY_ASSERTED = [['a trailing separator', 'sub/'], ['a trailing dot', 'sub/.'], ['a bare dot', '.']];
  const NOT_ASSERTED = [['a plain path', 'sub/a.txt'], ['a name ending in a dot', 'a.'], ['a name containing a dot', 'a.b']];

  for (const [name, target] of DIRECTORY_ASSERTED) {
    it(`treats ${name} as an assertion that the target is a directory`, () => {
      assert.equal(requiresDirectory(target), true, JSON.stringify(target));
    });
  }
  for (const [name, target] of NOT_ASSERTED) {
    it(`does not read ${name} as a directory assertion`, () => {
      assert.equal(requiresDirectory(target), false, JSON.stringify(target));
    });
  }

  for (const [name, target, message] of REFUSED) {
    it(`refuses ${name}`, () => {
      assert.throws(() => assertNameableTarget(target), message, `expected ${JSON.stringify(target)} to be refused`);
    });
  }

  for (const [name, target] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      assert.doesNotThrow(() => assertNameableTarget(target), `expected ${JSON.stringify(target)} to be accepted`);
    });
  }

  // The walk budget counts ENTRIES; without a byte ceiling a run reads up to the per-file limit for
  // every entry. The sibling inventory tool already had this budget — the asymmetry was the defect.
  it('the AGGREGATE read budget stops the search and names itself', () => {
    const root = seed(scratch(), { 'a.txt': `${'x'.repeat(400)}needle\n`, 'b.txt': `${'y'.repeat(400)}needle\n` });
    const r = run(['--pattern', 'needle', '--path', '.', '--max-total-bytes', '300'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, '--max-total-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  it('a paths file repeating ONE target 5001 times names one target, not 5001', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), Array.from({ length: HARD_MAX_TARGETS + 1 }, () => 'a.txt').join('\n'));
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK, 'the ceiling counts TARGETS, not lines');
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  // End to end, both spellings, both tools: the OS answers ENOTDIR for a REGULAR FILE named as a
  // directory, and neither tool may quietly search or report the file instead.
  it('a regular file named with a trailing separator or dot is not searched', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    assert.equal(run(['--pattern', 'needle', '--path', 'a.txt/'], root).code, EXIT_ERROR);
    assert.equal(run(['--pattern', 'needle', '--path', 'a.txt/.'], root).code, EXIT_ERROR);
    assert.equal(run(['--pattern', 'needle', '--path', 'a.txt'], root).result.matches.length, 1, 'the plain spelling still works');
    rmSync(root, { recursive: true, force: true });
  });

  it('an existing DIRECTORY named with a trailing separator is searched normally', () => {
    const root = seed(scratch(), { 'sub/a.txt': 'needle\n' });
    const r = run(['--pattern', 'needle', '--path', 'sub/'], root);
    assert.equal(r.code, EXIT_OK, 'the assertion holds, so the target is not refused');
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('once the aggregate budget is exactly spent, a later target is not opened at all', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n', 'b.txt': 'needle\n' });
    const r = run(['--pattern', 'needle', '--path', 'a.txt', '--path', 'b.txt', '--max-total-bytes', '7'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, '--max-total-bytes');
    assert.equal(r.result.matches.length, 1, 'the first target was searched, the second was not');
    rmSync(root, { recursive: true, force: true });
  });

  // A short read still moved bytes. Charging only on success would let a failing file do real I/O the
  // budget never learns about — the budget would bound successful work rather than work.
  it('bytes moved by a FAILED read are still charged against the aggregate budget', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n', 'b.txt': 'needle\n' });
    let firstCall = true;
    const partialRead = (fd, buf, offset, length, position) => {
      if (firstCall) {
        firstCall = false;
        return 3;
      }
      return offset === 0 ? readSync(fd, buf, offset, length, position) : 0;
    };
    const result = search({
      root: realpathSync(root),
      pattern: 'needle',
      paths: ['a.txt', 'b.txt'],
      max: 10,
      maxBytes: 1024,
      maxTotalBytes: 5,
      io: { read: partialRead },
    });
    assert.equal(result.incomplete.bound, '--max-total-bytes', 'the 3 bytes the failed read moved were charged');
    rmSync(root, { recursive: true, force: true });
  });

  // The charge has to happen per chunk, not after the loop: a read that THROWS mid-file would
  // otherwise move real bytes the budget never learns about.
  it('bytes moved before a mid-file read FAULT are charged, not lost', () => {
    const root = seed(scratch(), { 'a.txt': 'needle and more text\n' });
    let calls = 0;
    const faultingRead = () => {
      calls += 1;
      if (calls === 1) return 4;
      throw Object.assign(new Error('device fell over'), { code: 'EIO' });
    };
    const result = search({
      root: realpathSync(root),
      pattern: 'needle',
      paths: ['a.txt'],
      max: 10,
      maxBytes: 1024,
      maxTotalBytes: 1024,
      io: { read: faultingRead },
    });
    // A mid-read fault is a COUNTED skip, not a crash — and the four bytes it moved are charged.
    assert.equal(result.skipped.unreadable, 1);
    assert.equal(result.bytesRead, 4, 'the bytes moved before the fault are charged, not lost');
    rmSync(root, { recursive: true, force: true });
  });

  it('the aggregate budget is reported, so a partial read is visible rather than internal', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const whole = search({ root: realpathSync(root), pattern: 'needle', paths: ['a.txt'], max: 10, maxBytes: 1024 });
    assert.equal(whole.bytesRead, 7);
    rmSync(root, { recursive: true, force: true });
  });

  it('a SINGLE file larger than the remaining aggregate budget is not read whole', () => {
    const root = seed(scratch(), { 'big.txt': `${'x'.repeat(4096)}needle\n` });
    const r = run(['--pattern', 'needle', '--path', '.', '--max-total-bytes', '256'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, '--max-total-bytes');
    assert.equal(r.result.matches.length, 0, 'the file was never searched, so it cannot have matched');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('repo-search — only regular files are read', () => {
  it('a symlink is never followed and is counted as skipped, not silently ignored', () => {
    const root = seed(scratch(), { 'real.txt': 'needle\n' });
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const r = run(['--pattern', 'needle', '--path', '.'], root);
    assert.equal(r.result.matches.length, 1, 'the symlink must not produce a second hit');
    assert.ok(r.result.skipped.symlinks >= 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a binary file is skipped and COUNTED (never a silent omission)', () => {
    const root = seed(scratch(), { 'bin.dat': 'needle\0\0binary\n', 'ok.txt': 'needle\n' });
    const r = run(['--pattern', 'needle', '--path', '.'], root);
    assert.equal(r.result.matches.length, 1);
    assert.ok(r.result.skipped.binary >= 1);
    rmSync(root, { recursive: true, force: true });
  });
});

// --paths-file is the TARGET half of the same idea --pattern-file already carries for the pattern:
// a path that cannot survive in a command string (a backtick, `$(`, `>`) reaches the tool by file, so
// the residual guard has nothing to scan. Without it a search may name a pattern it cannot spell but
// not a PATH it cannot spell, and the promptless lane covers only half the arguments.
describe('repo-search — --paths-file carries targets the command string cannot', () => {
  it('each line of the file becomes a target', () => {
    const root = seed(scratch(), { 'a/one.txt': 'needle\n', 'b/two.txt': 'needle\n', 'c/three.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), 'a\nb\n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 2, 'only the two listed targets are searched');
    rmSync(root, { recursive: true, force: true });
  });

  it('a target whose name carries shell-significant bytes is reachable ONLY through the file lane', () => {
    const root = seed(scratch(), { 'we`ird$(dir)/x.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), 'we`ird$(dir)\n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('composes with --pattern-file, and unions with --path', () => {
    const root = seed(scratch(), { 'a/one.txt': 'a>b\n', 'b/two.txt': 'a>b\n', 'c/three.txt': 'a>b\n' });
    writeFileSync(join(root, 'p.txt'), 'a>b\n');
    writeFileSync(join(root, 'targets.lst'), 'a\n');
    const r = run(['--pattern-file', 'p.txt', '--paths-file', 'targets.lst', '--path', 'b'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 2, 'the union of --path and --paths-file is searched');
    rmSync(root, { recursive: true, force: true });
  });

  it('CRLF, a trailing delimiter, empty lines and duplicates are all normalised', () => {
    const root = seed(scratch(), { 'a/one.txt': 'needle\n', 'b/two.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), 'a\r\n\nb\na\n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 2, 'an empty line is never the root, and a duplicate never doubles a hit');
    rmSync(root, { recursive: true, force: true });
  });

  // The lane exists to carry names a command string cannot. Trimming would silently rewrite the
  // caller's target — the exact failure the lane removes — so a name with edge whitespace survives
  // byte-for-byte and a whitespace-only line is a real target, not a stand-in for the root.
  it('a target name with LEADING and TRAILING spaces survives the lane unchanged', () => {
    const root = seed(scratch(), { ' spaced dir /x.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), ' spaced dir \n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('BOTH lane files are excluded from the search by real path, and the skip is COUNTED', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    writeFileSync(join(root, 'p.txt'), 'needle\n');
    writeFileSync(join(root, 'targets.lst'), '.\n');
    const r = run(['--pattern-file', 'p.txt', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1, 'neither lane file may match its own contents');
    assert.equal(r.result.skipped.patternFile, 1);
    assert.equal(r.result.skipped.pathsFile, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a missing paths file is an I/O failure — exit 1, at PARITY with --pattern-file', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const missingPaths = run(['--pattern', 'needle', '--paths-file', 'nope.lst'], root);
    const missingPattern = run(['--pattern-file', 'nope.txt', '--path', '.'], root);
    assert.equal(missingPaths.code, EXIT_ERROR);
    assert.equal(missingPattern.code, EXIT_ERROR, 'the two file lanes classify the same failure the same way');
    rmSync(root, { recursive: true, force: true });
  });

  it('a paths file naming only EMPTY lines is a usage error, never a silent search of everything', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), '\n\n\n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    // The lane must refuse for its OWN reason: an unknown-argument rejection is also EXIT_USAGE and
    // would let this pass while checking nothing.
    assert.doesNotMatch(r.stderr, /unknown argument/u);
    assert.match(r.stderr, /no target/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('too many entries names the bound instead of truncating silently', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), Array.from({ length: HARD_MAX_TARGETS + 1 }, (_, i) => `d${i}`).join('\n'));
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.doesNotMatch(r.stderr, /unknown argument/u);
    assert.match(r.stderr, new RegExp(String(HARD_MAX_TARGETS), 'u'));
    rmSync(root, { recursive: true, force: true });
  });

  it('the ceiling holds over the UNION of both lanes, not just within the file', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    const argv = ['--pattern', 'needle', ...Array.from({ length: HARD_MAX_TARGETS + 1 }, (_, i) => ['--path', `d${i}`]).flat()];
    const r = run(argv, root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, new RegExp(String(HARD_MAX_TARGETS), 'u'));
    rmSync(root, { recursive: true, force: true });
  });

  // A lossy decode would not fail — it would name a DIFFERENT path that happens to exist, which is
  // the one outcome worse than any refusal in a lane built to carry names verbatim.
  it('a paths file whose bytes are not valid UTF-8 is REFUSED, never lossily decoded', () => {
    const root = seed(scratch(), { 'a.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /UTF-8/u);
    rmSync(root, { recursive: true, force: true });
  });

  // A decoder that strips a leading U+FEFF rewrites a legitimate name into a different one — the same
  // silent substitution as a lossy decode, one layer down.
  it('a target name STARTING with U+FEFF survives the lane unchanged', () => {
    const root = seed(scratch(), { '﻿bom-dir/x.txt': 'needle\n' });
    writeFileSync(join(root, 'targets.lst'), '﻿bom-dir\n');
    const r = run(['--pattern', 'needle', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('a PATTERN starting with U+FEFF is searched as written, not silently trimmed', () => {
    const root = seed(scratch(), { 'a.txt': '﻿needle\n' });
    writeFileSync(join(root, 'p.txt'), '﻿needle\n');
    const r = run(['--pattern-file', 'p.txt', '--path', '.'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.matches.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('--help documents the target lane the way it documents the pattern lane', () => {
    assert.match(run(['--help'], process.cwd()).stdout, /--paths-file/u);
  });
});
