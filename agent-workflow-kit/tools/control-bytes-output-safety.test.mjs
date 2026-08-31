// control-bytes-output-safety.test.mjs — the round-2 fold suite (first-pass-quality plan 1): every
// DYNAMIC diagnostic that reaches a report line (a location cause, git stderr, an fs error code, a
// user argument) is escaped through the same renderer as paths, and the git-location leaf survives
// a repository path carrying a newline (one identity per rev-parse spawn, never a split). Red-first
// on the pre-fold modules; a separate file because control-bytes.test.mjs sits near its line cap.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER, resolveGitLocation } from './git-env.mjs';
import { makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';

const tool = await import('./control-bytes.mjs').catch(() => ({}));
const { main } = tool;
const withRepo = (body, files) => {
  const r = makeRepo('output-safety', files);
  try {
    return body(r);
  } finally {
    r.cleanup();
  }
};
// No raw C0/DEL byte and no U+FFFD in ANY output line — the helper every case here ends with. The
// LF that joins lines (the static usage block carries its own) is the line boundary, not a leak.
const assertLinesSafe = (lines) => {
  for (const line of lines.join('\n').split('\n')) {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      assert.ok(cp >= 0x20 && cp !== 0x7f && cp !== 0xfffd, `raw byte U+${cp.toString(16)} reached a line: ${JSON.stringify(line)}`);
    }
  }
};

describe('control-bytes — dynamic diagnostics are escaped, never emitted raw', { skip: skipWithoutGit }, () => {
  it('a location cause carrying a control byte (git stderr) is escaped in the refusal line', () => withRepo((r) => {
    const spawn = (cmd, args, opts) => (args[0] === 'rev-parse'
      ? { status: 128, stdout: '', stderr: 'fatal: not a git repository: \x01evil' }
      : spawnSync(cmd, args, opts));
    const result = main(['--check'], { cwd: r.cwd, env: r.env, spawn });
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /the git location is not-a-repository/u);
    assert.match(result.lines[0], /\\u\{1\}evil/u);
    assertLinesSafe(result.lines);
  }));
  it('a failing git query\'s stderr carrying an escape byte is escaped in the refusal line', () => withRepo((r) => {
    const spawn = (cmd, args, opts) => (args[0] === 'ls-files' && args[1] === '-s'
      ? { status: 129, stdout: Buffer.alloc(0), stderr: Buffer.from('bo\x1bom') }
      : spawnSync(cmd, args, opts));
    const result = main(['--check'], { cwd: r.cwd, env: r.env, spawn });
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /git ls-files -s -z exited 129/u);
    assert.match(result.lines[0], /bo\\u\{1b\}om/u);
    assertLinesSafe(result.lines);
  }));
  it('a user argument carrying a control byte is escaped in the usage line', () => withRepo((r) => {
    const result = main(['--cwd', `${r.dir}/no\x01where`], { cwd: r.cwd, env: r.env });
    assert.equal(result.code, 2);
    assert.match(result.lines[0], /no\\u\{1\}where/u);
    assertLinesSafe(result.lines);
  }));
  it('the injectable realpath reaches the location check through main: a throwing realpath is a named error refusal', () => withRepo((r) => {
    const io = { realpath: () => { throw Object.assign(new Error('loop'), { code: 'ELOOP' }); } };
    const result = main(['--check'], { cwd: r.cwd, env: r.env, io });
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /the git location is error/u);
    assert.match(result.lines[0], /cannot be resolved \(ELOOP\)/u);
  }));
  it('an fs error code carrying a control byte is escaped in the unreadable refusal', () => withRepo((r) => {
    const io = {
      open: (path, flags) => {
        if (String(path).endsWith('f.txt')) throw Object.assign(new Error('x'), { code: 'E\x02VIL' });
        return tool.defaultIo.open(path, flags);
      },
    };
    const result = main(['--check'], { cwd: r.cwd, env: r.env, io });
    assert.equal(result.code, 1);
    assert.match(result.lines.join('\n'), /f\.txt: unreadable \(E\\u\{2\}VIL\)/u);
    assertLinesSafe(result.lines);
  }));
});

describe('control-bytes — a nested-repository entry swapped for a symlink is judged, never skipped', { skip: skipWithoutGit }, () => {
  it('the trailing slash never reaches the filesystem: the swapped symlink\'s target is judged', () => withRepo((r) => {
    const nested = join(r.dir, 'racer');
    mkdirSync(nested);
    r.must(['init', '-q'], { cwd: nested });
    writeFileSync(join(nested, 'x.txt'), 'x');
    // Capture git's REAL answers while the nested repository stands (the `racer/` entry) …
    const capture = {};
    for (const args of [['ls-files', '-s', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
      capture[args.join(' ')] = spawnSync('git', args, { cwd: r.dir, env: r.env, maxBuffer: GIT_MAX_BUFFER });
    }
    assert.ok(capture['ls-files --others --exclude-standard -z'].stdout.toString('utf8').includes('racer/'), 'git names the nested repository with the trailing slash');
    // … then race: the directory is now a symlink whose target string carries a control byte.
    rmSync(nested, { recursive: true, force: true });
    const target = join(r.home, 'tar\x02get');
    mkdirSync(target);
    symlinkSync(target, join(r.dir, 'racer'));
    const spawn = (cmd, args, opts) => capture[args.join(' ')] ?? spawnSync(cmd, args, opts);
    const result = main(['--check'], { cwd: r.cwd, env: r.env, spawn });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.match(result.lines.join('\n'), /racer\/ symlink-target offset \d+: 0x02/u, 'the swapped link is judged as a symlink, never skipped as a nested repository');
    assertLinesSafe(result.lines);
  }));
});

describe('git-env — a repository path carrying a newline resolves (one identity per spawn)', { skip: process.platform === 'win32' ? 'POSIX-only fixture (a newline in a path)' : skipWithoutGit }, () => {
  it('work-tree, with the top equal to the newline-bearing path, and the gate renders it escaped', () => {
    const r = makeRepo('new\nline');
    try {
      const location = resolveGitLocation(r.cwd, { env: r.env });
      assert.equal(location.state, 'work-tree', location.cause ?? '');
      assert.equal(location.top, r.dir);
      assert.ok(location.top.includes('\n'), 'the fixture path really carries a newline');
      const result = main(['--check'], { cwd: r.cwd, env: r.env });
      assert.equal(result.code, 0, result.lines.join('\n'));
      assert.match(result.lines[0], /work tree .*new\\u\{a\}line/u);
      assertLinesSafe(result.lines);
    } finally {
      r.cleanup();
    }
  });
});
