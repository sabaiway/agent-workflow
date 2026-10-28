// gate-hook.test.mjs — acceptance spec for the gate-hook writer CLI (gate-hook.mjs). Hermetic:
// injected in-memory fs, the velocity/cheap-agents test idiom. The load-bearing claims:
//   • preview-then-mutate (dry-run default, zero writes) and the EXACT settings fixture;
//   • merge-don't-clobber (foreign hooks/matchers/keys + permissions preserved semantically,
//     EOL preserved, idempotent re-apply is a zero-diff no-op);
//   • malformed existing `hooks` shape → STOP with ZERO writes;
//   • a differing target is written with the kit's body in place; the entry is wired only while
//     it is wired in neither settings file;
//   • stamp/symlink/unsafe-mode STOPs (both settings files); settings.local.json never written;
//   • place-then-wire ORDER, observable on an injected mid-failure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { statSync } from 'node:fs';
import * as gateHook from './gate-hook.mjs';
import { fileLine } from './distribution-files/index.mjs';

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
  applyGateHookCommand,
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
  memFs({ ...extra, files: { [STAMP_ABS]: '5.0.0\n', ...(extra.files ?? {}) } });

const wiredSettings = (extra = {}) =>
  JSON.stringify({ hooks: { PreToolUse: [buildHookSettingsEntry()] }, ...extra });

const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};

describe('spec:init-project/S27 the plain gate-hook writer by proof', () => {
  const DIVERGED = '// an older placed hook, longer than the bundled runtime it is replaced by\n';
  const hookLine = (dryRun) =>
    `${HOOK_FILE_REL}: differs from the body the kit writes for it — ${dryRun ? 'would be written' : 'written'} with that body; a hook of your own goes in .claude/hooks/<name>.local.mjs`;
  const RETIRED = /reseed|preserved|never clobbered|\brm\b/iu;
  const capture = () => {
    const lines = [];
    return {
      log: (line) => lines.push(String(line)),
      errlog: (line) => lines.push(String(line)),
      out: () => lines.join('\n'),
    };
  };
  const planOf = ({ placePlanned, replacePlanned, wirePlanned }) => ({ placePlanned, replacePlanned, wirePlanned });

  it('each dry run plans by the file and the wiring, prints the differing line and writes nothing', () => {
    const states = [
      { name: 'differing wired', files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings() }, plan: [false, true, false] },
      { name: 'differing unwired', files: { [HOOK_ABS]: DIVERGED }, plan: [false, true, true] },
      { name: 'absent', files: {}, plan: [true, false, true] },
      { name: 'current wired', files: { [HOOK_ABS]: BUNDLE_CONTENT, [LOCAL_ABS]: wiredSettings() }, plan: [false, false, false] },
      { name: 'current unwired', files: { [HOOK_ABS]: BUNDLE_CONTENT }, plan: [false, false, true] },
    ];
    for (const state of states) {
      const fs = deployedFs({ files: state.files });
      const before = new Map(fs.store);
      const result = writeGateHook({ cwd: PROJ, dryRun: true }, fs);
      const [placePlanned, replacePlanned, wirePlanned] = state.plan;
      assert.deepEqual(planOf(result), { placePlanned, replacePlanned, wirePlanned }, state.name);
      assert.equal(result.wrote, false);
      assert.equal('reseed' in result || 'reseedPlanned' in result, false, state.name);
      const cap = capture();
      assert.equal(main(['--cwd', PROJ], { ...fs, ...cap }), 0, cap.out());
      const lines = cap.out().split('\n');
      assert.equal(lines[0], 'agent-workflow gate hook — DRY RUN (no changes; re-run with --apply)');
      assert.equal(lines.includes(`  - ${hookLine(true)}`), replacePlanned, `${state.name}: ${cap.out()}`);
      assert.doesNotMatch(cap.out(), RETIRED);
      assert.deepEqual(fs.writes, []);
      assert.deepEqual(fs.store, before);
    }
  });

  it('the differing line is fileLine of the index over the state hook, and the module imports it from the index', () => {
    const source = readFileSync(new URL('./gate-hook.mjs', import.meta.url), 'utf8');
    const fromIndex = /^import \{[^}]*\bfileLine\b[^}]*\} from '\.\/distribution-files\/index\.mjs';$/mu;
    assert.ok(fromIndex.test(source), 'gate-hook.mjs imports fileLine from ./distribution-files/index.mjs');
    assert.equal(/reseed/iu.test(source), false, 'gate-hook.mjs names no reseed');
    assert.equal('applyReseedCommand' in gateHook, false);
    assert.equal(fileLine({ rel: HOOK_FILE_REL, state: 'hook' }, undefined, true), hookLine(true));
    assert.equal(fileLine({ rel: HOOK_FILE_REL, state: 'hook' }, 'written', false), hookLine(false));
  });

  it('the apply writes the kit body in place, wires only an unwired hook, and a second apply writes nothing', () => {
    for (const state of ['differing wired', 'differing unwired', 'absent']) {
      const root = mkdtempSync(join(tmpdir(), 'gate-hook-apply-'));
      try {
        mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
        mkdirSync(join(root, '.claude'), { recursive: true });
        const bundlePath = join(root, 'bundle-gate-approve.mjs');
        const hookPath = join(root, HOOK_FILE_REL);
        const settingsPath = join(root, '.claude', 'settings.json');
        const localPath = join(root, '.claude', 'settings.local.json');
        const wired = state === 'differing wired';
        const localBytes = '{"otherLocal":"kept"}\n';
        const settingsBytes = wired ? `${wiredSettings()}\n` : '{"otherProject":"kept"}\n';
        writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '5.0.0\n');
        writeFileSync(bundlePath, BUNDLE_CONTENT);
        writeFileSync(settingsPath, settingsBytes);
        writeFileSync(localPath, localBytes);
        if (state !== 'absent') {
          mkdirSync(join(root, '.claude', 'hooks'));
          writeFileSync(hookPath, DIVERGED);
        }
        const inodeBefore = state === 'absent' ? null : statSync(hookPath).ino;
        const writes = [];
        const deps = { bundlePath, writeFile: (path, ...args) => writes.push(path) && writeFileSync(path, ...args) };
        const cap = capture();
        assert.equal(main(['--apply', '--cwd', root], { ...deps, ...cap }), 0, cap.out());
        assert.equal(readFileSync(hookPath, 'utf8'), BUNDLE_CONTENT, state);
        if (inodeBefore !== null) assert.equal(statSync(hookPath).ino, inodeBefore);
        assert.deepEqual(writes, wired ? [hookPath] : [hookPath, settingsPath], state);
        const lines = cap.out().split('\n');
        assert.equal(lines[0], 'agent-workflow gate hook — APPLY');
        assert.ok(lines.includes(state === 'absent' ? `  - ${HOOK_FILE_REL}: placed` : `  - ${hookLine(false)}`), cap.out());
        assert.doesNotMatch(cap.out(), RETIRED);
        const settingsAfter = readFileSync(settingsPath, 'utf8');
        if (wired) assert.equal(settingsAfter, settingsBytes);
        else assert.deepEqual(JSON.parse(settingsAfter), { otherProject: 'kept', hooks: { PreToolUse: [buildHookSettingsEntry()] } });
        assert.equal(readFileSync(localPath, 'utf8'), localBytes);
        const second = capture();
        assert.equal(main(['--apply', '--cwd', root], { ...deps, ...second }), 0, second.out());
        assert.equal(writes.length, wired ? 1 : 2, second.out());
        assert.ok(second.out().split('\n').includes(`  - ${HOOK_FILE_REL}: already current`), second.out());
        assert.equal(readFileSync(settingsPath, 'utf8'), settingsAfter);
        assert.equal(readFileSync(localPath, 'utf8'), localBytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('a link or non-regular target, the stamp, an unsafe mode and malformed settings refuse with nothing written', () => {
    for (const fixture of [{ symlinks: [HOOK_ABS] }, { dirs: [HOOK_ABS] }]) {
      for (const dryRun of [true, false]) {
        const fs = deployedFs(fixture);
        const cap = capture();
        assert.equal(main([...(dryRun ? [] : ['--apply']), '--cwd', PROJ], { ...fs, ...cap }), 1, cap.out());
        assert.ok(cap.out().includes(`${HOOK_FILE_REL} exists but is not a regular file`), cap.out());
        assert.deepEqual(fs.writes, []);
      }
    }
    const states = [
      { files: { [STAMP_ABS]: '1.0.0\n' }, code: GATE_HOOK_STAMP, message: /lineage/u },
      { files: { [SETTINGS_ABS]: wiredSettings({ permissions: { defaultMode: 'bypassPermissions' } }) }, code: GATE_HOOK_UNSAFE_MODE, message: /bypassPermissions/u },
      { files: { [SETTINGS_ABS]: JSON.stringify({ hooks: { PreToolUse: {} } }) }, code: GATE_HOOK_MALFORMED, message: /"hooks.PreToolUse" must be an array/u },
    ];
    for (const state of states) {
      const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings(), ...state.files } });
      const before = new Map(fs.store);
      if (state.code === GATE_HOOK_STAMP) assert.equal(writeGateHook({ cwd: PROJ, dryRun: true }, fs).stampOk, false);
      assert.throws(() => writeGateHook({ cwd: PROJ, dryRun: false }, fs), (err) => err.code === state.code && state.message.test(err.message));
      const cap = capture();
      assert.equal(main(['--apply', '--cwd', PROJ], { ...fs, ...cap }), 1, cap.out());
      assert.deepEqual(fs.writes, []);
      assert.deepEqual(fs.store, before);
    }
  });

  it('a file swapped after its write refuses the wiring by GATE_HOOK_DIVERGED with the settings untouched', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED } });
    const swapAfterWrite = (path, content) => fs.writeFile(path, path === HOOK_ABS ? 'swapped by an external process' : content);
    assert.throws(
      () => writeGateHook({ cwd: PROJ, dryRun: false }, { ...fs, writeFile: swapAfterWrite }),
      (err) => err.code === GATE_HOOK_DIVERGED && err.message.includes('changed after preflight'),
    );
    assert.deepEqual(fs.writes.map((write) => write.path), [HOOK_ABS]);
    assert.equal(fs.store.has(SETTINGS_ABS), false);
  });

  it('--reseed exits 2 naming the unknown argument with nothing read', () => {
    for (const argv of [['--reseed'], ['--apply', '--reseed']]) {
      const fs = deployedFs({ files: { [HOOK_ABS]: DIVERGED, [SETTINGS_ABS]: wiredSettings() } });
      const reads = [];
      const seen = (fn) => (path, ...args) => reads.push(path) && fn(path, ...args);
      const cap = capture();
      const deps = { ...fs, exists: seen(fs.exists), lstat: seen(fs.lstat), readFile: seen(fs.readFile), ...cap };
      assert.equal(main([...argv, '--cwd', PROJ], deps), 2, cap.out());
      assert.equal(cap.out().split('\n')[0], 'unknown argument: --reseed');
      assert.deepEqual(reads, []);
      assert.deepEqual(fs.writes, []);
    }
  });

  it('a valid project file beside a local file whose hooks.PreToolUse is an object stops neither mode', () => {
    for (const dryRun of [true, false]) {
      const fs = deployedFs({ files: { [SETTINGS_ABS]: '{}', [LOCAL_ABS]: JSON.stringify({ hooks: { PreToolUse: {} } }) } });
      const cap = capture();
      assert.equal(main([...(dryRun ? [] : ['--apply']), '--cwd', PROJ], { ...fs, ...cap }), 0, cap.out());
      assert.deepEqual(fs.writes.map((write) => write.path), dryRun ? [] : [HOOK_ABS, SETTINGS_ABS]);
    }
  });

  it('every recovery names gate-hook --apply with the absolute root, a relative --cwd resolved, and help names no reseed', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-recovery-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      const bundlePath = join(root, 'bundle-gate-approve.mjs');
      writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '5.0.0\n');
      writeFileSync(bundlePath, BUNDLE_CONTENT);
      writeFileSync(join(root, '.claude', 'settings.json'), wiredSettings());
      writeFileSync(join(root, HOOK_FILE_REL), DIVERGED);
      const rel = relative(process.cwd(), root);
      assert.notEqual(rel, root);
      const refused = capture();
      assert.equal(main(['--read-lane', '--apply', '--cwd', rel], { bundlePath, ...refused }), 1, refused.out());
      const dry = capture();
      assert.equal(main(['--read-lane', '--cwd', rel], { bundlePath, ...dry }), 0, dry.out());
      assert.match(dry.out(), /hook currency: STALE/u);
      unlinkSync(join(root, HOOK_FILE_REL));
      const absent = capture();
      assert.equal(main(['--read-lane', '--apply', '--cwd', rel], { bundlePath, ...absent }), 1, absent.out());
      for (const text of [refused.out(), dry.out(), absent.out()]) {
        assert.ok(text.includes(applyGateHookCommand(root)), text);
        assert.ok(!text.includes(`--cwd ${rel}`), text);
        assert.doesNotMatch(text, RETIRED);
      }
      const help = capture();
      assert.equal(main(['--help'], help), 0);
      assert.ok(help.out().includes('gate-hook --apply --cwd <dir>'), help.out());
      assert.doesNotMatch(help.out(), RETIRED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a hook swapped for a link before the write, a platform without no-follow and a link planted before the create refuse', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-hook-late-link-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      const bundlePath = join(root, 'bundle-gate-approve.mjs');
      const hookPath = join(root, HOOK_FILE_REL);
      const settingsPath = join(root, '.claude', 'settings.json');
      const foreignPath = join(root, 'foreign.mjs');
      writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), '5.0.0\n');
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
      assert.equal(main(['--apply', '--cwd', root], { bundlePath, writeFile: swap, ...linked }), 1, linked.out());
      assert.match(linked.out(), /changed before the write — refusing to write through it/u);
      assert.equal(readFileSync(foreignPath, 'utf8'), 'foreign bytes\n');
      assert.equal(readFileSync(settingsPath, 'utf8'), `${wiredSettings()}\n`);
      unlinkSync(hookPath);
      writeFileSync(hookPath, DIVERGED);
      const bare = capture();
      assert.equal(main(['--apply', '--cwd', root], { bundlePath, noFollow: null, ...bare }), 1, bare.out());
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

  it('a STOP surfaces on stderr, names its path and exits 1', () => {
    const fs = deployedFs({ symlinks: [HOOK_ABS] });
    const err = [];
    const code = main(['--apply'], { ...fs, cwd: PROJ, log: () => {}, errlog: (line) => err.push(line) });
    assert.equal(code, 1);
    assert.ok(err.join('\n').includes(HOOK_FILE_REL));
    assert.doesNotMatch(err.join('\n'), /delete|reseed/u);
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
  // council B5). stamp (default '5.0.0' = the lineage head): the deployment stamp (--read-lane --apply
  // enforces it, council B6); null skips it.
  const makeDeployed = ({ hook, lanes, gates, wired = true, stamp = '5.0.0' } = {}) => {
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

  it('--apply REFUSES a STALE placed hook — names the gate-hook --apply route, writes nothing', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /NOT the current bundle/);
    assert.ok(cap.out().includes(applyGateHookCommand(root)), cap.out());
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

  it('the stale recovery names the gate-hook --apply route with an ABSOLUTE root and no rm (council R2-M3)', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    // the recovery pins the absolute root — run from ANY cwd it can only write THIS repo's hook,
    // never a sibling project's.
    assert.ok(root.startsWith('/'));
    assert.ok(cap.out().includes(`--apply --cwd ${root}`), cap.out());
    assert.doesNotMatch(cap.out(), /rm |reseed/u);
  });
});
