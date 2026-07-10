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
import { join } from 'node:path';

import {
  GATE_HOOK_DIVERGED,
  GATE_HOOK_MALFORMED,
  GATE_HOOK_STAMP,
  GATE_HOOK_SYMLINK,
  GATE_HOOK_UNSAFE_MODE,
  HOOK_COMMAND,
  HOOK_FILE_REL,
  buildHookSettingsEntry,
  formatResult,
  main,
  parseArgs,
  writeGateHook,
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
  memFs({ ...extra, files: { [STAMP_ABS]: '2.0.0\n', ...(extra.files ?? {}) } });

const wiredSettings = (extra = {}) =>
  JSON.stringify({ hooks: { PreToolUse: [buildHookSettingsEntry()] }, ...extra });

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

  it('a STOP surfaces on stderr and exits 1', () => {
    const fs = deployedFs({ files: { [HOOK_ABS]: 'diverged' } });
    const err = [];
    const code = main(['--apply'], { ...fs, cwd: PROJ, log: () => {}, errlog: (line) => err.push(line) });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /delete the file to reseed/u);
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
