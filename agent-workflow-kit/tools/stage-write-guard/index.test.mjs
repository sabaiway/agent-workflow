import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileLine } from '../distribution-files/index.mjs';
import { LOCAL, SETTINGS, makeHookProject, plantLink, snapshot } from '../hook-writer/hook-harness.test.mjs';

const loadDoor = () => import('./index.mjs');

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../../references/hooks/stage-write-guard.mjs', import.meta.url));
const HOOK = '.claude/hooks/stage-write-guard.mjs';
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stage-write-guard.mjs"';
const MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
const EVENT = 'PreToolUse';
const NOTHING_TO_CHANGE = 'nothing to change: the stage guard hook is placed, current and wired';
const TITLE = 'agent-workflow stage guard hook — ';
const RELOAD = 'the guard runs from the next file write';
const TRUST_POSTURE = 'trust posture: the guard reads the stage record and the orchestration config on each file write of the edit tools and prints one deny or nothing; it makes no network call, writes nothing and approves nothing.';
const COMMAND_NOTE = '  command: ';
const DRY_RUN_PLACE = `  - ${HOOK}: would place`;
const SETTINGS_WOULD_ADD = `  - ${SETTINGS}: would add `;
const FOREIGN_PRE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] };
const FOREIGN_STOP = { matcher: 'foreign', hooks: [{ type: 'command', command: 'echo stop' }] };
const PERMISSIONS = { allow: ['Read'], defaultMode: 'default' };
const BEFORE = { hooks: { PreToolUse: [FOREIGN_PRE], Stop: [FOREIGN_STOP] }, permissions: PERMISSIONS };

const makeProject = (t, options = {}) => makeHookProject(t, { prefix: 'stage-guard-writer-', hookRel: HOOK, ...options });
const runCli = (args) => {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: run.status, out: run.stdout, err: run.stderr, lines: run.stdout.split('\n') };
};
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const readOrNull = (path) => (existsSync(path) ? readFileSync(path) : null);
const withEntry = (settings, entry) => ({ ...settings, hooks: { ...settings.hooks, [EVENT]: [...(settings.hooks?.[EVENT] ?? []), entry] } });

describe('spec:stage-write-guard/S7 the writer places the bundled hook and wires its entry through the hook writer', () => {
  it('the door exports exactly its five names, the command and the matcher', async () => {
    const door = await loadDoor();
    assert.deepEqual(Object.keys(door).sort(), [
      'STAGE_GUARD_HOOK_COMMAND', 'STAGE_GUARD_MATCHER', 'buildStageGuardEntry', 'isStageGuardWired', 'writeStageGuard',
    ]);
    assert.equal(door.STAGE_GUARD_HOOK_COMMAND, COMMAND);
    assert.equal(door.STAGE_GUARD_MATCHER, MATCHER);
    const entry = door.buildStageGuardEntry();
    assert.equal(entry.matcher, MATCHER);
    assert.ok(entry.hooks.some((hook) => hook.type === 'command' && hook.command === COMMAND), JSON.stringify(entry));
  });

  it('the dry run plans exactly the writes its apply makes, the hook placed then the entry wired, and a second apply changes nothing', async (t) => {
    const { buildStageGuardEntry } = await loadDoor();
    const root = makeProject(t, { settings: BEFORE });
    const before = snapshot(root);
    const dryRun = runCli(['--cwd', root]);
    assert.equal(dryRun.code, 0, dryRun.err);
    assert.equal(dryRun.err, '');
    assert.ok(dryRun.lines[0].startsWith(`${TITLE}DRY RUN`), dryRun.out);
    assert.ok(dryRun.lines.includes(DRY_RUN_PLACE), dryRun.out);
    assert.ok(dryRun.lines.some((line) => line.startsWith(SETTINGS_WOULD_ADD) && line.includes(EVENT)), dryRun.out);
    assert.deepEqual(snapshot(root), before);
    const apply = runCli(['--apply', '--cwd', root]);
    assert.equal(apply.code, 0, apply.err);
    assert.equal(apply.err, '');
    assert.deepEqual(readFileSync(join(root, HOOK)), readFileSync(BUNDLE_PATH));
    assert.deepEqual(readJson(root, SETTINGS), withEntry(BEFORE, buildStageGuardEntry()));
    assert.deepEqual(readdirSync(join(root, '.claude')).sort(), ['hooks', 'settings.json']);
    assert.deepEqual(readdirSync(join(root, '.claude/hooks')), ['stage-write-guard.mjs']);
    assert.equal(existsSync(join(root, LOCAL)), false);
    const applied = snapshot(root);
    const again = runCli(['--apply', '--cwd', root]);
    assert.deepEqual({ code: again.code, out: again.out, err: again.err }, { code: 0, out: `${NOTHING_TO_CHANGE}\n`, err: '' });
    assert.deepEqual(snapshot(root), applied);
  });

  it('the apply writes the hook file before the settings file', async (t) => {
    const { writeStageGuard } = await loadDoor();
    const root = makeProject(t, { settings: BEFORE });
    const writes = [];
    const writeFile = (path, ...args) => {
      writes.push(path);
      writeFileSync(path, ...args);
    };
    writeStageGuard({ cwd: root, dryRun: false }, { writeFile });
    assert.deepEqual(writes, [join(root, HOOK), join(root, SETTINGS)]);
  });

  it('an accepted hook whose file differs is written in place with the settings bytes equal', async (t) => {
    const { buildStageGuardEntry } = await loadDoor();
    const root = makeProject(t, { settings: withEntry(BEFORE, buildStageGuardEntry()), hook: 'older guard\n' });
    const hookPath = join(root, HOOK);
    const inode = statSync(hookPath).ino;
    const settings = readFileSync(join(root, SETTINGS));
    const dryRun = runCli(['--cwd', root]);
    assert.equal(dryRun.code, 0, dryRun.err);
    assert.ok(dryRun.lines.includes(`  - ${fileLine({ rel: HOOK, state: 'hook' }, undefined, true)}`), dryRun.out);
    const apply = runCli(['--apply', '--cwd', root]);
    assert.equal(apply.code, 0, apply.err);
    assert.ok(apply.lines.includes(`  - ${fileLine({ rel: HOOK, state: 'hook' }, 'written', false)}`), apply.out);
    assert.deepEqual(readFileSync(hookPath), readFileSync(BUNDLE_PATH));
    assert.equal(statSync(hookPath).ino, inode);
    assert.deepEqual(readFileSync(join(root, SETTINGS)), settings);
  });

  it('isStageGuardWired judges both settings files, and another matcher or another command is not wired', async (t) => {
    const { buildStageGuardEntry, isStageGuardWired } = await loadDoor();
    const entry = buildStageGuardEntry();
    const otherMatcher = { ...entry, matcher: 'Write' };
    const otherCommand = { matcher: MATCHER, hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/other.mjs"' }] };
    assert.equal(isStageGuardWired({ hooks: { [EVENT]: [FOREIGN_PRE, entry] } }), true);
    assert.equal(isStageGuardWired({ hooks: { [EVENT]: [otherMatcher] } }), false);
    assert.equal(isStageGuardWired({ hooks: { [EVENT]: [otherCommand] } }), false);
    assert.equal(isStageGuardWired({ hooks: { Stop: [entry] } }), false);
    assert.equal(isStageGuardWired({}), false);

    const localOnly = makeProject(t, { local: { hooks: { [EVENT]: [entry] } } });
    const localBefore = readFileSync(join(localOnly, LOCAL));
    const apply = runCli(['--apply', '--cwd', localOnly]);
    assert.equal(apply.code, 0, apply.err);
    assert.deepEqual(readFileSync(join(localOnly, HOOK)), readFileSync(BUNDLE_PATH));
    assert.equal(existsSync(join(localOnly, SETTINGS)), false);
    assert.deepEqual(readFileSync(join(localOnly, LOCAL)), localBefore);

    for (const foreign of [otherMatcher, otherCommand]) {
      const root = makeProject(t, { settings: withEntry(BEFORE, foreign) });
      const dryRun = runCli(['--cwd', root]);
      assert.equal(dryRun.code, 0, dryRun.err);
      assert.ok(dryRun.lines.some((line) => line.startsWith(SETTINGS_WOULD_ADD)), dryRun.out);
      const wired = runCli(['--apply', '--cwd', root]);
      assert.equal(wired.code, 0, wired.err);
      assert.deepEqual(readJson(root, SETTINGS), withEntry(withEntry(BEFORE, foreign), entry));
    }
  });

  it('installs beside an unsafe permission mode with the guard\'s own lines and no command note', (t) => {
    const modes = [
      { settings: { permissions: { defaultMode: 'bypassPermissions' } } },
      { local: { permissions: { defaultMode: 'unknownMode' } } },
    ];
    for (const mode of modes) {
      const root = makeProject(t, mode);
      const dryRun = runCli(['--cwd', root]);
      assert.equal(dryRun.code, 0, dryRun.err);
      assert.ok(dryRun.lines.includes(TRUST_POSTURE), dryRun.out);
      assert.equal(dryRun.lines.some((line) => line.startsWith(COMMAND_NOTE)), false, dryRun.out);
      const apply = runCli(['--apply', '--cwd', root]);
      assert.equal(apply.code, 0, apply.err);
      assert.ok(apply.lines[0].startsWith(TITLE), apply.out);
      assert.ok(apply.lines.some((line) => line.includes(RELOAD)), apply.out);
      assert.ok(apply.lines.includes(TRUST_POSTURE), apply.out);
      assert.equal(apply.lines.some((line) => line.startsWith(COMMAND_NOTE)), false, apply.out);
      assert.deepEqual(readFileSync(join(root, HOOK)), readFileSync(BUNDLE_PATH));
    }
  });

  it('a link at the hook path refuses with exit 1 and nothing written through it, and a usage error exits 2', (t) => {
    const root = makeProject(t, { settings: BEFORE });
    plantLink(root, HOOK);
    const before = snapshot(root);
    for (const args of [[], ['--apply']]) {
      const run = runCli([...args, '--cwd', root]);
      assert.equal(run.code, 1, run.out);
      assert.ok(run.err.includes(`${HOOK} exists but is not a regular file — refusing to touch it`), run.err);
      assert.deepEqual(snapshot(root), before);
    }
    assert.equal(readFileSync(join(root, 'backing'), 'utf8'), 'untouched\n');
    for (const args of [['--unknown'], ['--cwd']]) {
      const run = runCli(args);
      assert.equal(run.code, 2, run.out);
      assert.equal(run.out, '');
    }
  });

  it('a placed hook swapped for a link or other bytes after its write leaves the settings untouched', async (t) => {
    const { writeStageGuard } = await loadDoor();
    const swaps = [
      { name: 'a link', code: 'GATE_HOOK_SYMLINK', swap: (path, backing) => { unlinkSync(path); symlinkSync(backing, path); }, isLink: true },
      { name: 'other bytes', code: 'GATE_HOOK_DIVERGED', swap: (path) => writeFileSync(path, 'foreign bytes\n'), isLink: false },
    ];
    for (const row of swaps) {
      const root = makeProject(t, { settings: BEFORE });
      const settingsPath = join(root, SETTINGS);
      const settings = readOrNull(settingsPath);
      const inode = statSync(settingsPath).ino;
      const hookPath = join(root, HOOK);
      const backing = join(root, 'foreign-guard.mjs');
      writeFileSync(backing, 'foreign bytes\n');
      const writeFile = (path, ...args) => {
        writeFileSync(path, ...args);
        if (path === hookPath) row.swap(path, backing);
      };
      assert.throws(() => writeStageGuard({ cwd: root, dryRun: false }, { writeFile }), { code: row.code }, row.name);
      assert.equal(lstatSync(hookPath).isSymbolicLink(), row.isLink, row.name);
      assert.deepEqual(readOrNull(settingsPath), settings, row.name);
      assert.equal(statSync(settingsPath).ino, inode, row.name);
      assert.equal(readFileSync(backing, 'utf8'), 'foreign bytes\n', row.name);
    }
  });
});
