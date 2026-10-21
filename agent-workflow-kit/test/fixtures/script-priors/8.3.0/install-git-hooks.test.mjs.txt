// install-git-hooks.test.mjs — the pre-commit installer on a deployed copy: the hooks path comes from git
// plumbing (a linked worktree resolves ITS OWN hooks path); the guard, rules-check and layout-check lines
// are carried by role, fail closed on a duplicate and refuse a bad flag value, writing nothing. Every child
// runs with each inherited GIT_* variable stripped, so a hook's environment never leaks in.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_SRC = join(HERE, 'install-git-hooks.mjs');
const MALFORMED_PACKAGE_JSON = '{ not json';
const [NAMED_PACKAGE_JSON, NAMED_FIXTURE] = ['{"name":"named-fixture"}', 'named-fixture'];
const WIN32 = ['--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})'];
const BACKSLASH = String.fromCharCode(92);
const SHELL_ACTIVE = [34, 36, 96, 92, 13, 10].map((code) => String.fromCharCode(code)).filter((ch) => process.platform !== 'win32' || ch !== BACKSLASH);
const shown = (path) => (process.platform === 'win32' ? path.replaceAll(BACKSLASH, '/') : path);

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));
const envAt = (home) => ({
  ...BASE_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@e', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@e',
});

// A child that never started or was killed has no exit status to judge — it fails the cell outright.
const spawnChecked = (command, args, cwd) => {
  const r = spawnSync(command, args, { cwd, env: envAt(cwd), encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.signal !== null) throw new Error(`${command} was killed by ${r.signal}`);
  return r;
};
const succeeds = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const git = (cwd, ...args) => succeeds(spawnChecked('git', args, cwd));

// The installer anchors ROOT at <its dir>/.. — deploy it into a fixture's scripts/ like a consumer.
const mkProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-hooks-')));
  const g = (...a) => git(root, ...a);
  g('init', '-q');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(INSTALLER_SRC, join(root, 'scripts', 'install-git-hooks.mjs'));
  writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  for (const args of [['add', '-A'], ['commit', '-qm', 'base']]) g(...args);
  return { root, g };
};
const inProject = (cell) => () => { const fx = mkProject(); try { cell(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); } };

const runInstaller = (root, args = [], pre = []) =>
  spawnChecked(process.execPath, [...pre, join(root, 'scripts', 'install-git-hooks.mjs'), ...args], root);
const installs = (...a) => succeeds(runInstaller(...a));

const hooksPathOf = (root) => resolve(root, git(root, 'rev-parse', '--git-path', 'hooks').stdout.trim());
const markerFor = (name) => `# ${name}:install-git-hooks.mjs`;
const readHook = (root) => readFileSync(join(hooksPathOf(root), 'pre-commit'), 'utf8');
const stub = (root, rel) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), '// a stand-in tool\n'), join(root, rel));

// The hook the 4.0.0-8.2.1 installer body writes with no guard: the six docs and scripts lines.
const plainHook = (root) => `#!/usr/bin/env bash
${markerFor(basename(root))}
# Auto-installed by scripts/install-git-hooks.mjs (run it from "prepare" or by hand).
# Runs the docs cap-validator + index-freshness gate + rotation-freshness checks
# + the scripts/ test suite before every commit, so files cannot drift over their
# declared maxLines, the auto-generated index.md cannot silently go stale, stale
# archive entries never reach a commit, and regressions to the scripts are caught.
set -e
node scripts/check-docs-size.mjs
node scripts/check-docs-size.mjs --check-index
node scripts/archive-changelog.mjs --check
node scripts/archive-issues.mjs --check
node scripts/archive-decisions.mjs --check
node --test scripts/*.test.mjs
`;
const line = (path, role) => `node "${role ? shown(path) : path}" --check${role ? ` # ${role}` : ''}\n`;

describe('install-git-hooks — beside no package.json, or a malformed one, the marker names the directory basename', () => {
  it('no package.json, then a MALFORMED one — the marker names the directory basename', inProject(({ root }) => {
    const expected = markerFor(basename(root));
    installs(root);
    assert.ok(readHook(root).split('\n').includes(expected));
    writeFileSync(join(root, 'package.json'), MALFORMED_PACKAGE_JSON);
    installs(root);
    assert.ok(readHook(root).split('\n').includes(expected));
  }));

  it('a named package.json wins — the marker carries its name', inProject(({ root }) => {
    writeFileSync(join(root, 'package.json'), NAMED_PACKAGE_JSON);
    installs(root);
    assert.ok(readHook(root).split('\n').includes(markerFor(NAMED_FIXTURE)));
  }));
});

describe('install-git-hooks — the hooks path comes from git plumbing (C7)', () => {
  it('a normal repo installs at the git-path hooks location', inProject(({ root }) => {
    installs(root);
    assert.ok(existsSync(join(hooksPathOf(root), 'pre-commit')), 'the hook lands where git says hooks live');
  }));

  it('a LINKED WORKTREE installs at ITS OWN git-path hooks (never a hardcoded <worktree>/.git/hooks)', inProject(({ root, g }) => {
    const wt = join(root, '..', `wt-${Date.now() % 1e6}`);
    g('worktree', 'add', '-q', wt);
    try {
      mkdirSync(join(wt, 'scripts'), { recursive: true });
      cpSync(INSTALLER_SRC, join(wt, 'scripts', 'install-git-hooks.mjs'));
      installs(wt);
      const expected = join(hooksPathOf(wt), 'pre-commit');
      assert.ok(existsSync(expected), `the worktree hook lands at git's own answer (${expected})`);
      assert.ok(!existsSync(join(wt, '.git', 'hooks', 'pre-commit')), 'never a literal <worktree>/.git/hooks (a worktree .git is a FILE)');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }));
});

describe('install-git-hooks — the commit-guard arm persists (C8)', () => {
  it('an armed guard SURVIVES a later flagless re-run (carried forward from the managed hook)', inProject(({ root }) => {
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    assert.match(readHook(root), /guard\.mjs" --check/, 'the guard line is written armed');
    assert.equal(runInstaller(root).status, 0, 'the flagless canonical re-run succeeds');
    assert.match(readHook(root), /guard\.mjs" --check/, 'the armed guard line survives a flagless re-run');
  }));

  it('--no-commit-guard is the ONLY consented disable; combining both flags is a usage error', inProject(({ root }) => {
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    assert.equal(runInstaller(root, ['--no-commit-guard']).status, 0);
    assert.doesNotMatch(readHook(root), /" --check$/m, 'the guard line is removed on the explicit disable');
    const both = runInstaller(root, ['--commit-guard', 'guard.mjs', '--no-commit-guard']);
    assert.equal(both.status, 2, 'both flags together are a usage error, never an order-dependent pick');
  }));

  it('a DUPLICATED/malformed guard line in the managed hook fails CLOSED on a flagless re-run', inProject(({ root }) => {
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    const armed = readHook(root);
    const guardLine = armed.split('\n').find((l) => /" --check$/.test(l));
    writeFileSync(join(hooksPathOf(root), 'pre-commit'), `${armed}${guardLine}\n`); // duplicate the guard line
    const r = runInstaller(root);
    assert.equal(r.status, 1, 'two guard lines are ambiguous — fail closed, never guess');
    assert.match(r.stderr, /guard/i);
  }));
});

describe('spec:init-project/S58 install-git-hooks — the rules-check and layout-check lines on a deployed copy', () => {
  it('each flag writes its resolved path and role comment, ordered docs, rules, layout, guard; a flagless re-run keeps all three; --commit-guard replaces and --no-commit-guard drops the guard alone', inProject(({ root }) => {
    const [rules, layout, guard, guard2] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs', 'guard.mjs', 'g2/guard.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--commit-guard', 'guard.mjs']);
    installs(root, ['--layout-check', 'tools/source-size-check.mjs']);
    installs(root, ['--rules-check', rules]);
    const armed = plainHook(root) + line(rules, 'rules-check') + line(layout, 'layout-check');
    assert.equal(readHook(root), armed + line(guard), 'each arming run carried the other armed lines');
    assert.match(installs(root).stdout, /already up to date/, 'a flagless re-run keeps all three');
    assert.equal(readHook(root), armed + line(guard));
    installs(root, ['--commit-guard', guard2]);
    assert.equal(readHook(root), armed + line(guard2), '--commit-guard replaces the guard line alone');
    installs(root, ['--no-commit-guard']);
    assert.equal(readHook(root), armed, '--no-commit-guard drops the guard line alone');
  }));

  it('a legacy guard line whose file name is rules-cli.mjs keeps the guard role beside a rules line', inProject(({ root }) => {
    const [legacy, rules] = ['legacy/rules-cli.mjs', 'tools/rules-cli.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--commit-guard', legacy]);
    installs(root, ['--rules-check', rules]);
    const expected = plainHook(root) + line(rules, 'rules-check') + line(legacy);
    assert.equal(readHook(root), expected);
    installs(root);
    assert.equal(readHook(root), expected, 'the flagless re-run keeps the legacy line as the guard');
  }));

  it('two lines of one role exit 1 naming that role, the hook unchanged', inProject(({ root }) => {
    installs(root, ['--rules-check', stub(root, 'tools/rules-cli.mjs'), '--layout-check', stub(root, 'tools/source-size-check.mjs')]);
    const armed = readHook(root);
    for (const role of ['rules-check', 'layout-check']) {
      const roleLine = armed.split('\n').find((l) => l.endsWith(` --check # ${role}`));
      assert.ok(roleLine, `the ${role} line is armed`);
      writeFileSync(join(hooksPathOf(root), 'pre-commit'), `${armed}${roleLine}\n`);
      const r = runInstaller(root);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`carries 2 ${role} lines`));
      assert.equal(readHook(root), `${armed}${roleLine}\n`);
    }
  }));

  it('over a hook with no rules or layout line, a flagless and a --commit-guard run write the 4.0.0-8.2.1 bytes', inProject(({ root }) => {
    installs(root);
    assert.equal(readHook(root), plainHook(root));
    installs(root, ['--commit-guard', 'guard.mjs']);
    assert.equal(readHook(root), plainHook(root) + line(join(root, 'guard.mjs')));
  }));

  it('a wrong file name, a shell-active path or a missing value exits 2, a missing file exits 1, each writing nothing', inProject(({ root }) => {
    const [rules, layout] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--commit-guard', 'guard.mjs']);
    const before = readHook(root);
    const cases = [
      [['--rules-check', layout], 2, /--rules-check takes a path to rules-cli\.mjs/],
      [['--layout-check', rules], 2, /--layout-check takes a path to source-size-check\.mjs/],
      ...SHELL_ACTIVE.flatMap((ch, at) => [
        [['--rules-check', join(root, `r${at}${ch}x`, 'rules-cli.mjs')], 2, /a backslash, CR or LF/],
        [['--layout-check', join(root, `l${at}${ch}x`, 'source-size-check.mjs')], 2, /a backslash, CR or LF/],
      ]),
      [['--rules-check', join(root, 'nowhere', 'rules-cli.mjs')], 1, /does not exist/],
      [['--layout-check', join(root, 'nowhere', 'source-size-check.mjs')], 1, /does not exist/],
      [['--rules-check'], 2, /--rules-check needs a path/],
      [['--layout-check'], 2, /--layout-check needs a path/],
    ];
    for (const [args, status, message] of cases) {
      const r = runInstaller(root, args);
      assert.equal(r.status, status, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.match(r.stderr, message);
      assert.equal(readHook(root), before, `${JSON.stringify(args)} wrote nothing`);
    }
  }));

  it('an ordinary win32 path, its separators made /, arms and a flagless re-run carries it; on posix it is the backslash refusal', inProject(({ root }) => {
    installs(root);
    const given = `${root}/a${BACKSLASH}b/rules-cli.mjs`;
    const armedAt = stub(root, 'a/b/rules-cli.mjs');
    if (process.platform !== 'win32') { // there the backslash is refused, writing nothing
      const posix = runInstaller(root, ['--rules-check', given]);
      assert.deepEqual([posix.status, /a backslash, CR or LF/.test(posix.stderr), readHook(root)], [2, true, plainHook(root)], posix.stderr);
    }
    installs(root, ['--rules-check', given], WIN32);
    assert.equal(readHook(root), plainHook(root) + line(armedAt, 'rules-check'));
    assert.match(installs(root).stdout, /already up to date/, 'the flagless re-run recognises the win32-armed line');
    assert.equal(readHook(root), plainHook(root) + line(armedAt, 'rules-check'));
  }));
});
