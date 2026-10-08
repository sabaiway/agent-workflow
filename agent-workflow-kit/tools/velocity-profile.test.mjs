import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  KIT_SOURCE_SIZE_TOOL,
  KIT_WRITER_PREVIEW_TOOLS,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  UNIVERSAL_READONLY_ALLOWLIST,
  VELOCITY_NON_READONLY,
  VELOCITY_INVALID_ARGUMENT,
  VELOCITY_MALFORMED,
  VELOCITY_OFFCORE,
  WORKFLOW_STAMP,
  deriveKitToolsAllowlist,
  discoverGateCandidates,
  isExecutableFile,
  main,
  parseArgs,
  planVelocityProfile,
  preflightVelocityProfile,
  screenAllowlistEntry,
  validateProfile,
  writeVelocityProfile,
} from './velocity-profile.mjs';
import { GROUNDING_TOOL, REPO_SEARCH_TOOL, REVIEW_ROUNDS_TOOL } from './procedures.mjs';
import { SCANNED_TOOL_LANES } from '../references/hooks/gate-approve.mjs';
import { buildRecommendations } from './recommendations.mjs';
import { bundledSandboxRecipe, usedBridges } from './bridge-sandbox-recipe.mjs';
import { stateDirsOf } from './bridge-state-dirs.mjs';

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
const SOURCE_SIZE_EXACT = `Bash(node ${join(KIT_ROOT, 'tools/source-size-check.mjs')} --check)`;
const PREVIEW_FORBIDDEN_FLAGS = ['--apply', '--write', '--yes', '--refresh-placed'];

describe('KIT_READONLY_TOOLS tier — frozen membership + derivation', () => {
  it('matches the frozen 15-member tool list + count sentinel', () => {
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
      'tools/repo-search.mjs',
      'tools/path-inventory.mjs',
      'tools/review-rounds-cli.mjs',
      'tools/control-bytes.mjs',
      'tools/robustness-brief.mjs',
    ];
    assert.equal(Object.isFrozen(KIT_READONLY_TOOLS), true);
    // 9 → 10: AD-044 Plan 4 Phase 3 — the recommendations advisor joins the tier.
    // 10 → 11: the literal search lane. Its allow rule is not a convenience here — a non-core
    // command gets NO decision from the hook, and no decision is not an allow.
    // 11 → 12: the inventory lane, for the same reason on the other half of the corpus.
    // 12 → 13: the round table. 13 → 14: control-bytes. 14 → 15: robustness-brief.
    assert.equal(KIT_READONLY_TOOLS.length, 15, 'kit-tools tier count sentinel - edit deliberately');
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

  it('derives 14 wildcard entries + the exact run-gates and source-size entries + 3 exact previews (count sentinel 19)', () => {
    const derived = tierEntries();
    assert.equal(Object.isFrozen(derived), true);
    // 12 → 13: AD-044 Plan 4 Phase 3 — the recommendations advisor joins KIT_READONLY_TOOLS.
    // 13 → 14: the literal search lane joins as a wildcard entry.
    // 14 → 15: the inventory lane joins as a wildcard entry.
    // 15 → 16: the source-size checker joins as a SECOND exact entry — its --check mode only.
    // 16 → 17: the round table joins as a wildcard entry.
    // 17 → 18: control-bytes. 18 → 19: robustness-brief.
    assert.equal(derived.length, 19, 'derived tier count sentinel - edit deliberately');
    const wildcards = derived.filter((e) => e.endsWith(':*)'));
    assert.equal(wildcards.length, 14);
    for (const rel of KIT_READONLY_TOOLS) {
      if (rel === KIT_RUN_GATES_TOOL) continue;
      assert.equal(derived.includes(wildcardEntryOf(rel)), true, rel);
    }
    assert.equal(derived.includes(RUN_GATES_EXACT), true, 'the exact root-pinned run-gates entry');
    assert.equal(derived.includes(SOURCE_SIZE_EXACT), true, 'the exact source-size --check entry');
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) assert.equal(derived.includes(previewEntryOf(rel)), true, rel);
  });

  // 4.1.d — the check-only rule. The tool is a WRITER; exactly ONE of its modes is seeded.
  it('check-invocation-promptless-rule-seeded: the exact --check form is derived and screens read-only', () => {
    assert.equal(KIT_SOURCE_SIZE_TOOL, 'tools/source-size-check.mjs');
    assert.equal(SOURCE_SIZE_EXACT, `Bash(node ${join(KIT_ROOT, 'tools/source-size-check.mjs')} --check)`);
    assert.equal(tierEntries().includes(SOURCE_SIZE_EXACT), true);
    assert.equal(screenAllowlistEntry(SOURCE_SIZE_EXACT), true, 'the seeded entry must pass its own screen');
    // It joins NEITHER list — a wildcard would cover the writers, and its arg-free form is a usage
    // error rather than a dry-run, so the writer-preview class does not describe it either.
    assert.equal(KIT_READONLY_TOOLS.includes(KIT_SOURCE_SIZE_TOOL), false);
    assert.equal(KIT_WRITER_PREVIEW_TOOLS.includes(KIT_SOURCE_SIZE_TOOL), false);
  });

  // The seeded rule and the DECLARED gate cmd are deliberately DIFFERENT strings, and the near-miss
  // is easy to assume — this pins both halves: that they cannot be made equal, and that no surface
  // says they are. The retired phrase is assembled from parts so this file cannot match itself.
  it('the seeded rule is NOT the declared gate cmd, and no surface claims it is', () => {
    const gateRule = `Bash(node "${join(KIT_ROOT, 'tools/source-size-check.mjs')}" --check)`;
    assert.notEqual(gateRule, SOURCE_SIZE_EXACT, 'the fill quotes the path so a space survives; a seedable rule may not');
    assert.equal(screenAllowlistEntry(gateRule), false, 'the quoted form is not even seedable — the equality is unreachable, not merely absent');
    const retired = ['the declared gate', 'carries'].join(' ');
    for (const file of ['velocity-profile.mjs', 'velocity-profile.test.mjs']) {
      const text = readFileSync(join(KIT_ROOT, 'tools', file), 'utf8');
      assert.equal(text.includes(retired), false, `${file} must not claim the seeded rule IS the declared gate cmd`);
    }
  });

  // The hook's scanned-tool lanes are DELIBERATELY untouched: each entry promises an out-of-band
  // recovery flag for caller-supplied argument bytes, and the source-size checker has none — a wrong
  // entry would make the hook advise the impossible. The settings allow rule alone is the mechanism.
  it('hook-lanes-unchanged: the source-size checker is NOT in the hook\'s scanned-tool lanes', () => {
    assert.deepEqual(
      Object.keys(SCANNED_TOOL_LANES),
      ['agent-workflow-kit/tools/repo-search.mjs', 'agent-workflow-kit/tools/path-inventory.mjs'],
      'scanned-tool lane membership sentinel — the two tools that take caller-supplied argument bytes',
    );
    for (const lane of Object.keys(SCANNED_TOOL_LANES)) {
      assert.equal(lane.includes('source-size'), false, lane);
    }
  });

  it('writer-invocation-not-matched-by-any-seeded-rule: --write-baseline, --adopt, a wildcard and a --cwd form all stay uncovered', () => {
    const derived = tierEntries();
    const abs = join(KIT_ROOT, 'tools/source-size-check.mjs');
    for (const uncovered of [
      `Bash(node ${abs}:*)`,
      `Bash(node ${abs})`,
      `Bash(node ${abs} --write-baseline)`,
      `Bash(node ${abs} --adopt)`,
      `Bash(node ${abs} --check --cwd ${TIER_PROJECT})`,
    ]) {
      assert.equal(derived.includes(uncovered), false, `not seeded: ${uncovered}`);
      assert.equal(screenAllowlistEntry(uncovered), false, `not screenable: ${uncovered}`);
    }
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
    assert.match(dry.stdout, /would add kit-tools tier entries: 19/);
    assert.equal(existsSync(settingsPath(cwd)), false);
    assert.equal(existsSync(pathOf(cwd, CLAUDE_DIR)), false);
  });

  // THE RESEED BOUNDARY, as a mechanism rather than a release note. Registry membership governs only
  // what the profile seeds on its NEXT run: a project whose settings were written by an earlier kit
  // does NOT gain a new tool's allow rule by upgrading. What makes that recoverable rather than
  // silent is that the delta is computed against the project's OWN allow list, so the missing entry
  // is reported and the advisor can offer the one-line re-run.
  it('a project seeded by an EARLIER kit is told exactly which tier entries it is missing', (t) => {
    const cwd = makeTempProject(t);
    ensureClaudeDir(cwd);
    const already = derivedFor(cwd).filter((entry) => !entry.includes('path-inventory.mjs'));
    writeJson(settingsPath(cwd), { permissions: { allow: already } });

    const dry = runMain(['--kit-tools'], cwd);
    assert.equal(dry.code, EXIT_OK);
    assert.match(dry.stdout, /would add kit-tools tier entries: 1/);
    assert.match(dry.stdout, /path-inventory\.mjs/);
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

describe('bridge-wrappers tier — frozen membership, derivation, screen, audit self-consistency', () => {
  const allPlaced = () => true;
  const nonePlaced = () => false;
  const GROUNDING_RULE = `Bash(node "${GROUNDING_TOOL}":*)`;
  const runBridgeMain = (argv, cwd, findWrapper = nonePlaced, extra = {}) => {
    const stdout = [];
    const stderr = [];
    const code = main([...argv, '--cwd', cwd], {
      log: (line) => stdout.push(line),
      errlog: (line) => stderr.push(line),
      findWrapper,
      detect: () => [],
      home: join(cwd, 'synthetic-home'),
      env: { PATH: '/nonexistent-path-for-tests', HOME: join(cwd, 'synthetic-home') },
      ...extra,
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };
  const BUNDLE_ROOT = join(KIT_ROOT, 'bridges');
  const BUNDLES = ['antigravity-cli-bridge', 'codex-cli-bridge'];
  const manifestPath = (bundle) => join(BUNDLE_ROOT, bundle, 'capability.json');
  const AGY_HOSTS = readJson(manifestPath('antigravity-cli-bridge')).networkHosts;
  const CODEX_HOSTS = readJson(manifestPath('codex-cli-bridge')).networkHosts;
  const UNION_HOSTS = [...AGY_HOSTS, ...CODEX_HOSTS.filter((host) => !AGY_HOSTS.includes(host))];
  const READY = BUNDLES.map((name) => ({ name, readiness: 'ready' }));
  const signedOut = (name) => READY.map((row) => ({ ...row, readiness: row.name === name ? 'needs-credentials' : 'ready' }));
  const reviewConfig = (review) => Object.fromEntries(
    ['plan-authoring', 'plan-execution', 'feedback-triage', 'epic'].map((activity) => [activity, { review }]),
  );
  const bridgeProject = (t, config = reviewConfig('council'), readiness = READY) => {
    const fixture = makeTempProject(t);
    const cwd = join(fixture, 'project');
    const home = join(fixture, 'home');
    mkdirSync(home);
    seedWorkflowStamp(cwd);
    ensureClaudeDir(cwd);
    if (config !== null) writeJson(join(cwd, 'docs/ai/orchestration.json'), config);
    const env = { PATH: '/nonexistent-path-for-tests', HOME: home, TMPDIR: join(fixture, 'scratch') };
    const writes = [];
    const writeFile = (path, ...args) => {
      writes.push(path);
      writeFileSync(path, ...args);
    };
    return { cwd, home, env, writes, writeFile, detect: () => readiness, findWrapper: nonePlaced, ...bundleDeps() };
  };
  const bundleDeps = (entries = BUNDLES, readFile = readFileSync) => ({ bundleRoot: BUNDLE_ROOT, readdir: (dir) => (dir === BUNDLE_ROOT ? entries : readdirSync(dir)), readFile });
  const failWith = (code) => { throw Object.assign(new Error(`${code}: fixture`), { code }); };
  const HOSTS_HEADER = /^(?:would add|added) sandbox\.network\.allowedDomains entries: (\d+)$/;
  const listedEntries = (stdout, header) => {
    const lines = stdout.split('\n');
    const at = lines.findIndex((line) => header.test(line));
    if (at < 0) return undefined;
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => !line.startsWith('  - '));
    const entries = rest.slice(0, end).map((line) => line.slice(4));
    const count = Number(lines[at].match(header)[1]);
    return { count, entries: count === 0 && entries.length === 1 && entries[0] === '(none)' ? [] : entries, after: rest[end] };
  };
  const listedHosts = (stdout) => {
    const block = listedEntries(stdout, HOSTS_HEADER);
    return block && { ...block, hosts: block.entries };
  };
  const listedDirs = (stdout) => listedEntries(stdout, /^(?:would add|added) sandbox\.filesystem\.allowWrite entries: (\d+)$/);
  const listedAllow = (stdout) => listedEntries(stdout, /^(?:would add|added) bridge-wrappers tier allow entries: (\d+)$/);
  const listedExcluded = (stdout) => listedEntries(stdout, /^(?:would add|added) sandbox\.excludedCommands entries: (\d+)$/);
  const assertLists = (stdout, expected, label) => {
    for (const [key, parse, present] of [
      ['allow', listedAllow, 'bridge tier'],
      ['excluded', listedExcluded, 'excludedCommands'],
      ['hosts', listedHosts, 'allowedDomains'],
      ['dirs', listedDirs, 'allowWrite'],
    ]) {
      const block = parse(stdout);
      assert.deepEqual(block?.entries ?? [], expected[key], `${label}: exact ${key} list`);
      if (block || expected[key].length || key === 'allow' || key === 'excluded') {
        assert.equal(block?.count, expected[key].length, `${label}: ${key} count`);
        assert.match(block?.after ?? '', new RegExp(`^already present \\(${present}\\): \\d+$`), `${label}: ${key} present line`);
      }
    }
  };

  it('the FROZEN tier constant is exactly the two review wrappers (count sentinel)', () => {
    assert.deepEqual([...BRIDGE_REVIEW_WRAPPERS], ['codex-review', 'agy-review']);
    assert.equal(BRIDGE_REVIEW_WRAPPERS.length, 2, 'growing the tier is a reviewed decision, never a drive-by');
  });

  it('derivation uses review and execute roles: code-mode allows, grounding and * exclusions without execution allows', async () => {
    const { usedBridges, bundledSandboxRecipe } = await import('./bridge-sandbox-recipe.mjs').catch(() => ({}));
    assert.equal(typeof usedBridges, 'function', 'usedBridges is not exported yet (S2-15)');
    assert.equal(typeof bundledSandboxRecipe, 'function', 'bundledSandboxRecipe is not exported yet (S2-15)');
    const config = reviewConfig('council');
    config['plan-execution'].execute = 'delegated';
    const used = usedBridges(config, READY);
    assert.deepEqual(used, [
      { bridge: 'antigravity-cli-bridge', roles: ['review'] },
      { bridge: 'codex-cli-bridge', roles: ['review', 'execute'] },
    ]);
    const bridge = bundledSandboxRecipe(used, bundleDeps());
    assert.deepEqual(bridge.allow, ['Bash(agy-review code:*)', GROUNDING_RULE, 'Bash(codex-review code:*)']);
    assert.deepEqual(bridge.excludedCommands, ['agy-review *', 'codex-review *', 'codex-exec *']);
    assert.deepEqual(bridge.skips, []);
    for (const entry of bridge.allow) {
      assert.doesNotMatch(entry, /codex-exec|agy-run/, 'execution and probe wrappers keep their permission prompt');
    }
  });

  it('the grounding rule byte-equals the procedures-rendered spelling (seeded↔rendered parity)', async () => {
    const { bundledSandboxRecipe } = await import('./bridge-sandbox-recipe.mjs').catch(() => ({}));
    assert.equal(typeof bundledSandboxRecipe, 'function', 'bundledSandboxRecipe is not exported yet (S2-15)');
    const bridge = bundledSandboxRecipe(['agy-review'], bundleDeps());
    assert.ok(Array.isArray(bridge.allow), 'bundledSandboxRecipe has no allow form yet (S2-15)');
    assert.equal(bridge.allow.includes(`Bash(node "${GROUNDING_TOOL}":*)`), true, 'the seeded rule wraps exactly the rendered `node "${GROUNDING_TOOL}"` prefix');
  });

  it('the screen accepts EXACTLY the seeded code-mode forms and rejects every near-miss spelling', () => {
    assert.equal(screenAllowlistEntry('Bash(codex-review code:*)'), true);
    assert.equal(screenAllowlistEntry('Bash(agy-review code:*)'), true);
    assert.equal(screenAllowlistEntry(GROUNDING_RULE), true);
    // Near-misses: non-review wrappers, bare/plan/diff spellings, exact (non-wildcard) forms — the
    // file-argument modes can read outside the repo, so they must keep their prompt.
    assert.equal(screenAllowlistEntry('Bash(codex-exec:*)'), false, 'the execution wrapper never passes');
    assert.equal(screenAllowlistEntry('Bash(agy-run:*)'), false, 'the probe wrapper never passes');
    assert.equal(screenAllowlistEntry('Bash(codex-review:*)'), false, 'the BARE wrapper prefix covers plan mode — not the tier form');
    assert.equal(screenAllowlistEntry('Bash(agy-review:*)'), false, 'the BARE wrapper prefix covers plan/diff modes — not the tier form');
    assert.equal(screenAllowlistEntry('Bash(codex-review plan:*)'), false, 'plan mode keeps its prompt');
    assert.equal(screenAllowlistEntry('Bash(agy-review diff:*)'), false, 'diff mode keeps its prompt');
    assert.equal(screenAllowlistEntry('Bash(codex-review code extra:*)'), false, 'an argument-bearing spelling is not the tier form');
    assert.equal(screenAllowlistEntry('Bash(codex-review code)'), false, 'the exact form is not the tier form');
  });

  it('the kit-tools tier seeds repo-search in EXACTLY the BARE byte-form the readers-sweep advisor renders', () => {
    assert.equal(tierEntries().includes(`Bash(node ${REPO_SEARCH_TOOL}:*)`), true, 'the seeded rule wraps exactly the rendered `node ${REPO_SEARCH_TOOL}` prefix — a quoted render is a dead rule');
    assert.equal(screenAllowlistEntry(`Bash(node "${REPO_SEARCH_TOOL}":*)`), false, 'the quoted spelling is NOT seedable — the screen accepts a quoted node token only for grounding');
  });

  it('the kit-tools tier seeds review-rounds-cli in EXACTLY the BARE byte-form the review-loop advisor renders', () => {
    assert.equal(tierEntries().includes(`Bash(node ${REVIEW_ROUNDS_TOOL}:*)`), true, 'the seeded rule wraps exactly the rendered `node ${REVIEW_ROUNDS_TOOL}` prefix — a quoted render is a dead rule');
    assert.equal(screenAllowlistEntry(`Bash(node "${REVIEW_ROUNDS_TOOL}":*)`), false, 'the quoted spelling is NOT seedable');
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

  it('dry-run derives exact surfaces from used roles, readiness, rosters, degradation and defaults — spec:velocity-profile/S1', (t) => {
    const codex = { allow: ['Bash(codex-review code:*)'], excluded: ['codex-review *'], hosts: CODEX_HOSTS, dirs: ['~/.codex'] };
    const council = {
      allow: ['Bash(agy-review code:*)', GROUNDING_RULE, ...codex.allow],
      excluded: ['agy-review *', 'codex-review *'],
      hosts: UNION_HOSTS,
      dirs: ['~/.gemini/antigravity-cli', '~/.codex'],
    };
    const execute = { allow: [], excluded: ['codex-exec *'], hosts: CODEX_HOSTS, dirs: ['~/.codex'] };
    const empty = { allow: [], excluded: [], hosts: [], dirs: [] };
    const delegated = reviewConfig('solo');
    delegated['plan-execution'].execute = 'delegated';
    const cases = [
      ['every review slot reviewed', reviewConfig('reviewed'), READY, codex],
      ['council union', reviewConfig('council'), READY, council],
      ['roster with signed-out agy', reviewConfig(['codex-review', 'agy-review', 'review-lens']), signedOut('antigravity-cli-bridge'), codex],
      ['council degraded to reviewed', reviewConfig('council'), signedOut('antigravity-cli-bridge'), codex],
      ['delegated execution only', delegated, READY, execute],
      ['delegated codex signed out', delegated, signedOut('codex-cli-bridge'), empty],
      ['absent config computed default', null, READY, codex],
      ['placed ready agy unused by any slot', reviewConfig('reviewed'), READY, codex],
      ['all slots solo with both bridges ready', reviewConfig('solo'), READY, empty],
    ];
    assert.deepEqual([CODEX_HOSTS.length, AGY_HOSTS.length, UNION_HOSTS.length], [4, 6, 8]);
    for (const [label, config, readiness, expected] of cases) {
      const deps = bridgeProject(t, config, readiness);
      const r = runBridgeMain(['--bridge-tier'], deps.cwd, nonePlaced, deps);
      assert.equal(r.code, EXIT_OK, r.stderr);
      assertLists(r.stdout, expected, label);
      assert.equal(existsSync(settingsPath(deps.cwd)), false, `${label}: dry-run creates no settings`);
      if (expected.excluded.length === 0) {
        const applied = runBridgeMain(['--apply', '--bridge-tier'], deps.cwd, nonePlaced, deps);
        assert.equal(applied.code, EXIT_OK, applied.stderr);
        assert.equal(readJson(settingsPath(deps.cwd)).sandbox, undefined, `${label}: no used bridge writes no sandbox key`);
      }
    }
  });

  it('pre-revision wiring merges * forms and missing dirs once, preserves siblings, and matches Recommendations delta — spec:velocity-profile/S2', (t) => {
    for (const covering of [[], ['~/.gemini']]) {
      const config = reviewConfig('council');
      config['plan-execution'].execute = 'delegated';
      const deps = bridgeProject(t, config);
      const allow = ['Bash(agy-review code:*)', GROUNDING_RULE, 'Bash(codex-review code:*)', 'Bash(foreign read:*)'];
      const excludedCommands = ['codex-review', 'agy-review', 'foreign-tool'];
      const network = { allowedDomains: ['internal.example.com', ...UNION_HOSTS], allowLocalBinding: true };
      const filesystem = { allowWrite: ['/foreign/state', ...covering], denyWrite: ['/private/state'] };
      const sandbox = { enabled: true, excludedCommands, network, filesystem };
      writeJson(settingsPath(deps.cwd), { permissions: { allow }, sandbox });
      const original = readText(settingsPath(deps.cwd));
      const expected = {
        allow: [],
        excluded: ['agy-review *', 'codex-review *', 'codex-exec *'],
        hosts: [],
        dirs: covering.length ? ['~/.codex'] : ['~/.gemini/antigravity-cli', '~/.codex'],
      };
      const recommendationDeps = {
        findWrapper: nonePlaced,
        env: deps.env,
        getenv: deps.env,
        home: deps.home,
        detect: deps.detect,
        takeCensus: () => ({
          counts: { assessable: 3, unsupported: 0, 'out-of-domain': 1, 'excluded-test': 0 },
          unsupportedExtensions: [],
          verdict: 'within-domain',
          total: 4,
        }),
      };
      const before = buildRecommendations({ cwd: deps.cwd, deps: recommendationDeps });
      const dry = runBridgeMain(['--bridge-tier'], deps.cwd, nonePlaced, deps);
      assert.equal(dry.code, EXIT_OK, dry.stderr);
      assertLists(dry.stdout, expected, 'pre-revision dry-run');
      assert.equal(readText(settingsPath(deps.cwd)), original);
      const applied = runBridgeMain(['--apply', '--bridge-tier'], deps.cwd, nonePlaced, deps);
      assert.equal(applied.code, EXIT_OK, applied.stderr);
      assertLists(applied.stdout, expected, 'pre-revision apply');
      for (const parse of [listedAllow, listedExcluded, listedHosts, listedDirs]) {
        assert.deepEqual(parse(dry.stdout), parse(applied.stdout), 'dry-run lists equal apply additions');
      }
      const delta = Object.values(expected).reduce((sum, entries) => sum + entries.length, 0);
      assert.equal(before.items.find((item) => item.key === 'bridge-tier')?.what,
        `bridge-wrappers tier incomplete — ${delta} entr(ies) missing (allow rules, exclusions, hosts or state dirs of used bridges)`);
      assert.equal(before.skips.some((skip) => skip.key === 'bridge-tier'), false);
      const settings = readJson(settingsPath(deps.cwd));
      assert.deepEqual(settings.permissions.allow, [...allow, ...UNIVERSAL_READONLY_ALLOWLIST]);
      assert.deepEqual(settings.sandbox, {
        ...sandbox,
        excludedCommands: [...excludedCommands, ...expected.excluded],
        filesystem: { ...filesystem, allowWrite: [...filesystem.allowWrite, ...expected.dirs] },
      });
      assert.match(applied.stdout, new RegExp(`^already present \\(allowWrite\\): ${covering.length}$`, 'm'));
      const bytes = readText(settingsPath(deps.cwd));
      assert.equal(runBridgeMain(['--apply', '--bridge-tier'], deps.cwd, nonePlaced, deps).code, EXIT_OK);
      assert.equal(readText(settingsPath(deps.cwd)), bytes, 'second apply leaves every byte unchanged');
      const after = buildRecommendations({ cwd: deps.cwd, deps: recommendationDeps });
      assert.equal(after.items.some((item) => item.key === 'bridge-tier'), false);
      assert.equal(after.skips.some((skip) => skip.key === 'bridge-tier'), false);
    }
  });

  it('writer to-add lists come from the leaf on bare-name, covering-dir and complete trees — spec:velocity-profile/S16', async (t) => {
    const { sandboxSurfaceDelta } = await import('./bridge-wiring.mjs').catch(() => ({}));
    const computeDelta = sandboxSurfaceDelta ?? (() => { throw new Error('bridge-wiring.mjs absent'); });
    const config = reviewConfig('council');
    config['plan-execution'].execute = 'delegated';
    const excludedCommands = ['agy-review *', 'codex-review *', 'codex-exec *'];
    const trees = [
      { excludedCommands: ['codex-review', 'agy-review'], network: { allowedDomains: UNION_HOSTS } },
      { excludedCommands, network: { allowedDomains: UNION_HOSTS.slice(1) }, filesystem: { allowWrite: ['~/.gemini'] } },
      { excludedCommands, network: { allowedDomains: UNION_HOSTS }, filesystem: { allowWrite: ['~/.gemini/antigravity-cli', '~/.codex'] } },
    ];
    for (const sandbox of trees) {
      const deps = bridgeProject(t, config, READY);
      const { cwd, env, home } = deps;
      const settings = { sandbox };
      writeJson(settingsPath(cwd), settings);
      const preflight = preflightVelocityProfile({ cwd }, deps);
      const plan = planVelocityProfile(preflight, { bridgeTier: true, ...deps });
      const recipe = bundledSandboxRecipe(usedBridges(config, READY), deps);
      const dirs = stateDirsOf(recipe.dirEntries, { env, root: cwd, home });
      const delta = computeDelta({ excludedCommands: recipe.excludedCommands, hosts: recipe.hosts, dirs }, settings.sandbox, { home, root: cwd });
      assert.deepEqual(
        [plan.excludedToAdd, plan.hostsToAdd, plan.dirsToAdd],
        [delta.excludedCommands, delta.hosts, delta.dirs],
      );
      if (sandbox === trees.at(-1)) assert.deepEqual([plan.excludedToAdd, plan.hostsToAdd, plan.dirsToAdd], [[], [], []]);
    }
    const source = readText(join(KIT_ROOT, 'tools/velocity-profile.mjs'));
    assert.match(source,
      /import\s*\{(?=[^}]*\bsandboxSurfaceDelta\b)(?=[^}]*\bHOST_HONORS_QUALIFIER\b)[^}]*\}\s*from\s*['"]\.\/bridge-wiring\.mjs['"]/);
    const body = source.split('export const planVelocityProfile')[1]?.split('\nexport const ')[0] ?? '';
    assert.match(body, /\bsandboxSurfaceDelta\(/);
    assert.doesNotMatch(body, /\bmissingStateDirs\(/);
    assert.doesNotMatch(body, /\bexisting\w*\.includes\(/);
  });

  it('malformed tier network/filesystem keys STOP dry-run and apply with zero writes; other modes and local keys keep their result — spec:velocity-profile/S3', (t) => {
    const malformed = [
      [{ network: ['x'] }, 'sandbox.network'],
      [{ network: { allowedDomains: 'x' } }, 'sandbox.network.allowedDomains'],
      [{ filesystem: ['x'] }, 'sandbox.filesystem'],
      [{ filesystem: { allowWrite: 'x' } }, 'sandbox.filesystem.allowWrite'],
      ...[42, '', '   '].map((entry) => [{ filesystem: { allowWrite: [entry] } }, 'sandbox.filesystem.allowWrite']),
    ];
    for (const [sandbox, key] of malformed) {
      const deps = bridgeProject(t);
      writeJson(join(deps.cwd, 'docs/ai/autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
      writeJson(settingsPath(deps.cwd), { sandbox });
      const original = readText(settingsPath(deps.cwd));
      for (const argv of [['--bridge-tier'], ['--apply', '--bridge-tier']]) {
        const r = runBridgeMain(argv, deps.cwd, nonePlaced, deps);
        assert.equal(r.code, EXIT_PRECONDITION, `${key}: ${argv.join(' ')} STOPs`);
        assert.ok(r.stderr.includes(key), r.stderr);
        assert.throws(() => writeVelocityProfile({ cwd: deps.cwd, bridgeTier: true, dryRun: !argv.includes('--apply') }, deps),
          (err) => err.code === VELOCITY_MALFORMED && err.message.includes(key));
        assert.equal(readText(settingsPath(deps.cwd)), original, `${key}: zero writes`);
        assert.deepEqual(deps.writes, [], `${key}: no writer called`);
      }
      for (const argv of [[], ['--kit-tools'], ['--autonomy']]) {
        const r = runBridgeMain(argv, deps.cwd, nonePlaced, deps);
        assert.equal(r.code, EXIT_OK, `${argv.join(' ') || 'flagless'}: ${r.stderr}`);
        assert.match(r.stdout, argv.includes('--autonomy') ? /^agent-workflow autonomy render - DRY RUN/ : /^agent-workflow velocity profile - DRY RUN/);
        assert.equal(readText(settingsPath(deps.cwd)), original);
      }
      writeJson(settingsPath(deps.cwd), {});
      writeJson(localSettingsPath(deps.cwd), { sandbox });
      const localBytes = readText(localSettingsPath(deps.cwd));
      for (const argv of [['--bridge-tier'], ['--apply', '--bridge-tier']]) {
        const r = runBridgeMain(argv, deps.cwd, nonePlaced, deps);
        assert.equal(r.code, EXIT_OK, `${key} in local settings alone: ${r.stderr}`);
        assert.equal(readText(localSettingsPath(deps.cwd)), localBytes);
      }
    }
  });

  it('manifest, rejected config and dangerous CODEX_HOME STOP with zero writes; stray bundle entries are skipped — spec:velocity-profile/S4', (t) => {
    const deps = bridgeProject(t);
    writeJson(settingsPath(deps.cwd), { permissions: { allow: [] } });
    const original = readText(settingsPath(deps.cwd));
    const broken = manifestPath('codex-cli-bridge');
    const readers = [
      (path, enc) => path === broken ? failWith('EACCES') : readFileSync(path, enc),
      (path, enc) => path === broken ? '{ not json' : readFileSync(path, enc),
    ];
    const stops = readers.map((readFile) => ({ deps: { ...deps, ...bundleDeps(BUNDLES, readFile) }, key: 'capability.json' }));
    for (const config of ['{ not json', JSON.stringify({ 'plan-execution': { review: 'unknown-recipe' } })]) {
      stops.push({ deps, key: 'docs/ai/orchestration.json', config });
    }
    for (const codexHome of [deps.home, `${deps.home}/`, dirname(deps.cwd)]) {
      writeJson(join(codexHome, 'auth.json'), {});
      stops.push({ deps: { ...deps, env: { ...deps.env, CODEX_HOME: codexHome } }, key: 'CODEX_HOME' });
    }
    for (const scenario of stops) {
      writeText(join(deps.cwd, 'docs/ai/orchestration.json'), scenario.config ?? JSON.stringify(reviewConfig('council')));
      for (const argv of [['--bridge-tier'], ['--apply', '--bridge-tier']]) {
        const r = runBridgeMain(argv, deps.cwd, nonePlaced, scenario.deps);
        assert.equal(r.code, EXIT_PRECONDITION, `${scenario.key}: ${argv.join(' ')} STOPs`);
        assert.ok(r.stderr.includes(scenario.key), r.stderr);
        assert.equal(readText(settingsPath(deps.cwd)), original, `${scenario.key}: zero writes`);
        assert.deepEqual(deps.writes, [], `${scenario.key}: no writer called`);
      }
    }
    writeJson(join(deps.cwd, 'docs/ai/orchestration.json'), reviewConfig('council'));
    const stray = manifestPath('.DS_Store');
    const readFile = (path, enc) => path === stray ? failWith('ENOTDIR') : readFileSync(path, enc);
    const r = runBridgeMain(['--bridge-tier'], deps.cwd, nonePlaced, { ...deps, ...bundleDeps(['.DS_Store', ...BUNDLES], readFile) });
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.deepEqual(listedHosts(r.stdout)?.hosts, UNION_HOSTS);
    assert.deepEqual(listedDirs(r.stdout)?.entries, ['~/.gemini/antigravity-cli', '~/.codex']);
    assert.equal(readText(settingsPath(deps.cwd)), original);
  });

  it('dry-run lists allowWrite beside other surfaces without writes; notice and USAGE name every conditional widening — spec:velocity-profile/S5', (t) => {
    const config = reviewConfig('council');
    config['plan-execution'].execute = 'delegated';
    const deps = bridgeProject(t, config);
    writeJson(settingsPath(deps.cwd), {});
    const original = readText(settingsPath(deps.cwd));
    const r = runBridgeMain(['--bridge-tier'], deps.cwd, nonePlaced, deps);
    assert.equal(r.code, EXIT_OK, r.stderr);
    assertLists(r.stdout, {
      allow: ['Bash(agy-review code:*)', GROUNDING_RULE, 'Bash(codex-review code:*)'],
      excluded: ['agy-review *', 'codex-review *', 'codex-exec *'],
      hosts: UNION_HOSTS,
      dirs: ['~/.gemini/antigravity-cli', '~/.codex'],
    }, 'dry-run blocks');
    assert.equal(listedDirs(r.stdout)?.after, 'already present (allowWrite): 0');
    assert.ok(r.stdout.indexOf('sandbox.filesystem.allowWrite entries:') > r.stdout.indexOf('already present (allowedDomains):'));
    assert.equal(readText(settingsPath(deps.cwd)), original, 'dry-run writes nothing');
    assert.deepEqual(deps.writes, []);
    const help = runBridgeMain(['--help'], deps.cwd, nonePlaced, deps);
    assert.equal(help.code, EXIT_OK);
    const usage = help.stdout.slice(help.stdout.indexOf('\n--bridge-tier'), help.stdout.indexOf('\n--autonomy')).replace(/\s+/g, ' ');
    for (const [label, text] of [['notice', KIT_BRIDGE_TIER_NOTICE], ['USAGE', usage]]) {
      for (const literal of [
        HOST_HONORS_QUALIFIER, 'runs outside the sandbox', 'every sandboxed command of the project can reach',
        'every sandboxed command can write', 'codex-exec *', 'keeps its prompt', 'used bridge',
        'sandbox.excludedCommands', 'sandbox.network.allowedDomains', 'allowWrite',
      ]) {
        assert.ok(text.includes(literal), `${label} contains ${literal}`);
      }
      assert.doesNotMatch(text, /hand-apply|unseeded|never seeds|placed bridges|weakening|credential/i, label);
    }
  });

  it('audit self-consistency: the flagless advisory flags NONE of the tier’s own entries — and DOES flag them for an absent bridge', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    runBridgeMain(['--apply', '--bridge-tier'], cwd, allPlaced, { detect: () => READY });
    const samehost = runBridgeMain(['--dry-run'], cwd, allPlaced);
    assert.equal(samehost.code, EXIT_OK);
    assert.doesNotMatch(samehost.stdout, /pre-existing non-read-only Bash allow entries/, 'no self-contradiction: seeded tier entries are tier-known to the audit');
    const otherhost = runBridgeMain(['--dry-run'], cwd, nonePlaced);
    assert.match(otherhost.stdout, /pre-existing non-read-only Bash allow entries/, 'NON-VACUOUS: the same entries flag where their bridges are NOT placed');
    assert.match(otherhost.stdout, /codex-review/);
  });

  it('a NON-ARRAY sandbox.excludedCommands is a fail-closed STOP — never treated as empty and overwritten (review-velocity-profile-r01-major-01)', (t) => {
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

  it('an UNSEEDABLE grounding path is a STATED skip, never a broken rule (the spaces class)', async () => {
    const { bundledSandboxRecipe } = await import('./bridge-sandbox-recipe.mjs').catch(() => ({}));
    assert.equal(typeof bundledSandboxRecipe, 'function', 'bundledSandboxRecipe is not exported yet (S2-15)');
    const bridge = bundledSandboxRecipe([...BRIDGE_REVIEW_WRAPPERS], { ...bundleDeps(), groundingAbsPath: '/kit with spaces/tools/grounding.mjs' });
    assert.ok(Array.isArray(bridge.allow), 'bundledSandboxRecipe has no allow form yet (S2-15)');
    assert.deepEqual(bridge.allow, ['Bash(agy-review code:*)', 'Bash(codex-review code:*)'], 'no grounding rule seeds');
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

  it('autonomy preview proves each tier entry, preserves foreign/local DEGRADE, and falls back on rejected config — spec:velocity-profile/S9', (t) => {
    const config = reviewConfig('council');
    config['plan-execution'].execute = 'delegated';
    const deps = bridgeProject(t, config);
    writeJson(join(deps.cwd, 'docs/ai/autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    const allow = ['Bash(agy-review code:*)', GROUNDING_RULE, 'Bash(codex-review code:*)'];
    const surfaces = {
      excludedCommands: ['agy-review', 'agy-review *', 'codex-review', 'codex-review *', 'codex-exec *'],
      network: { allowedDomains: UNION_HOSTS },
      filesystem: { allowWrite: ['~/.gemini/antigravity-cli', '~/.codex'] },
    };
    const note = (key, entry, widening) =>
      `  note: ${SETTINGS_FILE} has ${key} entry ${JSON.stringify(entry)} — tier-known: part of the bridge-wrappers tier consent; ${HOST_HONORS_QUALIFIER}, ${widening}.`;
    const expectedNotes = (sandbox) => [
      ...sandbox.excludedCommands.map((entry) => note('sandbox.excludedCommands', entry, entry.endsWith(' *')
        ? 'the wrapper runs outside the sandbox' : 'only its argument-free invocation runs outside the sandbox')),
      ...sandbox.network.allowedDomains.map((entry) => note('sandbox.network.allowedDomains', entry, 'every sandboxed command of the project can reach it')),
      ...sandbox.filesystem.allowWrite.map((entry) => note('sandbox.filesystem.allowWrite', entry, 'every sandboxed command can write it')),
    ];
    const render = () => runBridgeMain(['--autonomy'], deps.cwd, nonePlaced, deps);
    const degrade = (r, scope, key) => r.stdout.split('\n').filter((line) => line.includes('⚠ DEGRADE') && line.includes(`${scope} has ${key}`));
    const executeOnly = {
      excludedCommands: ['codex-exec *'],
      network: { allowedDomains: CODEX_HOSTS },
      filesystem: { allowWrite: ['~/.codex'] },
    };
    for (const [proof, sandbox] of [[allow, surfaces], [[], executeOnly]]) {
      writeJson(settingsPath(deps.cwd), { permissions: { allow: proof }, sandbox });
      const bytes = readText(settingsPath(deps.cwd));
      const r = render();
      assert.equal(r.code, EXIT_OK, r.stderr);
      const notes = r.stdout.split('\n').filter((line) => line.startsWith(`  note: ${SETTINGS_FILE} has sandbox.`));
      assert.deepEqual([...notes].sort(), expectedNotes(sandbox).sort(), 'exactly one consent note per proven entry');
      assert.doesNotMatch(notes.join('\n'), /remove.*by hand/i);
      assert.equal(degrade(r, SETTINGS_FILE, 'sandbox.').length, 0);
      assert.equal(readText(settingsPath(deps.cwd)), bytes, 'preview writes nothing');
    }
    const negatives = [
      [[], { excludedCommands: ['codex-review'] }, 'sandbox.excludedCommands'],
      [allow, { excludedCommands: ['codex-exec'] }, 'sandbox.excludedCommands'],
      [allow, { filesystem: { allowWrite: ['~/.gemini'] } }, 'sandbox.filesystem.allowWrite'],
      [allow, { excludedCommands: ['foreign-tool'] }, 'sandbox.excludedCommands'],
      [allow, { network: { allowedDomains: ['foreign.example.com'] } }, 'sandbox.network.allowedDomains'],
      [allow, { filesystem: { allowWrite: ['/foreign/state'] } }, 'sandbox.filesystem.allowWrite'],
    ];
    for (const [proof, sandbox, key] of negatives) {
      writeJson(settingsPath(deps.cwd), { permissions: { allow: proof }, sandbox });
      const r = render();
      assert.equal(r.code, EXIT_OK, r.stderr);
      const lines = degrade(r, SETTINGS_FILE, key);
      assert.equal(lines.length, 1, `${key} without exact tier proof keeps DEGRADE`);
      if (sandbox.filesystem?.allowWrite[0] === '~/.gemini') {
        assert.ok(lines[0].includes('covers the bridge state dir ~/.gemini/antigravity-cli'), lines[0]);
      }
    }
    writeJson(settingsPath(deps.cwd), { permissions: { allow }, sandbox: surfaces });
    writeJson(localSettingsPath(deps.cwd), { permissions: { allow }, sandbox: surfaces });
    const local = render();
    for (const key of ['sandbox.excludedCommands', 'sandbox.network.allowedDomains', 'sandbox.filesystem.allowWrite']) {
      assert.equal(degrade(local, SETTINGS_LOCAL_FILE, key).length, 1, `local ${key} is never tier-known`);
    }
    assert.doesNotMatch(local.stdout, /note: \.claude\/settings\.local\.json has sandbox\./);
    rmSync(localSettingsPath(deps.cwd));
    const jevHost = CODEX_HOSTS.find((host) => AGY_HOSTS.includes(host));
    const agyHost = AGY_HOSTS.find((host) => !CODEX_HOSTS.includes(host));
    writeJson(settingsPath(deps.cwd), {
      permissions: { allow: ['Bash(codex-review code:*)'] },
      sandbox: { network: { allowedDomains: [jevHost, agyHost] } },
    });
    const shared = render();
    assert.ok(shared.stdout.split('\n').includes(note('sandbox.network.allowedDomains', jevHost, 'every sandboxed command of the project can reach it')));
    assert.equal(degrade(shared, SETTINGS_FILE, 'sandbox.network.allowedDomains').length, 1);
    assert.match(degrade(shared, SETTINGS_FILE, 'sandbox.network.allowedDomains')[0], /1 pre-allowed domain\(s\)/);
    assert.equal(shared.stdout.split('\n').includes(note('sandbox.network.allowedDomains', agyHost, 'every sandboxed command of the project can reach it')), false);
    writeJson(settingsPath(deps.cwd), {
      permissions: { allow: ['Bash(codex-review code:*)'] },
      sandbox: { excludedCommands: ['codex-review', 'codex-review *'], network: { allowedDomains: [jevHost] }, filesystem: { allowWrite: ['~/.codex'] } },
    });
    const valid = render();
    assert.equal(valid.code, EXIT_OK, valid.stderr);
    writeJson(join(deps.cwd, 'docs/ai/orchestration.json'), { 'plan-execution': { review: 'unknown-recipe' } });
    const rejected = render();
    assert.equal(rejected.code, valid.code, rejected.stderr);
    assert.equal(rejected.stdout.split('\n').find((line) => line.startsWith('sandbox: ')), valid.stdout.split('\n').find((line) => line.startsWith('sandbox: ')));
    assert.match(rejected.stdout, /^  note: bridge-tier entries not judged — .*docs\/ai\/orchestration\.json/m);
    const legacy = [
      ['sandbox.excludedCommands', `1 command(s) run UNSANDBOXED ${HOST_HONORS_QUALIFIER} (network/fs confinement not applied to them); 1 bridge-review wrapper exclusion(s) are tier-known and not flagged`, 'every sandbox red-line'],
      ['sandbox.network.allowedDomains', `1 pre-allowed domain(s) — ${HOST_HONORS_QUALIFIER}, egress to them is not gated`, 'network'],
      ['sandbox.filesystem.allowWrite', `${HOST_HONORS_QUALIFIER}, 1 declared path(s) resolve OUTSIDE the repo and $TMPDIR and are writable: ${JSON.stringify(join(deps.home, '.codex'))}`, 'fs_outside_repo'],
    ];
    for (const [key, detail, weakens] of legacy) {
      const line = `  ⚠ DEGRADE: ${SETTINGS_FILE} has ${key} (${detail}), which WEAKENS the rendered ${weakens} red-line — the render preserves your sandbox tuning (never clobbers it), so remove it by hand if you want the red-line fully enforced.`;
      assert.deepEqual(degrade(rejected, SETTINGS_FILE, key), [line], `revision 3 fallback: ${key}`);
    }
    writeJson(settingsPath(deps.cwd), { permissions: { allow: ['Bash(codex-review code:*)'] }, sandbox: { excludedCommands: ['codex-review'] } });
    const bareOnly = render().stdout.split('\n').filter((line) => line.startsWith(`  note: ${SETTINGS_FILE} has sandbox.excludedCommands`));
    assert.deepEqual(bareOnly, [`  note: ${SETTINGS_FILE} has sandbox.excludedCommands (1 bridge-review wrapper exclusion(s) (codex-review) — tier-known: ${HOST_HONORS_QUALIFIER}, only their argument-free invocations run outside the sandbox, and their allow rules are present in the project settings).`], 'a bare name never claims its real calls run outside the sandbox');
  });
});

// ── every settings-derived RUNTIME claim is host-conditional (Decision 11) ─────────────────────
//
// The advisor's own mode doc records, from live observation, that whether a host honors the
// `sandbox.*` settings keys is unknowable from here — while these surfaces asserted the runtime
// EFFECT of those keys flat. A user who applied the advisor's autonomy item on a harness-managed
// host lost both review backends to a promise the kit could not keep. The CLASSIFICATION is
// unchanged; only the promise becomes conditional.

// The qualifier and the notice are pinned as LITERAL test data, deliberately not imported: the
// wording IS the contract here, and a test that imported the constant would stay green while the
// promise was reworded back into a flat one.
const HOST_HONORS_QUALIFIER = 'where the host honors the settings sandbox keys';
const HOST_HONORS_NOTICE_OPENING = 'host-conditional: whether a host applies the sandbox.* settings keys is not knowable from here';

describe('velocity — settings-derived runtime claims are host-conditional', () => {
  const allPlaced = () => true;
  const autonomyProject = (t, settings, local) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    if (settings) writeJson(settingsPath(cwd), settings);
    if (local) writeJson(localSettingsPath(cwd), local);
    return cwd;
  };
  const runAutonomy = (argv, cwd, extra = {}) => {
    const stdout = [];
    const stderr = [];
    const code = main([...argv, '--cwd', cwd], { log: (l) => stdout.push(l), errlog: (l) => stderr.push(l), ...extra });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };

  it('ONE qualifier constant serves all three claim surfaces — the tier notice, the USAGE text and the render', (t) => {
    assert.ok(KIT_BRIDGE_TIER_NOTICE.includes(HOST_HONORS_QUALIFIER), 'the always-printed tier notice conditions its routing claim');
    assert.ok(runMainWithoutCwd(['--help']).stdout.includes(HOST_HONORS_QUALIFIER), 'the USAGE bridge-tier line conditions it too');
    const cwd = autonomyProject(t, { sandbox: { network: { allowedDomains: ['example.com'] } } });
    assert.ok(runAutonomy(['--autonomy'], cwd).stdout.includes(HOST_HONORS_QUALIFIER), 'and so does the render that reports the key');
  });

  it('a PREVIEW and an APPLY run state the qualifier on the degrade line and name the unknown ONCE', (t) => {
    const cwd = autonomyProject(t, { sandbox: { network: { allowedDomains: ['example.com'] }, allowUnsandboxedCommands: true } });
    for (const argv of [['--autonomy'], ['--autonomy', '--apply']]) {
      const r = runAutonomy(argv, cwd, { findWrapper: allPlaced });
      assert.equal(r.code, EXIT_OK, r.stderr);
      // The weakening lines only — `<source> has <key>`; the render's OWN policy degrades (an
      // unexpressible red-line) are a different class and make no settings-key runtime claim.
      const degrades = r.stdout.split('\n').filter((l) => l.includes('⚠ DEGRADE') && l.includes('has sandbox.'));
      assert.ok(degrades.length >= 2, `${argv.join(' ')}: both settings-derived degrades render`);
      for (const line of degrades) {
        assert.ok(line.includes(HOST_HONORS_QUALIFIER), `${argv.join(' ')}: a runtime effect is never promised flat: ${line}`);
      }
      assert.equal(r.stdout.split(HOST_HONORS_NOTICE_OPENING).length - 1, 1, `${argv.join(' ')}: the unknown is named once, not per line`);
      // The apply preview IS the point-of-apply warning: the render is what the user reads before
      // consenting, so the conditional wording has to be there and not only in a doc.
      assert.match(r.stdout, /WEAKENS the rendered/, 'the classification itself stays a flat statement');
    }
  });

  it('the qualifier rides BOTH settings scopes — a local-file key is as host-conditional as a project one', (t) => {
    const cwd = autonomyProject(
      t,
      { sandbox: { network: { allowedDomains: ['example.com'] } } },
      { sandbox: { filesystem: { allowWrite: ['/etc/elsewhere'] } } },
    );
    const r = runAutonomy(['--autonomy'], cwd, { home: '/nonexistent-home' });
    const scoped = (rel) => r.stdout.split('\n').filter((l) => l.includes('⚠ DEGRADE') && l.includes(`${rel} has sandbox.`));
    for (const rel of [SETTINGS_FILE, SETTINGS_LOCAL_FILE]) {
      const lines = scoped(rel);
      assert.equal(lines.length, 1, `${rel} contributes its own degrade line`);
      assert.ok(lines[0].includes(HOST_HONORS_QUALIFIER), `${rel}: the runtime claim is conditional in this scope too`);
    }
  });

  it('a settings.local MASK of a sandbox key is conditioned; a permissions mask stays flat (the stated boundary)', (t) => {
    // "the local value wins" is a runtime claim wherever the masked key is a sandbox one — on a host
    // that ignores sandbox.* neither value takes effect. permissions.* precedence is the harness's
    // own permission model, so that mask is deliberately NOT hedged.
    const cwd = autonomyProject(
      t,
      { permissions: { allow: [] } },
      { sandbox: { autoAllowBashIfSandboxed: true }, permissions: { defaultMode: 'plan' } },
    );
    const masks = runAutonomy(['--autonomy'], cwd).stdout.split('\n').filter((l) => l.includes('which MASKS'));
    const sandboxMask = masks.find((l) => l.includes('sandbox.'));
    const permissionsMask = masks.find((l) => l.includes('permissions.'));
    assert.ok(sandboxMask, `a sandbox-key mask renders: ${masks.join(' | ')}`);
    assert.ok(sandboxMask.includes(HOST_HONORS_QUALIFIER), `a sandbox mask states a host-conditional effect: ${sandboxMask}`);
    assert.ok(permissionsMask, `a permissions mask renders: ${masks.join(' | ')}`);
    assert.ok(!permissionsMask.includes(HOST_HONORS_QUALIFIER), `the permission model is stated flat, on purpose: ${permissionsMask}`);
  });

  it('the --check gate surface carries the notice whenever it states one of these effects', (t) => {
    const cwd = autonomyProject(t, { permissions: { allow: [] } });
    runAutonomy(['--autonomy', '--apply'], cwd);
    const r = runAutonomy(['--autonomy', '--check'], cwd);
    assert.match(r.stdout, /IN SYNC/, r.stdout);
    assert.ok(r.stdout.includes(HOST_HONORS_QUALIFIER), 'the degrades it prints are conditional');
    assert.ok(r.stdout.includes(HOST_HONORS_NOTICE_OPENING), 'and the gate read in isolation names the unknown too');
  });

  it('a CLEAN settings file is conditioned too — the render owns sandbox claims of its own', (t) => {
    // The render always asserts what the keys it writes DO at run time (the sandbox line, the
    // fs_outside_repo note, the network/credentials degrades). With no foreign weakening present
    // those were the last flat promises left, which is exactly where a clean deployment reads them.
    const cwd = autonomyProject(t, { permissions: { allow: [] } });
    const r = runAutonomy(['--autonomy'], cwd);
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.doesNotMatch(r.stdout, /⚠ DEGRADE: .*has sandbox\./, 'no foreign key is declared here');
    assert.ok(r.stdout.includes(HOST_HONORS_NOTICE_OPENING), 'the notice rides EVERY autonomy render');
    const sandboxLine = r.stdout.split('\n').find((l) => l.startsWith('sandbox: '));
    assert.ok(sandboxLine.includes(HOST_HONORS_QUALIFIER), `the render-owned sandbox claim is conditional: ${sandboxLine}`);
    const fsNote = r.stdout.split('\n').find((l) => l.includes('fs_outside_repo=deny'));
    assert.ok(fsNote.includes(HOST_HONORS_QUALIFIER), `the confinement claim is conditional: ${fsNote}`);
    // Every OTHER sandbox-effect claim the render can emit is conditional too — the unanimity note
    // ("the sandbox still confines") and the sandbox-unavailable degrade included.
    for (const claim of r.stdout.split('\n').filter((l) => l.includes('the sandbox still confines') || l.includes('sandbox UNAVAILABLE on this host'))) {
      assert.ok(claim.includes(HOST_HONORS_QUALIFIER), `no sandbox-effect claim is left flat: ${claim}`);
    }
    for (const claim of r.stdout.split('\n').filter((l) => l.includes('prompt-on-egress') || l.includes('coverage is PARTIAL'))) {
      assert.ok(claim.includes(HOST_HONORS_QUALIFIER), `every render-owned runtime claim is conditional: ${claim}`);
    }
  });
});

// ── the allowWrite degrade resolves its entries and NAMES them (Decision 12) ────────────────────
//
// It used to hold the declared array, print a bare count, and call every entry external without
// resolving it — so an entry pointing INSIDE the repo was over-reported as an fs_outside_repo
// weakening, and the maintainer was never told WHICH path to remove. Resolution comes first, on the
// same leaf the advisor's convergence lane reads; the survivors are named.

describe('velocity — the allowWrite degrade resolves before it judges, and names what survives', () => {
  // The $TMPDIR boundary this suite resolves against. Registered for removal at suite end — a
  // describe-level mkdtemp with no cleanup leaks one directory into the system tmp per run.
  const boundaryTmp = mkdtempSync(join(tmpdir(), 'velocity-tmpdir-'));
  after(() => rmSync(boundaryTmp, { recursive: true, force: true }));
  const OUTSIDE_HOME = '/nonexistent-home';
  const writeProject = (t, allowWrite, scope = SETTINGS_FILE) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    writeJson(pathOf(cwd, scope), { sandbox: { filesystem: { allowWrite } } });
    return cwd;
  };
  const runRender = (cwd) => {
    const stdout = [];
    const code = main(['--autonomy', '--cwd', cwd], {
      log: (l) => stdout.push(l),
      errlog: () => {},
      home: OUTSIDE_HOME,
      env: { ...process.env, TMPDIR: boundaryTmp },
    });
    return { code, stdout: stdout.join('\n') };
  };
  const allowWriteLines = (out) => out.split('\n').filter((l) => l.includes('allowWrite'));
  const allowWriteLine = (out) => allowWriteLines(out)[0] ?? null;

  it('an entry resolving OUTSIDE the repo is reported by its RESOLVED path, never by a bare count', (t) => {
    const cwd = writeProject(t, ['/etc/elsewhere']);
    const line = allowWriteLine(runRender(cwd).stdout);
    assert.ok(line, 'an external write allowance is still a loud degrade');
    assert.ok(line.includes('"/etc/elsewhere"'), `the surviving entry is NAMED: ${line}`);
    assert.match(line, /WEAKENS the rendered fs_outside_repo red-line/, 'its classification is unchanged');
  });

  it('entries resolving to the repo root, INSIDE the repo, or inside $TMPDIR are not external weakenings at all', (t) => {
    const cwd = writeProject(t, ['.', 'build/artifacts', join(boundaryTmp, 'scratch')]);
    const out = runRender(cwd).stdout;
    assert.equal(allowWriteLine(out), null, `nothing outside the red-line's own surface is declared: ${out}`);
  });

  it('a tilde, a relative and an absolute entry all resolve the way a host resolving the key would', (t) => {
    const cwd = writeProject(t, ['~', '~/creds', '../sibling-of-the-repo', '/etc/elsewhere']);
    const line = allowWriteLine(runRender(cwd).stdout);
    assert.ok(line.includes(`"${OUTSIDE_HOME}"`), `a bare ~ resolves against home: ${line}`);
    assert.ok(line.includes(`"${OUTSIDE_HOME}/creds"`), `a ~/… entry resolves against home: ${line}`);
    assert.ok(line.includes(`"${resolve(cwd, '..', 'sibling-of-the-repo')}"`), `a relative entry resolves against the project root: ${line}`);
    assert.ok(line.includes('"/etc/elsewhere"'), `an absolute entry rides as given: ${line}`);
    assert.ok(line.includes('4 declared path(s)'), `the count agrees with what is named: ${line}`);
  });

  it('a NON-STRING entry is never dropped into silence — it is counted as unresolvable', (t) => {
    const cwd = writeProject(t, [42, '.']);
    const lines = allowWriteLines(runRender(cwd).stdout);
    assert.equal(lines.length, 1, `only the unverifiable record — no external path resolved: ${lines.join(' | ')}`);
    assert.match(lines[0], /1 declared entr\(ies\) could not be resolved/, lines[0]);
    // The entry could not be read, so nothing may be asserted about what it widens.
    assert.match(lines[0], /CANNOT BE VERIFIED/, lines[0]);
    assert.doesNotMatch(lines[0], /which WEAKENS/, 'an unreadable entry never carries a weakening claim');
  });

  it('a BLANK entry is unresolvable too — it never resolves to the repo root and vanishes as "contained"', (t) => {
    // The quieter of the two malformed shapes, and the one the advisor's own reader already refuses:
    // '' and '   ' mean nothing to a host, but they resolve to the project root and would be filtered
    // out as inside-the-repo — silence produced by the containment rule itself.
    const cwd = writeProject(t, ['   ', '.']);
    const lines = allowWriteLines(runRender(cwd).stdout);
    assert.equal(lines.length, 1, lines.join(' | '));
    assert.match(lines[0], /1 declared entr\(ies\) could not be resolved/, lines[0]);
    assert.doesNotMatch(lines[0], /which WEAKENS/, 'an unreadable entry never carries a weakening claim');
  });

  it('a MIXED array reports the two classes SEPARATELY — a resolved external path weakens, an unreadable entry does not', (t) => {
    const cwd = writeProject(t, ['/etc/elsewhere', 42]);
    const lines = allowWriteLines(runRender(cwd).stdout);
    assert.equal(lines.length, 2, `each class gets its own record: ${lines.join(' | ')}`);
    const weakening = lines.find((l) => l.includes('which WEAKENS'));
    const unverifiable = lines.find((l) => l.includes('CANNOT BE VERIFIED'));
    assert.ok(weakening && weakening.includes('"/etc/elsewhere"'), `the resolved path is named on the weakening record: ${lines.join(' | ')}`);
    assert.ok(unverifiable && /1 declared entr\(ies\)/.test(unverifiable), `the unreadable entry is its own record: ${lines.join(' | ')}`);
    assert.doesNotMatch(unverifiable, /which WEAKENS/);
  });

  it('an UNSUPPORTED credentials build states what THIS RENDER hides, never what the host does', (t) => {
    // The mirror image of the qualifier: claiming the vars are "NOT hidden" asserts a host-wide fact
    // just as much as claiming they are hidden — a harness-managed sandbox may hide them itself.
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    const stdout = [];
    // An unresolvable harness binary is the "version unknown" arm — the probe's own honest branch.
    main(['--autonomy', '--cwd', cwd], {
      log: (l) => stdout.push(l),
      errlog: () => {},
      findOnPath: () => ({ path: null, state: 'absent' }),
    });
    const line = stdout.join('\n').split('\n').find((l) => l.includes('sandbox credential denial arrived in'));
    assert.ok(line, 'an unresolvable/older harness still degrades loudly');
    assert.match(line, /THIS RENDER hides nothing/, line);
    assert.match(line, /a host sandbox of its own may still hide them/, 'the absence claim is scoped to the render, not the host');
  });

  it('a NON-ARRAY allowWrite is reported loudly, never assumed empty', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    writeJson(settingsPath(cwd), { sandbox: { filesystem: { allowWrite: '/etc/elsewhere' } } });
    const line = allowWriteLine(runRender(cwd).stdout);
    assert.ok(line, 'a present-but-unreadable declaration is never silence');
    assert.match(line, /not an array \(string\)/, line);
    assert.match(line, /UNKNOWN/, 'what it would make writable is stated as unknown, never guessed');
    // An unreadable value cannot be claimed to widen anything either — "unknown" and "WEAKENS" in
    // the same line would be the contradiction this whole phase exists to remove.
    assert.match(line, /CANNOT BE VERIFIED against it \(no claim either way\)/, line);
    assert.doesNotMatch(line, /which WEAKENS/, 'no effect is asserted over a value that cannot be read');
  });

  it('a SIBLING-PREFIX entry is not containment — a string prefix never reads as "inside the repo"', (t) => {
    const cwd = makeTempProject(t);
    seedWorkflowStamp(cwd);
    writeJson(join(cwd, 'docs', 'ai', 'autonomy.json'), { 'plan-execution': { autonomy: 'sandbox' } });
    ensureClaudeDir(cwd);
    // `<root>-sibling` shares every byte of the root as a PREFIX and is a different directory.
    const sibling = `${resolve(cwd)}-sibling`;
    writeJson(settingsPath(cwd), { sandbox: { filesystem: { allowWrite: [sibling] } } });
    const line = allowWriteLine(runRender(cwd).stdout);
    assert.ok(line, 'a sibling of the repo is outside it — the degrade stands');
    assert.ok(line.includes(`"${sibling}"`), `the sibling is named: ${line}`);
  });

  it('a path carrying shell metacharacters or a newline renders SAFELY on one line', (t) => {
    const cwd = writeProject(t, ['/etc/we$(id)ird; rm -rf /', '/etc/two\nlines']);
    const out = runRender(cwd).stdout;
    const line = allowWriteLine(out);
    assert.ok(line, 'the entries still surface');
    assert.ok(line.includes(String.raw`"/etc/two\nlines"`), `a newline is escaped, never a second rendered line: ${line}`);
    assert.ok(line.includes(`"${resolve('/etc/we$(id)ird; rm -rf /')}"`), `the metacharacters are shown as data, quoted: ${line}`);
    assert.equal(out.split('\n').filter((l) => l.includes('allowWrite')).length, 1, 'ONE line, whatever the entry carries');
  });
});
