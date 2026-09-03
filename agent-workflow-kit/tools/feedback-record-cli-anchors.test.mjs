import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIB, git, commit, makeRepo, row, record, putRecord, invoke, clean,
} from './feedback-record-cli-harness.test.mjs';

describe('feedback anchor filesystem and dirt [spec:feedback-triage/S9]', () => {
  it('refuses symlink directory traversal and over-cap anchors by name', async () => clean(async (repo) => {
    symlinkSync('anchor.txt', join(repo.root, 'linked.txt'));
    mkdirSync(join(repo.root, 'directory-anchor'));
    writeFileSync(join(repo.root, 'directory-anchor', 'kept.txt'), 'kept\n');
    writeFileSync(join(repo.root, 'large.txt'), Buffer.alloc(MIB + 1, 0x61));
    const head = commit(repo);
    const hostile = record(head, { rows: [
      row({ id: 1, evidence: '`linked.txt:1`' }),
      row({ id: 2, evidence: '`directory-anchor:1`' }),
      row({ id: 3, evidence: '`../escape.txt:1`' }),
      row({ id: 4, evidence: '`large.txt:1`' }),
    ] });
    const result = await invoke(repo, ['--check', putRecord(repo, hostile)]);
    const names = result.errors.map((line) => /: ([a-z-]+):/u.exec(line)?.[1]);
    const absent = result.errors.filter((line) => line.includes(': anchor-absent:'));
    assert.equal(result.code, 1);
    assert.equal(names.filter((name) => name === 'anchor-absent').length, 2);
    assert.ok(absent.some((line) => line.includes('linked.txt')) && absent.some((line) => line.includes('directory-anchor')));
    assert.ok(names.includes('anchor-path'));
    assert.ok(names.includes('anchor-unreadable'));
  }));

  it('refuses an anchor under a symlinked parent that leaves the tree and names an anchor under an absent parent absent', async () => clean(async (repo) => {
    const outside = mkdtempSync(join(tmpdir(), 'feedback-outside-'));
    try {
      writeFileSync(join(outside, 'leaf.txt'), 'one\ntwo\n');
      symlinkSync(outside, join(repo.root, 'escape'));
      const head = commit(repo);
      const text = record(head, { rows: [
        row({ id: 1, evidence: '`escape/leaf.txt:1`' }),
        row({ id: 2, evidence: '`missing-dir/leaf.txt:1`' }),
      ] });
      const result = await invoke(repo, ['--check', putRecord(repo, text)]);
      const escaped = result.errors.filter((line) => line.includes(': anchor-path:'));
      const absent = result.errors.filter((line) => line.includes(': anchor-absent:'));
      assert.equal(result.code, 1);
      assert.equal(escaped.length, 1);
      assert.ok(escaped[0].includes('escape/leaf.txt'));
      assert.equal(absent.length, 1);
      assert.ok(absent[0].includes('missing-dir/leaf.txt'));
    } finally { rmSync(outside, { recursive: true, force: true }); }
    const missingCwd = join(repo.root, 'missing-cwd');
    const unresolved = await invoke(repo, ['--check', putRecord(repo, record(repo.head), 'unresolved.md')], { cwd: missingCwd });
    assert.equal(unresolved.code, 1);
    assert.match(unresolved.errors.join('\n'), /anchor-path:.*working directory cannot be resolved/u);
  }));

  it('lists modified, untracked, gitignored, dot-prefixed and subdirectory anchors as dirty from any cwd', async () => clean(async (repo) => {
    writeFileSync(join(repo.root, 'anchor.txt'), 'changed\ntwo\nthree\n');
    writeFileSync(join(repo.root, 'untracked.txt'), 'new\n');
    mkdirSync(join(repo.root, 'scratch'));
    writeFileSync(join(repo.root, 'scratch', 'note.txt'), 'ignored\n');
    const text = record(repo.head, { rows: [
      row({ id: 1, evidence: '`./anchor.txt:1`' }),
      row({ id: 2, evidence: '`untracked.txt:1`' }),
      row({ id: 3, evidence: '`scratch/note.txt:1`' }),
    ] });
    const result = await invoke(repo, ['--check', putRecord(repo, text)]);
    const dirty = result.errors.filter((line) => line.includes(': anchor-dirty:'));
    assert.equal(result.code, 1);
    assert.equal(dirty.length, 3);
    for (const path of ['./anchor.txt', 'untracked.txt', 'scratch/note.txt']) assert.ok(dirty.some((line) => line.includes(path)), path);
    const status = result.calls.find(({ args }) => args[0] === 'status');
    assert.equal(status.options.cwd, repo.root);
    assert.deepEqual(status.args.slice(status.args.indexOf('--') + 1), [
      ':(literal)anchor.txt', ':(literal)untracked.txt', ':(literal)scratch/note.txt',
    ]);

    const nested = makeRepo();
    try {
      mkdirSync(join(nested.root, 'sub'));
      writeFileSync(join(nested.root, 'sub', 'inner.txt'), 'clean\n');
      nested.head = commit(nested);
      writeFileSync(join(nested.root, 'sub', 'inner.txt'), 'changed\n');
      const nestedRecord = putRecord(nested, record(nested.head, { rows: [row({ evidence: '`inner.txt:1`' })] }));
      const nestedResult = await invoke(nested, ['--check', nestedRecord], { cwd: join(nested.root, 'sub') });
      const nestedDirty = nestedResult.errors.filter((line) => line.includes(': anchor-dirty:'));
      assert.equal(nestedResult.code, 1);
      assert.equal(nestedDirty.length, 1);
      assert.ok(nestedDirty[0].includes('inner.txt'));
      const nestedStatus = nestedResult.calls.find(({ args }) => args[0] === 'status');
      assert.equal(nestedStatus.options.cwd, nested.root);
      assert.deepEqual(nestedStatus.args.slice(nestedStatus.args.indexOf('--') + 1), [':(literal)sub/inner.txt']);
    } finally { rmSync(nested.root, { recursive: true, force: true }); }
  }));

  it('names a non-UTF-8 anchor anchor-unreadable', async () => clean(async (repo) => {
    writeFileSync(join(repo.root, 'latin.txt'), Buffer.from([0x6f, 0xe9, 0x0a]));
    const head = commit(repo);
    const result = await invoke(repo, ['--check', putRecord(repo, record(head, { rows: [row({ evidence: '`latin.txt:1`' })] }))]);
    const unreadable = result.errors.filter((line) => line.includes(': anchor-unreadable:'));
    assert.equal(result.code, 1);
    assert.equal(unreadable.length, 1);
    assert.match(unreadable[0], /UTF-8/u);
  }));

  it('names an anchor path spelled __proto__ like any other', async () => clean(async (repo) => {
    const outDir = mkdtempSync(join(tmpdir(), 'feedback-proto-'));
    try {
      writeFileSync(join(repo.root, '__proto__'), 'prototype line\n');
      const head = commit(repo);
      const path = putRecord(repo, record(head, { rows: [row({ evidence: '`__proto__:1`' })] }));
      const out = join(outDir, 'facts.md');
      const accepted = await invoke(repo, ['--check', path, '--excerpts', out]);
      assert.equal(accepted.code, 0, accepted.errors.join('\n'));
      assert.equal(readFileSync(out, 'utf8'), '__proto__:1: prototype line');
      writeFileSync(join(repo.root, '__proto__'), 'changed\n');
      const refused = await invoke(repo, ['--check', path]);
      const dirty = refused.errors.filter((line) => line.includes(': anchor-dirty:'));
      assert.equal(refused.code, 1);
      assert.equal(dirty.length, 1);
      assert.ok(dirty[0].includes('__proto__'));
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }));

  it('refuses an anchor whose index bit conceals the working tree', async () => clean(async (repo) => {
    writeFileSync(join(repo.root, 'sparse.txt'), 'clean\n');
    repo.head = commit(repo);
    writeFileSync(join(repo.root, 'anchor.txt'), 'changed\n');
    git(repo, ['update-index', '--assume-unchanged', 'anchor.txt']);
    writeFileSync(join(repo.root, 'sparse.txt'), 'changed\n');
    git(repo, ['update-index', '--skip-worktree', 'sparse.txt']);
    const path = putRecord(repo, record(repo.head, { rows: [
      row({ id: 1, evidence: '`anchor.txt:1`' }), row({ id: 2, evidence: '`sparse.txt:1`' }),
    ] }));
    const concealed = await invoke(repo, ['--check', path]);
    const dirty = concealed.errors.filter((line) => line.includes(': anchor-dirty:'));
    assert.equal(concealed.code, 1);
    assert.equal(dirty.length, 2);
    assert.ok(dirty.some((line) => /anchor\.txt.*ls-files tag h/u.test(line)));
    assert.ok(dirty.some((line) => /sparse\.txt.*ls-files tag S/u.test(line)));
    writeFileSync(join(repo.root, 'loose.txt'), 'loose\n');
    const loosePath = putRecord(repo, record(repo.head, { rows: [row({ evidence: '`loose.txt:1`' })] }), 'loose-record.md');
    const loose = await invoke(repo, ['--check', loosePath]);
    assert.equal(loose.code, 1);
    assert.equal(loose.errors.filter((line) => line.includes(': anchor-dirty:')).length, 1);
    assert.equal(loose.errors.some((line) => line.includes(': git-location:')), false);
  }));

  it('names the second spawn when ls-files fails', async () => clean(async (repo) => {
    const spawn = (command, args, options) => args[0] === 'ls-files'
      ? { error: { code: 'EPIPE' } }
      : spawnSync(command, args, options);
    const result = await invoke(repo, ['--check', putRecord(repo)], { spawn });
    assert.equal(result.code, 1);
    assert.match(result.errors.join('\n'), /git-location:.*anchor-dirty cannot be judged.*EPIPE/u);
  }));

  it('names an absent tracked anchor once', async () => clean(async (repo) => {
    rmSync(join(repo.root, 'anchor.txt'));
    const result = await invoke(repo, ['--check', putRecord(repo)]);
    assert.equal(result.code, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /: anchor-absent:/u);
  }));

  it('refuses an anchor the index does not list as tracked at the stamped HEAD', async () => clean(async (repo) => {
    const outDir = mkdtempSync(join(tmpdir(), 'feedback-untracked-index-'));
    try {
      mkdirSync(join(repo.root, 'dir'));
      writeFileSync(join(repo.root, 'dir', 'file.txt'), 'inside\n');
      symlinkSync('dir', join(repo.root, 'clink'));
      repo.head = commit(repo);
      symlinkSync('dir', join(repo.root, 'link'));

      const configOut = join(outDir, 'config.md');
      const configPath = putRecord(repo, record(repo.head, { rows: [row({ evidence: '`.git/config:1`' })] }), 'config-record.md');
      const config = await invoke(repo, ['--check', configPath, '--excerpts', configOut]);
      const configDirty = config.errors.filter((line) => line.includes(': anchor-dirty:'));
      assert.equal(config.code, 1);
      assert.equal(config.errors.length, 1);
      assert.equal(configDirty.length, 1);
      assert.match(configDirty[0], /not tracked/u);
      assert.equal(existsSync(configOut), false);

      const linkedPath = putRecord(repo, record(repo.head, { rows: [row({ evidence: '`link/file.txt:1`' })] }), 'link-record.md');
      const linked = await invoke(repo, ['--check', linkedPath]);
      assert.equal(linked.code, 1);
      assert.equal(linked.errors.length, 1);
      assert.equal(linked.errors.filter((line) => line.includes(': anchor-dirty:')).length, 1);
      const pathCalls = linked.calls.filter(({ args }) => ['status', 'ls-files'].includes(args[0]));
      assert.equal(pathCalls.length, 2);
      for (const call of pathCalls) {
        const pathspecs = call.args.slice(call.args.indexOf('--') + 1);
        assert.deepEqual(pathspecs, [':(literal)link/file.txt']);
        assert.ok(!pathspecs.some((value) => value.includes('dir/file.txt')));
      }

      const committedPath = putRecord(repo, record(repo.head, { rows: [row({ evidence: '`clink/file.txt:1`' })] }), 'clink-record.md');
      const committed = await invoke(repo, ['--check', committedPath]);
      assert.equal(committed.code, 1);
      assert.equal(committed.errors.length, 1);
      assert.equal(committed.errors.filter((line) => line.includes(': anchor-dirty:')).length, 1);
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }));

  it('sends every rel as a literal pathspec', async () => clean(async (repo) => {
    const literal = ':!*.txt';
    writeFileSync(join(repo.root, literal), 'committed\n');
    repo.head = commit(repo);
    writeFileSync(join(repo.root, literal), 'changed\n');
    const path = putRecord(repo, record(repo.head, { rows: [row({ evidence: `\`${literal}:1\`` })] }), 'literal-dirty.md');
    const changed = await invoke(repo, ['--check', path]);
    const dirty = changed.errors.filter((line) => line.includes(': anchor-dirty:'));
    assert.equal(changed.code, 1);
    assert.equal(changed.errors.length, 1);
    assert.equal(dirty.length, 1);
    assert.match(dirty[0], /differs from the stamped HEAD/u);

    writeFileSync(join(repo.root, literal), 'committed\n');
    writeFileSync(join(repo.root, 'anchor.txt'), 'changed\n');
    const cleanPath = putRecord(repo, record(repo.head, { rows: [row({ evidence: `\`${literal}:1\`` })] }), 'literal.md');
    const accepted = await invoke(repo, ['--check', cleanPath]);
    assert.equal(accepted.code, 0, accepted.errors.join('\n'));
    const status = accepted.calls.find(({ args }) => args[0] === 'status');
    assert.deepEqual(status.args.slice(status.args.indexOf('--') + 1), [':(literal):!*.txt']);
  }));
});
