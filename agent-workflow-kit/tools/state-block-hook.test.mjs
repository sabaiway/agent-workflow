import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { fileLine } from './distribution-files/index.mjs';

const leaf = await import('./state-block-hook.mjs').catch(() => ({}));
const need = (name) => {
  if (!(name in leaf)) throw new Error(name + ' is absent');
  return leaf[name];
};
const HOOK = '.claude/hooks/state-block-guard.mjs';
const SETTINGS = '.claude/settings.json';
const LOCAL = '.claude/settings.local.json';
const STAMP = 'docs/ai/.workflow-version';
const BUNDLE_PATH = fileURLToPath(new URL('../references/hooks/state-block-guard.mjs', import.meta.url));
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs"';
const ENTRY = { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] };
const CURRENT = 'nothing to change: the state-block hook is placed, current and wired';
const OWN_HOOK = '; a hook of your own goes in .claude/hooks/<name>.local.mjs';
const SESSION_NOTE = 'settings hot-reload: the Stop hook runs from the next turn end — no session restart needed.';
const FOREIGN_PRE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] };
const FOREIGN_STOP = { matcher: 'foreign', hooks: [{ type: 'command', command: 'echo stop' }] };
const PERMISSIONS = { allow: ['Read'], defaultMode: 'default' };
const BEFORE = { hooks: { PreToolUse: [FOREIGN_PRE], Stop: [FOREIGN_STOP] }, permissions: PERMISSIONS };

const put = (root, rel, contents) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};
const makeProject = (t, { settings, local, hook, stamp = EXPECTED_WORKFLOW_VERSION } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'state-block-writer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, STAMP, `${stamp}\n`);
  if (settings !== undefined) put(root, SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  if (local !== undefined) put(root, LOCAL, `${JSON.stringify(local, null, 2)}\n`);
  if (hook !== undefined) put(root, HOOK, hook);
  return root;
};
const snapshot = (root) => readdirSync(root).sort().map((name) => {
  const path = join(root, name);
  const stat = lstatSync(path);
  const entry = { name, mode: stat.mode, inode: stat.ino };
  if (stat.isSymbolicLink()) return { ...entry, link: readlinkSync(path) };
  if (stat.isDirectory()) return { ...entry, children: snapshot(path) };
  return { ...entry, bytes: readFileSync(path) };
});
const plantLink = (root, rel, directory = false) => {
  const backing = join(root, 'backing');
  if (directory) mkdirSync(backing);
  else writeFileSync(backing, 'untouched\n');
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(backing, join(root, rel));
};
const invoke = (main, argv, deps = {}) => {
  const stdout = [];
  const stderr = [];
  const code = main(argv, {
    bundlePath: BUNDLE_PATH,
    log: (line) => stdout.push(String(line)),
    errlog: (line) => stderr.push(String(line)),
    ...deps,
  });
  return { code, out: stdout.join('\n'), err: stderr.join('\n') };
};

describe('spec:init-project/S28 the state-block writer by proof on a temp project', () => {
  it('dry run plans create, keep and replace across all three merge cases and writes nothing', (t) => {
    const bundle = readFileSync(BUNDLE_PATH);
    const placements = [
      { placement: 'create', hook: undefined, line: 'would place' },
      { placement: 'keep', hook: bundle, line: 'already current' },
      { placement: 'replace', hook: 'older runtime\n', line: `differs from the body the kit writes for it — would be written with that body${OWN_HOOK}` },
    ];
    const merges = [
      { mergeCase: 'no-hooks', settings: {}, line: 'the hooks key with the Stop entry' },
      { mergeCase: 'no-stop', settings: { hooks: { PreToolUse: [FOREIGN_PRE] } }, line: 'the Stop key beside the existing hooks' },
      { mergeCase: 'append', settings: BEFORE, line: 'one element to the existing hooks.Stop array' },
    ];
    const projects = placements.flatMap((placement) => merges.map((merge) => ({
      ...placement,
      merge,
      root: makeProject(t, { hook: placement.hook, settings: merge.settings }),
    })));
    for (const row of projects) {
      const before = snapshot(row.root);
      const result = need('writeStateBlockHook')({ cwd: row.root }, { bundlePath: BUNDLE_PATH });
      assert.equal(result.placement, row.placement);
      assert.equal(result.placePlanned, row.placement !== 'keep');
      assert.equal(result.mergeCase, row.merge.mergeCase);
      assert.equal(result.mergePlanned, true);
      assert.equal(result.wrote, false);
      assert.equal(result.dryRun, true);
      const output = invoke(need('main'), ['--cwd', row.root]);
      assert.equal(output.code, 0, output.err);
      assert.equal(output.err, '');
      const lines = output.out.split('\n');
      assert.equal(lines[0], 'agent-workflow state-block hook — DRY RUN (no changes; re-run with --apply)');
      assert.ok(lines.includes(`  - ${HOOK}: ${row.line}`));
      assert.ok(lines.includes(`  - ${SETTINGS}: would add ${row.merge.line}`));
      assert.deepEqual(snapshot(row.root), before);
    }
  });

  it('--apply places the bundle, preserves foreign settings and their inode, and is idempotent', (t) => {
    const root = makeProject(t, { settings: BEFORE });
    const settingsPath = join(root, SETTINGS);
    const inode = statSync(settingsPath).ino;
    const output = invoke(need('main'), ['--apply', '--cwd', root]);
    assert.equal(output.code, 0, output.err);
    assert.equal(output.err, '');
    assert.deepEqual(readFileSync(join(root, HOOK)), readFileSync(BUNDLE_PATH));
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(written, need('mergeStopEntry')(BEFORE));
    assert.deepEqual(written.hooks.Stop, [FOREIGN_STOP, ENTRY]);
    assert.deepEqual(written.hooks.PreToolUse, [FOREIGN_PRE]);
    assert.equal(written.hooks.Stop[0].matcher, FOREIGN_STOP.matcher);
    assert.deepEqual(written.permissions, PERMISSIONS);
    assert.equal(statSync(settingsPath).ino, inode);
    assert.ok(output.out.split('\n').includes(SESSION_NOTE));
    assert.equal(existsSync(join(root, LOCAL)), false);
    const before = snapshot(root);
    assert.deepEqual(invoke(need('main'), ['--apply', '--cwd', root]), { code: 0, out: CURRENT, err: '' });
    assert.deepEqual(snapshot(root), before);
  });

  it('--apply replaces a differing wired runtime in place without changing settings bytes', (t) => {
    const root = makeProject(t, { settings: { ...BEFORE, hooks: { ...BEFORE.hooks, Stop: [FOREIGN_STOP, ENTRY] } }, hook: 'old\n' });
    const hookPath = join(root, HOOK);
    const inode = statSync(hookPath).ino;
    const settings = readFileSync(join(root, SETTINGS));
    const output = invoke(need('main'), ['--apply', '--cwd', root]);
    assert.equal(output.code, 0, output.err);
    assert.equal(output.err, '');
    assert.ok(output.out.split('\n').includes(`  - ${HOOK}: differs from the body the kit writes for it — written with that body${OWN_HOOK}`), output.out);
    assert.deepEqual(readFileSync(hookPath), readFileSync(BUNDLE_PATH));
    assert.equal(statSync(hookPath).ino, inode);
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
  });

  it('a differing runtime swapped for a link before the replace write refuses, nothing written through it', (t) => {
    const root = makeProject(t, { settings: BEFORE, hook: 'old\n' });
    const hookPath = join(root, HOOK);
    const foreign = join(root, 'foreign.mjs');
    writeFileSync(foreign, 'foreign bytes\n');
    const settings = readFileSync(join(root, SETTINGS));
    const writeFile = (path, ...args) => {
      if (path === hookPath) {
        unlinkSync(hookPath);
        symlinkSync(foreign, hookPath);
      }
      writeFileSync(path, ...args);
    };
    const output = invoke(need('main'), ['--apply', '--cwd', root], { writeFile });
    assert.equal(output.code, 1, output.out);
    assert.match(output.err, /changed before the write — refusing to write through it/u);
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign bytes\n');
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
  });

  it('each malformed, linked, unsafe or stale refusal writes nothing and main returns 1', (t) => {
    const refusals = [
      { setup: (root) => put(root, SETTINGS, '{"hooks":{"Stop":{}}}'), message: '.claude/settings.json: "hooks.Stop" must be an array' },
      { setup: (root) => plantLink(root, '.claude', true), message: '.claude is a symlink — refusing to write through it' },
      { setup: (root) => plantLink(root, '.claude/hooks', true), message: '.claude/hooks is a symlink — refusing to write through it' },
      { setup: (root) => plantLink(root, HOOK), message: `${HOOK} exists but is not a regular file — refusing to touch it` },
      { setup: (root) => plantLink(root, SETTINGS), message: `${SETTINGS} exists but is not a regular file — refusing to clobber it` },
      { setup: (root) => put(root, SETTINGS, '{bad json'), message: `${SETTINGS}: malformed JSON` },
      { setup: (root) => put(root, SETTINGS, '{"permissions":{"defaultMode":"bypassPermissions"}}'), message: 'bypassPermissions appears in Claude settings' },
      { setup: (root) => put(root, LOCAL, '{"permissions":{"defaultMode":"unknownMode"}}'), message: 'an unsafe or unknown permissions.defaultMode is present in Claude settings' },
      { setup: (root) => put(root, STAMP, '0.0.0\n'), message: `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION}`, stale: true },
    ];
    const projects = refusals.map((row) => {
      const root = makeProject(t);
      row.setup(root);
      return { ...row, root, before: snapshot(root) };
    });
    const main = need('main');
    for (const row of projects) {
      for (const args of [[], ['--apply']]) {
        const output = invoke(main, [...args, '--cwd', row.root]);
        if (row.stale && args.length === 0) {
          assert.equal(output.code, 0, output.err);
          assert.equal(output.err, '');
          assert.ok(output.out.split('\n').includes('note: no current deployment stamp found (0.0.0) — --apply will refuse until init/upgrade runs.'));
        } else {
          assert.equal(output.code, 1, output.out);
          assert.equal(output.out, '');
          assert.ok(output.err.includes(row.message), output.err);
        }
        assert.deepEqual(snapshot(row.root), row.before);
      }
    }
  });

  it('a runtime swapped for a link after placement refuses before writing settings', (t) => {
    const root = makeProject(t, { settings: BEFORE });
    const settings = readFileSync(join(root, SETTINGS));
    const inode = statSync(join(root, SETTINGS)).ino;
    const backing = join(root, 'foreign-runtime.mjs');
    writeFileSync(backing, 'foreign bytes\n');
    const writes = [];
    const writeFile = (path, ...args) => {
      writes.push(path);
      writeFileSync(path, ...args);
      if (path === join(root, HOOK)) {
        unlinkSync(path);
        symlinkSync(backing, path);
      }
    };
    const write = need('writeStateBlockHook');
    assert.throws(() => write({ cwd: root, dryRun: false }, { writeFile, bundlePath: BUNDLE_PATH }), {
      code: 'GATE_HOOK_SYMLINK',
      message: `[agent-workflow-kit] ${HOOK} exists but is not a regular file — refusing to touch it`,
    });
    assert.deepEqual(writes, [join(root, HOOK)]);
    assert.equal(lstatSync(join(root, HOOK)).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
    assert.equal(statSync(join(root, SETTINGS)).ino, inode);
    assert.equal(readFileSync(backing, 'utf8'), 'foreign bytes\n');
  });

  it('a runtime swapped for other bytes after placement refuses before writing settings', (t) => {
    const root = makeProject(t, { settings: BEFORE });
    const settings = readFileSync(join(root, SETTINGS));
    const inode = statSync(join(root, SETTINGS)).ino;
    const replacement = 'foreign bytes\n';
    const writes = [];
    const writeFile = (path, ...args) => {
      writes.push(path);
      writeFileSync(path, ...args);
      if (path === join(root, HOOK)) writeFileSync(path, replacement);
    };
    const write = need('writeStateBlockHook');
    assert.throws(() => write({ cwd: root, dryRun: false }, { writeFile, bundlePath: BUNDLE_PATH }), {
      code: 'GATE_HOOK_DIVERGED',
      message: /changed after placement/u,
    });
    assert.deepEqual(writes, [join(root, HOOK)]);
    assert.equal(lstatSync(join(root, HOOK)).isFile(), true);
    assert.equal(readFileSync(join(root, HOOK), 'utf8'), replacement);
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
    assert.equal(statSync(join(root, SETTINGS)).ino, inode);
  });

  it('a runtime command in either settings file suppresses every settings write', (t) => {
    const projectEntry = { hooks: [{ type: 'command', command: `${COMMAND} --require-block` }] };
    const localEntry = { type: 'command', command: `node "${BUNDLE_PATH}"` };
    const projects = [
      { root: makeProject(t, { settings: { hooks: { Stop: [projectEntry] } } }), project: true },
      { root: makeProject(t, { local: { hooks: { Stop: [localEntry] } } }), project: false },
    ];
    for (const row of projects) {
      const settingsPath = join(row.root, SETTINGS);
      const localPath = join(row.root, LOCAL);
      const settings = existsSync(settingsPath) ? readFileSync(settingsPath) : null;
      const local = existsSync(localPath) ? readFileSync(localPath) : null;
      const result = need('writeStateBlockHook')({ cwd: row.root }, { bundlePath: BUNDLE_PATH });
      assert.equal(result.mergePlanned, false);
      assert.equal(result.wiredInProject, row.project);
      assert.equal(result.wiredInLocal, !row.project);
      const data = JSON.parse(readFileSync(row.project ? settingsPath : localPath, 'utf8'));
      assert.equal(need('isStopHookWired')(data), true);
      const writes = [];
      const output = [];
      const code = need('main')(['--apply', '--cwd', row.root], {
        bundlePath: BUNDLE_PATH,
        writeFile: (path, ...args) => {
          writes.push(path);
          writeFileSync(path, ...args);
        },
        log: (line) => output.push(line),
        errlog: (line) => assert.fail(line),
      });
      assert.equal(code, 0);
      assert.deepEqual(writes, [join(row.root, HOOK)]);
      assert.deepEqual(existsSync(settingsPath) ? readFileSync(settingsPath) : null, settings);
      assert.deepEqual(existsSync(localPath) ? readFileSync(localPath) : null, local);
      const settingsLine = row.project ? 'already wired' : 'already wired via .claude/settings.local.json — not duplicated';
      assert.ok(output.join('\n').split('\n').includes(`  - ${SETTINGS}: ${settingsLine}`));
    }
  });

  it('offers the documented Stop entry and command without --require-block', (t) => {
    const root = makeProject(t);
    assert.deepEqual(need('buildStopHookEntry')(), ENTRY);
    assert.equal(need('STATE_BLOCK_HOOK_COMMAND'), COMMAND);
    assert.equal(need('STATE_BLOCK_HOOK_COMMAND').includes('--require-block'), false);
    assert.equal(need('STATE_BLOCK_HOOK_RUNTIME'), 'state-block-guard.mjs');
    assert.equal(need('STATE_BLOCK_HOOK_FILE_REL'), HOOK);
    assert.equal(need('STOP_EVENT'), 'Stop');
    const result = need('writeStateBlockHook')({ cwd: root }, { bundlePath: BUNDLE_PATH });
    const line = `  command: ${COMMAND} (no --require-block; references/modes/state-block-guard.md says when to add it)`;
    assert.ok(need('formatResult')(result).split('\n').includes(line));
    const output = invoke(need('main'), ['--cwd', root]);
    assert.equal(output.code, 0, output.err);
    assert.ok(output.out.split('\n').includes(line));
  });

  it('exports exactly the eleven documented names', (t) => {
    makeProject(t);
    need('writeStateBlockHook');
    assert.deepEqual(Object.keys(leaf).sort(), [
      'STATE_BLOCK_HOOK_COMMAND', 'STATE_BLOCK_HOOK_FILE_REL', 'STATE_BLOCK_HOOK_RUNTIME', 'STOP_EVENT',
      'buildStopHookEntry', 'formatResult', 'isStopHookWired', 'main', 'mergeStopEntry', 'parseArgs', 'writeStateBlockHook',
    ].sort());
  });

  it('imports the shared safety helpers by name without copying their checks', (t) => {
    makeProject(t);
    need('writeStateBlockHook');
    const source = readFileSync(new URL('./state-block-hook.mjs', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/import\s*\{([^{}]*)\}\s*from\s*['"]\.\/gate-hook\.mjs['"]/gu)];
    assert.equal(imports.length, 1);
    const names = imports[0][1].split(',').map((name) => name.trim()).filter(Boolean);
    for (const name of ['fsDeps', 'assertDirSafe', 'assertSettingsWritable', 'planTarget', 'assertHooksShape', 'readStamp', 'formatJson', 'writeHookFile']) {
      assert.ok(names.includes(name), `${name} must be imported by name from ./gate-hook.mjs`);
    }
    for (const forbidden of ['lstat', 'isSymbolicLink', 'must be an array', 'must be a JSON object']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });

  it('a differing runtime\'s line is fileLine of the index over the state hook, imported from the index', (t) => {
    makeProject(t);
    need('writeStateBlockHook');
    const source = readFileSync(new URL('./state-block-hook.mjs', import.meta.url), 'utf8');
    const fromIndex = /^import \{[^}]*\bfileLine\b[^}]*\} from '\.\/distribution-files\/index\.mjs';$/mu;
    assert.ok(fromIndex.test(source), 'state-block-hook.mjs imports fileLine from ./distribution-files/index.mjs');
    assert.equal(/replaced? with the bundle/u.test(source), false, 'no line says replace with the bundle');
    for (const dryRun of [true, false]) {
      const tail = `${dryRun ? 'would be written' : 'written'} with that body${OWN_HOOK}`;
      assert.equal(fileLine({ rel: HOOK, state: 'hook' }, dryRun ? undefined : 'written', dryRun), `${HOOK}: differs from the body the kit writes for it — ${tail}`);
    }
  });

  it('main returns help and usage exit codes without calling process.exit', (t) => {
    const root = makeProject(t);
    const before = snapshot(root);
    const main = need('main');
    const exits = [];
    t.mock.method(process, 'exit', (code) => exits.push(code));
    const help = invoke(main, ['--help']);
    assert.equal(help.code, 0, help.err);
    assert.equal(help.err, '');
    assert.ok(help.out.startsWith('usage: state-block-hook [--apply] [--cwd <dir>] [--help]\n'));
    assert.ok(help.out.includes(HOOK));
    assert.deepEqual(need('parseArgs')(['--cwd', root]), { help: false, dryRun: true, cwd: root });
    for (const row of [
      { argv: ['--unknown'], message: 'unknown argument: --unknown' },
      { argv: ['--cwd'], message: '--cwd needs a directory argument' },
    ]) {
      const output = invoke(main, row.argv);
      assert.equal(output.code, 2);
      assert.equal(output.out, '');
      assert.equal(output.err, `${row.message}\n${help.out}`);
    }
    assert.equal(invoke(main, ['--cwd', root]).code, 0);
    assert.deepEqual(exits, []);
    assert.deepEqual(snapshot(root), before);
  });
});
