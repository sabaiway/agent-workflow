import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_COMMAND, NON_INTERACTIVE_ENV } from './git-process.mjs';

const mod = await import('./release-stages.mjs').catch(() => ({}));
const { STAGES, RELEASE_IDENTITY, stageCommand, liveOutcome, verifyOutcome, EXIT } = mod;

const RECORD = Object.freeze({
  ref: 'release/test',
  expect: Object.freeze({ memory: '7.1.3', engine: '4.4.1', kit: '10.5.1' }),
  tokenFile: '/tmp/token file',
  messageFile: '/tmp/message file',
  smoke: Object.freeze([
    Object.freeze({ kind: 'line', value: 'bridge ready' }),
    Object.freeze({ kind: 'file', value: '.codex/state.json=ready' }),
  ]),
});

describe('release stages', () => {
  // spec:release-run/S6
  it('builds every stage from the closed ordered table and one record', () => {
    assert.equal(typeof stageCommand, 'function');
    assert.deepEqual(STAGES, [
      'commit', 'preflight-remote', 'push', 'smoke-candidate',
      'cross-version-gate', 'live', 'verify', 'smoke-init',
    ]);
    assert.ok(Object.isFrozen(STAGES));
    assert.deepEqual(RELEASE_IDENTITY, { name: 'coder-tool', email: 'coder-tools@proton.me' });
    const baseEnv = {
      KEEP: 'yes',
      GIT_TERMINAL_PROMPT: 'inherited',
      GIT_AUTHOR_NAME: 'wrong',
      GIT_AUTHOR_EMAIL: 'wrong@example.test',
      GIT_COMMITTER_NAME: 'wrong',
      GIT_COMMITTER_EMAIL: 'wrong@example.test',
    };
    const commands = Object.fromEntries(STAGES.map((name) => [name, stageCommand(name, RECORD, baseEnv)]));
    assert.deepEqual(commands.commit.argv, ['commit', '--cleanup=verbatim', '-F', RECORD.messageFile]);
    assert.deepEqual(commands['preflight-remote'].argv, ['scripts/release/preflight-remote.mjs', '--ref', RECORD.ref]);
    assert.deepEqual(commands.push.argv, ['push', 'origin', `HEAD:refs/heads/${RECORD.ref}`]);
    assert.deepEqual(stageCommand('push', { ...RECORD, head: 'f'.repeat(40) }, baseEnv).argv, ['push', 'origin', `${'f'.repeat(40)}:refs/heads/${RECORD.ref}`]);
    assert.deepEqual(commands['smoke-candidate'].argv, ['scripts/release/smoke-candidate.mjs']);
    assert.deepEqual(commands['cross-version-gate'].argv, ['scripts/release/cross-version-gate.mjs']);
    const dispatch = [
      'scripts/release/dispatch-publish.mjs', 'all', '--ref', RECORD.ref,
      '--expect', 'memory=7.1.3', '--expect', 'engine=4.4.1', '--expect', 'kit=10.5.1',
      '--token-file', RECORD.tokenFile,
    ];
    assert.deepEqual(commands.live.argv, [...dispatch, '--live']);
    assert.deepEqual(commands.verify.argv, [...dispatch, '--verify-only']);
    assert.deepEqual(commands['smoke-init'].argv, [
      'scripts/release/smoke-init.mjs', '--expect-line', 'installed v10.5.1',
      '--expect-line', 'bridge ready', '--expect-file', '.codex/state.json=ready',
    ]);
    for (const name of STAGES) {
      assert.deepEqual(Object.keys(commands[name]), ['command', 'argv', 'env']);
      assert.equal(commands[name].command, name === 'commit' || name === 'push' ? GIT_COMMAND : 'node');
    }
    assert.deepEqual(commands['preflight-remote'].env, baseEnv);
    assert.deepEqual(commands.push.env, { ...baseEnv, ...NON_INTERACTIVE_ENV });
    assert.deepEqual(commands.commit.env, {
      ...baseEnv,
      ...NON_INTERACTIVE_ENV,
      GIT_AUTHOR_NAME: RELEASE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email,
      GIT_COMMITTER_NAME: RELEASE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email,
    });
    assert.throws(() => stageCommand('unknown', RECORD, baseEnv), /unknown release stage/);
  });

  // spec:release-run/S11
  it('classifies live and verify exits with the two closed state tables', () => {
    assert.equal(typeof liveOutcome, 'function');
    assert.equal(typeof verifyOutcome, 'function');
    assert.deepEqual(EXIT, { ok: 0, failed: 1, usage: 2, refusal: 3 });
    const liveCases = [
      [0, { status: 'pass', exit: 0 }],
      [9, { status: 'pass', exit: 9 }],
      [2, { status: 'fail', exit: 2, resumable: true }],
      [3, { status: 'fail', exit: 3, resumable: true }],
      [1, { status: 'fail', exit: 1, dispatched: 'unknown' }],
      [8, { status: 'fail', exit: 8, dispatched: 'unknown' }],
    ];
    for (const [exit, expected] of liveCases) assert.deepEqual(liveOutcome(exit), expected);
    const verifyCases = [
      [0, false, { status: 'pass', exit: 0 }],
      [9, false, { status: 'pass', exit: 9, inconclusive: true }],
      [9, true, { status: 'fail', exit: 9 }],
      [1, false, { status: 'fail', exit: 1 }],
      [8, true, { status: 'fail', exit: 8 }],
    ];
    for (const [exit, liveUnknown, expected] of verifyCases) {
      assert.deepEqual(verifyOutcome(exit, { liveUnknown }), expected);
    }
    assert.ok(Object.isFrozen(EXIT));
  });
});
