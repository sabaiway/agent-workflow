import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIVERSAL_READONLY_ALLOWLIST,
  VELOCITY_NON_READONLY,
  VELOCITY_INVALID_ARGUMENT,
  discoverGateCandidates,
  screenAllowlistEntry,
  validateProfile,
} from './velocity-profile.mjs';

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
