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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  memFs({ ...extra, files: { [STAMP_ABS]: '3.0.0\n', ...(extra.files ?? {}) } });

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
  // council B5). stamp (default '3.0.0' = the lineage head): the deployment stamp (--read-lane --apply
  // enforces it, council B6); null skips it.
  const makeDeployed = ({ hook, lanes, gates, wired = true, stamp = '3.0.0' } = {}) => {
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

  it('--apply REFUSES a STALE placed hook — names the delete-to-reseed recovery, writes nothing', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    const code = main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    const created = existsSync(lanesPath(root));
    cleanup(root);
    assert.equal(code, 1);
    assert.match(cap.out(), /NOT the current bundle/);
    assert.match(cap.out(), /rm \S*agent-workflow-gates\.mjs/); // path-agnostic; R2-M3 pins the absolute form
    assert.match(cap.out(), /--apply --cwd/);
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

  it('the stale recovery names an ABSOLUTE hook path, never a cwd-relative rm (council R2-M3)', () => {
    const { root, bundlePath } = makeDeployed({ hook: STALE });
    const cap = capture();
    main(['--read-lane', '--apply', '--cwd', root], { ...cap, bundlePath });
    cleanup(root);
    // the rm target is the absolute path under the pinned root — the recovery run from ANY cwd can
    // only delete THIS repo's hook, never a sibling project's.
    assert.match(cap.out(), /rm \/[^\s]*\.claude\/hooks\/agent-workflow-gates\.mjs/);
    assert.doesNotMatch(cap.out(), /rm \.claude\/hooks/);
  });
});
