import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPT_EDITS_MODE,
  BRIDGE_REVIEW_WRAPPERS,
  CLAUDE_DIR,
  EXPECTED_WORKFLOW_VERSION,
  KIT_BRIDGE_TIER_NOTICE,
  KIT_READONLY_TOOLS,
  KIT_RUN_GATES_TOOL,
  KIT_WRITER_PREVIEW_TOOLS,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  UNIVERSAL_READONLY_ALLOWLIST,
  VELOCITY_NON_READONLY,
  VELOCITY_INVALID_ARGUMENT,
  VELOCITY_OFFCORE,
  WORKFLOW_STAMP,
  deriveBridgeTierAllowlist,
  deriveKitToolsAllowlist,
  discoverGateCandidates,
  isExecutableFile,
  main,
  parseArgs,
  screenAllowlistEntry,
  validateProfile,
} from './velocity-profile.mjs';
import { GROUNDING_TOOL } from './procedures.mjs';

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

// Characterization of the real statSync primitive (AD-044 Plan 2, characterize-first): the probe's
// injectable seam is pinned elsewhere with fake predicates — THIS pins the default predicate itself
// against a real temp tree, before autonomy-doctor promotes it to the trusted-dir execution gate.
describe('isExecutableFile — real-fs characterization', () => {
  it('0755 regular file → true; 0644 regular file → false', (t) => {
    const dir = makeTempProject(t);
    const exec = join(dir, 'bwrap');
    const plain = join(dir, 'socat');
    writeText(exec, '#!/bin/sh\n');
    writeText(plain, 'not a binary\n');
    chmodSync(exec, 0o755);
    chmodSync(plain, 0o644);
    assert.equal(isExecutableFile(exec), true);
    assert.equal(isExecutableFile(plain), false);
  });

  it('a DIRECTORY named socat → false', (t) => {
    const dir = makeTempProject(t);
    mkdirSync(join(dir, 'socat'));
    assert.equal(isExecutableFile(join(dir, 'socat')), false);
  });

  it('a symlink to an executable → true (statSync follows the link)', (t) => {
    const dir = makeTempProject(t);
    const target = join(dir, 'socat1');
    writeText(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    symlinkSync(target, join(dir, 'socat'));
    assert.equal(isExecutableFile(join(dir, 'socat')), true);
  });

  it('ENOENT → false (never throws)', (t) => {
    const dir = makeTempProject(t);
    assert.equal(isExecutableFile(join(dir, 'absent')), false);
  });
});

describe('UNIVERSAL_READONLY_ALLOWLIST', () => {
  it('matches the frozen expected set + count', () => {
    // Frozen snapshot of the audited read-only core. `git grep` (`--open-files-in-pager=<cmd>` runs a
    // program), `sort` (`-o` writes, `--compress-program=<cmd>` runs a program), `file`
    // (`-C -m <magic>` compiles a magic FILE WRITE — probe-proven, AD-040) and `git cat-file`
    // (`--textconv`/`--filters` activate CONFIGURED external filters under an auto-approved
    // command, and its read utility is marginal next to the kept `git show` — diff-council fold,
    // AD-040) are deliberately ABSENT.
    // `git tag`/`git stash`/`git worktree` join as FIXED read-only forms only (their bare forms
    // mutate — probe-proven); `git blame`/`git shortlog` carry the same bounded `--output` write
    // residual as the kept git diff/log/show (documented + hook-covered).
    const expected = [
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git ls-files:*)',
      'Bash(git check-ignore:*)',
      'Bash(git branch --list:*)',
      'Bash(git rev-parse:*)',
      'Bash(git blame:*)',
      'Bash(git shortlog:*)',
      'Bash(git describe:*)',
      'Bash(git tag --list:*)',
      'Bash(git stash list:*)',
      'Bash(git worktree list:*)',
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
      'Bash(diff:*)',
      'Bash(stat:*)',
      'Bash(du:*)',
      'Bash(basename:*)',
      'Bash(dirname:*)',
      'Bash(realpath:*)',
    ];
    assert.equal(Object.isFrozen(UNIVERSAL_READONLY_ALLOWLIST), true);
    assert.equal(UNIVERSAL_READONLY_ALLOWLIST.length, 31, 'read-only allowlist count sentinel - edit deliberately');
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
      'Bash(file:*)',            // -C -m <magic> compiles a magic FILE WRITE (probe-proven, AD-040)
      'Bash(git cat-file:*)',    // --textconv/--filters run configured filters; git show covers the reads
      'Bash(git tag:*)',         // bare form mutates (creates a tag) - only the fixed --list form is core
      'Bash(git stash:*)',       // bare form mutates (stashes) - only the fixed list form is core
      'Bash(git worktree:*)',    // add/remove mutate - only the fixed list form is core
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

// ── the opt-in --kit-tools tier (F07, AD-040) ──────────────────────────────────────────
// Derivation is pure (no fs): entries resolve from the RUNNING tool's own location + the given
// project dir, so a fixed fixture path exercises the exact seeded byte-strings.
const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIER_PROJECT = '/tmp/velocity-tier-fixture';
const tierEntries = () => deriveKitToolsAllowlist({ projectDir: TIER_PROJECT });
const wildcardEntryOf = (rel) => `Bash(node ${join(KIT_ROOT, rel)}:*)`;
const previewEntryOf = (rel) => `Bash(node ${join(KIT_ROOT, rel)})`;
const RUN_GATES_EXACT = `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')} --cwd ${TIER_PROJECT})`;
const PREVIEW_FORBIDDEN_FLAGS = ['--apply', '--write', '--yes', '--refresh-placed'];

describe('KIT_READONLY_TOOLS tier — frozen membership + derivation', () => {
  it('matches the frozen 10-member tool list + count sentinel', () => {
    const expected = [
      'tools/recipes.mjs',
      'tools/procedures.mjs',
      'tools/family-registry.mjs',
      'tools/detect-backends.mjs',
      'tools/commands.mjs',
      'tools/review-state.mjs',
      'tools/recommendations.mjs',
      'tools/run-gates.mjs',
      'tools/manifest/validate.mjs',
      'tools/release-scan.mjs',
    ];
    assert.equal(Object.isFrozen(KIT_READONLY_TOOLS), true);
    // 9 → 10: AD-044 Plan 4 Phase 3 — the recommendations advisor joins the tier.
    assert.equal(KIT_READONLY_TOOLS.length, 10, 'kit-tools tier count sentinel - edit deliberately');
    assert.deepEqual([...KIT_READONLY_TOOLS], expected);
    assert.equal(KIT_RUN_GATES_TOOL, 'tools/run-gates.mjs');
  });

  it('writer-preview membership is frozen: exactly the three default-dry-run writers, never set-recipe or the rest', () => {
    assert.equal(Object.isFrozen(KIT_WRITER_PREVIEW_TOOLS), true);
    assert.deepEqual(
      [...KIT_WRITER_PREVIEW_TOOLS],
      ['tools/velocity-profile.mjs', 'tools/cheap-agents.mjs', 'tools/gate-hook.mjs'],
      'preview count sentinel - only writers whose ARG-FREE invocation is a dry-run',
    );
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) assert.equal(KIT_READONLY_TOOLS.includes(rel), false, rel);
  });

  it('derives 9 wildcard entries + the exact run-gates entry + 3 exact previews (count sentinel 13)', () => {
    const derived = tierEntries();
    assert.equal(Object.isFrozen(derived), true);
    // 12 → 13: AD-044 Plan 4 Phase 3 — the recommendations advisor joins KIT_READONLY_TOOLS.
    assert.equal(derived.length, 13, 'derived tier count sentinel - edit deliberately');
    const wildcards = derived.filter((e) => e.endsWith(':*)'));
    assert.equal(wildcards.length, 9);
    for (const rel of KIT_READONLY_TOOLS) {
      if (rel === KIT_RUN_GATES_TOOL) continue;
      assert.equal(derived.includes(wildcardEntryOf(rel)), true, rel);
    }
    assert.equal(derived.includes(RUN_GATES_EXACT), true, 'the exact root-pinned run-gates entry');
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) assert.equal(derived.includes(previewEntryOf(rel)), true, rel);
  });

  it('the run-gates negatives (Decision 3): no wildcard form anywhere; bare / other --cwd / --only forms stay uncovered', () => {
    const derived = tierEntries();
    assert.equal(derived.some((e) => e.includes('run-gates.mjs:*')), false, 'no wildcard run-gates entry in any seeded set');
    for (const uncovered of [
      previewEntryOf('tools/run-gates.mjs'), // bare, cwd-defaulting
      `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')} --cwd /some/other/project)`,
      `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')} --cwd ${TIER_PROJECT} --only unit-tests)`,
    ]) {
      assert.equal(derived.includes(uncovered), false, uncovered);
    }
  });

  it('no preview entry carries an apply-class flag; no tier entry resolves to a writer tool', () => {
    for (const entry of tierEntries()) {
      for (const flag of PREVIEW_FORBIDDEN_FLAGS) assert.equal(entry.includes(flag), false, `${entry} ~ ${flag}`);
      assert.doesNotMatch(entry, /set-recipe|setup-backends|uninstall|hide-footprint|inject-methodology/u, entry);
    }
  });

  it('the derivation is fail-safe on a missing project dir (typed argument error)', () => {
    assert.throws(() => deriveKitToolsAllowlist({}), (e) => e.code === VELOCITY_INVALID_ARGUMENT);
  });

  it('rejects a space-carrying or metacharacter-carrying project root UP FRONT with a clear error (R1 fold)', () => {
    for (const bad of ['/tmp/has space', '/tmp/has$dollar', '/tmp/tick`tick']) {
      assert.throws(
        () => deriveKitToolsAllowlist({ projectDir: bad }),
        (e) => e.code === VELOCITY_INVALID_ARGUMENT && /hand-add|by hand/iu.test(e.message),
        bad,
      );
    }
  });

  it('rejects quote- and glob-bracket-carrying roots too — unquoted shell syntax breaks a byte-exact rule (R2 fold)', () => {
    for (const bad of ["/tmp/it's", '/tmp/dq"dq', '/tmp/arr[0]', '/tmp/br]x']) {
      assert.throws(
        () => deriveKitToolsAllowlist({ projectDir: bad }),
        (e) => e.code === VELOCITY_INVALID_ARGUMENT,
        bad,
      );
    }
  });
});

describe('screenAllowlistEntry — the tier entry classes', () => {
  it('accepts every derived tier entry', () => {
    for (const entry of tierEntries()) assert.equal(screenAllowlistEntry(entry), true, entry);
  });

  it('rejects a wildcard run-gates, writer paths, bare exact run-gates, and relative-path spellings', () => {
    const rejected = [
      `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')}:*)`, // wildcard would be BROADER than AD-037 (--cwd escapes)
      `Bash(node ${join(KIT_ROOT, 'tools/set-recipe.mjs')}:*)`, // writer, never in the tier
      `Bash(node ${join(KIT_ROOT, 'tools/setup-backends.mjs')}:*)`, // writer
      `Bash(node ${join(KIT_ROOT, 'tools/uninstall.mjs')})`, // guarded teardown is not a preview
      `Bash(node ${join(KIT_ROOT, 'tools/hide-footprint.mjs')})`, // arg-free form APPLIES - not a dry-run
      `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')})`, // bare exact: cwd-defaulting, follows the shell
      'Bash(node tools/recipes.mjs:*)', // relative spelling is a dead rule - screen refuses to bless it
      'Bash(node /tmp/"quoted"/tools/recipes.mjs:*)', // unquoted shell syntax in the path token (R2 fold)
      "Bash(node /tmp/it's/tools/recipes.mjs:*)",
      'Bash(node /tmp/glob[0]/tools/recipes.mjs:*)',
      'Bash(node --test:*)',
    ];
    for (const entry of rejected) assert.equal(screenAllowlistEntry(entry), false, entry);
  });

  it('still rejects an exact-form entry for the git/npm/shell core (exact form is tier-only, no behavior change)', () => {
    for (const entry of ['Bash(git status)', 'Bash(ls)', 'Bash(npm view)']) {
      assert.equal(screenAllowlistEntry(entry), false, entry);
    }
  });
});

describe('validateProfile — the selected-allowlist contract (core vs core+tier)', () => {
  it('validates the derived tier against the core+tier audited set', () => {
    const derived = tierEntries();
    assert.deepEqual(validateProfile(derived, [...UNIVERSAL_READONLY_ALLOWLIST, ...derived]), {
      ok: true,
      count: derived.length,
    });
  });

  it('throws VELOCITY_OFFCORE for a screen-passing node entry outside the derived tier (first off-core test)', () => {
    const foreign = 'Bash(node /elsewhere/tools/recipes.mjs:*)';
    assert.equal(screenAllowlistEntry(foreign), true, 'shape passes the screen');
    const derived = tierEntries();
    assert.throws(
      () => validateProfile([foreign], [...UNIVERSAL_READONLY_ALLOWLIST, ...derived]),
      (e) => e.code === VELOCITY_OFFCORE,
    );
  });

  it('flagless semantics unchanged: a tier entry is OFFCORE against the argument-less core-only call', () => {
    assert.throws(
      () => validateProfile([tierEntries()[0]]),
      (e) => e.code === VELOCITY_OFFCORE,
    );
  });

  it('throws VELOCITY_NON_READONLY for a writer-path tier-shaped entry', () => {
    assert.throws(
      () => validateProfile([`Bash(node ${join(KIT_ROOT, 'tools/hide-footprint.mjs')}:*)`], [...UNIVERSAL_READONLY_ALLOWLIST]),
      (e) => e.code === VELOCITY_NON_READONLY,
    );
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
      { command: 'npm run test', scriptName: 'test', addByHand: true },
      { command: 'npm run lint', scriptName: 'lint', addByHand: true },
      { command: 'npm run release:npm', scriptName: 'release:npm', addByHand: true, warn: 'do not add' },
      { command: 'npm run prepublishOnly', scriptName: 'prepublishOnly', addByHand: true, warn: 'do not add' },
      { command: 'npm run commit', scriptName: 'commit', addByHand: true, warn: 'do not add' },
      { command: 'npm run build', scriptName: 'build', addByHand: true },
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
      kitTools: false,
      bridgeTier: false,
      autonomy: false,
      check: false,
      cwd: undefined,
    });
    assert.equal(parseArgs(['--kit-tools']).kitTools, true);
    assert.equal(parseArgs(['--kit-tools', '--apply']).apply, true);
    assert.equal(parseArgs(['--bridge-tier']).bridgeTier, true);
    assert.equal(parseArgs(['--bridge-tier', '--apply']).apply, true);
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

  it('the residual notice carries the approval floor, mirrored in the velocity.md prose twin (F15, AD-040)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    const dry = runMain(['--dry-run'], cwd);
    const FLOOR_ITEMS = [
      /every writer --apply\/--write\/--yes still prompts/,
      /clobber-protection STOPs still stop/,
      /the three release asks \(commit\/push\/publish\) stay maintainer-owned/,
    ];
    for (const item of FLOOR_ITEMS) assert.match(dry.stdout, item);
    // Twin-drift guard: the hand-maintained prose twin carries the same floor items (markdown
    // emphasis stripped so the comparison stays mechanical).
    const proseTwin = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'modes', 'velocity.md'),
      UTF8,
    ).replaceAll('`', '').replaceAll('**', '');
    for (const item of FLOOR_ITEMS) assert.match(proseTwin, item);
  });
});

describe('velocity profile CLI — the opt-in --kit-tools tier', () => {
  const derivedFor = (cwd) => deriveKitToolsAllowlist({ projectDir: cwd });

  it('--kit-tools --apply seeds core + tier; the flagless apply stays core-only', (t) => {
    const tierCwd = makeTempProject(t);
    seedWorkflowStamp(tierCwd);
    const tierResult = runMain(['--apply', '--kit-tools'], tierCwd);
    const tierAllow = readJson(settingsPath(tierCwd)).permissions.allow;

    const coreCwd = makeTempProject(t);
    seedWorkflowStamp(coreCwd);
    const coreResult = runMain(['--apply'], coreCwd);
    const coreAllow = readJson(settingsPath(coreCwd)).permissions.allow;

    assert.equal(tierResult.code, EXIT_OK);
    assertCorePresentOnce(tierAllow);
    for (const entry of derivedFor(tierCwd)) {
      assert.equal(tierAllow.filter((candidate) => candidate === entry).length, 1, entry);
    }
    assert.equal(coreResult.code, EXIT_OK);
    for (const entry of coreAllow) {
      assert.equal(entry.includes('/tools/'), false, `flagless apply must stay core-only: ${entry}`);
    }
  });

  it('--kit-tools --dry-run works undeployed (no stamp), predicts the tier, writes nothing', (t) => {
    const cwd = makeTempProject(t); // deliberately NOT seedWorkflowStamp
    const dry = runMain(['--kit-tools'], cwd);

    assert.equal(dry.code, EXIT_OK);
    assert.match(dry.stdout, /would add kit-tools tier entries: 13/);
    assert.equal(existsSync(settingsPath(cwd)), false);
    assert.equal(existsSync(pathOf(cwd, CLAUDE_DIR)), false);
  });

  it('--kit-tools output names run-gates as project-exec, never read-only', (t) => {
    const cwd = makeTempProject(t);
    const dry = runMain(['--kit-tools'], cwd);
    assert.match(dry.stdout, /project-exec/);
    assert.match(dry.stdout, /runs YOUR declared gates\.json/);
    assert.match(dry.stdout, /every --apply\/--write\/--yes still prompts/);
    assert.match(dry.stdout, /NO PreToolUse-hook residual coverage/);
  });

  it('--kit-tools --apply hits the same refusal paths (stamp, bypassPermissions) with zero writes', (t) => {
    const missingCwd = makeTempProject(t);
    const missingApply = runMain(['--apply', '--kit-tools'], missingCwd);

    const bypassCwd = makeTempProject(t);
    seedWorkflowStamp(bypassCwd);
    ensureClaudeDir(bypassCwd);
    writeJson(settingsPath(bypassCwd), { permissions: { defaultMode: BYPASS_MODE } });
    const before = readText(settingsPath(bypassCwd));
    const bypassApply = runMain(['--apply', '--kit-tools'], bypassCwd);

    assert.equal(missingApply.code, EXIT_PRECONDITION);
    assert.match(missingApply.stderr, /found none/);
    assert.equal(existsSync(settingsPath(missingCwd)), false);
    assert.equal(bypassApply.code, EXIT_PRECONDITION);
    assert.equal(readText(settingsPath(bypassCwd)), before);
  });

  it('is idempotent on a second --kit-tools apply', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    const first = runMain(['--apply', '--kit-tools'], cwd);
    const firstBytes = readText(settingsPath(cwd));
    const second = runMain(['--apply', '--kit-tools'], cwd);

    assert.equal(first.code, EXIT_OK);
    assert.equal(second.code, EXIT_OK);
    assert.equal(readText(settingsPath(cwd)), firstBytes);
    assert.match(second.stdout, /added read-only core entries: 0/);
    assert.match(second.stdout, /added kit-tools tier entries: 0/);
  });

  it('characterizes the flagless pre-existing advisory (pinned pre-tier) and keeps it after a tier apply', (t) => {
    // (a) characterize-first: the CURRENT flagless behavior on a non-tier project.
    const legacyCwd = makeTempProject(t);
    seedWorkflowStamp(legacyCwd);
    ensureClaudeDir(legacyCwd);
    writeJson(settingsPath(legacyCwd), { permissions: { allow: [LEGACY_FETCH_ALLOW] } });
    const legacyDry = runMain(['--dry-run'], legacyCwd);
    assert.equal(legacyDry.code, EXIT_OK);
    assert.match(legacyDry.stdout, /pre-existing non-read-only Bash allow entries/);
    assert.match(legacyDry.stdout, /git fetch/);

    // (b) no self-contradiction: the advisory never flags an entry the tier itself seeded.
    const tierCwd = makeTempProject(t);
    seedWorkflowStamp(tierCwd);
    runMain(['--apply', '--kit-tools'], tierCwd);
    const after = runMain(['--dry-run'], tierCwd);
    assert.equal(after.code, EXIT_OK);
    assert.doesNotMatch(after.stdout, /pre-existing non-read-only Bash allow entries/);
  });

  it('the advisory flags kit-tool-shaped entries OUTSIDE the derived tier (foreign path / foreign root — R1 fold)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    const foreignWildcard = 'Bash(node /tmp/malicious/tools/recipes.mjs:*)';
    const foreignRunGates = `Bash(node ${join(KIT_ROOT, 'tools/run-gates.mjs')} --cwd /some/other/project)`;
    writeJson(settingsPath(cwd), { permissions: { allow: [foreignWildcard, foreignRunGates] } });

    const dry = runMain(['--dry-run'], cwd);

    assert.equal(dry.code, EXIT_OK);
    assert.match(dry.stdout, /pre-existing non-read-only Bash allow entries/);
    assert.match(dry.stdout, /\/tmp\/malicious\/tools\/recipes\.mjs/);
    assert.match(dry.stdout, /--cwd \/some\/other\/project/);
  });
});

// ── the --bridge-tier (AD-044 Plan 4, Decision 2) ────────────────────────────────────
// Placement is injected (deps.findWrapper) — a hermetic test never depends on what the HOST has
// on PATH. The frozen constant is the membership source; the derivation only ever consults the
// probe for placement.
describe('bridge-wrappers tier — frozen membership, derivation, screen, audit self-consistency', () => {
  const allPlaced = () => true;
  const nonePlaced = () => false;
  const GROUNDING_RULE = `Bash(node "${GROUNDING_TOOL}":*)`;
  const runBridgeMain = (argv, cwd, findWrapper) => {
    const stdout = [];
    const stderr = [];
    const code = main([...argv, '--cwd', cwd], {
      log: (line) => stdout.push(line),
      errlog: (line) => stderr.push(line),
      findWrapper,
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };

  it('the FROZEN tier constant is exactly the two review wrappers (count sentinel)', () => {
    assert.deepEqual([...BRIDGE_REVIEW_WRAPPERS], ['codex-review', 'agy-review']);
    assert.equal(BRIDGE_REVIEW_WRAPPERS.length, 2, 'growing the tier is a reviewed decision, never a drive-by');
  });

  it('derivation (all placed): code-mode wildcards + the quoted grounding rule + excludedCommands; NEVER codex-exec/agy-run', () => {
    const bridge = deriveBridgeTierAllowlist({ findWrapper: allPlaced });
    assert.deepEqual([...bridge.allow], ['Bash(codex-review code:*)', 'Bash(agy-review code:*)', GROUNDING_RULE]);
    assert.deepEqual([...bridge.excludedCommands], ['codex-review', 'agy-review']);
    assert.deepEqual(bridge.skips, []);
    for (const entry of [...bridge.allow, ...bridge.excludedCommands]) {
      assert.doesNotMatch(entry, /codex-exec|agy-run/, 'non-review wrappers are NEVER seeded (delegated execution keeps its human prompt)');
    }
  });

  it('the grounding rule byte-equals the procedures-rendered spelling (seeded↔rendered parity)', () => {
    const bridge = deriveBridgeTierAllowlist({ findWrapper: allPlaced });
    assert.equal(bridge.allow.includes(`Bash(node "${GROUNDING_TOOL}":*)`), true, 'the seeded rule wraps exactly the rendered `node "${GROUNDING_TOOL}"` prefix');
  });

  it('an absent bridge is a STATED skip with zero entries for it; grounding derives ONLY with agy (codex R9)', () => {
    const onlyCodex = deriveBridgeTierAllowlist({ findWrapper: (cmd) => cmd === 'codex-review' });
    assert.deepEqual([...onlyCodex.allow], ['Bash(codex-review code:*)'], 'a codex-only install never auto-allows the agy facts pre-step writer');
    assert.deepEqual([...onlyCodex.excludedCommands], ['codex-review']);
    assert.equal(onlyCodex.skips.length, 1);
    assert.match(onlyCodex.skips[0].reason, /agy-review.*not placed/);
    const onlyAgy = deriveBridgeTierAllowlist({ findWrapper: (cmd) => cmd === 'agy-review' });
    assert.deepEqual([...onlyAgy.allow], ['Bash(agy-review code:*)', GROUNDING_RULE], 'the grounding rule rides the agy placement');
    const none = deriveBridgeTierAllowlist({ findWrapper: nonePlaced });
    assert.deepEqual([...none.allow], [], 'no placed bridge → no allow entries (grounding included)');
    assert.deepEqual([...none.excludedCommands], []);
    assert.equal(none.skips.length, 2);
  });

  it('the screen accepts EXACTLY the seeded code-mode forms and rejects every near-miss spelling', () => {
    assert.equal(screenAllowlistEntry('Bash(codex-review code:*)'), true);
    assert.equal(screenAllowlistEntry('Bash(agy-review code:*)'), true);
    assert.equal(screenAllowlistEntry(GROUNDING_RULE), true);
    // Near-misses: non-review wrappers, bare/plan/diff spellings, exact (non-wildcard) forms — the
    // file-argument modes can read outside the repo, so they must keep their prompt (codex R2).
    assert.equal(screenAllowlistEntry('Bash(codex-exec:*)'), false, 'the execution wrapper never passes');
    assert.equal(screenAllowlistEntry('Bash(agy-run:*)'), false, 'the probe wrapper never passes');
    assert.equal(screenAllowlistEntry('Bash(codex-review:*)'), false, 'the BARE wrapper prefix covers plan mode — not the tier form');
    assert.equal(screenAllowlistEntry('Bash(agy-review:*)'), false, 'the BARE wrapper prefix covers plan/diff modes — not the tier form');
    assert.equal(screenAllowlistEntry('Bash(codex-review plan:*)'), false, 'plan mode keeps its prompt');
    assert.equal(screenAllowlistEntry('Bash(agy-review diff:*)'), false, 'diff mode keeps its prompt');
    assert.equal(screenAllowlistEntry('Bash(codex-review code extra:*)'), false, 'an argument-bearing spelling is not the tier form');
    assert.equal(screenAllowlistEntry('Bash(codex-review code)'), false, 'the exact form is not the tier form');
  });

  it('NEGATIVE: no other node tool rides the quoted-grounding class', () => {
    assert.equal(screenAllowlistEntry(`Bash(node "${join(KIT_ROOT, 'tools/velocity-profile.mjs')}":*)`), false, 'a quoted WRITER path never passes');
    assert.equal(screenAllowlistEntry(`Bash(node "${join(KIT_ROOT, 'tools/recipes.mjs')}":*)`), false, 'the kit-tools tier stays UNQUOTED — quoted spellings are dead rules there');
    assert.equal(screenAllowlistEntry(`Bash(node ${GROUNDING_TOOL}:*)`), false, 'the UNQUOTED grounding spelling is not the seeded byte-form (grounding is a writer, not a kit-readonly tool)');
  });

  it('tier entries stay OFFCORE without the flag (flagless semantics unchanged)', () => {
    assert.throws(() => validateProfile(['Bash(codex-review code:*)']), (err) => err.code === VELOCITY_OFFCORE);
    assert.throws(() => validateProfile([GROUNDING_RULE]), (err) => err.code === VELOCITY_OFFCORE);
  });

  it('the tier notice states the informed-consent posture EXPLICITLY (codex R2 resolution, pinned)', () => {
    assert.match(KIT_BRIDGE_TIER_NOTICE, /runs UNATTENDED/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /reads any repo file it is pointed at and sends the assembled payload to its subscription backend/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /never codex-exec\/agy-run/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /never the plan\/diff modes/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /--facts\/--decided\) rides the same consent/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /scratch-destination guard/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /sandbox\.excludedCommands/);
    assert.match(KIT_BRIDGE_TIER_NOTICE, /PLAIN invocation starting with the wrapper name/);
  });

  it('a tiered apply seeds BOTH surfaces; a second apply is idempotent (merge-don’t-clobber)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), { sandbox: { enabled: true, excludedCommands: ['user-tool'] }, permissions: { allow: [] } });
    const first = runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced);
    assert.equal(first.code, EXIT_OK, first.stderr);
    const settings = readJson(settingsPath(cwd));
    for (const rule of ['Bash(codex-review code:*)', 'Bash(agy-review code:*)', GROUNDING_RULE]) {
      assert.equal(settings.permissions.allow.includes(rule), true, rule);
    }
    assert.deepEqual(settings.sandbox.excludedCommands, ['user-tool', 'codex-review', 'agy-review'], 'foreign exclusions preserved, tier names appended');
    assert.equal(settings.sandbox.enabled, true, 'foreign sandbox sub-keys preserved');
    const bytes = readText(settingsPath(cwd));
    const second = runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced);
    assert.equal(second.code, EXIT_OK);
    assert.equal(readText(settingsPath(cwd)), bytes, 'a second tiered apply changes nothing');
    assert.match(first.stdout, /runs UNATTENDED/, 'the notice prints on every tiered run');
  });

  it('audit self-consistency: the flagless advisory flags NONE of the tier’s own entries — and DOES flag them for an absent bridge', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced);
    const samehost = runBridgeMain(['--dry-run'], cwd, allPlaced);
    assert.equal(samehost.code, EXIT_OK);
    assert.doesNotMatch(samehost.stdout, /pre-existing non-read-only Bash allow entries/, 'no self-contradiction: seeded tier entries are tier-known to the audit');
    const otherhost = runBridgeMain(['--dry-run'], cwd, nonePlaced);
    assert.match(otherhost.stdout, /pre-existing non-read-only Bash allow entries/, 'NON-VACUOUS: the same entries flag where their bridges are NOT placed');
    assert.match(otherhost.stdout, /codex-review/);
  });

  it('a NON-ARRAY sandbox.excludedCommands is a fail-closed STOP — never treated as empty and overwritten (codex R1)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), { sandbox: { excludedCommands: 'codex-review' } });
    const original = readText(settingsPath(cwd));
    const dry = runBridgeMain(['--dry-run', '--bridge-tier'], cwd, allPlaced);
    const apply = runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced);
    assert.equal(dry.code, EXIT_PRECONDITION, 'the dry-run already STOPs (it must faithfully predict the apply)');
    assert.equal(apply.code, EXIT_PRECONDITION);
    assert.match(apply.stderr, /excludedCommands must be an array/);
    assert.equal(readText(settingsPath(cwd)), original, 'zero writes on the malformed STOP');
  });

  it('flagless runs never touch the sandbox block (no excludedCommands without the consent flag)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    const r = runBridgeMain(['--apply'], cwd, allPlaced);
    assert.equal(r.code, EXIT_OK, r.stderr);
    const settings = readJson(settingsPath(cwd));
    assert.equal(settings.sandbox, undefined, 'no sandbox block appears without --bridge-tier');
  });

  it('--bridge-tier cannot combine with --autonomy (allowlist-mode flag)', () => {
    assert.equal(runMainWithoutCwd(['--autonomy', '--bridge-tier']).code, EXIT_USAGE);
  });

  it('an UNSEEDABLE grounding path is a STATED skip, never a broken rule (the spaces class)', () => {
    const bridge = deriveBridgeTierAllowlist({ findWrapper: allPlaced, groundingAbsPath: '/kit with spaces/tools/grounding.mjs' });
    assert.deepEqual([...bridge.allow], ['Bash(codex-review code:*)', 'Bash(agy-review code:*)'], 'no grounding rule seeds');
    assert.equal(bridge.skips.some((s) => /grounding pre-step rule is not seeded/.test(s.reason)), true, 'the skip is stated');
  });

  it('a THROWING placement probe degrades the flagless advisory to over-flagging (defensive derive)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), { permissions: { allow: ['Bash(codex-review code:*)'] } });
    const r = runBridgeMain(['--dry-run'], cwd, () => { throw new Error('probe exploded'); });
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.match(r.stdout, /pre-existing non-read-only Bash allow entries/, 'over-flagging is the safe direction when the probe fails');
  });

  it('tier-known excludedCommands suppression demands PROOF — project file + the derived allow rules (codex R4)', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    // (a) hand-added exclusion WITHOUT the tier allow rules → stays a loud weakening.
    writeJson(settingsPath(cwd), { sandbox: { excludedCommands: ['codex-review'] } });
    const bare = runBridgeMain(['--autonomy'], cwd, allPlaced);
    assert.match(bare.stdout, /⚠ DEGRADE: .*excludedCommands/, 'a name-only match proves nothing');
    // (b) the tier's own output (allow rules + exclusion, project file) → an informational note.
    runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced);
    const tiered = runBridgeMain(['--autonomy'], cwd, allPlaced);
    assert.doesNotMatch(tiered.stdout, /⚠ DEGRADE: .*excludedCommands/, 'the proven tier output is never flagged');
    assert.match(tiered.stdout, /note: .*tier-known/, 'it is surfaced as a note instead');
    // (c) the same exclusion in settings.LOCAL.json → a loud weakening (never tier output).
    writeJson(localSettingsPath(cwd), { sandbox: { excludedCommands: ['agy-review'] } });
    const local = runBridgeMain(['--autonomy'], cwd, allPlaced);
    assert.match(local.stdout, /⚠ DEGRADE: settings\.local.*excludedCommands|⚠ DEGRADE: \.claude\/settings\.local\.json.*excludedCommands/, 'a local-file exclusion is never tier-known');
  });
});
