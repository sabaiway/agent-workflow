// path-inventory.test.mjs — acceptance spec for the promptless path-inventory lane.
//
// The load-bearing claims pinned here:
//   • a MISSING path is a RESULT (`exists:false`, exit 0), never an I/O failure — the whole reason
//     the tool exists is questions of the form "does either of these exist", and a tool that errors
//     on the interesting answer forces the caller back into a composed shell;
//   • containment is decided on the REAL path even when the target does not exist, so a symlinked
//     ancestor pointing outside the root is refused rather than reported;
//   • symlinks are never followed and are reported BY TYPE;
//   • line count is `wc -l` compatible — newline characters, so a final line without one is not
//     counted (a tool that answers a different question than the command it replaces is a trap);
//   • results are deterministic: targets in input order, directory entries in byte order;
//   • every bound NAMES itself and never truncates silently;
//   • binary and special files are reported by type, never decoded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readSync } from 'node:fs';
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
  countLines,
  inventory,
  main,
  readBounded,
  typeOfDirent,
  typeOfStats,
} from './path-inventory.mjs';

const TOOL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'path-inventory.mjs');

const scratch = () => mkdtempSync(join(tmpdir(), 'aw-path-inventory-'));

const seed = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

const run = (argv, cwd) => main(argv, { cwd });
const byPath = (result, rel) => result.results.find((r) => r.path === rel);

describe('path-inventory — a missing path is an ANSWER, not a failure', () => {
  it('reports exists:false and still exits 0, alongside a path that does exist', () => {
    const root = seed(scratch(), { 'there.txt': 'x\n' });
    const r = run(['--path', 'there.txt', '--path', 'gone.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(byPath(r.result, 'there.txt').exists, true);
    assert.equal(byPath(r.result, 'gone.txt').exists, false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a missing leaf under a MISSING directory is still just exists:false', () => {
    const root = scratch();
    const r = run(['--path', 'no/such/leaf.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(byPath(r.result, 'no/such/leaf.txt').exists, false);
    rmSync(root, { recursive: true, force: true });
  });

  // A regular file used as an intermediate component is an ordinary typo, and the answer is still
  // "not there". Refusing it with an I/O error would break the tool's central promise on the most
  // common mistake there is.
  // A trailing separator or `.` asserts a directory. The OS answers ENOTDIR when it is not one, and
  // ENOTDIR is "not there" everywhere else here — so the assertion failing is an ANSWER, not a fault.
  it('a regular file named as a directory is absent; the directory itself is not', () => {
    const root = seed(scratch(), { 'note.txt': 'x\n', 'sub/a.txt': 'y\n' });
    const r = run(['--path', 'note.txt/', '--path', 'note.txt/.', '--path', 'sub/', '--path', 'note.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(byPath(r.result, 'note.txt/').exists, false);
    assert.equal(byPath(r.result, 'note.txt/.').exists, false);
    assert.equal(byPath(r.result, 'sub/').type, 'directory', 'the assertion holds for a real directory');
    assert.equal(byPath(r.result, 'note.txt').type, 'file', 'the plain spelling is unaffected');
    rmSync(root, { recursive: true, force: true });
  });

  it('a path UNDER a regular file is absent, not a failure — at one level and at several', () => {
    const root = seed(scratch(), { 'note.txt': 'x\n' });
    const r = run(['--path', 'note.txt/child', '--path', 'note.txt/a/b/c'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(byPath(r.result, 'note.txt/child').exists, false);
    assert.equal(byPath(r.result, 'note.txt/a/b/c').exists, false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a target that reaches OUTSIDE the root is refused, never answered', () => {
    const root = scratch();
    assert.equal(run(['--path', '../escape-me.txt'], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  // `resolve()` collapses `..` lexically, so `note.txt/../a.txt` would become `a.txt` and the tool
  // would answer about a path the OS itself refuses (note.txt is not a directory). Answering about a
  // DIFFERENT existing path is worse than any refusal.
  // Whether an invocation is refused must not depend on how much work happened first: an invalid
  // target at the END of the list is refused before ANY target is inspected.
  it('an invalid target late in the list is refused before any work is done', () => {
    const root = seed(scratch(), { 'a.txt': 'x\n', 'b.txt': 'y\n' });
    let reads = 0;
    const r = main(['--path', 'a.txt', '--path', 'b.txt', '--path', 'note/../c.txt'], { cwd: root });
    assert.equal(r.code, EXIT_USAGE);
    assert.equal(r.result, null, 'no partial result is produced for a refused invocation');
    assert.equal(reads, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it('a `..` component is refused instead of being collapsed into a different existing path', () => {
    const root = seed(scratch(), { 'note.txt': 'x\n', 'a.txt': 'y\n' });
    const r = run(['--path', 'note.txt/../a.txt'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /\.\./u);
    assert.equal(run(['--path', 'sub/deeper/../../a.txt'], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  it('a missing leaf under a symlinked ancestor pointing OUTSIDE the root is refused', () => {
    const outside = seed(scratch(), { 'secret.txt': 'x\n' });
    const root = scratch();
    symlinkSync(outside, join(root, 'link'));
    const r = run(['--path', 'link/nothing-here.txt'], root);
    assert.equal(r.code, EXIT_ERROR, 'a lexical check would have passed this');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('path-inventory — types are reported, never followed or decoded', () => {
  it('a symlink is reported BY TYPE and is not followed', () => {
    const root = seed(scratch(), { 'real.txt': 'needle\n' });
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const entry = byPath(run(['--path', 'link.txt'], root).result, 'link.txt');
    assert.equal(entry.exists, true);
    assert.equal(entry.type, 'symlink');
    rmSync(root, { recursive: true, force: true });
  });

  it('a DANGLING symlink exists as a symlink and says its target does not resolve', () => {
    const root = scratch();
    symlinkSync(join(root, 'nowhere.txt'), join(root, 'dangling.txt'));
    const entry = byPath(run(['--path', 'dangling.txt'], root).result, 'dangling.txt');
    assert.equal(entry.exists, true);
    assert.equal(entry.type, 'symlink');
    assert.equal(entry.resolves, false);
    rmSync(root, { recursive: true, force: true });
  });

  // A FIFO / socket / device cannot be created in the sandbox this suite runs in (unix-socket listen
  // is EPERM), and a test that skips when its fixture will not build checks nothing. The two type
  // classifiers are pure maps from a stats shape, so a stub exercises the same branch a device would.
  it('anything that is not a file, directory or symlink classifies as special — both as a target and as an entry', () => {
    const device = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false };
    assert.equal(typeOfStats(device), 'special');
    assert.equal(typeOfDirent(device), 'special');
    assert.equal(typeOfStats({ ...device, isFile: () => true }), 'file');
    assert.equal(typeOfDirent({ ...device, isDirectory: () => true }), 'directory');
    assert.equal(typeOfStats({ ...device, isSymbolicLink: () => true }), 'symlink');
  });

  // "(dangling)" must mean "the target is not there", not "something went wrong while looking". A
  // symlink LOOP is a real fault and would otherwise be reported as a normal answer with exit 0.
  it('a symlink LOOP is an I/O failure, never reported as merely dangling', () => {
    const root = scratch();
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    const r = run(['--path', 'a'], root);
    assert.equal(r.code, EXIT_ERROR);
    assert.match(r.stderr, /ELOOP|cannot resolve/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('a binary file reports its type and size but is never decoded into contents', () => {
    const root = seed(scratch(), { 'bin.dat': 'a\0\0b\n' });
    const entry = byPath(run(['--path', 'bin.dat', '--contents'], root).result, 'bin.dat');
    assert.equal(entry.type, 'file');
    assert.equal(entry.binary, true);
    assert.equal(entry.contents, null);
    rmSync(root, { recursive: true, force: true });
  });

  // "Binaries are never decoded" has to hold for the WHOLE buffer that was read, not for a sniff
  // window: a NUL past the window would otherwise be decoded as text in direct contradiction of the
  // contract the header states.
  it('a NUL far past the sniff window still counts as binary', () => {
    const root = seed(scratch(), { 'late.dat': `${'a'.repeat(20000)}\0tail` });
    const entry = byPath(run(['--path', 'late.dat', '--contents'], root).result, 'late.dat');
    assert.equal(entry.binary, true);
    assert.equal(entry.contents, null);
    rmSync(root, { recursive: true, force: true });
  });

  // The size and the budget must come from the descriptor that was actually read. Taking them from an
  // earlier lstat means a file that grew in between is reported at the wrong size and charged the
  // wrong amount against the run's budget, with a full exit 0.
  it('bytes and the budget come from the OPENED descriptor, not from an earlier stat', () => {
    const root = seed(scratch(), { 'a.txt': 'abcdefgh' });
    const result = inventory({
      root,
      paths: ['a.txt'],
      io: { fstat: (fd) => ({ isFile: () => true, size: 4 }) },
    });
    assert.equal(result.results[0].bytes, 4, 'the reported size is the one the read was sized by');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('path-inventory — the numbers answer the same question the command it replaces did', () => {
  it('countLines is wc -l compatible: newline characters, not visual lines', () => {
    assert.equal(countLines(Buffer.from('a\nb\nc\n')), 3);
    assert.equal(countLines(Buffer.from('a\nb\nc')), 2, 'a final line without a newline is not counted, exactly as wc -l');
    assert.equal(countLines(Buffer.from('')), 0);
  });

  it('size and line count are reported for a regular file', () => {
    const root = seed(scratch(), { 'a.txt': 'one\ntwo\n' });
    const entry = byPath(run(['--path', 'a.txt'], root).result, 'a.txt');
    assert.equal(entry.bytes, 8);
    assert.equal(entry.lines, 2);
    rmSync(root, { recursive: true, force: true });
  });

  it('a directory lists its entries in byte order with their types, one level deep', () => {
    const root = seed(scratch(), { 'd/b.txt': '', 'd/a.txt': '', 'd/sub/c.txt': '' });
    const entry = byPath(run(['--path', 'd'], root).result, 'd');
    assert.equal(entry.type, 'directory');
    assert.deepEqual(entry.entries.map((e) => e.name), ['a.txt', 'b.txt', 'sub']);
    assert.equal(entry.entries.find((e) => e.name === 'sub').type, 'directory');
    rmSync(root, { recursive: true, force: true });
  });

  it('targets keep INPUT order, so the answer lines up with the question', () => {
    const root = seed(scratch(), { 'z.txt': '', 'a.txt': '' });
    const r = run(['--path', 'z.txt', '--path', 'a.txt'], root);
    assert.deepEqual(r.result.results.map((e) => e.path), ['z.txt', 'a.txt']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('path-inventory — contents are opt-in and bounded', () => {
  it('contents are absent by default and present with --contents', () => {
    const root = seed(scratch(), { 'a.txt': 'hello\n' });
    assert.equal(byPath(run(['--path', 'a.txt'], root).result, 'a.txt').contents, undefined);
    assert.equal(byPath(run(['--path', 'a.txt', '--contents'], root).result, 'a.txt').contents, 'hello\n');
    rmSync(root, { recursive: true, force: true });
  });

  it('a file above the content bound NAMES the bound instead of returning a truncated string as if whole', () => {
    const root = seed(scratch(), { 'big.txt': 'x'.repeat(4096) });
    const r = run(['--path', 'big.txt', '--contents', '--max-content-bytes', '16'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.ok(r.result.incomplete, 'the bound that fired is named');
    assert.equal(byPath(r.result, 'big.txt').contents, null);
    rmSync(root, { recursive: true, force: true });
  });

  // Per-target ceilings bound ONE target; with thousands of them the run is still unbounded, and every
  // result accumulates before anything is formatted. The aggregate ceiling is what makes the total a
  // constant no number of targets can grow.
  it('the AGGREGATE byte budget stops the run and names itself, however small each file is', () => {
    const root = seed(scratch(), { 'a.txt': 'x'.repeat(64), 'b.txt': 'y'.repeat(64), 'c.txt': 'z'.repeat(64) });
    const r = run(['--path', 'a.txt', '--path', 'b.txt', '--path', 'c.txt', '--contents', '--max-total-bytes', '80'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, '--max-total-bytes');
    assert.equal(byPath(r.result, 'a.txt').contents, 'x'.repeat(64), 'the budget stops the run, it does not blank what was already read');
    assert.equal(byPath(r.result, 'c.txt').contents, null);
    rmSync(root, { recursive: true, force: true });
  });

  // The pre-read check uses the `lstat` size; the charge uses the descriptor's. A file that GREW in
  // between passes the first and must still be caught by the second, or the run exceeds its own
  // ceiling with a clean exit. Only injection can stage that race honestly.
  it('a file that grew between the stat and the read is still caught by the aggregate budget', () => {
    const root = seed(scratch(), { 'a.txt': 'abcdefgh' });
    const result = inventory({
      root,
      paths: ['a.txt'],
      maxTotalBytes: 16,
      io: { fstat: () => ({ isFile: () => true, size: 32 }), read: (fd, buf, offset, length) => length },
    });
    assert.equal(result.incomplete.bound, '--max-total-bytes');
    assert.equal(result.results[0].withheld, '--max-total-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  // The aggregate ceiling must bound the WORK, not just the accounting: once the budget is spent, a
  // later target must not be read at all. Counting the read calls is the only way to assert that.
  it('once the aggregate budget is spent, a later target is never READ', () => {
    const root = seed(scratch(), { 'a.txt': 'x'.repeat(64), 'b.txt': 'y'.repeat(64) });
    let reads = 0;
    const result = inventory({
      root,
      paths: ['a.txt', 'b.txt'],
      contents: true,
      maxTotalBytes: 64,
      io: { read: (fd, buf, offset, length, position) => { reads += 1; return readSync(fd, buf, offset, length, position); } },
    });
    assert.equal(reads, 1, 'the second target must not be read once the budget is gone');
    assert.equal(byPath(result, 'b.txt').withheld, '--max-total-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  it('a directory truncated by a ceiling says so ON THE ENTRY, in JSON and in the human shape', () => {
    const root = scratch();
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'many', `f${i}.txt`), '');
    const r = run(['--path', 'many', '--max-entries', '5'], root);
    assert.equal(byPath(r.result, 'many').withheld, '--max-entries');
    assert.match(r.stdout, /withheld: --max-entries/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('the AGGREGATE entry budget bounds directory listing across targets', () => {
    const root = scratch();
    for (const d of ['d1', 'd2']) {
      mkdirSync(join(root, d));
      for (let i = 0; i < 6; i += 1) writeFileSync(join(root, d, `f${i}.txt`), '');
    }
    const r = run(['--path', 'd1', '--path', 'd2', '--max-total-entries', '8'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(r.result.incomplete.bound, '--max-total-entries');
    rmSync(root, { recursive: true, force: true });
  });

  // A path that does not exist is a RESULT. A path that exists and cannot be read is an I/O FAILURE —
  // exit 1, the same code a failed directory open already returns. Exit 3 means "a ceiling fired",
  // and putting a real fault under it would make the two indistinguishable.
  it('an UNREADABLE file that EXISTS is an I/O failure — exit 1, distinct from a bound and from absent', () => {
    const root = seed(scratch(), { 'locked.txt': 'secret\n' });
    chmodSync(join(root, 'locked.txt'), 0o000);
    const r = run(['--path', 'locked.txt'], root);
    chmodSync(join(root, 'locked.txt'), 0o600);
    assert.equal(r.code, EXIT_ERROR);
    assert.match(r.stderr, /locked\.txt/u);
    assert.equal(run(['--path', 'absent.txt'], root).code, EXIT_OK, 'absent stays a result');
    rmSync(root, { recursive: true, force: true });
  });

  // A symlink pointing OUTSIDE the root must still be reported BY TYPE. Dereferencing the leaf to
  // containment-check it turned the contract's own case into a refusal.
  it('a symlink whose TARGET is outside the root is reported by type, not refused', () => {
    const outside = seed(scratch(), { 'secret.txt': 'x\n' });
    const root = scratch();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const r = run(['--path', 'escape.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(byPath(r.result, 'escape.txt').type, 'symlink');
    assert.equal(byPath(r.result, 'escape.txt').resolves, true);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('a later target hitting a different ceiling says which one withheld IT', () => {
    const root = seed(scratch(), { 'a.txt': 'x'.repeat(64), 'big.txt': 'y'.repeat(4096) });
    const r = run(['--path', 'a.txt', '--path', 'big.txt', '--contents', '--max-content-bytes', '128'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.equal(byPath(r.result, 'big.txt').withheld, '--max-content-bytes');
    assert.equal(byPath(r.result, 'a.txt').withheld, undefined);
    rmSync(root, { recursive: true, force: true });
  });

  // A read that stops early is a real race — the file shrinks between the fstat and the read — that
  // cannot be staged honestly on a real filesystem. The primitive takes an injectable io for exactly
  // this branch: what matters is that a half-read file is never returned as if it were whole.
  it('a SHORT read is reported as short, never returned as complete content', () => {
    const root = seed(scratch(), { 'a.txt': 'abcdefgh' });
    const stubbed = readBounded(join(root, 'a.txt'), 1024, {
      read: (fd, buf, offset, length, position) => (offset === 0 ? 3 : 0),
    });
    assert.equal(stubbed.kind, 'short');
    assert.equal(stubbed.got, 3);
    assert.equal(stubbed.want, 8);
    const whole = readBounded(join(root, 'a.txt'), 1024);
    assert.equal(whole.kind, 'ok');
    assert.equal(whole.buf.toString('utf8'), 'abcdefgh');

    // …and end to end it is an I/O failure, not a bound: a half-read file must never come back as a
    // complete answer, and exit 3 would say "a ceiling fired" about a fault.
    assert.throws(
      () => inventory({ root, paths: ['a.txt'], contents: true, io: { read: (fd, buf, offset) => (offset === 0 ? 3 : 0) } }),
      /yielded 3 of 8/u,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('a directory above the entry bound NAMES the bound', () => {
    const root = scratch();
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'many', `f${i}.txt`), '');
    const r = run(['--path', 'many', '--max-entries', '5'], root);
    assert.equal(r.code, EXIT_INCOMPLETE);
    assert.ok(r.result.incomplete);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('path-inventory — the argument lanes match repo-search, including the file lane', () => {
  it('--paths-file supplies targets whose bytes never enter the command string', () => {
    const root = seed(scratch(), { 'we`ird$(dir)/x.txt': 'y\n' });
    writeFileSync(join(root, 'targets.lst'), 'we`ird$(dir)/x.txt\n');
    const r = run(['--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.results[0].exists, true);
    rmSync(root, { recursive: true, force: true });
  });

  // Deduping only WITHIN each lane leaves the union: the same target named twice would be read twice
  // and charged twice against the run's aggregate byte budget.
  it('a target named by BOTH lanes is inspected once', () => {
    const root = seed(scratch(), { 'a.txt': 'x\n' });
    writeFileSync(join(root, 'targets.lst'), 'a.txt\n');
    const r = run(['--path', 'a.txt', '--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.result.results.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('an EMPTY-lines-only paths file is a usage error, never an implicit "everything"', () => {
    const root = scratch();
    writeFileSync(join(root, 'targets.lst'), '\n\n');
    const r = run(['--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.doesNotMatch(r.stderr, /unknown argument/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('too many entries names the ceiling', () => {
    const root = scratch();
    writeFileSync(join(root, 'targets.lst'), Array.from({ length: HARD_MAX_TARGETS + 1 }, (_, i) => `f${i}`).join('\n'));
    const r = run(['--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, new RegExp(String(HARD_MAX_TARGETS), 'u'));
    rmSync(root, { recursive: true, force: true });
  });

  it('the ceiling holds across the UNION of both lanes, not just within the file', () => {
    const root = scratch();
    const argv = Array.from({ length: HARD_MAX_TARGETS + 1 }, (_, i) => ['--path', `f${i}`]).flat();
    const r = run(argv, root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, new RegExp(String(HARD_MAX_TARGETS), 'u'));
    rmSync(root, { recursive: true, force: true });
  });

  it('naming no target at all is a usage error, not a walk of the whole root', () => {
    const root = seed(scratch(), { 'a.txt': '' });
    assert.equal(run([], root).code, EXIT_USAGE);
    rmSync(root, { recursive: true, force: true });
  });

  // An EMPTY --path passes a bare count check and then resolves to the root, which is exactly the
  // accidental whole-root walk the "name at least one target" rule exists to prevent.
  it('an EMPTY --path value is refused, not silently treated as the root', () => {
    const root = seed(scratch(), { 'a.txt': '' });
    const r = run(['--path', ''], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.doesNotMatch(r.stderr, /unknown argument/u);
    rmSync(root, { recursive: true, force: true });
  });

  // Exit 1 alone proves nothing here: an unhandled TypeError lands on the same generic catch and the
  // same exit code, which is exactly how a broken tagged-union check hid behind a green test once.
  // The stderr has to name the lane, not a crash.
  it('an unreadable paths file is a NAMED I/O failure — exit 1, at parity with repo-search', () => {
    const root = scratch();
    const missing = run(['--paths-file', 'nope.lst'], root);
    assert.equal(missing.code, EXIT_ERROR);
    assert.match(missing.stderr, /--paths-file/u);
    assert.doesNotMatch(missing.stderr, /undefined|TypeError/u);

    mkdirSync(join(root, 'a-directory.lst'));
    const notRegular = run(['--paths-file', 'a-directory.lst'], root);
    assert.equal(notRegular.code, EXIT_ERROR);
    assert.match(notRegular.stderr, /--paths-file/u);
    assert.doesNotMatch(notRegular.stderr, /undefined|TypeError/u);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('path-inventory — the human shape is safe to print', () => {
  it('control and ANSI bytes in a name are escaped, never emitted raw', () => {
    const root = scratch();
    writeFileSync(join(root, 'we\x1b[31mird.txt'), '');
    const r = run(['--path', 'we\x1b[31mird.txt'], root);
    assert.equal(r.code, EXIT_OK);
    assert.ok(!r.stdout.includes('\x1b'), 'an escape byte must never reach the terminal');
    rmSync(root, { recursive: true, force: true });
  });

  // A refusal carries the caller's own path. Escaping only the SUCCESS output would make the safe
  // path the only safe one — the wrong half to protect. The exact class of refusal is not the point
  // here, so this pins "refused" rather than a specific code.
  it('control bytes in a REFUSED path are escaped in stderr too', () => {
    const outside = seed(scratch(), { 'secret.txt': 'x\n' });
    const root = scratch();
    const r = run(['--path', `../${'\x1b'}[31m`], root);
    assert.notEqual(r.code, EXIT_OK);
    assert.ok(!r.stderr.includes('\x1b'), 'an escape byte must never reach the terminal, even on a refusal');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('a paths file whose bytes are not valid UTF-8 is REFUSED, never lossily decoded', () => {
    const root = scratch();
    writeFileSync(join(root, 'targets.lst'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
    const r = run(['--paths-file', 'targets.lst'], root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /UTF-8/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('--json emits the machine shape and the human form is the default', () => {
    const root = seed(scratch(), { 'a.txt': 'x\n' });
    const parsed = JSON.parse(run(['--path', 'a.txt', '--json'], root).stdout);
    assert.equal(parsed.results[0].path, 'a.txt');
    assert.equal(parsed.incomplete, null);
    assert.doesNotMatch(run(['--path', 'a.txt'], root).stdout, /^\{/u);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('path-inventory — usage surface', () => {
  it('an unknown argument is a loud exit 2 and --help exits 0 naming both lanes', () => {
    const root = scratch();
    assert.equal(run(['--bogus'], root).code, EXIT_USAGE);
    const help = run(['--help'], root);
    assert.equal(help.code, EXIT_OK);
    assert.match(help.stdout, /--paths-file/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('runs as a real subprocess with the documented exit codes', () => {
    const root = seed(scratch(), { 'a.txt': 'x\n' });
    const ok = spawnSync(process.execPath, [TOOL_PATH, '--path', 'a.txt'], { cwd: root, encoding: 'utf8' });
    assert.equal(ok.status, EXIT_OK);
    assert.match(ok.stdout, /a\.txt/u);
    const bad = spawnSync(process.execPath, [TOOL_PATH, '--bogus'], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, EXIT_USAGE);
    assert.match(bad.stderr, /path-inventory:/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('importing the module runs nothing (main is guarded by isDirectRun)', () => {
    const probe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(TOOL_PATH)}).then(() => process.exit(0))`], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, '');
    rmSync(scratch(), { recursive: true, force: true });
  });
});
