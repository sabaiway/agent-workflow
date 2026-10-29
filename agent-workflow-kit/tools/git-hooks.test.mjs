import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeProjectFileCreateOnly } from './atomic-write.mjs';
import { hermeticGitEnv } from './git-env.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { THEMES, themePaths } from './project-rules/index.mjs';

const leaf = await import('./git-hooks.mjs').catch(() => ({}));
const need = (name) => {
  if (!(name in leaf)) throw new Error(name + ' is absent');
  return leaf[name];
};
const TOOLS = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(TOOLS, '..', 'references', 'scripts');
const INSTALLER = 'scripts/install-git-hooks.mjs';
const KIT_DIR = 'scripts/agent-workflow';
const KIT_INSTALLER = `${KIT_DIR}/git-hooks/install-git-hooks.mjs`;
// A flat suite of an earlier release and a file of the user's own in a module folder: neither a copy nor evidence.
const [FLAT_SUITE, OWN] = ['scripts/markdown-blocks.test.mjs', `${KIT_DIR}/shared/notes.md`];
const STUB = 'process.exit(0);\n';
const FOREIGN = Buffer.from('foreign bytes\n');
const UNMANAGED = '#!/bin/sh\nexit 0\n';
const ROUTE = "/agent-workflow-kit upgrade writes the kit's current installer over any other installer body, with no question; if it stops on another cause, resolve the cause it names and run it again; then apply this item again";
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
// The folder itself is named, not only a longer path beneath it.
const assertNamesPath = (io, path) => assert.ok(io.errors.some((line) => line.endsWith(path) || line.includes(`${path} `)), io.errors.join('\n'));
// The kit mirror's deployed entries, read through the manifest's reader inside each test so the suite loads without it.
const deployedFamily = async () => (await import('../references/scripts/family.mjs')).readFamily(BUNDLE).filter(({ role }) => role === 'deployed');
const kitRel = ({ path }) => `${KIT_DIR}/${path}`;
// Every file and every empty folder beneath root/rel as root-relative POSIX paths, a link listed and never followed.
const tree = (root, rel = 'scripts') => {
  const walk = (at) => {
    const stat = lstatSync(join(root, at), { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isDirectory()) return [at];
    const names = readdirSync(join(root, at));
    return names.length === 0 ? [`${at}/`] : names.flatMap((name) => walk(`${at}/${name}`));
  };
  return walk(rel).sort();
};
const watch = (t, io) => {
  const [seen, inner] = [[], io.spawn];
  io.spawn = t.mock.fn((argv, options) => (seen.push(tree(options.cwd)), inner(argv, options)));
  return seen;
};
const previewLines = (family) => [
  ...family.map((entry) => `copy: ${kitRel(entry)} created sha256:${sha(readBundle(entry.path))}`),
  `runs: node ${KIT_INSTALLER} sha256:${sha(readBundle('git-hooks/install-git-hooks.mjs'))}`,
];

describe('spec:init-project/S34 the git-hook writer by proof on a temp git project', () => {
  it('previews every deployed entry created at its kit-folder path with the bundled sha256, then the runs line, writing nothing', async (t) => {
    const { root, io } = makeProject(t);
    for (const extra of [[], [FLAT_SUITE, OWN]]) {
      for (const rel of extra) put(root, rel, FOREIGN);
      const before = snapshot(root);
      io.lines.length = 0;
      assert.equal(invoke(['--enforcement'], io), 0);
      assert.ok(io.lines.at(-1).startsWith(`runs: node ${KIT_INSTALLER} sha256:`), io.lines.at(-1));
      assert.deepEqual(io.lines, previewLines(await deployedFamily()));
      assert.deepEqual(snapshot(root), before);
    }
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('applies create-only through writeProjectFileCreateOnly, keeps a file of its own byte for byte, runs the kit-folder installer at the root and reruns idempotently', async (t) => {
    const { root, io } = makeProject(t);
    for (const rel of [FLAT_SUITE, OWN]) put(root, rel, FOREIGN);
    const [seen, written] = [watch(t, io), []];
    io.writeFile = (dir, rel, bytes) => (written.push(resolve(dir, rel)), writeProjectFileCreateOnly(dir, rel, bytes));
    assert.equal(invoke(['--apply', '--enforcement'], io), 0);
    const { arguments: [argv, options] } = io.spawn.mock.calls[0];
    assert.deepEqual([argv, options.cwd, options.env === io.env, options.stdio], [['node', join(root, KIT_INSTALLER)], root, true, 'inherit']);
    const family = await deployedFamily();
    assert.deepEqual(written.sort(), family.map((entry) => join(root, kitRel(entry))).sort());
    for (const entry of family) assert.deepEqual(readFileSync(join(root, kitRel(entry))), readBundle(entry.path));
    for (const rel of [FLAT_SUITE, OWN]) assert.deepEqual(readFileSync(join(root, rel)), FOREIGN);
    assert.deepEqual(seen, [[...family.map(kitRel), FLAT_SUITE, OWN].sort()]);
    assert.match(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), /^.*:install-git-hooks\.mjs$/m);
    const before = snapshot(join(root, 'scripts'));
    const secondIo = makeIo(t, root, io.env);
    secondIo.writeFile = t.mock.fn(() => assert.fail('second apply must copy nothing'));
    assert.equal(invoke(['--apply', '--enforcement'], secondIo), 0);
    assert.deepEqual(snapshot(join(root, 'scripts')), before);
    assert.equal(secondIo.writeFile.mock.callCount(), 0);
    assert.match(secondIo.output.join(''), /already up to date/);
  });

  it('rolls back an installer refusal over an unmanaged hook: every created file and each folder it created removed when empty, an existing file kept', async (t) => {
    for (const existing of [[], [FLAT_SUITE], [FLAT_SUITE, OWN]]) {
      const { root, io } = makeProject(t);
      const hook = put(root, '.git/hooks/pre-commit', UNMANAGED, { mode: 0o755 });
      for (const rel of existing) put(root, rel, FOREIGN);
      const [before, seen] = [snapshot(root), watch(t, io)];
      assert.equal(invoke(['--apply', '--enforcement'], io), 1);
      assert.ok(seen[0]?.includes(KIT_INSTALLER), 'the kit-folder installer stood when the installer ran');
      assert.deepEqual(seen, [[...(await deployedFamily()).map(kitRel), ...existing].sort()]);
      assertNamed(io, 'installer exited 1');
      assert.deepEqual(readFileSync(hook), Buffer.from(UNMANAGED));
      assert.deepEqual(snapshot(root), before, existing.join(', '));
    }
  });

  it('a link planted at a later copy\'s path after the dry run refuses at its gate: the earlier copies and the folders this run created removed, the link kept, nothing spawned', async (t) => {
    const { root, io } = makeProject(t);
    const plan = need('planGitHooks')({ root, variant: 'enforcement' });
    const last = kitRel((await deployedFamily()).at(-1));
    const target = put(root, 'outside-scripts', FOREIGN);
    mkdirSync(dirname(join(root, last)), { recursive: true });
    symlinkSync(target, join(root, last));
    assert.equal(need('applyGitHooks')(plan, io), 1);
    assertNamed(io, join(root, last));
    assert.deepEqual(tree(root), [last]);
    assert.equal(readlinkSync(join(root, last)), target);
    assert.deepEqual(readFileSync(target), FOREIGN);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('refuses a planned copy a regular file took after the dry run, keeping that file and running nothing', (t) => {
    const { root, io } = makeProject(t);
    const plan = need('planGitHooks')({ root, variant: 'enforcement' });
    const installer = put(root, KIT_INSTALLER, FOREIGN);
    assert.equal(need('applyGitHooks')(plan, io), 1);
    assertNamed(io, installer);
    assert.deepEqual(tree(root), [KIT_INSTALLER]);
    assert.deepEqual(readFileSync(installer), FOREIGN);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('names a created file that EACCES prevents removing while retaining exit 1', (t) => {
    const { root, io } = makeProject(t);
    put(root, '.git/hooks/pre-commit', UNMANAGED, { mode: 0o755 });
    const stuck = join(root, KIT_INSTALLER);
    io.unlink = (path) => {
      if (path === stuck) throw Object.assign(new Error('cannot unlink'), { code: 'EACCES' });
      unlinkSync(path);
    };
    assert.equal(invoke(['--apply', '--enforcement'], io), 1);
    assertNamed(io, 'installer exited 1');
    assertNamed(io, stuck);
    assert.deepEqual(tree(root), [KIT_INSTALLER]);
    assert.deepEqual(readFileSync(stuck), readBundle('git-hooks/install-git-hooks.mjs'));
  });

  it('a module folder the rollback cannot lstat (EACCES) is named with each file beneath it, nothing removed through it, the rest rolled back', async (t) => {
    const { root, io } = makeProject(t);
    const stuck = join(root, KIT_DIR, 'shared');
    const after = { spawn: false };
    io.lstat = (path) => {
      if (after.spawn && path === stuck) throw Object.assign(new Error('cannot lstat'), { code: 'EACCES' });
      return lstatSync(path);
    };
    io.spawn = t.mock.fn(() => ((after.spawn = true), { status: 1 }));
    assert.equal(invoke(['--apply', '--enforcement'], io), 1);
    assertNamed(io, 'installer exited 1');
    assertNamesPath(io, stuck);
    const beneath = (await deployedFamily()).filter((entry) => kitRel(entry).startsWith(`${KIT_DIR}/shared/`));
    for (const entry of beneath) assertNamesPath(io, join(root, kitRel(entry)));
    assert.deepEqual(tree(root), beneath.map(kitRel).sort());
    for (const entry of beneath) assert.deepEqual(readFileSync(join(root, kitRel(entry))), readBundle(entry.path));
  });

  it('refuses rollback through a scripts/, kit folder or module folder replaced by a link, naming it and removing nothing through it', async (t) => {
    for (const swapped of [KIT_DIR, `${KIT_DIR}/shared`, 'scripts']) {
      const { root, io } = makeProject(t);
      const [path, moved] = [join(root, swapped), join(root, 'moved')];
      io.spawn = t.mock.fn(() => {
        if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) (renameSync(path, moved), symlinkSync(moved, path));
        return { status: 1 };
      });
      assert.equal(invoke(['--apply', '--enforcement'], io), 1);
      assertNamesPath(io, path);
      assert.equal(readlinkSync(path), moved);
      const beneath = (await deployedFamily()).filter((entry) => kitRel(entry).startsWith(`${swapped}/`));
      assert.deepEqual(tree(root, 'moved'), beneath.map((entry) => `moved/${kitRel(entry).slice(swapped.length + 1)}`).sort(), swapped);
      for (const entry of beneath) assert.deepEqual(readFileSync(join(moved, kitRel(entry).slice(swapped.length + 1))), readBundle(entry.path));
    }
  });

  it('a scripts/ planted as a link after the dry run refuses the first copy, making no folder through it and spawning nothing', (t) => {
    const { root, io } = makeProject(t);
    const plan = need('planGitHooks')({ root, variant: 'enforcement' });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'scripts'));
    assert.equal(need('applyGitHooks')(plan, io), 1);
    assertNamed(io, join(root, 'scripts'));
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(io.spawn.mock.callCount(), 0);
  });

  it('under a deployed evidence script, flat or in the kit folder, copies nothing and runs the project installer, an absent installer there being exit 3', (t) => {
    for (const evidence of ['scripts/archive-decisions.mjs', `${KIT_DIR}/archives/archive-decisions.mjs`]) {
      const { root, io } = makeProject(t);
      put(root, evidence, FOREIGN);
      put(root, INSTALLER, 'process.exit(9);\n');
      const installer = put(root, KIT_INSTALLER, STUB);
      const before = snapshot(root);
      io.writeFile = t.mock.fn(() => assert.fail('a deployment is never copied into'));
      assert.equal(invoke(['--enforcement'], io), 0);
      assert.deepEqual(io.lines, [`runs: node ${KIT_INSTALLER} sha256:${sha(STUB)}`], evidence);
      assert.equal(invoke(['--apply', '--enforcement'], io), 0);
      assert.deepEqual(io.spawn.mock.calls.map(({ arguments: [argv] }) => argv), [['node', installer]]);
      assert.deepEqual(snapshot(root), before);
      unlinkSync(installer);
      const missing = snapshot(root);
      const refused = makeIo(t, root, io.env);
      assert.equal(invoke(['--apply', '--enforcement'], refused), 3);
      assertNamed(refused, installer);
      assert.deepEqual(snapshot(root), missing);
      assert.equal(refused.spawn.mock.callCount(), 0);
      assert.equal(io.writeFile.mock.callCount(), 0);
    }
  });

  it('refuses a linked scripts/, kit folder, module folder or installer in both variants and a linked or non-regular copy path, writing and spawning nothing', (t) => {
    const BOTH_VARIANTS = ['--enforcement', '--commit-guard'];
    const cases = [
      ['scripts', 'directory-link', BOTH_VARIANTS],
      [KIT_DIR, 'directory-link', BOTH_VARIANTS],
      [`${KIT_DIR}/git-hooks`, 'directory-link', BOTH_VARIANTS],
      [KIT_INSTALLER, 'file-link', BOTH_VARIANTS],
      [`${KIT_DIR}/docs-size/check-docs-size.mjs`, 'file-link', ['--enforcement']],
      [`${KIT_DIR}/shared/markdown-blocks.mjs`, 'directory', ['--enforcement']],
    ];
    for (const [rel, kind, variants] of cases) {
      const { root, io } = makeProject(t);
      const path = join(root, rel);
      if (kind === 'directory-link') {
        const backing = join(root, 'backing');
        mkdirSync(backing);
        for (const held of [KIT_INSTALLER, `${KIT_DIR}/archives/archive-decisions.mjs`].filter((file) => file.startsWith(`${rel}/`))) put(backing, held.slice(rel.length + 1), STUB);
        mkdirSync(dirname(path), { recursive: true });
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
          assertNamesPath(io, path);
          assert.deepEqual(snapshot(root), before);
          assert.equal(io.spawn.mock.callCount(), 0);
        }
      }
    }
  });

  it('previews commit-guard with the quoted tools path and requires a project installer', (t) => {
    const { root, io } = makeProject(t);
    const installer = put(root, KIT_INSTALLER, STUB);
    const before = snapshot(root);
    assert.equal(invoke(['--commit-guard'], io), 0);
    const guard = shellQuoteArg(join(TOOLS, 'commit-guard.mjs'));
    assert.deepEqual(io.lines, [
      `runs: node ${KIT_INSTALLER} --commit-guard ${guard} sha256:${sha(readFileSync(installer))}`,
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
    assert.equal(io.lines[0], 'usage: git-hooks (--enforcement | --commit-guard | --hook-checks) [--cwd <root>] [--apply]');
    assert.deepEqual(io.errors, []);
    const file = put(root, 'regular-file', FOREIGN);
    const invalid = [
      ['--bogus'], ['--enforcement', '--cwd'], ['--enforcement', '--cwd', file],
      [], ['--enforcement', '--commit-guard'], ['--help', '--enforcement'],
    ];
    const before = snapshot(root);
    for (const argv of invalid) assert.equal(invoke(argv, { ...io, cwd: root }), 2);
    assert.ok(io.errors.includes('pass exactly one of --enforcement, --commit-guard and --hook-checks'), io.errors.join('\n'));
    assert.equal(io.spawn.mock.callCount(), 0);
    assert.deepEqual(snapshot(root), before);
  });

  it('DEPLOYED_SCRIPTS equals the manifest\'s deployed entries, no suite, support or skill-home file among them, re-exported with INSTALLER_REL from node-evidence', async () => {
    assert.equal(need('INSTALLER_REL'), KIT_INSTALLER);
    assert.equal('BUNDLED_SCRIPT_NAMES' in leaf, false, 'BUNDLED_SCRIPT_NAMES retires');
    assert.equal(need('SCRIPTS_REL'), 'scripts');
    const family = (await import('../references/scripts/family.mjs')).readFamily(BUNDLE);
    const list = need('DEPLOYED_SCRIPTS');
    assert.ok(Object.isFrozen(list));
    assert.deepEqual(list.map(({ path }) => path), family.filter(({ role }) => role === 'deployed').map(({ path }) => path));
    for (const { path, role } of family.filter(({ role }) => role !== 'deployed')) assert.equal(list.some((entry) => entry.path === path), false, `${role} ${path}`);
    const evidence = await import('./node-evidence.mjs');
    assert.deepEqual([list === evidence.DEPLOYED_SCRIPTS, need('INSTALLER_REL') === evidence.INSTALLER_REL], [true, true]);
  });

  it('maps the project installer exit 7 to exit 1 with its original status named', (t) => {
    const { root, io } = makeProject(t);
    put(root, KIT_INSTALLER, 'process.exit(7);\n');
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

describe('spec:init-project/S52 commit-guard verifies the installed hook under one env', () => {
  const placeInstaller = (root, state, body) => put(root, KIT_INSTALLER, state === 'absent' || state === 'no-hooks-dir'
    ? 'process.exit(0);\n' : [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "import { join } from 'node:path';",
      "const hooks = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', env: process.env });",
      "const hook = join(hooks.stdout.trim(), 'pre-commit');",
      "mkdirSync(hooks.stdout.trim(), { recursive: true });",
      state === 'directory' ? 'mkdirSync(hook);' : `writeFileSync(hook, ${JSON.stringify(body)});`,
    ].join('\n'));
  for (const [state, code] of [
    ['unarmed', 1], ['absent', 1], ['directory', 1], ['unmanaged', 1], ['armed', 0],
    ['bundled', 0], ['no-hooks-dir', 0], ['custom-hooks', 1], ['enforcement', 0], ['dry-run', 0],
  ]) it(`${state}: returns ${code} and preserves the installer's result`, (t) => {
    const { root, io } = makeProject(t);
    if (state === 'custom-hooks') Object.assign(io.env, {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(root, 'custom-hooks'),
    });
    if (state === 'no-hooks-dir') {
      io.env.GIT_DIR = join(root, 'missing-git-dir');
      assert.equal(need('resolveGitHooksPath')(root, io.env), null);
    }
    const body = state === 'unmanaged' ? UNMANAGED : '#!/bin/sh\n# installed by:install-git-hooks.mjs\n'
      + (state === 'armed' ? `node "${join(TOOLS, 'commit-guard.mjs')}" --check\n` : '');
    if (state === 'bundled') put(root, KIT_INSTALLER, readBundle('git-hooks/install-git-hooks.mjs'));
    else placeInstaller(root, state, body);
    const outsideGit = () => snapshot(root).filter(({ name }) => name !== '.git');
    const before = outsideGit();
    if (state !== 'enforcement') io.writeFile = t.mock.fn(() => assert.fail('commit-guard must write nothing'));
    const flags = state === 'dry-run' ? [] : ['--apply'];
    assert.equal(invoke([...flags, state === 'enforcement' ? '--enforcement' : '--commit-guard'], io), code);
    const hook = join(root, state === 'custom-hooks' ? 'custom-hooks' : '.git/hooks', 'pre-commit');
    const expected = state === 'directory' ? `${hook} is unreadable (EISDIR) after the installer exited 0`
      : `${hook} carries no commit-guard line after the installer exited 0 — ${ROUTE}`;
    assert.deepEqual(io.errors, code === 1 ? [expected] : []);
    if (state !== 'enforcement') {
      assert.deepEqual(outsideGit().filter(({ name }) => name !== 'custom-hooks'), before);
      assert.equal(io.writeFile.mock.callCount(), 0);
    }
    assert.equal(io.spawn.mock.callCount(), state === 'dry-run' ? 0 : 1);
    if (state !== 'dry-run') assert.equal(io.spawn.mock.calls[0].arguments[1].env, io.env);
    if (state === 'directory') assert.ok(lstatSync(hook).isDirectory());
    else if (['absent', 'no-hooks-dir', 'dry-run'].includes(state)) assert.equal(existsSync(hook), false);
    else if (state !== 'bundled') assert.deepEqual(readFileSync(hook), Buffer.from(body));
    const result = need('readPreCommitState')(root, { env: io.env });
    const expectedState = state === 'no-hooks-dir' ? state : state === 'directory' ? 'unreadable'
      : ['absent', 'dry-run'].includes(state) ? 'absent' : state === 'unmanaged' ? state : 'managed';
    assert.equal(result.state, expectedState);
    assert.equal(result.armed, ['armed', 'bundled'].includes(state));
    if (state === 'armed') assert.ok(need('canonicalGuardLineRe')().test(body));
  });
  it('owns the four hook facts once, re-exports identical objects and has no guard import', async () => {
    const names = ['readPreCommitState', 'canonicalGuardLineRe', 'INSTALLER_MARKER_RE', 'resolveGitHooksPath'];
    const source = readFileSync(join(TOOLS, 'git-hooks.mjs'), 'utf8');
    assert.doesNotMatch(source, /\b(?:import|export)\b[^;]*['"]\.\/commit-guard\.mjs['"]/u);
    const facades = await Promise.all(['./recommendations.mjs', './commit-guard.mjs'].map((path) => import(path)));
    for (const name of names) {
      const declarations = readdirSync(TOOLS).filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
        .filter((file) => new RegExp(`\\bconst\\s+${name}\\s*=`, 'u').test(readFileSync(join(TOOLS, file), 'utf8')));
      assert.deepEqual(declarations, ['git-hooks.mjs']);
      assert.match(source, new RegExp(`export const ${name}\\b`, 'u'));
      for (const facade of facades) assert.equal(facade[name], need(name));
    }
    assert.equal(need('resolveGitHooksPath').length, 1);
  });
  it('exports UPGRADE_ROUTE as the literal route: the upgrade, then apply this item again', () => {
    assert.equal(need('UPGRADE_ROUTE'), ROUTE);
    assert.ok(ROUTE.includes('/agent-workflow-kit upgrade') && ROUTE.endsWith('then apply this item again'), ROUTE);
    assert.doesNotMatch(ROUTE, /\b(?:custom|prior|classify)\b/u);
  });
});

const [PRIOR, BUNDLED] = [readFileSync(join(TOOLS, '..', 'test/fixtures/script-priors/4.0.0/install-git-hooks.mjs.txt')), readBundle('git-hooks/install-git-hooks.mjs')];
const [RULES_CLI, SIZE_CLI] = [join(TOOLS, 'project-rules', 'rules-cli.mjs'), join(TOOLS, 'source-size-check.mjs')];
const BOTH = ['--rules-check', RULES_CLI, '--layout-check', SIZE_CLI];
const roleLine = (path, role) => `node "${path}" --check # ${role}-check`;
const [RULES_ON, LAYOUT_ON, RULES_ELSEWHERE, LAYOUT_ELSEWHERE] = [[RULES_CLI, 'rules'], [SIZE_CLI, 'layout'], ['/elsewhere/rules-cli.mjs', 'rules'], ['/elsewhere/source-size-check.mjs', 'layout']].map((pair) => roleLine(...pair));
const managed = (...lines) => ['#!/bin/sh', '# fixture:install-git-hooks.mjs', ...lines, ''].join('\n');
const THEME_FILES = ((body) => ({ ...Object.fromEntries(THEMES.flatMap(({ name }) => [themePaths(name).kit, themePaths(name).effective]).map((rel) => [rel, body])), [themePaths(THEMES[0].name).record]: JSON.stringify({ schema: 1, themes: Object.fromEntries(THEMES.map(({ name }) => [name, { kit: sha(body), local: 'absent', effective: sha(body) }])) }) }))('# A rules theme\n');
const deploy = (t, { installer = PRIOR, rules = true, hook, at = KIT_INSTALLER } = {}) => {
  const { root, io } = makeProject(t);
  for (const [rel, bytes] of Object.entries(rules ? THEME_FILES : { 'docs/ai/README.md': '' })) put(root, rel, bytes);
  if (installer !== null) (installer === 'dir' ? mkdirSync(join(root, at), { recursive: true }) : put(root, at, installer));
  if (hook !== undefined) put(root, '.git/hooks/pre-commit', hook, { mode: 0o755 });
  return { root, io, hookPath: join(root, '.git', 'hooks', 'pre-commit') };
};
const runsLine = (flags, bytes, at = INSTALLER) => `runs: node ${at} ${flags.join(' ')} sha256:${sha(bytes)}`;

describe('spec:init-project/S60 the --hook-checks dry run by proof on a temp git project', () => {
  const current = () => readBundle('git-hooks/install-git-hooks.mjs');
  const kitRuns = (flags, bytes) => runsLine(flags, bytes, KIT_INSTALLER);
  for (const [name, opts, code, expected] of [
    ['a prior installer under two armable unarmed lines', {}, 0, () => [kitRuns(BOTH, PRIOR)]],
    ['a current installer', { installer: 'current' }, 0, () => [kitRuns(BOTH, current())]],
    ['a custom installer', { installer: FOREIGN }, 0, () => [kitRuns(BOTH, FOREIGN)]],
    ['an armed rules line and a layout line on another path', { installer: 'current', hook: managed(RULES_ON, LAYOUT_ELSEWHERE) }, 0, () => [kitRuns(BOTH.slice(2), current())]],
    ['a rules line on another path and an armed layout line', { installer: 'current', hook: managed(RULES_ELSEWHERE, LAYOUT_ON) }, 0, () => [kitRuns(BOTH.slice(0, 2), current())]],
    ['no rules theme and an armed layout line', { rules: false, hook: managed(LAYOUT_ON) }, 3, () => [`nothing to plan — the rules-check line: not armable (${THEMES.map(({ name }) => `${name}: absent`).join(', ')}); the layout-check line: armed`]],
    ['both lines armed', { hook: managed(RULES_ON, LAYOUT_ON) }, 3, () => ['nothing to plan — the rules-check line: armed; the layout-check line: armed']],
    ['an absent installer', { installer: null }, 3, (root) => [`${join(root, KIT_INSTALLER)} is absent — nothing here places the hook installer`]],
    ['an installer that is a directory', { installer: 'dir' }, 3, (root) => [`${join(root, KIT_INSTALLER)} is not a regular file`]],
    ['a scripts/ that is a link', { installer: null, link: true }, 3, (root) => [`${join(root, 'scripts')} is not a plain directory`]],
    ['a kit tools path holding $', { toolsDir: '/kit$x/tools' }, 3, () => ['the kit\'s tools path /kit$x/tools carries ", $, a backtick, a backslash, CR or LF — a hook line would not run the file it names']],
  ]) it(`${name}: exit ${code} with its lines, writing nothing`, (t) => {
    const { root, io } = deploy(t, { ...opts, at: KIT_INSTALLER, installer: opts.installer === 'current' ? current() : opts.installer });
    if (opts.link) symlinkSync(mkdtempSync(join(root, 'real-')), join(root, 'scripts'));
    const before = snapshot(root);
    assert.deepEqual([invoke(['--hook-checks'], { ...io, toolsDir: opts.toolsDir ?? TOOLS }), code === 0 ? io.lines : io.errors, snapshot(root), io.spawn.mock.callCount()], [code, expected(root), before, 0]);
  });
});

describe('spec:init-project/S61 the --apply --hook-checks by proof', () => {
  const route = (hook) => [`${hook} carries no rules-check line after the installer exited 0 — ${ROUTE}`];
  const writes = (text, status) => (hook) => (put(dirname(hook), 'pre-commit', text), { status });
  for (const [name, opts, act, code, errors] of [
    ['a current installer arms both lines', { installer: BUNDLED }, 'real', 0, () => []],
    ['a prior installer runs as it stands', {}, 'real', 1, route],
    ['a non-zero exit over an untouched hook', { hook: managed() }, () => ({ status: 1 }), 1, () => ['installer exited 1']],
    ['an exit 0 arming nothing over an absent hook', {}, () => ({ status: 0 }), 1, route],
    ['a non-zero exit after the hook was written', {}, writes(managed(), 1), 1, () => ['installer exited 1']],
    ['an unreadable hook after exit 0', {}, (hook) => (mkdirSync(hook, { recursive: true }), { status: 0 }), 1, (hook) => [`${hook} is unreadable (EISDIR) after the installer exited 0`]],
    ['a custom installer leaving a same-role line on another path', { installer: FOREIGN }, writes(managed(RULES_ELSEWHERE, RULES_ON, LAYOUT_ON), 0), 1, (hook) => [`${hook} still carries a rules-check line on a path other than this kit's after the installer exited 0`]],
    ['a no-hooks-dir answer', { noHooks: true }, 'real', 0, () => []],
  ]) it(`${name}: exit ${code}, writing and restoring nothing`, (t) => {
    const { root, io, hookPath } = deploy(t, opts);
    const [plan, env, seen, lines] = [need('planGitHooks')({ root, variant: 'hook-checks' }), opts.noHooks ? { ...io.env, GIT_DIR: join(root, 'missing') } : io.env, [], []];
    const spawn = t.mock.fn((argv, options) => (seen.push(readFileSync(argv[1])), act === 'real' ? io.spawn(argv, options) : act(hookPath)));
    const [replaceFile, writeFile] = ['replaceFile', 'writeFile'].map((seam) => () => assert.fail(`hook-checks must not call ${seam}`));
    assert.equal(need('applyGitHooks')(plan, { env, spawn, error: (line) => lines.push(line), replaceFile, writeFile }), code);
    assert.deepEqual([lines, seen, readFileSync(join(root, KIT_INSTALLER)), spawn.mock.calls.map(({ arguments: [argv, options] }) => [argv, options.cwd, options.env])],
      [errors(hookPath), [opts.installer ?? PRIOR], opts.installer ?? PRIOR, [[['node', join(root, KIT_INSTALLER), ...BOTH], root, env]]]);
    if (code === 0) assert.deepEqual(['state', 'rulesArmed', 'layoutArmed'].map((key) => need('readPreCommitState')(root, { env })[key]), opts.noHooks ? ['no-hooks-dir', false, false] : ['managed', true, true]);
  });
  it('readPreCommitState answers exactly its fields in every state, arming by the canonical lines and flagging a foreign one', (t) => {
    const dir = makeTemp(t);
    const read = (hook, deps) => (hook === undefined || put(dir, 'pre-commit', hook), need('readPreCommitState')(dir, { gitHooksPath: () => dir, ...deps }));
    const [off, WIN_RULES] = [{ armed: false, rulesArmed: false, rulesForeign: false, layoutArmed: false, layoutForeign: false }, roleLine('C:/kit/project-rules/rules-cli.mjs', 'rules')];
    for (const [hook, deps, expected] of [
      [undefined, { gitHooksPath: () => null }, { state: 'no-hooks-dir' }], [undefined, {}, { state: 'absent' }],
      [managed(), { readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }, { state: 'unreadable', code: 'EACCES', path: join(dir, 'pre-commit') }],
      [managed(`node "${join(TOOLS, 'commit-guard.mjs')}" --check`, RULES_ON, LAYOUT_ON), {}, { state: 'managed', armed: true, rulesArmed: true, layoutArmed: true }],
      [managed(`# ${RULES_ON}`, `${LAYOUT_ON} `, `${RULES_ON} # no`), {}, { state: 'managed' }],
      [managed(RULES_ELSEWHERE, LAYOUT_ELSEWHERE), {}, { state: 'managed', rulesForeign: true, layoutForeign: true }],
      [`#!/bin/sh\n${RULES_ON}\n${RULES_ELSEWHERE}\n`, {}, { state: 'unmanaged', rulesArmed: true, rulesForeign: true }],
      [managed(WIN_RULES), { toolsDir: 'C:\\kit', platform: 'win32' }, { state: 'managed', rulesArmed: true }],
      [managed(WIN_RULES), { toolsDir: 'C:\\kit', platform: 'linux' }, { state: 'managed', rulesForeign: true }],
    ]) assert.deepEqual(read(hook, deps), { ...off, ...expected }, hook);
    assert.ok([need('canonicalRulesLineRe')().test(RULES_ON), need('canonicalLayoutLineRe')().test(LAYOUT_ON), need('canonicalRulesLineRe')('C:\\kit', 'win32').test(WIN_RULES)].every(Boolean));
  });
});
