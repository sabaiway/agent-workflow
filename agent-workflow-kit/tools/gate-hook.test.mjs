// gate-hook.test.mjs — acceptance spec for the gate-hook writer CLI (gate-hook.mjs). Hermetic:
// injected in-memory fs, the velocity/cheap-agents test idiom. The load-bearing claims:
//   • preview-then-mutate (dry-run default, zero writes) and the EXACT settings fixture;
//   • merge-don't-clobber (foreign hooks/matchers/keys + permissions preserved semantically,
//     EOL preserved, idempotent re-apply is a zero-diff no-op);
//   • malformed existing `hooks` shape → STOP with ZERO writes;
//   • diverged target + unwired → STOP (no file write, no settings mutation); diverged +
//     already-wired → report-only, nothing clobbered or unwired;
//   • stamp/symlink/unsafe-mode STOPs (both settings files); settings.local.json never written;
//   • place-then-wire ORDER, observable on an injected mid-failure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { statSync } from 'node:fs';
import * as gateHook from './gate-hook.mjs';

import {
  GATE_HOOK_DIVERGED,
  GATE_HOOK_MALFORMED,
  GATE_HOOK_STAMP,
  GATE_HOOK_STALE,
  GATE_HOOK_SYMLINK,
  GATE_HOOK_UNSAFE_MODE,
  HOOK_COMMAND,
  HOOK_FILE_REL,
  LANES_REL,
  READ_LANE_KEY,
  applyReadLaneCommand,
  buildHookSettingsEntry,
  formatResult,
  main,
  parseArgs,
  planReadLane,
  writeGateHook,
  writeReadLane,
} from './gate-hook.mjs';

const PROJ = '/proj';
const BUNDLE_PATH = '/bundle/gate-approve.mjs';
const BUNDLE_CONTENT = '// the bundled hook runtime\n';
const HOOK_ABS = join(PROJ, HOOK_FILE_REL);
const SETTINGS_ABS = join(PROJ, '.claude/settings.json');
const LOCAL_ABS = join(PROJ, '.claude/settings.local.json');
const STAMP_ABS = join(PROJ, 'docs/ai/.workflow-version');

// The plan's literal settings fragment — asserted VERBATIM below.
const SETTINGS_FIXTURE = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"',
            timeout: 30,
          },
        ],
      },
    ],
  },
};

const fileStat = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
const dirStat = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
const linkStat = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

const memFs = ({ files = {}, dirs = [], symlinks = [] } = {}) => {
  const store = new Map(Object.entries({ [BUNDLE_PATH]: BUNDLE_CONTENT, ...files }));
  const dirSet = new Set(dirs);
  const linkSet = new Set(symlinks);
  const writes = [];
  return {
    writes,
    store,
    bundlePath: BUNDLE_PATH,
    exists: (path) => store.has(path) || dirSet.has(path),
    lstat: (path) => {
      if (linkSet.has(path)) return linkStat;
      if (dirSet.has(path)) return dirStat;
      if (store.has(path)) return fileStat;
      throw ENOENT();
    },
    readFile: (path) => {
      if (store.has(path)) return store.get(path);
      throw ENOENT();
    },
    writeFile: (path, content) => {
      writes.push({ path, content });
      store.set(path, content);
    },
    mkdir: (path) => dirSet.add(path),
  };
};

const deployedFs = (extra = {}) =>
  memFs({ ...extra, files: { [STAMP_ABS]: '4.0.0\n', ...(extra.files ?? {}) } });

const wiredSettings = (extra = {}) =>
  JSON.stringify({ hooks: { PreToolUse: [buildHookSettingsEntry()] }, ...extra });

const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};

describe('spec:init-project/S27 gate-hook --reseed by proof', () => {
  const DIVERGED = '// an older placed hook, longer than the bundled runtime it is replaced by\n';
  const CURRENT_LINE = 'nothing to change: the placed hook is current';
  const capture = () => {
    const lines = [];
    return {
      log: (line) => lines.push(String(line)),
      errlog: (line) => lines.push(String(line)),
      out: () => lines.join('\n'),
    };
  };

  it('a diverged wired dry run plans replacement alone and prints the reseed preview without writes', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings() } });
    const before = new Map(fs.store);
    const result = writeGateHook({ cwd: PROJ, dryRun: true, reseed: true }, fs);
    const cap = capture();
    const code = main(['--reseed', '--cwd', PROJ], { ...fs, ...cap });
    assert.equal(result.reseedPlanned, true);
    assert.equal(result.wirePlanned, false);
    assert.equal(result.placePlanned, false);
    assert.equal(result.wrote, false);
    assert.equal(code, 0, cap.out());
    assert.equal(cap.out().split('\n')[0], 'agent-workflow gate hook — DRY RUN (no changes; re-run with --apply --reseed)');
    assert.ok(cap.out().split('\n').includes(`  - ${HOOK_FILE_REL}: would replace with the bundle (it differed from the bundled runtime)`));
    assert.deepEqual(fs.writes, []);
    assert.deepEqual(fs.store, before);
  });

  it('a diverged unwired dry run plans replacement and wiring instead of GATE_HOOK_DIVERGED', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED } });
    const before = new Map(fs.store);
    const result = writeGateHook({ cwd: PROJ, dryRun: true, reseed: true }, fs);
    assert.equal(result.reseedPlanned, true);
    assert.equal(result.wirePlanned, true);
    assert.equal(result.placePlanned, false);
    assert.equal(result.wrote, false);
    assert.deepEqual(fs.writes, []);
    assert.deepEqual(fs.store, before);
  });

  it('reseed refuses absent, symlinked and non-regular targets in both modes with no writes and exit 1', () => {
    const states = [
      { name: 'absent', fixture: {}, code: GATE_HOOK_STALE, message: /is not placed/u },
      { name: 'symlinked', fixture: { symlinks: [HOOK_ABS] }, code: GATE_HOOK_SYMLINK, message: /not a regular file/u },
      { name: 'directory', fixture: { dirs: [HOOK_ABS] }, code: GATE_HOOK_SYMLINK, message: /not a regular file/u },
    ];
    for (const state of states) {
      for (const dryRun of [true, false]) {
        const fs = deployedFs(state.fixture);
        const before = new Map(fs.store);
        assert.throws(
          () => writeGateHook({ cwd: PROJ, dryRun, reseed: true }, fs),
          (err) => {
            assert.equal(err.code, state.code, state.name);
            assert.equal(err.exitCode, 1);
            assert.ok(err.message.includes(HOOK_FILE_REL));
            assert.match(err.message, state.message);
            return true;
          },
        );
        const cap = capture();
        const argv = [...(dryRun ? [] : ['--apply']), '--reseed', '--cwd', PROJ];
        assert.equal(main(argv, { ...fs, ...cap }), 1, cap.out());
        assert.match(cap.out(), state.message);
        assert.deepEqual(fs.writes, []);
        assert.deepEqual(fs.store, before);
      }
    }
  });

  it('a current hook wired in project or local only prints exactly one no-change line in both modes', () => {
    for (const settingsPath of [SETTINGS_ABS, LOCAL_ABS]) {
      for (const dryRun of [true, false]) {
        const fs = deployedFs({ files: { [HOOK_ABS]: BUNDLE_CONTENT, [settingsPath]: wiredSettings() } });
        const before = new Map(fs.store);
        const cap = capture();
        const argv = [...(dryRun ? [] : ['--apply']), '--reseed', '--cwd', PROJ];
        const code = main(argv, { ...fs, ...cap });
        assert.equal(code, 0, cap.out());
        assert.equal(cap.out(), CURRENT_LINE);
        assert.deepEqual(fs.writes, []);
        assert.deepEqual(fs.store, before);
      }
    }
  });

  it('a current unwired hook plans wiring alone and applies only the exact settings fixture', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: BUNDLE_CONTENT } });
    const before = new Map(fs.store);
    const result = writeGateHook({ cwd: PROJ, dryRun: true, reseed: true }, fs);
    assert.equal(result.reseedPlanned, false);
    assert.equal(result.wirePlanned, true);
    assert.equal(result.placePlanned, false);
    assert.equal(result.wrote, false);
    assert.deepEqual(fs.writes, []);
    assert.deepEqual(fs.store, before);
    const cap = capture();
    assert.equal(main(['--reseed', '--cwd', PROJ], { ...fs, ...cap }), 0, cap.out());
    assert.match(cap.out(), /settings\.json: would wire/u);
    assert.deepEqual(fs.writes, []);
    const applied = writeGateHook({ cwd: PROJ, dryRun: false, reseed: true }, fs);
    assert.equal(applied.wrote, true);
    assert.deepEqual(fs.writes.map((write) => write.path), [SETTINGS_ABS]);
    assert.deepEqual(JSON.parse(fs.store.get(SETTINGS_ABS)), SETTINGS_FIXTURE);
    assert.equal(fs.store.get(HOOK_ABS), BUNDLE_CONTENT);
  });

  it('reseed with read-lane exits 2 and parseArgs names the incompatible flags', () => {
    const fs = deployedFs();
    const cap = capture();
    const message = '--reseed and --read-lane cannot be used together';
    const code = main(['--reseed', '--read-lane', '--cwd', PROJ], { ...fs, ...cap });
    assert.equal(code, 2);
    assert.equal(cap.out().split('\n')[0], message);
    assert.throws(
      () => parseArgs(['--reseed', '--read-lane']),
      (err) => {
        assert.equal(err.exitCode, 2);
        assert.equal(err.message, message);
        return true;
      },
    );
    assert.deepEqual(fs.writes, []);
  });

  it('apply reseeds in place, preserves wired settings, wires once when unwired and repeats without byte changes', () => {
    for (const wired of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'gate-hook-reseed-'));
      try {
        mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
        mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
        const stampPath = join(root, 'docs', 'ai', '.workflow-version');
        const bundlePath = join(root, 'bundle-gate-approve.mjs');
        const hookPath = join(root, HOOK_FILE_REL);
        const settingsPath = join(root, '.claude', 'settings.json');
        const localPath = join(root, '.claude', 'settings.local.json');
        const localBytes = '{"otherLocal":"kept"}\n';
        const settingsBytes = wired ? `${wiredSettings()}\n` : '{"otherProject":"kept"}\n';
        writeFileSync(stampPath, '4.0.0\n');
        writeFileSync(bundlePath, BUNDLE_CONTENT);
        writeFileSync(hookPath, DIVERGED);
        writeFileSync(settingsPath, settingsBytes);
        writeFileSync(localPath, localBytes);
        const inodeBefore = statSync(hookPath).ino;
        const writes = [];
        const deps = {
          bundlePath,
          writeFile: (path, content, encoding) => {
            writes.push(path);
            writeFileSync(path, content, encoding);
          },
        };
        const cap = capture();
        const argv = ['--apply', '--reseed', '--cwd', root];
        assert.equal(main(argv, { ...deps, ...cap }), 0, cap.out());
        assert.equal(readFileSync(hookPath, 'utf8'), BUNDLE_CONTENT);
        assert.equal(statSync(hookPath).ino, inodeBefore);
        assert.deepEqual(writes, wired ? [hookPath] : [hookPath, settingsPath]);
        assert.equal(cap.out().split('\n')[0], 'agent-workflow gate hook — APPLY');
        assert.ok(cap.out().includes(`  - ${HOOK_FILE_REL}: replaced with the bundle (it differed from the bundled runtime)`));
        const settingsAfter = readFileSync(settingsPath, 'utf8');
        if (wired) assert.equal(settingsAfter, settingsBytes);
        else assert.deepEqual(JSON.parse(settingsAfter), {
          otherProject: 'kept',
          hooks: { PreToolUse: [buildHookSettingsEntry()] },
        });
        assert.equal(readFileSync(localPath, 'utf8'), localBytes);
        const second = capture();
        const writeCount = writes.length;
        assert.equal(main(argv, { ...deps, ...second }), 0, second.out());
        assert.equal(second.out(), CURRENT_LINE);
        assert.equal(writes.length, writeCount);
        assert.equal(readFileSync(hookPath, 'utf8'), BUNDLE_CONTENT);
        assert.equal(statSync(hookPath).ino, inodeBefore);
        assert.equal(readFileSync(settingsPath, 'utf8'), settingsAfter);
        assert.equal(readFileSync(localPath, 'utf8'), localBytes);
        assert.equal(readFileSync(stampPath, 'utf8'), '4.0.0\n');
        assert.equal(readFileSync(bundlePath, 'utf8'), BUNDLE_CONTENT);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('apply reseed refuses a hook swapped for a link before the write, and a platform without no-follow', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-late-link-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      const bundlePath = join(root, 'bundle-gate-approve.mjs');
      const hookPath = join(root, HOOK_FILE_REL);
      const settingsPath = join(root, '.claude', 'settings.json');
      const foreignPath = join(root, 'foreign.mjs');
      writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '4.0.0\n');
      writeFileSync(bundlePath, BUNDLE_CONTENT);
      writeFileSync(settingsPath, `${wiredSettings()}\n`);
      writeFileSync(foreignPath, 'foreign bytes\n');
      writeFileSync(hookPath, DIVERGED);
      const swap = (path, ...args) => {
        if (path === hookPath) {
          unlinkSync(hookPath);
          symlinkSync(foreignPath, hookPath);
        }
        writeFileSync(path, ...args);
      };
      const linked = capture();
      assert.equal(main(['--apply', '--reseed', '--cwd', root], { bundlePath, writeFile: swap, ...linked }), 1, linked.out());
      assert.match(linked.out(), /changed before the write — refusing to write through it/u);
      assert.equal(readFileSync(foreignPath, 'utf8'), 'foreign bytes\n');
      assert.equal(readFileSync(settingsPath, 'utf8'), `${wiredSettings()}\n`);
      unlinkSync(hookPath);
      writeFileSync(hookPath, DIVERGED);
      const bare = capture();
      assert.equal(main(['--apply', '--reseed', '--cwd', root], { bundlePath, noFollow: null, ...bare }), 1, bare.out());
      assert.match(bare.out(), /no O_NOFOLLOW open flag — refusing to replace/u);
      assert.equal(readFileSync(hookPath, 'utf8'), DIVERGED);
      unlinkSync(hookPath);
      const plant = (path, ...args) => {
        if (path === hookPath) symlinkSync(foreignPath, hookPath);
        writeFileSync(path, ...args);
      };
      const created = capture();
      assert.equal(main(['--apply', '--cwd', root], { bundlePath, writeFile: plant, ...created }), 1, created.out());
      assert.match(created.out(), /changed before the write — refusing to write through it/u);
      assert.equal(readFileSync(foreignPath, 'utf8'), 'foreign bytes\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a relative --cwd prints the reseed route with the absolute root', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-relative-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      const bundlePath = join(root, 'bundle-gate-approve.mjs');
      writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '4.0.0\n');
      writeFileSync(bundlePath, BUNDLE_CONTENT);
      writeFileSync(join(root, HOOK_FILE_REL), DIVERGED);
      const rel = relative(process.cwd(), root);
      assert.notEqual(rel, root);
      const cap = capture();
      assert.equal(main(['--apply', '--cwd', rel], { bundlePath, ...cap }), 1, cap.out());
      assert.ok(cap.out().includes(`--apply --reseed --cwd ${root}`), cap.out());
      assert.ok(!cap.out().includes(`--cwd ${rel}`), cap.out());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('apply reseed keeps stamp, bypassPermissions and malformed hooks refusals with zero writes', () => {
    const states = [
      { files: { [STAMP_ABS]: '1.0.0\n' }, code: GATE_HOOK_STAMP, message: /lineage/u },
      { files: { [SETTINGS_ABS]: wiredSettings({ permissions: { defaultMode: 'bypassPermissions' } }) }, code: GATE_HOOK_UNSAFE_MODE, message: /bypassPermissions/u },
      { files: { [SETTINGS_ABS]: JSON.stringify({ hooks: { PreToolUse: {} } }) }, code: GATE_HOOK_MALFORMED, message: /"hooks.PreToolUse" must be an array/u },
    ];
    for (const state of states) {
      const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings(), ...state.files } });
      const before = new Map(fs.store);
      if (state.code === GATE_HOOK_STAMP) {
        const dry = writeGateHook({ cwd: PROJ, dryRun: true, reseed: true }, fs);
        assert.equal(dry.stampOk, false);
        assert.match(formatResult(dry), /--apply will refuse/u);
        const cap = capture();
        assert.equal(main(['--reseed', '--cwd', PROJ], { ...fs, ...cap }), 0, cap.out());
      }
      assert.throws(
        () => writeGateHook({ cwd: PROJ, dryRun: false, reseed: true }, fs),
        (err) => {
          assert.equal(err.code, state.code);
          assert.equal(err.exitCode, 1);
          assert.match(err.message, state.message);
          return true;
        },
      );
      const cap = capture();
      assert.equal(main(['--apply', '--reseed', '--cwd', PROJ], { ...fs, ...cap }), 1, cap.out());
      assert.match(cap.out(), state.message);
      assert.deepEqual(fs.writes, []);
      assert.deepEqual(fs.store, before);
    }
  });

  it('every stale recovery names the reseed route with the absolute root and help carries no rm or delete', () => {
    const root = PROJ;
    const unwired = deployedFs({ files: { [HOOK_ABS]: DIVERGED } });
    const wired = deployedFs({
      dirs: [join(root, 'docs'), join(root, 'docs', 'ai')],
      files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings() },
    });
    const refused = capture();
    assert.equal(main(['--apply', '--cwd', root], { ...unwired, ...refused }), 1);
    const lane = capture();
    assert.equal(main(['--apply', '--read-lane', '--cwd', root], { ...wired, ...lane }), 1);
    assert.match(lane.out(), /NOT the current bundle/u);
    const report = capture();
    assert.equal(main(['--cwd', root], { ...wired, ...report }), 0);
    const help = capture();
    assert.equal(main(['--help'], help), 0);
    assert.ok(root.startsWith('/'));
    for (const text of [refused.out(), lane.out(), report.out()]) {
      assert.ok(text.includes(`--apply --reseed --cwd ${root}`), text);
    }
    assert.ok(help.out().split('\n').includes('       gate-hook --reseed [--dry-run | --apply] [--cwd <dir>]      (replace a placed hook with the bundle)'));
    assert.ok(help.out().includes('(gate-hook --apply --reseed --cwd <dir>)'));
    assert.ok(help.out().replace(/\s+/gu, ' ').includes('a current hook wired in either settings file is nothing to change, and a current unwired one is only wired.'));
    for (const text of [refused.out(), lane.out(), report.out(), help.out()]) {
      assert.doesNotMatch(text, /rm |delete/u);
    }
    assert.deepEqual(unwired.writes, []);
    assert.deepEqual(wired.writes, []);
  });

  it('exports the shared functions, planTarget names its rel and assertHooksShape validates Stop', () => {
    const rel = '.claude/hooks/state-block-guard.mjs';
    const target = join(PROJ, rel);
    const fs = deployedFs({ symlinks: [target] });
    const data = { hooks: { Stop: {} } };
    const names = ['fsDeps', 'lstatNoFollow', 'assertDirSafe', 'assertSettingsWritable', 'planTarget', 'assertHooksShape', 'readStamp', 'formatJson'];
    for (const name of names) assert.equal(typeof need(gateHook, name), 'function', name);
    assert.throws(
      () => need(gateHook, 'planTarget')(target, rel, BUNDLE_CONTENT, fs),
      (err) => {
        assert.equal(err.code, GATE_HOOK_SYMLINK);
        assert.ok(err.message.includes(rel));
        assert.doesNotMatch(err.message, /agent-workflow-gates\.mjs/u);
        return true;
      },
    );
    assert.throws(
      () => need(gateHook, 'assertHooksShape')(data, '.claude/settings.json', 'Stop'),
      (err) => {
        assert.equal(err.code, GATE_HOOK_MALFORMED);
        assert.match(err.message, /"hooks\.Stop" must be an array/u);
        return true;
      },
    );
    assert.deepEqual(fs.writes, []);
  });
});

describe('gate-hook writer — preview-then-mutate and the exact fixture', () => {
  it('dry-run is the default and writes NOTHING', () => {
    const fs = deployedFs();
    const out = [];
    const code = main([], { ...fs, cwd: PROJ, log: (line) => out.push(line), errlog: () => {} });
    assert.equal(code, 0);
    assert.equal(fs.writes.length, 0);
    assert.match(out.join('\n'), /DRY RUN/u);
  });

  it('apply places the bundle content and merges the settings fixture VERBATIM', () => {
    const fs = deployedFs();
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.wrote, true);
    assert.equal(fs.store.get(HOOK_ABS), BUNDLE_CONTENT);
    assert.deepStrictEqual(JSON.parse(fs.store.get(SETTINGS_ABS)), SETTINGS_FIXTURE);
  });

  it('places the hook file BEFORE wiring settings (place-then-wire order)', () => {
    const fs = deployedFs();
    writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.deepEqual(fs.writes.map((write) => write.path), [HOOK_ABS, SETTINGS_ABS]);
  });

  it('the order is observable on an injected mid-failure: file placed, settings untouched', () => {
    const fs = deployedFs();
    const failingWrite = (path, content) => {
      if (path === SETTINGS_ABS) throw new Error('disk full');
      fs.writeFile(path, content);
    };
    assert.throws(() => writeGateHook({ cwd: PROJ, dryRun: false }, { ...fs, writeFile: failingWrite }), /disk full/u);
    assert.equal(fs.store.get(HOOK_ABS), BUNDLE_CONTENT);
    assert.equal(fs.store.has(SETTINGS_ABS), false);
  });

  it('is idempotent: a re-apply is a zero-diff no-op (no duplicate entry, no writes)', () => {
    const fs = deployedFs();
    writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    const settingsAfterFirst = fs.store.get(SETTINGS_ABS);
    const second = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(second.wrote, false);
    assert.equal(fs.writes.length, 2);
    assert.equal(fs.store.get(SETTINGS_ABS), settingsAfterFirst);
    assert.equal(JSON.parse(settingsAfterFirst).hooks.PreToolUse.length, 1);
  });

  it('repairs the wired-but-missing state: places the file, leaves settings untouched', () => {
    const fs = deployedFs({ files: { [SETTINGS_ABS]: wiredSettings() } });
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.wrote, true);
    assert.deepEqual(fs.writes.map((write) => write.path), [HOOK_ABS]);
  });
});

describe('gate-hook writer — merge-don\'t-clobber', () => {
  const foreign = {
    otherTopLevel: 'kept',
    permissions: { allow: ['Bash(ls:*)'], defaultMode: 'acceptEdits' },
    hooks: {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-post' }] }],
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'foreign-pre' }] }],
    },
  };

  it('preserves foreign hooks/matchers/keys and existing permissions SEMANTICALLY', () => {
    const fs = deployedFs({ files: { [SETTINGS_ABS]: JSON.stringify(foreign) } });
    writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    const merged = JSON.parse(fs.store.get(SETTINGS_ABS));
    assert.equal(merged.otherTopLevel, 'kept');
    assert.deepEqual(merged.permissions, foreign.permissions);
    assert.deepEqual(merged.hooks.PostToolUse, foreign.hooks.PostToolUse);
    assert.deepEqual(merged.hooks.PreToolUse[0], foreign.hooks.PreToolUse[0]);
    assert.deepEqual(merged.hooks.PreToolUse[1], buildHookSettingsEntry());
    assert.equal(merged.hooks.PreToolUse.length, 2);
  });

  it('preserves the settings file EOL (CRLF stays CRLF)', () => {
    const crlf = JSON.stringify(foreign, null, 2).replace(/\n/gu, '\r\n');
    const fs = deployedFs({ files: { [SETTINGS_ABS]: crlf } });
    writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.match(fs.store.get(SETTINGS_ABS), /\r\n/u);
  });

  it('never writes settings.local.json', () => {
    const fs = deployedFs({ files: { [LOCAL_ABS]: JSON.stringify({ permissions: {} }) } });
    writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(fs.writes.some((write) => write.path === LOCAL_ABS), false);
  });

  it('already wired via settings.local.json → not duplicated into project settings', () => {
    const fs = deployedFs({ files: { [LOCAL_ABS]: wiredSettings() } });
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.wirePlanned, false);
    assert.deepEqual(fs.writes.map((write) => write.path), [HOOK_ABS]);
    assert.match(formatResult(result), /already wired via .claude\/settings\.local\.json/u);
  });
});

describe('gate-hook writer — precondition STOPs (zero writes, dry-run predicts apply)', () => {
  const assertStop = (fs, code, { dryRun = false } = {}) => {
    assert.throws(
      () => writeGateHook({ cwd: PROJ, dryRun }, fs),
      (thrown) => {
        assert.equal(thrown.code, code);
        assert.equal(thrown.exitCode, 1);
        return true;
      },
    );
    assert.equal(fs.writes.length, 0);
  };

  it('a malformed existing hooks shape is a STOP with ZERO writes (all shapes, both modes)', () => {
    const malformed = [
      { hooks: 'nope' },
      { hooks: { PreToolUse: {} } },
      { hooks: { PreToolUse: ['nope'] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: 'nope' }] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: ['nope'] }] } },
    ];
    for (const shape of malformed) {
      assertStop(deployedFs({ files: { [SETTINGS_ABS]: JSON.stringify(shape) } }), GATE_HOOK_MALFORMED);
      assertStop(deployedFs({ files: { [SETTINGS_ABS]: JSON.stringify(shape) } }), GATE_HOOK_MALFORMED, { dryRun: true });
    }
  });

  it('diverged target + absent settings entry → STOP: no file write AND no settings mutation', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: 'something else entirely' } });
    assertStop(fs, GATE_HOOK_DIVERGED);
    assertStop(fs, GATE_HOOK_DIVERGED, { dryRun: true });
    assert.equal(fs.store.get(HOOK_ABS), 'something else entirely');
    assert.equal(fs.store.has(SETTINGS_ABS), false);
  });

  it('diverged target + already-wired entry → report-only: nothing clobbered or unwired', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: 'customized', [SETTINGS_ABS]: wiredSettings() } });
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.wrote, false);
    assert.equal(fs.writes.length, 0);
    assert.equal(fs.store.get(HOOK_ABS), 'customized');
    assert.equal(JSON.parse(fs.store.get(SETTINGS_ABS)).hooks.PreToolUse.length, 1);
    assert.match(formatResult(result), /diverged from the bundle — preserved/u);
  });

  it('an identical target file is "already current" (idempotent re-run, not a divergence)', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: BUNDLE_CONTENT } });
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.target.action, 'already-current');
    assert.deepEqual(fs.writes.map((write) => write.path), [SETTINGS_ABS]);
  });

  it('the stamp gates apply only: dry-run reports, apply refuses', () => {
    const fs = memFs();
    const dry = writeGateHook({ cwd: PROJ, dryRun: true }, fs);
    assert.equal(dry.stampOk, false);
    assert.match(formatResult(dry), /--apply will refuse/u);
    assertStop(memFs(), GATE_HOOK_STAMP);
  });

  it('symlink STOPs on .claude / .claude/hooks / target file / settings.json (dry-run too)', () => {
    assertStop(deployedFs({ symlinks: [join(PROJ, '.claude')] }), GATE_HOOK_SYMLINK, { dryRun: true });
    assertStop(deployedFs({ dirs: [join(PROJ, '.claude')], symlinks: [join(PROJ, '.claude/hooks')] }), GATE_HOOK_SYMLINK, { dryRun: true });
    assertStop(
      deployedFs({ dirs: [join(PROJ, '.claude'), join(PROJ, '.claude/hooks'), HOOK_ABS] }),
      GATE_HOOK_SYMLINK,
      { dryRun: true },
    );
    assertStop(deployedFs({ dirs: [join(PROJ, '.claude'), SETTINGS_ABS] }), GATE_HOOK_SYMLINK, { dryRun: true });
  });

  it('refuses bypassPermissions / unsafe modes in EITHER settings file', () => {
    const bypass = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
    const weird = JSON.stringify({ permissions: { defaultMode: 'weird-mode' } });
    assertStop(deployedFs({ files: { [SETTINGS_ABS]: bypass } }), GATE_HOOK_UNSAFE_MODE, { dryRun: true });
    assertStop(deployedFs({ files: { [LOCAL_ABS]: bypass } }), GATE_HOOK_UNSAFE_MODE, { dryRun: true });
    assertStop(deployedFs({ files: { [LOCAL_ABS]: weird } }), GATE_HOOK_UNSAFE_MODE, { dryRun: true });
  });
});

describe('gate-hook CLI — usage and report', () => {
  it('maps bad args to the usage exit code', () => {
    assert.throws(() => parseArgs(['--nope']), (thrown) => thrown.exitCode === 2);
    assert.throws(() => parseArgs(['--dry-run', '--apply']), (thrown) => thrown.exitCode === 2);
    assert.throws(() => parseArgs(['--cwd']), (thrown) => thrown.exitCode === 2);
  });

  it('the apply report carries the trust posture, hot-reload and hidden-mode reconcile lines', () => {
    const fs = deployedFs();
    const out = [];
    const code = main(['--apply'], { ...fs, cwd: PROJ, log: (line) => out.push(line), errlog: () => {} });
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /trust posture:/u);
    assert.match(text, /hot-reload/u);
    assert.match(text, /hide-footprint reconcile/u);
  });

  it('a STOP surfaces on stderr, names the reseed route and exits 1', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: 'diverged' } });
    const err = [];
    const code = main(['--apply'], { ...fs, cwd: PROJ, log: () => {}, errlog: (line) => err.push(line) });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /--apply --reseed --cwd \/proj/u);
    assert.doesNotMatch(err.join('\n'), /delete/u);
  });

  it('HOOK_COMMAND references the placed path (the fixture and the placement can never drift)', () => {
    assert.equal(HOOK_COMMAND.includes(HOOK_FILE_REL), true);
  });
});

describe('gate-hook writer — wired-detection is matcher- and type-specific', () => {
  it('a same-command entry under a DIFFERENT matcher does NOT suppress the Bash merge', () => {
    const foreignMatcher = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
    });
    const fs = deployedFs({ files: { [SETTINGS_ABS]: foreignMatcher } });
    const result = writeGateHook({ cwd: PROJ, dryRun: false }, fs);
    assert.equal(result.wirePlanned, true, 'a Write-matcher entry must not read as our Bash wiring');
    const merged = JSON.parse(fs.store.get(SETTINGS_ABS));
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.deepEqual(merged.hooks.PreToolUse[1], buildHookSettingsEntry());
  });

  it('an entry with our matcher but a non-command hook type does NOT count as wired', () => {
    const wrongType = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'other', command: HOOK_COMMAND }] }] },
    });
    const fs = deployedFs({ files: { [SETTINGS_ABS]: wrongType } });
    assert.equal(writeGateHook({ cwd: PROJ, dryRun: false }, fs).wirePlanned, true);
  });
});

describe('gate-hook writer — TOCTOU re-verify before wiring', () => {
  it('a target swapped after preflight but before wiring → STOP, no settings mutation', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: BUNDLE_CONTENT } }); // already-current → place not planned
    // Inject a divergence at read time to simulate an external swap between preflight and wiring.
    let reads = 0;
    const swappingRead = (path) => {
      if (path === HOOK_ABS) {
        reads += 1;
        return reads === 1 ? BUNDLE_CONTENT : 'swapped by an external process';
      }
      return fs.readFile(path);
    };
    assert.throws(
      () => writeGateHook({ cwd: PROJ, dryRun: false }, { ...fs, readFile: swappingRead }),
      (thrown) => thrown.code === GATE_HOOK_DIVERGED,
    );
    assert.equal(fs.store.has(SETTINGS_ABS), false);
  });

  it('a target turned into a symlink after preflight → STOP, no settings mutation', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: BUNDLE_CONTENT } });
    let lstats = 0;
    const swappingLstat = (path) => {
      if (path === HOOK_ABS) {
        lstats += 1;
        return lstats === 1 ? fileStat : linkStat;
      }
      return fs.lstat(path);
    };
    assert.throws(
      () => writeGateHook({ cwd: PROJ, dryRun: false }, { ...fs, lstat: swappingLstat }),
      (thrown) => thrown.code === GATE_HOOK_DIVERGED,
    );
    assert.equal(fs.store.has(SETTINGS_ABS), false);
  });
});

// ── --read-lane: the opt-in read-only compound lane + currency check (AD-055 Part II) ──
// Real scratch dirs (the ack-write idiom) — the lane write routes through the atomic-write core.
describe('gate-hook --read-lane — the opt-in read-only compound lane writer', () => {
  const BUNDLE_V = '// bundled hook v1.48\n'; // the "current" bundle content
  const STALE = '// an older placed hook\n';
  const lanesPath = (root) => join(root, 'docs', 'ai', 'lanes.json');
  const gatesPath = (root) => join(root, 'docs', 'ai', 'gates.json');
  const hookPath = (root) => join(root, HOOK_FILE_REL);

  // hook: BUNDLE_V (current) | STALE (diverged) | undefined (not placed). lanes: raw lanes.json body.
  // wired (default true): wire the hook into settings.json (the --read-lane currency check needs it,
  // council B5). stamp (default '4.0.0' = the lineage head): the deployment stamp (--read-lane --apply
  // enforces it, council B6); null skips it.
  const makeDeployed = ({ hook, lanes, gates, wired = true, stamp = '4.0.0' } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-lane-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    if (stamp !== null) writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${stamp}\n`);
    const bundlePath = join(root, 'bundle-gate-approve.mjs');
    writeFileSync(bundlePath, BUNDLE_V);
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    if (hook !== undefined) writeFileSync(hookPath(root), hook);
    if (wired) writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [buildHookSettingsEntry()] } }));
    if (lanes !== undefined) writeFileSync(lanesPath(root), lanes);
    if (gates !== undefined) writeFileSync(gatesPath(root), gates);
    return { root, bundlePath };
  };
  const capture = () => {
    const lines = [];
    const push = (m) => lines.push(String(m));
    return { log: push, errlog: push, out: () => lines.join('\n') };
  };
  const cleanup = (root) => rmSync(root, { recursive: true, force: true });

  it('dry-run (current hook, no lanes.json) — previews the create + posture, writes nothing, prints the apply cmd', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V });
    const cap = capture();
    const code = main(['--read-lane', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 0, cap.out());
    assert.match(cap.out(), /DRY RUN/);
    assert.match(cap.out(), /would create .*lanes\.json .*"readLane" = true/);
    assert.match(cap.out(), /hook currency: current/);
    assert.match(cap.out(), /posture:/);
    assert.match(cap.out(), /subset invariant/);
    assert.match(cap.out(), /never the OS sandbox/);
    assert.ok(cap.out().includes(applyReadLaneCommand(root)), 'the preview prints the exact --apply command');
    assert.equal(created, false, 'a dry-run never creates the toggle file');
  });

  it('dry-run with a STALE placed hook — reports STALE and warns --apply will refuse', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    const code = main(['--read-lane', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    assert.equal(code, 0, cap.out());
    assert.match(cap.out(), /hook currency: STALE/);
    assert.match(cap.out(), /--apply will REFUSE/);
  });

  it('--apply (current hook) creates docs/ai/lanes.json with EXACTLY { "readLane": true }', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V });
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...capture(), bundlePath });
    const parsed = JSON.parse(readFileSync(lanesPath(root), 'utf8'));
    cleanup(root);
    assert.equal(code, 0);
    assert.deepEqual(parsed, { [READ_LANE_KEY]: true });
  });

  it('--apply MERGE-PRESERVES every existing key and flips readLane:false → true', () => {
    const { root, bundlePath } = makeDeployed({
      hook: BUNDLE_V,
      lanes: JSON.stringify({ _README: 'hi', otherLane: false, readLane: false }),
    });
    main(['--read-lane', '--apply', '--cwd', root], { ...capture(), bundlePath });
    const parsed = JSON.parse(readFileSync(lanesPath(root), 'utf8'));
    cleanup(root);
    assert.deepEqual(parsed, { _README: 'hi', otherLane: false, readLane: true });
  });

  it('--apply REFUSES a STALE placed hook — names the reseed route, writes nothing', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /NOT the current bundle/);
    assert.match(cap.out(), /--apply --reseed --cwd/); // path-agnostic; R2-M3 pins the absolute form
    assert.doesNotMatch(cap.out(), /rm /u);
    assert.equal(created, false, 'the toggle is never written when the hook is stale');
  });

  it('--apply REFUSES when the hook is not placed — names the place-first recovery', () => {
    const { root, bundlePath } = makeDeployed({}); // no hook placed
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /is not placed/);
  });

  it('the STALE / not-placed refusals carry the GATE_HOOK_STALE code (exit 1)', () => {
    const stale = makeDeployed({ hook: STALE });
    assert.throws(
      () => writeReadLane({ cwd: stale.root, dryRun: false }, { bundlePath: stale.bundlePath }),
      (e) => e.code === GATE_HOOK_STALE && e.exitCode === 1,
    );
    cleanup(stale.root);
  });

  it('--apply is idempotent: readLane already true → nothing-to-do, no *.tmp left behind', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, lanes: JSON.stringify({ readLane: true }) });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const leftovers = readdirSync(join(root, 'docs', 'ai')).filter((f) => f.includes('.tmp'));
    cleanup(root);
    assert.equal(code, 0);
    assert.match(cap.out(), /already enables the read-lane/);
    assert.deepEqual(leftovers, []);
  });

  it('REFUSES an absent docs/ai deployment (dry-run and apply) — never previews a write it cannot do', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-lane-nodep-'));
    const bundlePath = join(root, 'bundle.mjs');
    writeFileSync(bundlePath, BUNDLE_V);
    const dry = main(['--read-lane', '--cwd', root], { ...capture(), bundlePath });
    const apply = main(['--read-lane', '--apply', '--cwd', root], { ...capture(), bundlePath });
    cleanup(root);
    assert.equal(dry, 1);
    assert.equal(apply, 1);
  });

  it('refuses a SYMLINKED lanes.json target — the link target stays untouched', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V });
    writeFileSync(join(root, 'elsewhere.json'), '{}');
    symlinkSync(join(root, 'elsewhere.json'), lanesPath(root));
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const target = readFileSync(join(root, 'elsewhere.json'), 'utf8');
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /symlink/);
    assert.equal(target, '{}', 'the link target is never written through');
  });

  it('fail-closed on a MALFORMED existing lanes.json — never overwrites an unparseable toggle', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, lanes: '{ not json' });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const onDisk = readFileSync(lanesPath(root), 'utf8');
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /not valid JSON/);
    assert.equal(onDisk, '{ not json');
  });

  it('never touches gates.json or settings.json (only lanes.json is written)', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, gates: '{"gates":[]}' });
    const settingsBefore = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    main(['--read-lane', '--apply', '--cwd', root], { ...capture(), bundlePath });
    const gatesUntouched = readFileSync(gatesPath(root), 'utf8');
    const settingsUntouched = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    cleanup(root);
    assert.equal(gatesUntouched, '{"gates":[]}', 'gates.json is byte-untouched');
    assert.equal(settingsUntouched, settingsBefore, 'settings.json is byte-untouched (only lanes.json is written)');
  });

  it('--apply REFUSES a current hook that is NOT wired — names the wire-first recovery [B5]', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, wired: false });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /NOT wired/);
    assert.equal(created, false, 'the toggle is never written for an unwired hook — the lane could not fire');
  });

  it('--apply enforces the deployment stamp head — a wrong-lineage stamp REFUSES [B6]', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, stamp: '1.0.0' });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /lineage|1\.0\.0/);
    assert.equal(created, false, 'a wrong-stamp deployment is never written');
  });

  it('planReadLane exposes the merge base + currency-independent plan', () => {
    const { root } = makeDeployed({ hook: BUNDLE_V, lanes: JSON.stringify({ _README: 'x' }) });
    const plan = planReadLane({ cwd: root }, {});
    cleanup(root);
    assert.equal(plan.already, false);
    assert.deepEqual(plan.merged, { _README: 'x', readLane: true });
    assert.deepEqual(plan.otherKeys, ['_README']);
  });

  it('parseArgs accepts --read-lane; USAGE documents it', () => {
    assert.equal(parseArgs(['--read-lane']).readLane, true);
    assert.equal(parseArgs([]).readLane, false);
    const cap = capture();
    main(['--help'], cap);
    assert.match(cap.out(), /--read-lane/);
    assert.match(cap.out(), new RegExp(LANES_REL.replace(/[/.]/g, '\\$&')));
  });

  it('fail-closed on a NON-OBJECT lanes.json root (a JSON array) — never overwritten', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, lanes: '[]' });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const onDisk = readFileSync(lanesPath(root), 'utf8');
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /not a JSON object/);
    assert.equal(onDisk, '[]', 'the non-object store is left byte-untouched');
  });

  it('a TOCTOU vanish treats the toggle as absent; a non-ENOENT read error is a fail-closed STOP', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, lanes: JSON.stringify({ _README: 'x' }) });
    const lanesAbs = lanesPath(root);
    // (a) lstat saw a regular file, the read then ENOENTs → treated as absent → writes readLane:true.
    const enoent = (p, enc) => {
      if (p === lanesAbs) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return readFileSync(p, enc);
    };
    const okResult = writeReadLane({ cwd: root, dryRun: false }, { bundlePath, readFile: enoent });
    assert.equal(okResult.wrote, true);
    assert.deepEqual(JSON.parse(readFileSync(lanesAbs, 'utf8')), { readLane: true });
    // (b) a non-ENOENT read error on an existing store → fail-closed STOP, nothing overwritten.
    writeFileSync(lanesAbs, JSON.stringify({ _README: 'x' }));
    const eacces = (p, enc) => {
      if (p === lanesAbs) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return readFileSync(p, enc);
    };
    assert.throws(
      () => writeReadLane({ cwd: root, dryRun: false }, { bundlePath, readFile: eacces }),
      (e) => /cannot read.*refusing to overwrite/.test(e.message) && e.exitCode === 1,
    );
    cleanup(root);
  });

  it('a SYMLINKED placed hook is a hard STOP (never touched)', () => {
    const { root, bundlePath } = makeDeployed({});
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'real-hook.mjs'), BUNDLE_V);
    symlinkSync(join(root, 'real-hook.mjs'), hookPath(root));
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /not a regular file/);
  });

  it('dry-run with the lane ALREADY enabled reports nothing-to-do (DRY RUN)', () => {
    const { root, bundlePath } = makeDeployed({ hook: BUNDLE_V, lanes: JSON.stringify({ readLane: true }) });
    const cap = capture();
    const code = main(['--read-lane', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    assert.equal(code, 0);
    assert.match(cap.out(), /DRY RUN: .*already enables the read-lane/);
  });

  it('dry-run surfaces the wired + stamp warnings that would block --apply (council B5/B6 preview)', () => {
    const unwired = makeDeployed({ hook: BUNDLE_V, wired: false });
    const cap1 = capture();
    main(['--read-lane', '--cwd', unwired.root], { ...cap1, bundlePath: unwired.bundlePath });
    cleanup(unwired.root);
    assert.match(cap1.out(), /hook wiring: NOT wired/);
    const badStamp = makeDeployed({ hook: BUNDLE_V, stamp: '1.0.0' });
    const cap2 = capture();
    main(['--read-lane', '--cwd', badStamp.root], { ...cap2, bundlePath: badStamp.bundlePath });
    cleanup(badStamp.root);
    assert.match(cap2.out(), /deployment stamp: 1\.0\.0 . lineage head/);
  });

  it('the stale recovery names the reseed route with an ABSOLUTE root and no rm (council R2-M3)', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    // the reseed route pins the absolute root — the recovery run from ANY cwd can only replace THIS
    // repo's hook, never a sibling project's.
    assert.ok(root.startsWith('/'));
    assert.ok(cap.out().includes(`--apply --reseed --cwd ${root}`), cap.out());
    assert.doesNotMatch(cap.out(), /rm /u);
  });
});
