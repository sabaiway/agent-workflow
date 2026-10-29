// install-git-hooks-repo-exec.test.mjs — the SIBLING installer executed IN PLACE (no deploy
// copy): GIT_DIR pins every git answer to a fixture repo, so the run exercises this tree's own
// file — the D3(d) changed-line check reads real executions of the shipped bytes, while the
// deploy-copy suite (install-git-hooks.test.mjs) keeps the consumer-shaped behavior pins. Every
// branch of the installer runs from here: fresh install, the guard arm/carry/disable/conflict
// lanes, the rules-check and layout-check arm/carry/duplicate/refusal lanes (win32 included), the
// unmanaged refusal, a foreign-named marker rewritten name-free, the up-to-date short-circuit, the
// not-a-git-checkout skip, the rejected-run catch, an import with an unresolvable entry, and the S71 real-commit lane (real `git commit`
// through the written hook over stand-ins at their deployed paths). Every child runs with each
// inherited GIT_* variable stripped, so a hook's environment never leaks in.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, 'install-git-hooks.mjs');
const WIN32 = ['--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})'];
const BACKSLASH = String.fromCharCode(92);
const shown = (path) => (process.platform === 'win32' ? path.replaceAll(BACKSLASH, '/') : path);

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));
const envAt = (home, extra = {}) => ({
  ...BASE_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', ...extra,
});

// A child that never started or was killed has no exit status to judge — it fails the cell outright.
const spawnChecked = (command, args, options) => {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (r.error) throw r.error;
  if (r.signal !== null) throw new Error(`${command} was killed by ${r.signal}`);
  return r;
};

const mkRepo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-repo-exec-')));
  assert.equal(spawnChecked('git', ['init', '-q'], { cwd: root, env: envAt(root) }).status, 0);
  writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
  return { root, gitDir: join(root, '.git') };
};

// The installer anchors its git queries at its OWN parent dir — GIT_DIR overrides that anchor to
// the fixture repo, so running the in-place file NEVER touches this tree's hooks.
const runAt = (gitDir, args = [], pre = []) =>
  spawnChecked(process.execPath, [...pre, INSTALLER, ...args], { env: envAt(dirname(gitDir), { GIT_DIR: gitDir }) });

const hookOf = ({ gitDir }) => readFileSync(join(gitDir, 'hooks', 'pre-commit'), 'utf8');
const stub = (root, rel) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), '// a stand-in tool\n'), join(root, rel));

describe('install-git-hooks — the in-place installer under a GIT_DIR-pinned fixture', () => {
  it('installs the managed hook, is idempotent, and refuses an UNMANAGED hook', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir).status, 0);
    assert.match(hookOf(fx), /:install-git-hooks\.mjs/, 'the managed marker is written');
    const again = runAt(fx.gitDir);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already up to date/);
    writeFileSync(join(fx.gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const refused = runAt(fx.gitDir);
    assert.equal(refused.status, 1, 'an unmanaged hook is never overwritten');
    assert.match(refused.stderr, /Refusing to overwrite/);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('the guard lanes: arm (absolute path) → carry on flagless re-run → consented disable', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs')]).status, 0);
    assert.match(hookOf(fx), /guard\.mjs" --check/);
    assert.equal(runAt(fx.gitDir).status, 0, 'the flagless re-run keeps the armed line');
    assert.match(hookOf(fx), /guard\.mjs" --check/);
    assert.equal(runAt(fx.gitDir, ['--no-commit-guard']).status, 0);
    assert.doesNotMatch(hookOf(fx), /" --check$/m);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('the guard refusals: both flags (usage), a bare flag (usage), a missing path, a duplicated line', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs'), '--no-commit-guard']).status, 2);
    assert.equal(runAt(fx.gitDir, ['--commit-guard']).status, 2, '--commit-guard without a path is a usage error');
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'no-such.mjs')]).status, 1, 'a nonexistent guard path refuses');
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs')]).status, 0);
    const armed = hookOf(fx);
    const guardLine = armed.split('\n').find((l) => /" --check$/.test(l));
    writeFileSync(join(fx.gitDir, 'hooks', 'pre-commit'), `${armed}${guardLine}\n`);
    const dup = runAt(fx.gitDir);
    assert.equal(dup.status, 1, 'two guard lines are ambiguous — fail closed');
    assert.match(dup.stderr, /commit-guard --check lines/);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('the role lanes: arm both beside the guard in order → carry → duplicate fails closed; each refusal writes nothing', () => {
    const fx = mkRepo();
    const [rules, layout, guard] = ['t/rules-cli.mjs', 't/source-size-check.mjs', 'guard.mjs'].map((rel) => stub(fx.root, rel));
    const ok = (args, pre) => { const r = runAt(fx.gitDir, args, pre); assert.equal(r.status, 0, r.stderr); return r; };
    ok(['--commit-guard', guard, '--layout-check', layout, '--rules-check', rules]);
    const tail = `node "${shown(rules)}" --check # rules-check\nnode "${shown(layout)}" --check # layout-check\nnode "${guard}" --check\n`;
    assert.ok(hookOf(fx).endsWith(`node scripts/agent-workflow/archives/archive-decisions.mjs --check\n${tail}`), hookOf(fx));
    assert.doesNotMatch(hookOf(fx), /^node --test/m, 'the hook runs no suite');
    assert.match(ok([]).stdout, /already up to date/, 'the flagless re-run carries all three');
    const before = hookOf(fx);
    const cases = [
      [['--rules-check', layout], 2], [['--layout-check', rules], 2], [['--rules-check'], 2], [['--layout-check'], 2],
      [['--layout-check', join(fx.root, 'a$b', 'source-size-check.mjs')], 2], [['--rules-check', join(fx.root, 'no', 'rules-cli.mjs')], 1],
      ...(process.platform === 'win32' ? [] : [[['--rules-check', `${fx.root}/w${BACKSLASH}x/rules-cli.mjs`], 2]]),
    ];
    for (const [args, status] of cases) {
      const r = runAt(fx.gitDir, args);
      assert.equal(r.status, status, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.equal(hookOf(fx), before, `${JSON.stringify(args)} wrote nothing`);
    }
    const winArmed = stub(fx.root, 'w/x/rules-cli.mjs');
    ok(['--rules-check', `${fx.root}/w${BACKSLASH}x/rules-cli.mjs`], WIN32);
    assert.ok(hookOf(fx).includes(`node "${shown(winArmed)}" --check # rules-check\n`), 'the win32 path arms with / separators');
    const winHook = hookOf(fx);
    writeFileSync(join(fx.gitDir, 'hooks', 'pre-commit'), `${winHook}node "${layout}" --check # layout-check\n`);
    const dup = runAt(fx.gitDir);
    assert.equal(dup.status, 1, dup.stderr);
    assert.match(dup.stderr, /carries 2 layout-check lines/);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('a hook carrying # <any name>:install-git-hooks.mjs, LF or CRLF, reads as managed and is rewritten name-free; a mid-line marker stays unmanaged (spec:script-family/S9)', () => {
    const fx = mkRepo();
    const at = join(fx.gitDir, 'hooks', 'pre-commit');
    mkdirSync(dirname(at), { recursive: true });
    for (const eol of ['\n', '\r\n']) {
      writeFileSync(at, ['#!/usr/bin/env bash', '# old-name:install-git-hooks.mjs', 'set -e', ''].join(eol));
      const r = runAt(fx.gitDir);
      assert.equal(r.status, 0, `${JSON.stringify(eol)}: ${r.stderr}`);
      assert.deepEqual(hookOf(fx).split('\n').filter((l) => l.endsWith(':install-git-hooks.mjs')), ['# agent-workflow:install-git-hooks.mjs'], hookOf(fx));
    }
    const kept = '#!/bin/sh\n# agent-workflow:install-git-hooks.mjs (kept by hand)\n';
    writeFileSync(at, kept);
    assert.equal(runAt(fx.gitDir).status, 1, 'no line ends with :install-git-hooks.mjs — unmanaged');
    assert.equal(hookOf(fx), kept, 'left as before');
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('a pre-commit path that cannot be read as a file rejects the run: the catch prints the error and exits 1', () => {
    const fx = mkRepo();
    mkdirSync(join(fx.gitDir, 'hooks', 'pre-commit'), { recursive: true });
    const r = runAt(fx.gitDir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /EISDIR/, 'the error itself is printed');
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('an import whose entry path cannot be resolved is no direct run: exit 0, nothing printed, no hook written', () => {
    const fx = mkRepo();
    const r = spawnChecked(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(INSTALLER).href)});`, join(fx.root, 'no', 'such', 'entry')],
      { env: envAt(fx.root, { GIT_DIR: fx.gitDir }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
    assert.equal(existsSync(join(fx.gitDir, 'hooks', 'pre-commit')), false);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('outside a git checkout the installer SKIPS loudly and writes nothing', () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'hooks-repo-exec-nogit-'));
    const r = runAt(join(nowhere, 'absent-git-dir'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipping \(not a git checkout\)/);
    assert.equal(existsSync(join(nowhere, 'absent-git-dir')), false, 'nothing was created');
    rmSync(nowhere, { recursive: true, force: true });
  });
});

// The commit lane also drops NODE_TEST_CONTEXT, so no child the hook runs inherits the outer runner's context.
const IDENTITY = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@e', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@e' };
const bareAt = (home, extra = {}) => { const { NODE_TEST_CONTEXT: _, ...env } = envAt(home, { ...IDENTITY, ...extra }); return env; };
const passes = (r) => (assert.equal(r.status, 0, r.stderr), r);

// Passing stand-ins for every script the hook runs, each at its deployed path in the kit folder; the docs checker,
// run right after the local line, records whether the marker existed. The marker and the record live in a sibling
// dir, outside the work tree.
const commitRepo = (root, side) => {
  const [marker, record, local] = [join(side, 'marker'), join(side, 'record'), join(root, 'scripts', 'pre-commit.local')];
  const kit = join(root, 'scripts', 'agent-workflow');
  const git = (...args) => spawnChecked('git', args, { cwd: root, env: bareAt(root) });
  for (const folder of ['docs-size', 'archives']) mkdirSync(join(kit, folder), { recursive: true });
  writeFileSync(join(kit, 'docs-size', 'check-docs-size.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
if (!process.argv.includes('--check-index')) writeFileSync(${JSON.stringify(record)}, String(existsSync(${JSON.stringify(marker)})));\n`);
  for (const name of ['archive-changelog', 'archive-issues', 'archive-decisions']) writeFileSync(join(kit, 'archives', `${name}.mjs`), 'process.exit(0);\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) passes(git(...args));
  passes(spawnChecked(process.execPath, [INSTALLER], { env: bareAt(root, { GIT_DIR: join(root, '.git') }) }));
  const head = () => git('rev-parse', 'HEAD').stdout.trim();
  const commit = (body) => {
    if (body !== undefined) { writeFileSync(local, body); chmodSync(local, 0o644); assert.equal(statSync(local).mode & 0o111, 0, 'the local file is not executable'); }
    writeFileSync(join(root, 'change.txt'), 'change\n');
    passes(git('add', 'change.txt'));
    return git('commit', '-qm', 'change');
  };
  return { marker, record, local, head, commit };
};
const inCommitRepo = (cell) => () => {
  const dirs = ['hooks-commit-', 'hooks-commit-side-'].map((prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix))));
  try { cell(commitRepo(...dirs)); } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
};

describe('spec:init-project/S71 the local hook file through real commits over stand-ins at their deployed paths', () => {
  it('a local file that writes a marker runs before the docs check, and the commit exits 0', { timeout: 120_000 }, inCommitRepo((fx) => {
    passes(fx.commit(`printf made > "${fx.marker}"\n`));
    assert.ok(existsSync(fx.marker), 'the local file ran: its marker appeared');
    assert.equal(readFileSync(fx.record, 'utf8'), 'true', 'the marker existed when check-docs-size.mjs ran');
  }));

  it('a local file that exits 1 stops the commit: non-zero, no new commit', { timeout: 120_000 }, inCommitRepo((fx) => {
    const before = fx.head();
    assert.notEqual(fx.commit('exit 1\n').status, 0, 'a local file exiting 1 stops the commit');
    assert.equal(fx.head(), before, 'no new commit');
    rmSync(fx.local);
    passes(fx.commit());
    assert.notEqual(fx.head(), before, 'with the local file gone the same commit lands: the stop was the local file\'s');
  }));

  it('with no local file the commit exits 0', { timeout: 120_000 }, inCommitRepo((fx) => {
    const before = fx.head();
    passes(fx.commit());
    assert.notEqual(fx.head(), before, 'the commit landed');
    assert.equal(readFileSync(fx.record, 'utf8'), 'false', 'the hook ran its stand-ins, with no marker');
  }));
});
