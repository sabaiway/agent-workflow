import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv } from './git-env.mjs';
import { shellQuoteArg } from './repo-lex.mjs';

const leaf = await import('./git-hooks.mjs').catch(() => ({}));
const need = (name) => {
  if (!(name in leaf)) throw new Error(name + ' is absent');
  return leaf[name];
};
const TOOLS = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(TOOLS, '..', 'references', 'scripts');
const NAMES = readdirSync(BUNDLE).filter((name) => name.endsWith('.mjs')).sort();
const INSTALLER = 'scripts/install-git-hooks.mjs';
const KEPT = 'scripts/markdown-blocks.test.mjs';
const FOREIGN = Buffer.from('foreign bytes\n');
const UNMANAGED = '#!/bin/sh\nexit 0\n';
const readBundle = (name) => readFileSync(join(BUNDLE, name));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const put = (root, rel, bytes, options) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, options);
  return path;
};
const snapshot = (root) => readdirSync(root).sort().map((name) => {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { name, kind: 'link', target: readlinkSync(path) };
  if (stat.isDirectory()) return { name, kind: 'directory', children: snapshot(path) };
  return { name, kind: 'file', bytes: readFileSync(path) };
});
const makeTemp = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'git-hooks-writer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process, 'exit', () => { throw new Error('main must not exit'); });
  return root;
};
const makeIo = (t, root, env) => {
  const lines = [];
  const errors = [];
  const output = [];
  return {
    cwd: root,
    env,
    lines,
    errors,
    output,
    log: (line) => lines.push(String(line)),
    error: (line) => errors.push(String(line)),
    spawn: t.mock.fn((argv, options) => {
      const result = spawnSync(process.execPath, argv.slice(1), {
        ...options, stdio: 'pipe', encoding: 'utf8',
      });
      output.push(result.stdout ?? '', result.stderr ?? '');
      return result;
    }),
  };
};
const makeProject = (t) => {
  const root = makeTemp(t);
  const env = hermeticGitEnv(process.env, root);
  env.PATH = [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
  const result = spawnSync('git', ['init', '-q', root], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return { root, io: makeIo(t, root, env) };
};
const invoke = (argv, io) => {
  const code = need('main')(argv, io);
  assert.equal(process.exit.mock.callCount(), 0, 'main must return without exiting');
  return code;
};
const assertNamed = (io, path) => assert.ok(io.errors.join('\n').includes(path), io.errors.join('\n'));
const installerLine = () => `runs: node ${INSTALLER} sha256:${sha(readBundle('install-git-hooks.mjs'))}`;
const previewLines = (kept) => [
  ...NAMES.map((name) => `copy: scripts/${name} ${`scripts/${name}` === kept
    ? 'kept' : `created sha256:${sha(readBundle(name))}`}`),
  installerLine(),
];

describe('spec:init-project/S34 the git-hook writer by proof on a temp git project', () => {
  it('previews created and kept copies in bundle order without changing the tree', (t) => {
    const { root, io } = makeProject(t);
    const before = snapshot(root);
    assert.equal(invoke(['--enforcement'], io), 0);
    assert.deepEqual(io.lines, previewLines());
    assert.deepEqual(snapshot(root), before);
    put(root, KEPT, FOREIGN);
    const withKept = snapshot(root);
    io.lines.length = 0;
    assert.equal(invoke(['--enforcement'], io), 0);
    assert.deepEqual(io.lines, previewLines(KEPT));
    assert.deepEqual(snapshot(root), withKept);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('applies bundled bytes, preserves a foreign file and reruns the installer idempotently', (t) => {
    const { root, io } = makeProject(t);
    put(root, KEPT, FOREIGN);
    assert.equal(invoke(['--apply', '--enforcement'], io), 0);
    for (const name of NAMES) {
      assert.deepEqual(readFileSync(join(root, 'scripts', name)),
        `scripts/${name}` === KEPT ? FOREIGN : readBundle(name));
    }
    const hook = join(root, '.git/hooks/pre-commit');
    assert.match(readFileSync(hook, 'utf8'), /^.*:install-git-hooks\.mjs$/m);
    const before = snapshot(join(root, 'scripts'));
    const secondIo = makeIo(t, root, io.env);
    secondIo.writeFile = t.mock.fn(() => assert.fail('second apply must copy nothing'));
    assert.equal(invoke(['--apply', '--enforcement'], secondIo), 0);
    assert.deepEqual(snapshot(join(root, 'scripts')), before);
    assert.equal(secondIo.writeFile.mock.callCount(), 0);
    assert.match(secondIo.output.join(''), /already up to date/);
    const { arguments: [argv, options] } = io.spawn.mock.calls[0];
    assert.deepEqual(argv, ['node', join(root, INSTALLER)]);
    assert.equal(options.cwd, root);
    assert.equal(options.env, io.env);
    assert.equal(options.stdio, 'inherit');
  });

  it('rolls back installer refusal while preserving an unmanaged hook and pre-existing scripts', (t) => {
    for (const keep of [false, true]) {
      const { root, io } = makeProject(t);
      const hook = put(root, '.git/hooks/pre-commit', UNMANAGED, { mode: 0o755 });
      if (keep) put(root, KEPT, FOREIGN);
      assert.equal(invoke(['--apply', '--enforcement'], io), 1);
      assertNamed(io, 'installer exited 1');
      assert.deepEqual(readFileSync(hook), Buffer.from(UNMANAGED));
      if (keep) {
        assert.deepEqual(readdirSync(join(root, 'scripts')), ['markdown-blocks.test.mjs']);
        assert.deepEqual(readFileSync(join(root, KEPT)), FOREIGN);
      } else assert.equal(existsSync(join(root, 'scripts')), false);
    }
  });

  it('rolls back earlier copies when the last planned copy becomes a link without spawning', (t) => {
    const { root, io } = makeProject(t);
    const plan = need('planGitHooks')({ root, variant: 'enforcement' });
    const last = plan.copies.filter(({ action }) => action === 'created').at(-1);
    const target = put(root, 'outside-scripts', FOREIGN);
    mkdirSync(join(root, 'scripts'));
    symlinkSync(target, last.path);
    assert.equal(need('applyGitHooks')(plan, io), 1);
    assertNamed(io, `scripts/${last.name}`);
    assert.deepEqual(readdirSync(join(root, 'scripts')), [last.name]);
    assert.ok(lstatSync(last.path).isSymbolicLink());
    assert.equal(readlinkSync(last.path), target);
    assert.deepEqual(readFileSync(target), FOREIGN);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('refuses a planned copy a regular file took after the dry run, keeping that file and running nothing', (t) => {
    const { root, io } = makeProject(t);
    const plan = need('planGitHooks')({ root, variant: 'enforcement' });
    const installer = put(root, INSTALLER, FOREIGN);
    assert.equal(need('applyGitHooks')(plan, io), 1);
    assertNamed(io, installer);
    assert.deepEqual(readdirSync(join(root, 'scripts')), ['install-git-hooks.mjs']);
    assert.deepEqual(readFileSync(installer), FOREIGN);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('names a created file that EACCES prevents removing while retaining exit 1', (t) => {
    const { root, io } = makeProject(t);
    put(root, '.git/hooks/pre-commit', UNMANAGED, { mode: 0o755 });
    const stuck = join(root, 'scripts', NAMES[0]);
    io.unlink = (path) => {
      if (path === stuck) throw Object.assign(new Error('cannot unlink'), { code: 'EACCES' });
      unlinkSync(path);
    };
    assert.equal(invoke(['--apply', '--enforcement'], io), 1);
    assertNamed(io, 'installer exited 1');
    assertNamed(io, stuck);
    assert.deepEqual(readdirSync(join(root, 'scripts')), [NAMES[0]]);
    assert.deepEqual(readFileSync(stuck), readBundle(NAMES[0]));
  });

  it('refuses rollback through a scripts directory replaced by a link', (t) => {
    const { root, io } = makeProject(t);
    const scripts = join(root, 'scripts');
    const moved = join(root, 'moved');
    io.spawn = t.mock.fn(() => {
      renameSync(scripts, moved);
      symlinkSync(moved, scripts);
      return { status: 1 };
    });
    assert.equal(invoke(['--apply', '--enforcement'], io), 1);
    assertNamed(io, scripts);
    assert.ok(lstatSync(scripts).isSymbolicLink());
    assert.equal(readlinkSync(scripts), moved);
    assert.deepEqual(readdirSync(moved).sort(), NAMES);
    for (const name of NAMES) assert.deepEqual(readFileSync(join(moved, name)), readBundle(name));
  });

  it('runs only a deployed project installer and refuses a deployment missing it', (t) => {
    const { root, io } = makeProject(t);
    put(root, 'scripts/archive-decisions.mjs', FOREIGN);
    const installer = put(root, INSTALLER, readBundle('install-git-hooks.mjs'));
    const before = snapshot(join(root, 'scripts'));
    assert.equal(invoke(['--enforcement'], io), 0);
    assert.deepEqual(io.lines, [installerLine()]);
    assert.equal(invoke(['--apply', '--enforcement'], io), 0);
    assert.deepEqual(snapshot(join(root, 'scripts')), before);
    assert.match(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), /:install-git-hooks\.mjs$/m);
    unlinkSync(installer);
    const missing = snapshot(root);
    const refused = makeIo(t, root, io.env);
    assert.equal(invoke(['--apply', '--enforcement'], refused), 3);
    assertNamed(refused, installer);
    assert.deepEqual(snapshot(root), missing);
    assert.equal(refused.spawn.mock.callCount(), 0);
  });

  it('refuses linked scripts or installers in both variants and wrong-kind enforcement copies', (t) => {
    const cases = [
      ['scripts', 'directory-link', ['--enforcement', '--commit-guard']],
      [INSTALLER, 'file-link', ['--enforcement', '--commit-guard']],
      ['scripts/check-docs-size.test.mjs', 'file-link', ['--enforcement']],
      [KEPT, 'directory', ['--enforcement']],
    ];
    for (const [rel, kind, variants] of cases) {
      const { root, io } = makeProject(t);
      const path = join(root, rel);
      if (kind === 'directory-link') {
        const backing = join(root, 'backing');
        mkdirSync(backing);
        for (const name of NAMES) put(backing, name, readBundle(name));
        symlinkSync(backing, path);
      } else if (kind === 'file-link') {
        const backing = put(root, 'backing', FOREIGN);
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(backing, path);
      } else mkdirSync(path, { recursive: true });
      const before = snapshot(root);
      for (const variant of variants) {
        for (const flags of [[], ['--apply']]) {
          io.errors.length = 0;
          assert.equal(invoke([...flags, variant], io), 3);
          assertNamed(io, path);
          assert.deepEqual(snapshot(root), before);
          assert.equal(io.spawn.mock.callCount(), 0);
        }
      }
    }
  });

  it('previews commit-guard with the quoted tools path and requires a project installer', (t) => {
    const { root, io } = makeProject(t);
    const installer = put(root, INSTALLER, readBundle('install-git-hooks.mjs'));
    const before = snapshot(root);
    assert.equal(invoke(['--commit-guard'], io), 0);
    const guard = shellQuoteArg(join(TOOLS, 'commit-guard.mjs'));
    assert.deepEqual(io.lines, [
      `runs: node ${INSTALLER} --commit-guard ${guard} sha256:${sha(readFileSync(installer))}`,
    ]);
    assert.deepEqual(snapshot(root), before);
    unlinkSync(installer);
    const missing = snapshot(root);
    assert.equal(invoke(['--commit-guard'], io), 3);
    assertNamed(io, installer);
    assert.deepEqual(snapshot(root), missing);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('returns help without reading cwd and rejects each invalid argument form with exit 2', (t) => {
    const root = makeTemp(t);
    const io = makeIo(t, join(root, 'does-not-exist'), hermeticGitEnv(process.env, root));
    assert.equal(invoke(['--help'], io), 0);
    assert.equal(io.lines.length, 1);
    assert.match(io.lines[0], /^usage: git-hooks /);
    assert.deepEqual(io.errors, []);
    const file = put(root, 'regular-file', FOREIGN);
    const invalid = [
      ['--bogus'], ['--enforcement', '--cwd'], ['--enforcement', '--cwd', file],
      [], ['--enforcement', '--commit-guard'], ['--help', '--enforcement'],
    ];
    const before = snapshot(root);
    for (const argv of invalid) assert.equal(invoke(argv, { ...io, cwd: root }), 2);
    assert.equal(io.spawn.mock.callCount(), 0);
    assert.deepEqual(snapshot(root), before);
  });

  it('exports a frozen sorted list of all bundled mjs files and the scripts paths', () => {
    assert.deepEqual(need('BUNDLED_SCRIPT_NAMES'), NAMES);
    assert.ok(Object.isFrozen(need('BUNDLED_SCRIPT_NAMES')));
    assert.equal(need('SCRIPTS_REL'), 'scripts');
    assert.equal(need('INSTALLER_REL'), INSTALLER);
  });

  it('maps the project installer exit 7 to exit 1 with its original status named', (t) => {
    const { root, io } = makeProject(t);
    put(root, INSTALLER, 'process.exit(7);\n');
    const before = snapshot(root);
    assert.equal(invoke(['--apply', '--commit-guard'], io), 1);
    assertNamed(io, 'installer exited 7');
    assert.deepEqual(snapshot(root), before);
    assert.equal(io.spawn.mock.callCount(), 1);
  });

  it('rethrows an lstat failure other than absence instead of reading the path as absent', (t) => {
    const { root } = makeProject(t);
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const lstat = (path) => {
      if (path === join(root, 'scripts')) throw denied;
      return lstatSync(path);
    };
    assert.throws(() => need('planGitHooks')({ root, variant: 'enforcement', lstat }), denied);
  });
});
