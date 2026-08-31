// control-bytes-arms.test.mjs — the refusal arms the main suites reach through no real filesystem
// state (first-pass-quality plan 1, the changed-line coverage obligation): gitQuery's synchronous
// throw, an index mode naming no readable kind, an untracked lstat failure, and enumerateIndex's
// own spawn throw (past the location check). A separate file so no red-proof-bound suite moves.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { main } from './control-bytes.mjs';
import { enumerateIndex } from './source-size-scope.mjs';
import { SOURCE_SIZE_STOP } from './source-size-refusal.mjs';
import { makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';

const withRepo = (body) => {
  const r = makeRepo('arms');
  try {
    return body(r);
  } finally {
    r.cleanup();
  }
};
const text = (result) => result.lines.join('\n');

describe('control-bytes — the refusal arms behind injected seams', { skip: skipWithoutGit }, () => {
  it('a git query that throws synchronously (past the location probes) refuses with the message escaped', () => withRepo((r) => {
    const spawn = (cmd, args, opts) => {
      if (args[0] === 'ls-files' && args[1] === '-s') throw new Error('bo\x01om');
      return spawnSync(cmd, args, opts);
    };
    const result = main(['--check'], { cwd: r.cwd, env: r.env, spawn });
    assert.equal(result.code, 1);
    assert.match(text(result), /git ls-files -s -z threw synchronously \(bo\\u\{1\}om\)/u);
  }));
  it('an index mode naming no readable kind refuses by the mode', () => withRepo((r) => {
    const record = Buffer.from(`000000 ${'a'.repeat(40)} 0\tweird\0`);
    const spawn = (cmd, args, opts) => (args[0] === 'ls-files' && args[1] === '-s'
      ? { status: 0, stdout: record, stderr: Buffer.alloc(0) }
      : spawnSync(cmd, args, opts));
    const result = main(['--check'], { cwd: r.cwd, env: r.env, spawn });
    assert.equal(result.code, 1);
    assert.match(text(result), /REFUSED — weird: unreadable \(index mode 000000 names no readable kind\)/u);
  }));
  it('an untracked path whose lstat fails is unreadable (EACCES) or absent (ENOENT), each by name', () => withRepo((r) => {
    r.write('locked.txt', 'x\n');
    r.write('gone.txt', 'y\n');
    const lie = (code) => { throw Object.assign(new Error(code), { code }); };
    const lstat = (path) => {
      if (String(path).endsWith('locked.txt')) lie('EACCES');
      if (String(path).endsWith('gone.txt')) lie('ENOENT');
      return lstatSync(path);
    };
    const result = main(['--check'], { cwd: r.cwd, env: r.env, io: { lstat } });
    assert.equal(result.code, 1);
    assert.match(text(result), /REFUSED — locked\.txt: unreadable \(EACCES\)/u);
    assert.match(text(result), /REFUSED — gone\.txt: absent \(git named it/u);
  }));
});

describe('enumerateIndex — the enumeration spawn throw past the location check', { skip: skipWithoutGit }, () => {
  it('a spawn that throws only on ls-files refuses in the enumeration-error class naming the message', () => withRepo((r) => {
    const spawn = (cmd, args, opts) => {
      if (args[0] === 'ls-files') throw new Error('boom');
      return spawnSync(cmd, args, { ...opts, env: opts.env ?? r.env });
    };
    assert.throws(
      () => enumerateIndex(r.cwd, { spawn, env: r.env }),
      (err) => err.code === SOURCE_SIZE_STOP && err.exitCode === 2 && /could not be enumerated .*boom/u.test(err.message),
    );
  }));
});
