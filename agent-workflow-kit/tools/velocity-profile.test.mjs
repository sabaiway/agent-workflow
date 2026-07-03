import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCEPT_EDITS_MODE,
  CLAUDE_DIR,
  EXPECTED_WORKFLOW_VERSION,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  UNIVERSAL_READONLY_ALLOWLIST,
  VELOCITY_NON_READONLY,
  VELOCITY_INVALID_ARGUMENT,
  WORKFLOW_STAMP,
  discoverGateCandidates,
  main,
  parseArgs,
  screenAllowlistEntry,
  validateProfile,
} from './velocity-profile.mjs';

const UTF8 = 'utf8';
const TEMP_PREFIX = 'velocity-profile-';
const JSON_INDENT = 2;
const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const READ_ALLOW = 'Read(*)';
const LEGACY_FETCH_ALLOW = 'Bash(git fetch:*)';
const BYPASS_MODE = 'bypassPermissions';

const makeTempProject = (t) => {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const writeText = (absPath, text) => writeFileSync(absPath, text, UTF8);

const readText = (absPath) => readFileSync(absPath, UTF8);

const writeJson = (absPath, data) => writeText(absPath, `${JSON.stringify(data, null, JSON_INDENT)}\n`);

const readJson = (absPath) => JSON.parse(readText(absPath));

const ensureClaudeDir = (cwd) => mkdirSync(join(cwd, CLAUDE_DIR), { recursive: true });

const seedWorkflowStamp = (cwd, version = EXPECTED_WORKFLOW_VERSION) => {
  mkdirSync(join(cwd, 'docs/ai'), { recursive: true });
  writeText(join(cwd, WORKFLOW_STAMP), `${version}\n`);
};

const pathOf = (cwd, rel) => join(cwd, rel);

const settingsPath = (cwd) => pathOf(cwd, SETTINGS_FILE);

const localSettingsPath = (cwd) => pathOf(cwd, SETTINGS_LOCAL_FILE);

const runMain = (argv, cwd) => {
  const stdout = [];
  const stderr = [];
  const code = main([...argv, '--cwd', cwd], {
    log: (line) => stdout.push(line),
    errlog: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
};

const runMainWithoutCwd = (argv) => {
  const stdout = [];
  const stderr = [];
  const code = main(argv, {
    log: (line) => stdout.push(line),
    errlog: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
};

const assertCorePresentOnce = (allow) => {
  for (const entry of UNIVERSAL_READONLY_ALLOWLIST) {
    assert.equal(allow.filter((candidate) => candidate === entry).length, 1, entry);
  }
};

describe('UNIVERSAL_READONLY_ALLOWLIST', () => {
  it('matches the frozen expected set + count', () => {
    // Frozen snapshot of the audited read-only core. `git grep` (`--open-files-in-pager=<cmd>` runs a
    // program) and `sort` (`-o` writes, `--compress-program=<cmd>` runs a program) are deliberately
    // ABSENT — they carry an inline write/exec flag, so they are not genuinely read-only.
    const expected = [
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git ls-files:*)',
      'Bash(git check-ignore:*)',
      'Bash(git branch --list:*)',
      'Bash(npm view:*)',
      'Bash(npm ls:*)',
      'Bash(npm outdated:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(wc:*)',
      'Bash(readlink:*)',
      'Bash(which:*)',
      'Bash(grep:*)',
    ];
    assert.equal(Object.isFrozen(UNIVERSAL_READONLY_ALLOWLIST), true);
    assert.equal(UNIVERSAL_READONLY_ALLOWLIST.length, 18, 'read-only allowlist count sentinel - edit deliberately');
    assert.deepEqual(UNIVERSAL_READONLY_ALLOWLIST, expected);
  });

  it('every entry passes the read-only screen', () => {
    for (const e of UNIVERSAL_READONLY_ALLOWLIST) assert.equal(screenAllowlistEntry(e), true, e);
  });

  it('contains no commit / push / publish allow entry (load-bearing invariant)', () => {
    for (const e of UNIVERSAL_READONLY_ALLOWLIST) {
      assert.doesNotMatch(e, /commit|push|publish/i, e);
    }
  });
});

describe('screenAllowlistEntry', () => {
  it('accepts reviewed read-only Bash allow entries', () => {
    const accepted = [
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git branch --list:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(grep:*)',
      'Bash(npm view:*)',
      'Bash(npm ls:*)',
    ];
    for (const entry of accepted) assert.equal(screenAllowlistEntry(entry), true, entry);
  });

  it('rejects non-read-only, write/exec-capable, or over-broad Bash allow entries', () => {
    const rejected = [
      'Bash(echo:*)',
      'Bash(find:*)',
      'Bash(sort:*)',            // -o writes, --compress-program=<cmd> runs a program
      'Bash(git grep:*)',        // --open-files-in-pager=<cmd> runs a program
      'Bash(git fetch:*)',
      'Bash(git remote:*)',
      'Bash(git branch:*)',
      'Bash(git ls-remote:*)',
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(gh api:*)',
      'Bash(node --test:*)',
      'Bash(npm run test:*)',
      'Bash(npm install:*)',
      'Bash(npm publish:*)',
      'Bash(npx x:*)',
      'Bash(git:*)',
      'Bash(npm:*)',
      'Bash(git status && git push:*)',
      'Bash(cat x > y:*)',
      'Bash(cat $(git push):*)',
      'Bash(git\tstatus:*)',
    ];
    for (const entry of rejected) assert.equal(screenAllowlistEntry(entry), false, entry);
  });
});

describe('discoverGateCandidates', () => {
  it('returns package scripts as hand-added npm run candidates with mutating-name warnings', () => {
    const packageJson = {
      scripts: {
        test: 'node --test',
        lint: 'eslint .',
        'release:npm': 'npm publish',
        prepublishOnly: 'node check-release.mjs',
        commit: 'git-cz',
        build: 'node build.mjs',
      },
    };
    assert.deepEqual(discoverGateCandidates(packageJson), [
      { command: 'npm run test', addByHand: true },
      { command: 'npm run lint', addByHand: true },
      { command: 'npm run release:npm', addByHand: true, warn: 'do not add' },
      { command: 'npm run prepublishOnly', addByHand: true, warn: 'do not add' },
      { command: 'npm run commit', addByHand: true, warn: 'do not add' },
      { command: 'npm run build', addByHand: true },
    ]);
  });

  it('returns an empty list when scripts are absent or not a script map', () => {
    assert.deepEqual(discoverGateCandidates({}), []);
    assert.deepEqual(discoverGateCandidates(), []);
    assert.deepEqual(discoverGateCandidates({ scripts: [] }), []);
  });
});

describe('validateProfile', () => {
  it('returns ok for the audited read-only allowlist', () => {
    assert.deepEqual(validateProfile(UNIVERSAL_READONLY_ALLOWLIST), {
      ok: true,
      count: UNIVERSAL_READONLY_ALLOWLIST.length,
    });
  });

  it('throws a typed read-only error for a non-read-only entry', () => {
    assert.throws(
      () => validateProfile([...UNIVERSAL_READONLY_ALLOWLIST, 'Bash(sort:*)']),
      (e) => e.code === VELOCITY_NON_READONLY,
    );
  });

  it('refuses a commit / push / publish allow entry (load-bearing invariant)', () => {
    for (const bad of ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npm publish:*)']) {
      assert.throws(
        () => validateProfile([...UNIVERSAL_READONLY_ALLOWLIST, bad]),
        (e) => e.code === VELOCITY_NON_READONLY,
        bad,
      );
    }
  });

  it('throws a typed argument error for a non-array input', () => {
    assert.throws(
      () => validateProfile('not-an-array'),
      (e) => e.code === VELOCITY_INVALID_ARGUMENT,
    );
  });
});

describe('velocity profile writer + CLI', () => {
  it('merges without clobbering existing settings and preserves legacy entries', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), {
      includeCoAuthoredBy: false,
      permissions: { allow: [READ_ALLOW, LEGACY_FETCH_ALLOW] },
      custom: 1,
    });

    const result = runMain(['--apply'], cwd);
    const settings = readJson(settingsPath(cwd));

    assert.equal(result.code, EXIT_OK);
    assert.equal(settings.includeCoAuthoredBy, false);
    assert.equal(settings.custom, 1);
    assert.equal(settings.permissions.allow.includes(READ_ALLOW), true);
    assert.equal(settings.permissions.allow.includes(LEGACY_FETCH_ALLOW), true);
    assertCorePresentOnce(settings.permissions.allow);
  });

  it('writes nothing for explicit --dry-run and for the default mode', (t) => {
    const absentCwd = makeTempProject(t);
    seedWorkflowStamp(absentCwd);
    const explicitDryRun = runMain(['--dry-run'], absentCwd);

    const presentCwd = makeTempProject(t);
    seedWorkflowStamp(presentCwd);
    ensureClaudeDir(presentCwd);
    const original = '{"custom":1}\n';
    writeText(settingsPath(presentCwd), original);
    const defaultDryRun = runMain([], presentCwd);

    assert.equal(explicitDryRun.code, EXIT_OK);
    assert.equal(existsSync(settingsPath(absentCwd)), false);
    assert.equal(existsSync(pathOf(absentCwd, CLAUDE_DIR)), false);
    assert.equal(defaultDryRun.code, EXIT_OK);
    assert.equal(readText(settingsPath(presentCwd)), original);
  });

  it('sets defaultMode only when --accept-edits is applied', (t) => {
    const defaultCwd = makeTempProject(t);
    seedWorkflowStamp(defaultCwd);
    const defaultResult = runMain(['--apply'], defaultCwd);
    const defaultSettings = readJson(settingsPath(defaultCwd));

    const acceptCwd = makeTempProject(t);
    seedWorkflowStamp(acceptCwd);
    const acceptResult = runMain(['--apply', '--accept-edits'], acceptCwd);
    const acceptSettings = readJson(settingsPath(acceptCwd));

    assert.equal(defaultResult.code, EXIT_OK);
    assert.equal(defaultSettings.permissions.defaultMode, undefined);
    assert.equal(acceptResult.code, EXIT_OK);
    assert.equal(acceptSettings.permissions.defaultMode, ACCEPT_EDITS_MODE);
  });

  it('refuses bypassPermissions in project settings with zero writes', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), { permissions: { defaultMode: BYPASS_MODE, allow: [READ_ALLOW] } });
    const before = readText(settingsPath(cwd));
    const result = runMain(['--apply'], cwd);

    assert.equal(result.code, EXIT_PRECONDITION);
    assert.match(result.stderr, /bypassPermissions/);
    assert.equal(readText(settingsPath(cwd)), before);
  });

  it('refuses bypassPermissions in local settings with zero writes', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(localSettingsPath(cwd), { permissions: { defaultMode: BYPASS_MODE } });
    const before = readText(localSettingsPath(cwd));
    const result = runMain(['--apply'], cwd);

    assert.equal(result.code, EXIT_PRECONDITION);
    assert.match(result.stderr, /bypassPermissions/);
    assert.equal(existsSync(settingsPath(cwd)), false);
    assert.equal(readText(localSettingsPath(cwd)), before);
  });

  it('stops loudly on malformed JSON in either settings file with zero writes', (t) => {
    const cases = [
      { rel: SETTINGS_FILE, expectProjectWrite: true },
      { rel: SETTINGS_LOCAL_FILE, expectProjectWrite: false },
    ];

    for (const { rel, expectProjectWrite } of cases) {
      const cwd = makeTempProject(t);
      seedWorkflowStamp(cwd);
      ensureClaudeDir(cwd);
      writeText(pathOf(cwd, rel), '{not json\n');
      const before = readText(pathOf(cwd, rel));
      const result = runMain(['--apply'], cwd);

      assert.equal(result.code, EXIT_PRECONDITION, rel);
      assert.match(result.stderr, /malformed JSON/, rel);
      assert.equal(readText(pathOf(cwd, rel)), before, rel);
      if (!expectProjectWrite) assert.equal(existsSync(settingsPath(cwd)), false, rel);
    }
  });

  it('stops on non-array permissions.allow in either settings file', (t) => {
    const cases = [SETTINGS_FILE, SETTINGS_LOCAL_FILE];

    for (const rel of cases) {
      const cwd = makeTempProject(t);
      seedWorkflowStamp(cwd);
      ensureClaudeDir(cwd);
      writeJson(pathOf(cwd, rel), { permissions: { allow: READ_ALLOW } });
      const before = readText(pathOf(cwd, rel));
      const result = runMain(['--apply'], cwd);

      assert.equal(result.code, EXIT_PRECONDITION, rel);
      assert.match(result.stderr, /permissions\.allow must be an array/, rel);
      assert.equal(readText(pathOf(cwd, rel)), before, rel);
      if (rel === SETTINGS_LOCAL_FILE) assert.equal(existsSync(settingsPath(cwd)), false, rel);
    }
  });

  it('refuses a symlinked .claude dir and creates an absent one on apply', (t) => {
    const symlinkCwd = makeTempProject(t);
    seedWorkflowStamp(symlinkCwd);
    mkdirSync(pathOf(symlinkCwd, 'real-claude'));
    symlinkSync(pathOf(symlinkCwd, 'real-claude'), pathOf(symlinkCwd, CLAUDE_DIR), 'dir');
    const symlinkResult = runMain(['--apply'], symlinkCwd);

    const absentCwd = makeTempProject(t);
    seedWorkflowStamp(absentCwd);
    const absentResult = runMain(['--apply'], absentCwd);

    assert.equal(symlinkResult.code, EXIT_PRECONDITION);
    assert.match(symlinkResult.stderr, /\.claude is a symlink/);
    assert.equal(existsSync(settingsPath(symlinkCwd)), false);
    assert.equal(absentResult.code, EXIT_OK);
    assert.equal(existsSync(settingsPath(absentCwd)), true);
  });

  it('never writes settings.local.json', (t) => {
    const presentCwd = makeTempProject(t);
    seedWorkflowStamp(presentCwd);
    ensureClaudeDir(presentCwd);
    const localOriginal = '{"permissions":{"defaultMode":"plan"}}\n';
    writeText(localSettingsPath(presentCwd), localOriginal);
    const presentResult = runMain(['--apply', '--accept-edits'], presentCwd);

    const absentCwd = makeTempProject(t);
    seedWorkflowStamp(absentCwd);
    const absentResult = runMain(['--apply'], absentCwd);

    assert.equal(presentResult.code, EXIT_OK);
    assert.equal(readText(localSettingsPath(presentCwd)), localOriginal);
    assert.equal(absentResult.code, EXIT_OK);
    assert.equal(existsSync(localSettingsPath(absentCwd)), false);
  });

  it('enforces the workflow stamp only on apply', (t) => {
    const missingCwd = makeTempProject(t);
    const missingApply = runMain(['--apply'], missingCwd);
    const missingDryRun = runMain(['--dry-run'], missingCwd);

    const wrongCwd = makeTempProject(t);
    seedWorkflowStamp(wrongCwd, '0.0.0');
    ensureClaudeDir(wrongCwd);
    const original = '{"custom":1}\n';
    writeText(settingsPath(wrongCwd), original);
    const wrongApply = runMain(['--apply'], wrongCwd);
    const wrongDryRun = runMain(['--dry-run'], wrongCwd);

    assert.equal(missingApply.code, EXIT_PRECONDITION);
    assert.match(missingApply.stderr, /found none/);
    assert.equal(existsSync(settingsPath(missingCwd)), false);
    assert.equal(missingDryRun.code, EXIT_OK);
    assert.match(missingDryRun.stdout, /would add read-only core entries/);
    assert.equal(wrongApply.code, EXIT_PRECONDITION);
    assert.match(wrongApply.stderr, /found 0\.0\.0/);
    assert.equal(readText(settingsPath(wrongCwd)), original);
    assert.equal(wrongDryRun.code, EXIT_OK);
  });

  it('maps bad args to usage exit code', () => {
    assert.equal(runMainWithoutCwd(['--wat']).code, EXIT_USAGE);
    assert.equal(runMainWithoutCwd(['--dry-run', '--apply']).code, EXIT_USAGE);
    assert.equal(runMainWithoutCwd(['--cwd']).code, EXIT_USAGE);
    assert.deepEqual(parseArgs([]), {
      help: false,
      dryRun: true,
      apply: false,
      acceptEdits: false,
      cwd: undefined,
    });
  });

  it('is idempotent on a second apply', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    const first = runMain(['--apply'], cwd);
    const firstBytes = readText(settingsPath(cwd));
    const second = runMain(['--apply'], cwd);
    const secondBytes = readText(settingsPath(cwd));

    assert.equal(first.code, EXIT_OK);
    assert.equal(second.code, EXIT_OK);
    assert.equal(secondBytes, firstBytes);
    assert.match(second.stdout, /added read-only core entries: 0/);
    assertCorePresentOnce(readJson(settingsPath(cwd)).permissions.allow);
  });

  it('refuses an unsafe project mode even when a safe local override masks it', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    // Committed project mode is unknown/unsafe; a safe local override must NOT let velocity write
    // (merge-don't-clobber would otherwise preserve the unsafe project mode for everyone).
    writeJson(settingsPath(cwd), { permissions: { defaultMode: 'wideOpen', allow: [READ_ALLOW] } });
    writeJson(localSettingsPath(cwd), { permissions: { defaultMode: 'default' } });
    const before = readText(settingsPath(cwd));
    const result = runMain(['--apply'], cwd);

    assert.equal(result.code, EXIT_PRECONDITION);
    assert.match(result.stderr, /unsafe or unknown permissions\.defaultMode/);
    assert.equal(readText(settingsPath(cwd)), before);
  });

  it('refuses a symlinked settings.json on BOTH dry-run and apply (no false prediction)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(pathOf(cwd, 'real-settings.json'), { custom: 1 });
    symlinkSync(pathOf(cwd, 'real-settings.json'), settingsPath(cwd), 'file');
    const dryRun = runMain(['--dry-run'], cwd);
    const apply = runMain(['--apply'], cwd);

    assert.equal(dryRun.code, EXIT_PRECONDITION);
    assert.equal(apply.code, EXIT_PRECONDITION);
    assert.match(dryRun.stderr, /not a regular file/);
    assert.deepEqual(readJson(pathOf(cwd, 'real-settings.json')), { custom: 1 });
  });

  it('degrades gracefully when package.json is malformed (advisory only, still writes)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeText(pathOf(cwd, 'package.json'), '{ broken json\n');
    const result = runMain(['--apply'], cwd);

    assert.equal(result.code, EXIT_OK);
    assertCorePresentOnce(readJson(settingsPath(cwd)).permissions.allow);
  });

  it('always prints the honest residual notice (locks the release honesty contract)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    const dry = runMain(['--dry-run'], cwd);
    assert.match(dry.stdout, /trust-posture convenience, NOT a sandbox/);
    assert.match(dry.stdout, /commit\/push\/publish are never allowlisted/);
    assert.match(dry.stdout, /runtime residual is not closed here/);
    assert.match(dry.stdout, /opt-in PreToolUse hook — Mode: hook/);
  });
});
