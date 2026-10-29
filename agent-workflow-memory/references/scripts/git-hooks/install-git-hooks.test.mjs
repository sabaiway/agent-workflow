// install-git-hooks.test.mjs — the pre-commit installer on a copy deployed in the kit folder: the hooks path
// comes from git plumbing (a linked worktree resolves ITS OWN hooks path); the marker names no project and any
// `<name>:install-git-hooks.mjs` line reads as managed; the hook runs the docs and archive checks through the
// stable kit command and no suite; the guard, rules-check and layout-check lines are carried by role, fail closed
// on a duplicate and refuse a bad flag value, writing nothing. Every child runs with each inherited GIT_*
// variable stripped, so a hook's environment never leaks in.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MAGIC_MARKER, isManaged } from './install-git-hooks.mjs';

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

// The installer takes its root three levels above its own folder — deploy it into a fixture's kit folder like a consumer.
const KIT_INSTALLER = join('scripts', 'agent-workflow', 'git-hooks', 'install-git-hooks.mjs');
const deploy = (root) => { mkdirSync(dirname(join(root, KIT_INSTALLER)), { recursive: true }); cpSync(INSTALLER_SRC, join(root, KIT_INSTALLER)); };
const mkProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-hooks-')));
  const g = (...a) => git(root, ...a);
  g('init', '-q');
  deploy(root);
  writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  for (const args of [['add', '-A'], ['commit', '-qm', 'base']]) g(...args);
  return { root, g };
};
const inProject = (cell) => () => { const fx = mkProject(); try { cell(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); } };

const runInstaller = (root, args = [], pre = []) =>
  spawnChecked(process.execPath, [...pre, join(root, KIT_INSTALLER), ...args], root);
const installs = (...a) => succeeds(runInstaller(...a));

const hooksPathOf = (root) => resolve(root, git(root, 'rev-parse', '--git-path', 'hooks').stdout.trim());
const markerFor = (name) => `# ${name}:install-git-hooks.mjs`;
const readHook = (root) => readFileSync(join(hooksPathOf(root), 'pre-commit'), 'utf8');
const stub = (root, rel) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), '// a stand-in tool\n'), join(root, rel));

const NAME_FREE = markerFor('agent-workflow');
const COMMAND = 'node scripts/agent-workflow/run.mjs';
const COMMAND_LINES = [`${COMMAND} docs-size`, `${COMMAND} docs-size --check-index`,
  ...['changelog', 'issues', 'decisions'].map((name) => `${COMMAND} archive-${name} --check`)];
const LOCAL_LINE = 'if [ -f scripts/pre-commit.local ]; then bash scripts/pre-commit.local; fi';
// The plain hook every write carries: the shebang, the name-free marker and `# ` header lines up to set -e (their
// wording is free, so they are read from the written hook); right after set -e one `# ` comment naming
// scripts/pre-commit.local (read the same way) and the exact local line; then the docs and archive lines through the
// stable kit command, and no suite line.
const localHook = (root) => {
  const lines = readHook(root).split('\n');
  const at = lines.indexOf('set -e');
  assert.ok(at > 1, `set -e follows the header, got ${JSON.stringify(lines)}`);
  const header = lines.slice(0, at);
  assert.deepEqual(header.slice(0, 2), ['#!/usr/bin/env bash', NAME_FREE], 'the shebang, then the name-free marker');
  assert.ok(header.slice(2).every((l) => l.startsWith('# ')), `only # comment lines up to set -e, got ${JSON.stringify(header)}`);
  const comment = lines[at + 1];
  assert.ok(comment?.startsWith('# ') && comment.includes('scripts/pre-commit.local'), `right after set -e a # comment names scripts/pre-commit.local, got ${JSON.stringify(comment)}`);
  assert.deepEqual(lines.filter((l) => l.includes('scripts/pre-commit.local')), [comment, LOCAL_LINE], 'the comment and the local line are the only lines naming scripts/pre-commit.local');
  assert.deepEqual(lines.slice(at + 3, at + 3 + COMMAND_LINES.length), COMMAND_LINES, 'the docs and archive lines through the kit command follow the local line');
  return [...header, 'set -e', comment, LOCAL_LINE, ...COMMAND_LINES, ''].join('\n');
};
// A claim that the hook or the installer runs the scripts' own tests.
const scriptTestsClaim = (text) => text.replace(/\s+/g, ' ').match(/scripts\/?`?\s+tests?\b|regressions to the scripts/i)?.[0] ?? null;
const hookText = (lines, eol) => lines.map((l) => `${l}${eol}`).join('');
const line = (path, role) => `node "${role ? shown(path) : path}" --check${role ? ` # ${role}` : ''}\n`;

describe('spec:script-family/S9 install-git-hooks — run from the kit folder: the name-free marker and the kit-command lines', () => {
  it('beside no package.json, a malformed one or a named one, the hook carries the name-free marker, the docs and archive lines through the kit command and no node --test line', inProject(({ root }) => {
    for (const pkg of [null, MALFORMED_PACKAGE_JSON, NAMED_PACKAGE_JSON]) {
      if (pkg !== null) writeFileSync(join(root, 'package.json'), pkg);
      installs(root);
      const lines = readHook(root).split('\n');
      for (const fixed of COMMAND_LINES) assert.ok(lines.includes(fixed), `${pkg}: the hook runs ${fixed}, got ${JSON.stringify(lines)}`);
      assert.deepEqual(lines.filter((l) => l.startsWith('node --test')), [], `${pkg}: the hook runs no suite`);
      assert.deepEqual(lines.filter((l) => l.endsWith(':install-git-hooks.mjs')), [NAME_FREE], `${pkg}: one marker line, naming no project`);
    }
  }));

  it('over a hook carrying # <any name>:install-git-hooks.mjs, with LF or CRLF line ends, it reads the hook as managed and rewrites its marker name-free', inProject(({ root }) => {
    mkdirSync(hooksPathOf(root), { recursive: true });
    for (const [name, eol] of [['old-project', '\n'], ['@scope/renamed root', '\r\n'], [NAMED_FIXTURE, '\r\n']]) {
      writeFileSync(join(hooksPathOf(root), 'pre-commit'), hookText(['#!/usr/bin/env bash', markerFor(name), 'set -e', 'node scripts/check-docs-size.mjs'], eol));
      const r = runInstaller(root);
      assert.equal(r.status, 0, `${JSON.stringify(markerFor(name) + eol)} reads as managed: ${r.stderr}`);
      assert.equal(readHook(root), localHook(root), 'the plain hook replaced it');
      assert.ok(!readHook(root).includes(name), `the marker no longer names ${name}`);
    }
  }));

  it('a hook with no line ending :install-git-hooks.mjs stays unmanaged: exit 1, left as before', inProject(({ root }) => {
    mkdirSync(hooksPathOf(root), { recursive: true });
    const unmanaged = [
      hookText(['#!/bin/sh', `${NAME_FREE} (kept by hand)`, 'exit 0'], '\n'),
      hookText(['#!/bin/sh', `${NAME_FREE}.bak`, 'exit 0'], '\r\n'),
      hookText(['#!/bin/sh', '# install-git-hooks.mjs', 'exit 0'], '\n'),
    ];
    for (const body of unmanaged) {
      writeFileSync(join(hooksPathOf(root), 'pre-commit'), body);
      const r = runInstaller(root);
      assert.equal(r.status, 1, `${JSON.stringify(body)} stays unmanaged: ${r.stdout}${r.stderr}`);
      assert.equal(readHook(root), body, `${JSON.stringify(body)} is left as before`);
    }
  }));

  it('the marker rule, imported: a hook is managed when a line, one trailing CR dropped, ends with :install-git-hooks.mjs', () => {
    assert.equal(MAGIC_MARKER, NAME_FREE);
    for (const hook of [`${NAME_FREE}\n`, `#!/bin/sh\r\n${markerFor('old')}\r\n`, `#!/bin/sh\n${markerFor('a b')}`]) assert.equal(isManaged(hook), true, JSON.stringify(hook));
    for (const hook of [`${NAME_FREE} (kept)\n`, `${NAME_FREE}\r\r\n`, '# install-git-hooks.mjs\n', '']) assert.equal(isManaged(hook), false, JSON.stringify(hook));
  });

  it('neither the installer\'s own header comment, its printed summary nor the hook\'s header comment claims scripts/ tests', inProject(({ root }) => {
    const source = readFileSync(INSTALLER_SRC, 'utf8').split('\n');
    const own = source.slice(1, source.findIndex((l, at) => at > 0 && !l.startsWith('//'))).join('\n');
    const summary = installs(root).stdout;
    const lines = readHook(root).split('\n');
    const hookHeader = lines.slice(1, lines.indexOf('set -e')).join('\n');
    for (const [where, text] of [['the installer header comment', own], ['the printed summary', summary], ['the hook header comment', hookHeader]]) {
      assert.equal(scriptTestsClaim(text), null, `${where} claims scripts/ tests`);
    }
  }));
});

// A header comment as one line of words: each line's comment mark dropped, so a phrase wrapped over two lines reads whole.
const wordsOf = (lines) => lines.map((l) => l.replace(/^(\/\/|#) ?/, '')).join(' ');

describe('spec:kit-command/S5 install-git-hooks — the hook names only the stable kit command', () => {
  it('the five command lines in order between the local line and the role and guard lines, none naming a module path, each name a KIT_COMMANDS key', async () => {
    const { KIT_COMMANDS } = await import('../run.mjs');
    inProject(({ root }) => {
      const [rules, guard] = ['tools/rules-cli.mjs', 'guard.mjs'].map((rel) => stub(root, rel));
      installs(root, ['--rules-check', rules, '--commit-guard', guard]);
      const lines = readHook(root).split('\n');
      assert.deepEqual(lines.slice(lines.indexOf(LOCAL_LINE) + 1).join('\n'), [...COMMAND_LINES, ''].join('\n') + line(rules, 'rules-check') + line(guard));
      assert.deepEqual(lines.filter((l) => /scripts\/agent-workflow\/(docs-size|archives)\//.test(l)), [], 'no line names a module path of docs-size or archives');
      const names = lines.flatMap((l) => l.match(/^node scripts\/agent-workflow\/run\.mjs (\S+)/)?.slice(1) ?? []);
      assert.deepEqual(names, ['docs-size', 'docs-size', 'archive-changelog', 'archive-issues', 'archive-decisions']);
      assert.deepEqual(names.filter((name) => !Object.hasOwn(KIT_COMMANDS, name)), [], 'every name the lines use is a key of KIT_COMMANDS');
    })();
  });

  it('the installer\'s own header comment and the hook\'s name node scripts/agent-workflow/run.mjs install-git-hooks; the installer imports nothing', async () => {
    const { KIT_COMMANDS } = await import('../run.mjs');
    assert.ok(Object.hasOwn(KIT_COMMANDS, 'install-git-hooks'));
    const source = readFileSync(INSTALLER_SRC, 'utf8');
    const own = source.split('\n').slice(1, source.split('\n').findIndex((l, at) => at > 0 && !l.startsWith('//')));
    let hookHeader = [];
    inProject(({ root }) => { installs(root); const lines = readHook(root).split('\n'); hookHeader = lines.slice(1, lines.indexOf('set -e')); })();
    for (const [where, text] of [['the installer header comment', wordsOf(own)], ['the hook header comment', wordsOf(hookHeader)]]) {
      assert.ok(text.includes(`${COMMAND} install-git-hooks`), `${where} names ${COMMAND} install-git-hooks: ${text}`);
    }
    const specs = [...source.matchAll(/\bfrom\s+(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3/g)].map((m) => m[2] ?? m[4]);
    assert.ok(specs.length >= 5, `the scan found the installer's imports: ${specs}`);
    assert.deepEqual(specs.filter((spec) => !spec.startsWith('node:')), [], 'the installer imports nothing but Node\'s own modules');
  });
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
      deploy(wt);
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
    assert.equal(runInstaller(root, ['--commit-guard', join(root, 'guard.mjs')]).status, 0);
    assert.match(readHook(root), /guard\.mjs" --check/, 'the guard line is written armed');
    assert.equal(runInstaller(root).status, 0, 'the flagless canonical re-run succeeds');
    assert.match(readHook(root), /guard\.mjs" --check/, 'the armed guard line survives a flagless re-run');
  }));

  it('--no-commit-guard is the ONLY consented disable; combining both flags is a usage error', inProject(({ root }) => {
    assert.equal(runInstaller(root, ['--commit-guard', join(root, 'guard.mjs')]).status, 0);
    assert.equal(runInstaller(root, ['--no-commit-guard']).status, 0);
    assert.doesNotMatch(readHook(root), /" --check$/m, 'the guard line is removed on the explicit disable');
    const both = runInstaller(root, ['--commit-guard', join(root, 'guard.mjs'), '--no-commit-guard']);
    assert.equal(both.status, 2, 'both flags together are a usage error, never an order-dependent pick');
  }));

  it('a DUPLICATED/malformed guard line in the managed hook fails CLOSED on a flagless re-run', inProject(({ root }) => {
    assert.equal(runInstaller(root, ['--commit-guard', join(root, 'guard.mjs')]).status, 0);
    const armed = readHook(root);
    const guardLine = armed.split('\n').find((l) => /" --check$/.test(l));
    writeFileSync(join(hooksPathOf(root), 'pre-commit'), `${armed}${guardLine}\n`); // duplicate the guard line
    const r = runInstaller(root);
    assert.equal(r.status, 1, 'two guard lines are ambiguous — fail closed, never guess');
    assert.match(r.stderr, /guard/i);
  }));
});

describe('spec:init-project/S58 install-git-hooks — the local, docs, archive, rules-check and layout-check lines on a copy deployed in the kit folder', () => {
  it('each flag writes its resolved path and role comment, ordered docs, rules, layout, guard; a flagless re-run keeps all three; --commit-guard replaces and --no-commit-guard drops the guard alone', inProject(({ root }) => {
    const [rules, layout, guard, guard2] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs', 'guard.mjs', 'g2/guard.mjs'].map((rel) => stub(root, rel));
    installs(root);
    assert.equal(readHook(root), localHook(root), 'the flagless first write is the plain hook');
    installs(root, ['--commit-guard', 'guard.mjs']);
    installs(root, ['--layout-check', 'tools/source-size-check.mjs']);
    assert.equal(readHook(root), localHook(root) + line(layout, 'layout-check') + line(guard), 'the --layout-check run carried the guard line');
    installs(root, ['--rules-check', rules]);
    const armed = localHook(root) + line(rules, 'rules-check') + line(layout, 'layout-check');
    assert.equal(readHook(root), armed + line(guard), 'each arming run carried the other armed lines');
    assert.match(installs(root).stdout, /already up to date/, 'a flagless re-run keeps all three');
    assert.equal(readHook(root), armed + line(guard));
    installs(root, ['--commit-guard', guard2]);
    assert.equal(readHook(root), armed + line(guard2), '--commit-guard replaces the guard line alone');
    installs(root, ['--no-commit-guard']);
    assert.equal(readHook(root), armed, '--no-commit-guard drops the guard line alone');
  }));

  it('over the armed hook with CRLF line ends, a flagless re-run keeps the rules, layout and guard lines with LF ends', inProject(({ root }) => {
    const [rules, layout, guard] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs', 'guard.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--rules-check', rules, '--layout-check', layout, '--commit-guard', guard]);
    const armed = readHook(root);
    writeFileSync(join(hooksPathOf(root), 'pre-commit'), armed.replaceAll('\n', '\r\n'));
    installs(root);
    assert.equal(readHook(root), armed);
  }));

  it('a legacy guard line whose file name is rules-cli.mjs keeps the guard role beside a rules line', inProject(({ root }) => {
    const [legacy, rules] = ['legacy/rules-cli.mjs', 'tools/rules-cli.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--commit-guard', legacy]);
    installs(root, ['--rules-check', rules]);
    const expected = localHook(root) + line(rules, 'rules-check') + line(legacy);
    assert.equal(readHook(root), expected);
    installs(root);
    assert.equal(readHook(root), expected, 'the flagless re-run keeps the legacy line as the guard');
  }));

  it('two lines of one role exit 1 naming that role, the hook unchanged', inProject(({ root }) => {
    const [rules, layout] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--rules-check', rules, '--layout-check', layout]);
    const armed = readHook(root);
    assert.equal(armed, localHook(root) + line(rules, 'rules-check') + line(layout, 'layout-check'), 'both lines armed after the plain hook');
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

  it('over a hook with no rules or layout line, a flagless and a --commit-guard run write the plain hook with the comment line and the local line right after set -e', inProject(({ root }) => {
    installs(root);
    assert.equal(readHook(root), localHook(root));
    installs(root, ['--commit-guard', 'guard.mjs']);
    assert.equal(readHook(root), localHook(root) + line(join(root, 'guard.mjs')));
  }));

  it('a wrong file name, a shell-active path or a missing value exits 2, a missing file exits 1, each writing nothing', inProject(({ root }) => {
    const [rules, layout, guard] = ['tools/rules-cli.mjs', 'tools/source-size-check.mjs', 'guard.mjs'].map((rel) => stub(root, rel));
    installs(root, ['--commit-guard', guard]);
    const before = readHook(root);
    assert.equal(before, localHook(root) + line(guard), 'the guard line armed after the plain hook');
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
      assert.deepEqual([posix.status, /a backslash, CR or LF/.test(posix.stderr), readHook(root)], [2, true, localHook(root)], posix.stderr);
    }
    installs(root, ['--rules-check', given], WIN32);
    assert.equal(readHook(root), localHook(root) + line(armedAt, 'rules-check'));
    assert.match(installs(root).stdout, /already up to date/, 'the flagless re-run recognises the win32-armed line');
    assert.equal(readHook(root), localHook(root) + line(armedAt, 'rules-check'));
  }));
});
