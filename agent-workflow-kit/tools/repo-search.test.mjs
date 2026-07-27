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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  EXIT_INCOMPLETE,
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
