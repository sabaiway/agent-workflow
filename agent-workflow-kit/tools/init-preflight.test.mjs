import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const preflight = await import('./init-preflight.mjs').catch(() => ({}));
const project = await import('./init-project.mjs').catch(() => ({}));
const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'SANDBOX_RUNTIME'];
const REFUSAL_CODES = ['EROFS', 'EPERM', 'EACCES'];
const INSIDE_LINE = 'you are inside an agent; run this in your own terminal';
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const STAT_PROBES = ['isCharacterDevice', 'isBlockDevice', 'isFIFO', 'isSocket', 'isSymbolicLink', 'isDirectory', 'isFile'];
const maskedStat = () => Object.fromEntries(STAT_PROBES.map((probe) => [probe, () => probe === 'isCharacterDevice']));
const settingsAbs = (root) => join(root, '.claude/settings.json');

const withFixture = async (fn) => {
  const base = mkdtempSync(join(tmpdir(), 'init-preflight-'));
  try {
    const home = join(base, 'home');
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(outside);
    for (const dir of [home, root]) {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(settingsAbs(dir), '{}', { mode: 0o644 });
      chmodSync(settingsAbs(dir), 0o644);
      assert.equal(lstatSync(settingsAbs(dir)).uid, process.geteuid());
    }
    mkdirSync(join(root, 'docs/ai/sub'), { recursive: true });
    writeFileSync(join(root, 'docs/ai/.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(root, '.mcp.json'), '{}');
    chmodSync(join(root, '.mcp.json'), 0o644);
    return await fn({ home, root, outside });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const hashTree = (root) => {
  const hash = createHash('sha256');
  const visit = (rel) => {
    const path = join(root, rel);
    hash.update(`${rel}\0`);
    if (lstatSync(path).isDirectory()) {
      hash.update('directory\0');
      for (const name of readdirSync(path).sort()) visit(join(rel, name));
    } else {
      const bytes = readFileSync(path);
      hash.update(`file:${bytes.length}\0`);
      hash.update(bytes);
    }
  };
  visit('');
  return hash.digest('hex');
};

const recordIo = ({ mask = null, refuse = null, code = 'EROFS' } = {}) => {
  const opened = [];
  const seen = [];
  const io = {
    lstat: (path, ...rest) => {
      seen.push(path);
      return path === mask ? maskedStat() : lstatSync(path, ...rest);
    },
    openSync: (path, flags, ...rest) => {
      opened.push([path, flags]);
      if (path === refuse) throw Object.assign(new Error(code), { code });
      return openSync(path, flags, ...rest);
    },
    closeSync,
    geteuid: () => process.geteuid(),
    readFile: readFileSync,
    readdir: readdirSync,
  };
  return { io, opened, seen };
};

const runRefusal = async (runInitProject, fixture, cwd, env, recording, afterFind) => {
  const printed = [];
  const calls = [];
  const before = [hashTree(fixture.home), hashTree(fixture.root)];
  const forbidden = (name) => (...args) => {
    calls.push([name, args]);
    assert.fail(`${name} must not be called`);
  };
  const result = await runInitProject({
    cwd, env, home: fixture.home, toolsDir: TOOLS_DIR, io: recording.io,
    terminal: { isTTY: true, ask: async () => '', print: (line) => printed.push(line) },
    spawn: forbidden('spawn'),
    recommend: forbidden('recommend'),
  });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(printed, [INSIDE_LINE]);
  assert.deepEqual(calls, []);
  if (afterFind) {
    assert.ok(recording.seen.includes(join(fixture.root, 'docs/ai')));
  } else {
    assert.equal(recording.seen.some((path) => path.endsWith(join('docs', 'ai'))), false);
  }
  assert.deepEqual([hashTree(fixture.home), hashTree(fixture.root)], before);
};

describe('spec:init-project/S8 preflight refuses before and after the find without writing', () => {
  it('a set marker refuses before the find while an empty marker does not', async () => {
    await withFixture(({ home }) => {
      const { io } = recordIo();
      const markers = need(preflight, 'AGENT_SESSION_MARKERS');
      const preflightInit = need(preflight, 'preflightInit');
      assert.deepEqual(markers, MARKERS);
      assert.equal(Object.isFrozen(markers), true);
      for (const marker of MARKERS) {
        const result = preflightInit({ root: null, home, env: { [marker]: '1' }, io });
        assert.equal(result.ok, false);
        assert.match(result.cause, new RegExp(`\\b${marker}\\b`, 'u'));
        assert.deepEqual(preflightInit({ root: null, home, env: { [marker]: '' }, io }), { ok: true, cause: null });
      }
    });
  });

  it('a write-refusing home settings file with a writable mode refuses; read-only and absent files do not', async () => {
    await withFixture(({ home }) => {
      const path = settingsAbs(home);
      const before = readFileSync(path);
      const recordings = REFUSAL_CODES.map((code) => recordIo({ refuse: path, code }));
      const preflightInit = need(preflight, 'preflightInit');
      for (const [index, code] of REFUSAL_CODES.entries()) {
        const { io, opened } = recordings[index];
        const result = preflightInit({ root: null, home, env: {}, io });
        assert.equal(result.ok, false);
        assert.ok(result.cause.includes(path));
        assert.match(result.cause, new RegExp(`\\b${code}\\b`, 'u'));
        assert.equal(opened.length, 1);
        assert.equal(opened[0][0], path);
        assert.equal(opened[0][1] & constants.O_WRONLY, constants.O_WRONLY);
        assert.equal(opened[0][1] & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
        assert.equal(opened[0][1] & (constants.O_CREAT | constants.O_TRUNC), 0);
        assert.deepEqual(readFileSync(path), before);
      }
      chmodSync(path, 0o444);
      const readonly = recordIo({ refuse: path });
      assert.deepEqual(preflightInit({ root: null, home, env: {}, io: readonly.io }), { ok: true, cause: null });
      assert.deepEqual(readonly.opened, []);
      assert.deepEqual(readFileSync(path), before);
      rmSync(path);
      const absent = recordIo({ refuse: path });
      assert.deepEqual(preflightInit({ root: null, home, env: {}, io: absent.io }), { ok: true, cause: null });
      assert.deepEqual(absent.opened, []);
    });
  });

  it('a device mask at home settings refuses without opening it', async () => {
    await withFixture(({ home }) => {
      const path = settingsAbs(home);
      const { io, opened } = recordIo({ mask: path });
      const preflightInit = need(preflight, 'preflightInit');
      const result = preflightInit({ root: null, home, env: {}, io });
      assert.equal(result.ok, false);
      assert.ok(result.cause.includes(path));
      assert.ok(result.cause.includes('a device-node mask'));
      assert.deepEqual(opened, []);
    });
  });

  it('an lstat or close failure outside the refusal codes throws naming the path and its code', async () => {
    await withFixture(({ home }) => {
      const path = settingsAbs(home);
      const preflightInit = need(preflight, 'preflightInit');
      const fail = (code) => Object.assign(new Error(code), { code });
      const lstatFails = { ...recordIo().io, lstat: () => { throw fail('EIO'); } };
      const closeFails = { ...recordIo().io, closeSync: (fd) => { closeSync(fd); throw fail('EBADF'); } };
      assert.throws(() => preflightInit({ root: null, home, env: {}, io: lstatFails }), (error) => error.code === 'EIO' && error.message.includes(path));
      assert.throws(() => preflightInit({ root: null, home, env: {}, io: closeFails }), (error) => error.code === 'EBADF' && error.message.includes(path));
    });
  });

  it('a root whose .git is a file (a linked worktree) preflights as one without a config file', async () => {
    await withFixture(({ home, root }) => {
      writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
      const { io } = recordIo();
      assert.deepEqual(need(preflight, 'preflightInit')({ root, home, env: {}, io }), { ok: true, cause: null });
    });
  });

  it('a refusing file of the found root refuses only after the find', async () => {
    await withFixture(({ home, root }) => {
      const path = join(root, '.mcp.json');
      const { io, opened } = recordIo({ refuse: path });
      const preflightInit = need(preflight, 'preflightInit');
      const result = preflightInit({ root, home, env: {}, io });
      assert.equal(result.ok, false);
      assert.ok(result.cause.includes(path));
      assert.match(result.cause, /\bEROFS\b/u);
      opened.length = 0;
      assert.deepEqual(preflightInit({ root: null, home, env: {}, io }), { ok: true, cause: null });
      assert.equal(opened.some(([openedPath]) => openedPath.startsWith(root)), false);
    });
  });

  it('with a TTY, a set marker or home refusal prints before the find inside, outside and from a subfolder, writing nothing', async () => {
    await withFixture(async (fixture) => {
      const { home, root, outside } = fixture;
      const runs = [root, join(root, 'docs/ai/sub'), outside].flatMap((cwd) => [
        { cwd, env: { CLAUDECODE: '1' }, recording: recordIo() },
        { cwd, env: {}, recording: recordIo({ mask: settingsAbs(home) }) },
        { cwd, env: {}, recording: recordIo({ refuse: settingsAbs(home) }) },
      ]);
      const runInitProject = need(project, 'runInitProject');
      for (const { cwd, env, recording } of runs) {
        await runRefusal(runInitProject, fixture, cwd, env, recording, false);
      }
    });
  });

  it('with a TTY, a refusing file of the found root prints after the find, writing nothing and keeping the exit status', async () => {
    await withFixture(async (fixture) => {
      const recording = recordIo({ refuse: settingsAbs(fixture.root) });
      const runInitProject = need(project, 'runInitProject');
      await runRefusal(runInitProject, fixture, fixture.root, {}, recording, true);
    });
  });
});
