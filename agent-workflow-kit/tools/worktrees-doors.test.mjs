import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, constants as fsConstants, existsSync, fchmodSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as worktrees from './worktrees.mjs';
import { shellQuoteArg } from './review-state.mjs';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'aw-worktrees-doors-'));
const HEAD_OID = 'a'.repeat(40);
const COMMON_GIT_DIR = join(TEMP_ROOT, 'common.git');

after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

const captureError = (operation) => {
  try {
    operation();
    return null;
  } catch (error) {
    return error;
  }
};

const formatWorktreeList = (entries, nulTerminated) => {
  const records = entries.map((entry) => [
    `worktree ${entry.path}`,
    `HEAD ${entry.head}`,
    ...(entry.branch === null ? ['detached'] : [`branch ${entry.branch}`]),
  ]);
  return nulTerminated
    ? `${records.map((fields) => fields.join('\0')).join('\0\0')}\0\0`
    : `${records.map((fields) => fields.join('\n')).join('\n\n')}\n\n`;
};

const createGitSeam = (root) => {
  const state = {
    calls: [],
    entries: [{ path: root, head: HEAD_OID, branch: 'refs/heads/main' }],
  };
  const git = (args, cwd) => {
    state.calls.push({ args: [...args], cwd });
    const commandArgs = args[0] === '--no-optional-locks' ? args.slice(1) : args;
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (commandArgs[0] === 'rev-parse' && commandArgs.includes('--show-toplevel')) return ok(`${root}\n`);
    if (commandArgs[0] === 'rev-parse' && commandArgs.includes('--git-dir')) return ok(`${COMMON_GIT_DIR}\n`);
    if (commandArgs[0] === 'rev-parse' && commandArgs.includes('--git-common-dir')) return ok(`${COMMON_GIT_DIR}\n`);
    if (commandArgs[0] === 'rev-parse' && commandArgs[1] === 'HEAD') return ok(`${HEAD_OID}\n`);
    if (commandArgs[0] === 'check-ignore') return ok(`${commandArgs.at(-1)}\n`);
    if (commandArgs[0] === 'ls-files') return ok();
    if (commandArgs[0] === 'status' && commandArgs[1] === '--porcelain') return ok();
    if (commandArgs[0] === 'worktree' && commandArgs[1] === 'list') {
      return ok(formatWorktreeList(state.entries, commandArgs.includes('-z')));
    }
    if (commandArgs[0] === 'worktree' && commandArgs[1] === 'add') {
      const target = commandArgs.at(-1);
      const branch = commandArgs[commandArgs.indexOf('-b') + 1];
      mkdirSync(target, { recursive: true });
      state.entries.push({ path: target, head: HEAD_OID, branch: `refs/heads/${branch}` });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
  return { git, state };
};

const createFixture = (name) => {
  const root = join(TEMP_ROOT, name);
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(join(root, 'docs/plans/SEED-PROMPT-feature.md'), '# plan\n');
  const { git, state } = createGitSeam(root);
  return { root, git, state };
};

const runCli = (argv, fixture, deps = {}) => {
  const out = [];
  const err = [];
  const code = worktrees.runCli(argv, {
    cwd: fixture.root,
    git: fixture.git,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const provision = (fixture, slug, extraArgs = [], deps = {}) => runCli([
  'provision', slug,
  '--plan', 'docs/plans/SEED-PROMPT-feature.md',
  '--as', `feature-${slug}.md`,
  ...extraArgs,
], fixture, deps);

describe('worktrees doors — descriptor-bound copy', () => {
  it('refuses a regular-file source swapped after lstat and before descriptor read', () => {
    const sourceDir = join(TEMP_ROOT, 'copy-src-swap');
    const worktree = join(TEMP_ROOT, 'copy-src-swap-wt');
    const source = join(sourceDir, 'source.txt');
    const heldSource = join(sourceDir, 'source-held.txt');
    const destination = join(worktree, 'source.txt');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'trusted\n');
    const state = { armed: false, opens: [] };
    const error = captureError(() => worktrees.copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'source.txt',
      deps: {
        open: (path, flags, mode) => {
          state.opens.push({ path, flags });
          if (path === source && !state.armed) {
            renameSync(source, heldSource);
            writeFileSync(source, 'attacker\n');
            state.armed = true;
          }
          return openSync(path, flags, mode);
        },
      },
    }));
    assert.equal(error?.code, worktrees.WORKTREES_STOP, 'the replacement inode must be refused');
    assert.equal(existsSync(destination), false, 'no destination may be created from the replacement inode');
    const sourceOpen = state.opens.find((entry) => entry.path === source);
    assert.ok(sourceOpen, 'the source must pass through the injected descriptor door');
    assert.equal(sourceOpen.flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR), fsConstants.O_RDONLY);
    assert.equal(sourceOpen.flags & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK);
    assert.equal(sourceOpen.flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
  });

  it('refuses a destination swapped to a symlink before exclusive descriptor creation', () => {
    const sourceDir = join(TEMP_ROOT, 'copy-dst-swap');
    const worktree = join(TEMP_ROOT, 'copy-dst-swap-wt');
    const source = join(sourceDir, 'source.txt');
    const destination = join(worktree, 'destination.txt');
    const victim = join(TEMP_ROOT, 'copy-dst-victim.txt');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'payload\n');
    writeFileSync(victim, 'victim\n');
    const state = { destinationStats: 0, opens: [] };
    const error = captureError(() => worktrees.copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'destination.txt',
      deps: {
        lstat: (path) => {
          if (path !== destination) return lstatSync(path);
          state.destinationStats += 1;
          if (state.destinationStats === 2) {
            symlinkSync(victim, destination);
            throw Object.assign(new Error('raced absence'), { code: 'ENOENT' });
          }
          return lstatSync(path);
        },
        open: (path, flags, mode) => {
          state.opens.push({ path, flags });
          return openSync(path, flags, mode);
        },
      },
    }));
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n', 'the raced symlink target must remain byte-exact');
    assert.equal(error?.code, worktrees.WORKTREES_STOP, 'the raced destination must be refused');
    const destinationOpen = state.opens.find((entry) => entry.path === destination);
    assert.ok(destinationOpen, 'the destination must pass through the injected descriptor door');
    assert.equal(destinationOpen.flags & fsConstants.O_WRONLY, fsConstants.O_WRONLY);
    assert.equal(destinationOpen.flags & fsConstants.O_CREAT, fsConstants.O_CREAT);
    assert.equal(destinationOpen.flags & fsConstants.O_EXCL, fsConstants.O_EXCL);
    assert.equal(destinationOpen.flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
  });

  it('preserves executable bits with fchmod on the destination descriptor', () => {
    const sourceDir = join(TEMP_ROOT, 'copy-exec');
    const worktree = join(TEMP_ROOT, 'copy-exec-wt');
    const source = join(sourceDir, 'run.sh');
    const destination = join(worktree, 'run.sh');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, '#!/bin/sh\n');
    chmodSync(source, 0o755);
    const calls = { fchmod: [], chmod: [] };
    worktrees.copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'run.sh',
      deps: {
        fchmod: (fd, mode) => {
          calls.fchmod.push({ fd, mode });
          fchmodSync(fd, mode);
        },
        chmod: (path, mode) => {
          calls.chmod.push({ path, mode });
          chmodSync(path, mode);
        },
      },
    });
    assert.equal(calls.fchmod.length, 1, 'the executable mode must be applied through the open destination fd');
    assert.equal(calls.chmod.length, 0, 'the path-based chmod race must be absent');
    assert.notEqual(lstatSync(destination).mode & 0o111, 0);
  });

  it('tripwire: worktrees.mjs has no raw copyFile call and keeps content reads in the read door', () => {
    const source = readFileSync(new URL('./worktrees.mjs', import.meta.url), 'utf8');
    const count = (pattern) => (source.match(pattern) ?? []).length;
    assert.equal(count(/\bcopyFile\(/g), 0, 'raw copyFile( calls must not exist — use the copy door');
    assert.equal(count(/\breadFile\(/g), 0, 'raw readFile( calls must not exist — use the read door');
    assert.equal(count(/\breadFileSync\(/g), 1, 'exactly one readFileSync( belongs to the read door');
  });
});

describe('worktrees doors — strict parsers', () => {
  it('parses NUL-terminated porcelain with a newline and Unicode in a worktree path', () => {
    const unusualPath = `${join(TEMP_ROOT, 'line')}\nЮникод path`;
    const porcelain = [
      'worktree /repo', `HEAD ${HEAD_OID}`, 'branch refs/heads/main', '',
      `worktree ${unusualPath}`, `HEAD ${'b'.repeat(40)}`, 'branch refs/heads/aw/unicode', '', '',
    ].join('\0');
    const entries = worktrees.parseWorktreeList(porcelain);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].path, unusualPath);
    assert.equal(entries[1].branch, 'refs/heads/aw/unicode');
  });

  it('list requests git worktree porcelain with NUL termination', () => {
    const fixture = createFixture('list-z');
    const linked = join(TEMP_ROOT, 'list-z-linked');
    mkdirSync(linked, { recursive: true });
    fixture.state.entries.push({ path: linked, head: HEAD_OID, branch: 'refs/heads/aw/list-z' });
    const result = runCli(['list'], fixture);
    assert.equal(result.code, worktrees.EXIT.ok, result.errText);
    const listCall = fixture.state.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'list');
    assert.deepEqual(listCall?.args, ['worktree', 'list', '--porcelain', '-z']);
  });

  it('exports parseStrictJson and refuses a duplicate key at any object depth', () => {
    assert.equal(typeof worktrees.parseStrictJson, 'function', 'parseStrictJson must be exported for reuse');
    assert.deepEqual(worktrees.parseStrictJson('{"outer":{"value":1}}'), { outer: { value: 1 } });
    assert.throws(
      () => worktrees.parseStrictJson('{"outer":{"value":1,"value":2}}'),
      /duplicate JSON key "value"/,
    );
  });

  it('the worktrees config refuses duplicate keys instead of accepting JSON last-wins semantics', () => {
    const root = join(TEMP_ROOT, 'duplicate-config');
    mkdirSync(join(root, 'docs/ai'), { recursive: true });
    writeFileSync(join(root, worktrees.CONFIG_REL), '{"parentDir":"first","parentDir":"second"}\n');
    assert.throws(
      () => worktrees.loadWorktreesConfig(root),
      (error) => error.code === worktrees.WORKTREES_STOP && /duplicate JSON key "parentDir"/.test(error.message),
    );
  });

  it('refuses a headingless handoff record', () => {
    const headingless = [
      '- slug: alpha',
      '- branch: aw/alpha',
      '- include: (none)',
      '- node_modules: absent',
      '- vscode-settings: absent',
      '',
    ].join('\n');
    assert.throws(
      () => worktrees.parseProvisionRecord(headingless),
      (error) => error.code === worktrees.WORKTREES_STOP && /missing required "## Provision record" section/.test(error.message),
    );
  });
});

describe('worktrees doors — no-follow node kinds', () => {
  it('does not use a regular file as the main node_modules source', () => {
    const fixture = createFixture('node-modules-file');
    writeFileSync(join(fixture.root, 'node_modules'), 'not a directory\n');
    const result = provision(fixture, 'nm-file');
    assert.equal(result.code, worktrees.EXIT.ok, result.errText);
    const target = join(dirname(fixture.root), `${basename(fixture.root)}--nm-file`);
    assert.equal(existsSync(join(target, 'node_modules')), false, 'a regular file must never be linked as node_modules');
    assert.match(result.text, /main's node_modules is neither a plain directory nor a symlink resolving to a directory — not symlinked/);
  });

  it('refuses a symlink passed as the seed-plan source before worktree creation', () => {
    const fixture = createFixture('seed-plan-symlink');
    writeFileSync(join(fixture.root, 'seed-real.md'), '# real\n');
    symlinkSync('../../seed-real.md', join(fixture.root, 'docs/plans/seed-link.md'));
    const result = runCli([
      'provision', 'seed-link',
      '--plan', 'docs/plans/seed-link.md',
      '--as', 'feature-seed-link.md',
    ], fixture);
    assert.equal(result.code, worktrees.EXIT.stop, result.errText);
    assert.match(result.errText, /--plan must be a regular non-symlink file/);
    assert.equal(fixture.state.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'), false);
  });
});

describe('worktrees doors — resume freshness and honest commands', () => {
  it('refreshes only the Provision record section while preserving user sections byte-exact', () => {
    const fixture = createFixture('record-surgery');
    const first = provision(fixture, 'record');
    assert.equal(first.code, worktrees.EXIT.ok, first.errText);
    const target = join(dirname(fixture.root), `${basename(fixture.root)}--record`);
    const handoffPath = join(target, 'docs/plans', worktrees.handoffBasename('record'));
    const original = readFileSync(handoffPath, 'utf8');
    const recordOffset = original.indexOf('## Provision record');
    const userPrefix = `${original.slice(0, recordOffset)}## User context\r\n\r\npreserve  trailing spaces  \r\n\r\n`;
    const userSuffix = '## User notes\r\n\r\n- keep: byte-exact\r\n';
    writeFileSync(handoffPath, `${userPrefix}${original.slice(recordOffset)}${userSuffix}`);
    writeFileSync(join(fixture.root, 'extra.txt'), 'extra\n');
    mkdirSync(join(fixture.root, 'node_modules'));
    mkdirSync(join(fixture.root, '.vscode'));
    writeFileSync(join(fixture.root, '.vscode/settings.json'), '{"editor.tabSize":2}\n');
    const resumed = provision(fixture, 'record', ['--resume', '--include', 'extra.txt']);
    assert.equal(resumed.code, worktrees.EXIT.ok, resumed.errText);
    const updated = readFileSync(handoffPath, 'utf8');
    assert.equal(updated.slice(0, updated.indexOf('## Provision record')), userPrefix);
    assert.equal(updated.slice(updated.indexOf('## User notes')), userSuffix);
    const record = worktrees.parseProvisionRecord(updated);
    assert.deepEqual(record.includes, ['extra.txt']);
    assert.equal(record.nodeModules, 'symlinked');
    assert.equal(record.vscode, 'written');
  });

  it('shell-quotes both code -n hints', () => {
    const fixture = createFixture('quoted-hint-main');
    const target = join(TEMP_ROOT, "hint dir;$(noop)'quoted");
    const created = provision(fixture, 'hint', ['--dir', target]);
    assert.equal(created.code, worktrees.EXIT.ok, created.errText);
    const listed = runCli(['list'], fixture);
    assert.equal(listed.code, worktrees.EXIT.ok, listed.errText);
    assert.deepEqual(
      [
        created.out.find((line) => line.startsWith('open it: code -n ')),
        listed.out.find((line) => line.startsWith('  open: code -n ')),
      ],
      [
        `open it: code -n ${shellQuoteArg(target)}`,
        `  open: code -n ${shellQuoteArg(target)}`,
      ],
    );
  });

  it('list reads status with optional locks disabled', () => {
    const fixture = createFixture('list-no-locks');
    const linked = join(TEMP_ROOT, 'list-no-locks-linked');
    mkdirSync(linked, { recursive: true });
    fixture.state.entries.push({ path: linked, head: HEAD_OID, branch: 'refs/heads/aw/list-no-locks' });
    const result = runCli(['list'], fixture);
    assert.equal(result.code, worktrees.EXIT.ok, result.errText);
    const statusCalls = fixture.state.calls.filter((call) => call.args.includes('status'));
    assert.deepEqual(statusCalls.map((call) => call.args), [['--no-optional-locks', 'status', '--porcelain']]);
  });
});
