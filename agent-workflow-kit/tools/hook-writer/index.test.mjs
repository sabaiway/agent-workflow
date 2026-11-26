import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL, SETTINGS, STAMP, makeHookProject, plantLink, put, snapshot } from './hook-harness.test.mjs';

const loadDoor = () => import('./index.mjs');

const HOOK = '.claude/hooks/sample-kit-hook.mjs';
const BUNDLE_REL = 'kit/sample-kit-hook.mjs';
const BUNDLE_BYTES = 'export const sample = 1;\n';
const EVENT = 'PostToolUse';
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sample-kit-hook.mjs"';
const ENTRY = Object.freeze({ matcher: 'Write', hooks: Object.freeze([Object.freeze({ type: 'command', command: COMMAND })]) });
const FOREIGN_PRE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] };
const FOREIGN_EVENT = { matcher: 'foreign', hooks: [{ type: 'command', command: 'echo post' }] };
const PERMISSIONS = { allow: ['Read'], defaultMode: 'default' };
const BEFORE = { hooks: { PreToolUse: [FOREIGN_PRE], [EVENT]: [FOREIGN_EVENT] }, permissions: PERMISSIONS };
const WIRED = { ...BEFORE, hooks: { ...BEFORE.hooks, [EVENT]: [FOREIGN_EVENT, ENTRY] } };
const LINES = Object.freeze({
  title: 'sample kit hook',
  commandNote: `command: ${COMMAND} (the sample note)`,
  reload: 'the sample hook runs from the next file write',
  merge: Object.freeze({
    'no-hooks': 'the hooks key with the PostToolUse entry',
    'no-event': 'the PostToolUse key beside the existing hooks',
    append: 'one element to the existing hooks.PostToolUse array',
  }),
  bypassReason: 'refusing to wire the sample hook beside it',
  trustPosture: 'trust posture: the sample hook reads nothing and approves nothing.',
  nothingToChange: 'nothing to change: the sample kit hook is placed, current and wired',
});

const runsSampleHook = (hook) => hook?.type === 'command' && hook.command === COMMAND;
const isSampleWired = (data) => Array.isArray(data?.hooks?.[EVENT])
  && data.hooks[EVENT].some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some(runsSampleHook));

const makeProject = (t, options = {}) => {
  const root = makeHookProject(t, { prefix: 'hook-writer-', hookRel: HOOK, ...options });
  put(root, BUNDLE_REL, BUNDLE_BYTES);
  return root;
};
const describeHook = (root, overrides = {}) => Object.freeze({
  fileRel: HOOK,
  bundlePath: join(root, BUNDLE_REL),
  event: EVENT,
  entry: ENTRY,
  isWired: isSampleWired,
  refusesUnsafeModes: true,
  lines: LINES,
  ...overrides,
});
const readOrNull = (path) => (existsSync(path) ? readFileSync(path) : null);
const recordingWrites = (writes, after = () => {}) => ({
  writeFile: (path, ...args) => {
    writes.push(path);
    writeFileSync(path, ...args);
    after(path);
  },
});

describe('spec:hook-writer/S1 a description\'s dry run plans exactly what its apply writes', () => {
  it('plans create, replace and keep by the bytes and the merge while neither settings file is wired, and the apply writes exactly that', async (t) => {
    const { writeKitHook } = await loadDoor();
    const placements = [
      { placement: 'create', hook: undefined },
      { placement: 'replace', hook: 'older body\n' },
      { placement: 'keep', hook: BUNDLE_BYTES },
    ];
    const wirings = [
      { name: 'unwired', options: { settings: BEFORE }, mergePlanned: true },
      { name: 'wired in the project file', options: { settings: WIRED }, mergePlanned: false },
      { name: 'wired in the local file alone', options: { settings: BEFORE, local: { hooks: { [EVENT]: [ENTRY] } } }, mergePlanned: false },
    ];
    const rows = placements.flatMap((placement) => wirings.map((wiring) => ({
      ...placement,
      wiring,
      root: makeProject(t, { hook: placement.hook, ...wiring.options }),
    })));
    for (const row of rows) {
      const hook = describeHook(row.root);
      const label = `${row.placement}, ${row.wiring.name}`;
      const settingsPath = join(row.root, SETTINGS);
      const localPath = join(row.root, LOCAL);
      const before = snapshot(row.root);
      const settingsBefore = readOrNull(settingsPath);
      const localBefore = readOrNull(localPath);
      const plan = writeKitHook(hook, { cwd: row.root, dryRun: true }, {});
      assert.equal(plan.placement, row.placement, label);
      assert.equal(plan.placePlanned, row.placement !== 'keep', label);
      assert.equal(plan.mergePlanned, row.wiring.mergePlanned, label);
      assert.deepEqual(snapshot(row.root), before, label);
      const writes = [];
      writeKitHook(hook, { cwd: row.root, dryRun: false }, recordingWrites(writes));
      const expected = [
        ...(plan.placePlanned ? [join(row.root, HOOK)] : []),
        ...(plan.mergePlanned ? [settingsPath] : []),
      ];
      assert.deepEqual(writes, expected, label);
      assert.equal(readFileSync(join(row.root, HOOK), 'utf8'), BUNDLE_BYTES, label);
      assert.deepEqual(readOrNull(localPath), localBefore, label);
      if (plan.mergePlanned) {
        assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), WIRED, label);
      } else {
        assert.deepEqual(readOrNull(settingsPath), settingsBefore, label);
      }
      const again = writeKitHook(hook, { cwd: row.root, dryRun: true }, {});
      assert.equal(again.placement, 'keep', label);
      assert.equal(again.placePlanned, false, label);
      assert.equal(again.mergePlanned, false, label);
    }
  });

  it('mergeHookEntryInto appends the one entry to the event and keeps every foreign key, entry and matcher', async () => {
    const { mergeHookEntryInto } = await loadDoor();
    const rows = [
      { base: {}, merged: { hooks: { [EVENT]: [ENTRY] } } },
      { base: { hooks: { PreToolUse: [FOREIGN_PRE] } }, merged: { hooks: { PreToolUse: [FOREIGN_PRE], [EVENT]: [ENTRY] } } },
      { base: BEFORE, merged: WIRED },
    ];
    for (const row of rows) {
      const merged = mergeHookEntryInto(row.base, EVENT, ENTRY);
      assert.deepEqual(merged, row.merged);
      assert.equal(merged.hooks[EVENT].at(-1).matcher, ENTRY.matcher);
    }
    assert.deepEqual(mergeHookEntryInto(BEFORE, EVENT, ENTRY).permissions, PERMISSIONS);
    assert.deepEqual(mergeHookEntryInto(BEFORE, EVENT, ENTRY).hooks.PreToolUse, [FOREIGN_PRE]);
  });

  it('formatKitHookResult prints the description\'s own lines', async (t) => {
    const { formatKitHookResult, writeKitHook } = await loadDoor();
    const root = makeProject(t, { settings: BEFORE });
    const hook = describeHook(root);
    const planned = formatKitHookResult(hook, writeKitHook(hook, { cwd: root, dryRun: true }, {})).split('\n');
    assert.ok(planned[0].includes(LINES.title), planned[0]);
    assert.ok(planned.includes(`  ${LINES.commandNote}`), planned.join('\n'));
    assert.ok(planned.includes(LINES.trustPosture), planned.join('\n'));
    const applied = formatKitHookResult(hook, writeKitHook(hook, { cwd: root, dryRun: false }, {}));
    assert.ok(applied.includes(LINES.reload), applied);
    assert.equal(formatKitHookResult(hook, writeKitHook(hook, { cwd: root, dryRun: true }, {})), LINES.nothingToChange);
  });
});

describe('spec:hook-writer/S2 the apply stops before any write, with gate-hook\'s error codes', () => {
  it('a stamp behind the head stops the apply with GATE_HOOK_STAMP and nothing written, the dry run reporting it', async (t) => {
    const { writeKitHook } = await loadDoor();
    const root = makeProject(t, { settings: BEFORE, stamp: '0.0.0' });
    const before = snapshot(root);
    const plan = writeKitHook(describeHook(root), { cwd: root, dryRun: true }, {});
    assert.equal(plan.stampOk, false);
    assert.equal(plan.stamp, '0.0.0');
    assert.throws(() => writeKitHook(describeHook(root), { cwd: root, dryRun: false }, {}), { code: 'GATE_HOOK_STAMP' });
    assert.deepEqual(snapshot(root), before);
  });

  it('a malformed event shape and a link at the hook path stop the dry run and the apply with nothing written', async (t) => {
    const { writeKitHook } = await loadDoor();
    const rows = [
      { setup: (root) => put(root, SETTINGS, `{"hooks":{"${EVENT}":{}}}`), code: 'GATE_HOOK_MALFORMED', message: `"hooks.${EVENT}" must be an array` },
      { setup: (root) => plantLink(root, HOOK), code: 'GATE_HOOK_SYMLINK', message: `${HOOK} exists but is not a regular file — refusing to touch it` },
    ];
    for (const row of rows) {
      const root = makeProject(t);
      row.setup(root);
      const before = snapshot(root);
      for (const dryRun of [true, false]) {
        assert.throws(() => writeKitHook(describeHook(root), { cwd: root, dryRun }, {}), (err) => err.code === row.code && err.message.includes(row.message));
        assert.deepEqual(snapshot(root), before);
      }
    }
  });

  it('a differing hook swapped for a link before its replace refuses with nothing written through the link', async (t) => {
    const { writeKitHook } = await loadDoor();
    const root = makeProject(t, { settings: BEFORE, hook: 'older body\n' });
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
    assert.throws(() => writeKitHook(describeHook(root), { cwd: root, dryRun: false }, { writeFile }), {
      code: 'GATE_HOOK_SYMLINK',
      message: /changed before the write — refusing to write through it/u,
    });
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign bytes\n');
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
  });

  it('an unsafe mode stops a description that applies the refusal and not one that does not', async (t) => {
    const { writeKitHook } = await loadDoor();
    const modes = [
      { name: 'bypass in the project file', options: { settings: { permissions: { defaultMode: 'bypassPermissions' } } }, message: LINES.bypassReason },
      { name: 'unknown mode in the local file', options: { local: { permissions: { defaultMode: 'unknownMode' } } }, message: 'an unsafe or unknown permissions.defaultMode is present in Claude settings' },
    ];
    for (const mode of modes) {
      const refusing = makeProject(t, mode.options);
      const before = snapshot(refusing);
      for (const dryRun of [true, false]) {
        assert.throws(
          () => writeKitHook(describeHook(refusing), { cwd: refusing, dryRun }, {}),
          (err) => err.code === 'GATE_HOOK_UNSAFE_MODE' && err.message.includes(mode.message),
          mode.name,
        );
        assert.deepEqual(snapshot(refusing), before, mode.name);
      }
      const installing = makeProject(t, mode.options);
      const hook = describeHook(installing, { refusesUnsafeModes: false });
      const plan = writeKitHook(hook, { cwd: installing, dryRun: true }, {});
      assert.equal(plan.placement, 'create', mode.name);
      assert.equal(plan.mergePlanned, true, mode.name);
      writeKitHook(hook, { cwd: installing, dryRun: false }, {});
      assert.equal(readFileSync(join(installing, HOOK), 'utf8'), BUNDLE_BYTES, mode.name);
      assert.equal(isSampleWired(JSON.parse(readFileSync(join(installing, SETTINGS), 'utf8'))), true, mode.name);
    }
  });

  it('a placed file swapped for a link or other bytes after its write leaves the settings untouched', async (t) => {
    const { writeKitHook } = await loadDoor();
    const swaps = [
      { name: 'a link', code: 'GATE_HOOK_SYMLINK', swap: (path, backing) => { unlinkSync(path); symlinkSync(backing, path); }, isLink: true },
      { name: 'other bytes', code: 'GATE_HOOK_DIVERGED', swap: (path) => writeFileSync(path, 'foreign bytes\n'), isLink: false },
    ];
    for (const row of swaps) {
      const root = makeProject(t, { settings: BEFORE });
      const settingsPath = join(root, SETTINGS);
      const settings = readFileSync(settingsPath);
      const inode = statSync(settingsPath).ino;
      const hookPath = join(root, HOOK);
      const backing = join(root, 'foreign-hook.mjs');
      writeFileSync(backing, 'foreign bytes\n');
      const writes = [];
      const deps = recordingWrites(writes, (path) => {
        if (path === hookPath) row.swap(path, backing);
      });
      assert.throws(() => writeKitHook(describeHook(root), { cwd: root, dryRun: false }, deps), { code: row.code }, row.name);
      assert.deepEqual(writes, [hookPath], row.name);
      assert.equal(lstatSync(hookPath).isSymbolicLink(), row.isLink, row.name);
      assert.deepEqual(readFileSync(settingsPath), settings, row.name);
      assert.equal(statSync(settingsPath).ino, inode, row.name);
      assert.equal(readFileSync(backing, 'utf8'), 'foreign bytes\n', row.name);
    }
  });
});

describe('spec:hook-writer/S3 the door imports the two refusals and every hardened check from gate-hook.mjs and restates none', () => {
  const HARDENED = ['fsDeps', 'assertDirSafe', 'assertSettingsWritable', 'planTarget', 'assertHooksShape', 'readStamp', 'formatJson', 'writeHookFile'];
  const REFUSALS = ['assertSafeModes', 'assertStampCurrent'];
  const FORBIDDEN = ['lstat', 'isSymbolicLink', 'must be an array', 'must be a JSON object'];
  const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('the door exports exactly its three names and gate-hook.mjs exports the two refusals', async () => {
    const door = await loadDoor();
    assert.deepEqual(Object.keys(door).sort(), ['formatKitHookResult', 'mergeHookEntryInto', 'writeKitHook']);
    const gateHook = await import('../gate-hook.mjs');
    for (const name of REFUSALS) assert.equal(typeof gateHook[name], 'function', name);
  });

  it('the door imports the refusals, the hardened checks and fileLine by name and restates none', () => {
    const source = readSource('./index.mjs');
    const imports = [...source.matchAll(/import\s*\{([^{}]*)\}\s*from\s*['"]\.\.\/gate-hook\.mjs['"]/gu)];
    assert.equal(imports.length, 1);
    const names = imports[0][1].split(',').map((name) => name.trim()).filter(Boolean);
    for (const name of [...REFUSALS, ...HARDENED]) {
      assert.ok(names.includes(name), `${name} must be imported by name from ../gate-hook.mjs`);
    }
    assert.match(source, /^import \{[^}]*\bfileLine\b[^}]*\} from '\.\.\/distribution-files\/index\.mjs';$/mu);
    for (const forbidden of FORBIDDEN) assert.equal(source.includes(forbidden), false, forbidden);
  });

  it('state-block-hook.mjs imports the door', () => {
    assert.match(readSource('../state-block-hook.mjs'), /from\s*['"]\.\/hook-writer\/index\.mjs['"]/u);
  });
});
