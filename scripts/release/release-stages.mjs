import { GIT_COMMAND, NON_INTERACTIVE_ENV } from './git-process.mjs';

const NODE_COMMAND = 'node';
export const INCONCLUSIVE_EXIT = 9;
const DISPATCH_SCRIPT = 'scripts/release/dispatch-publish.mjs';
const PREFLIGHT_SCRIPT = 'scripts/release/preflight-remote.mjs';
const SMOKE_CANDIDATE_SCRIPT = 'scripts/release/smoke-candidate.mjs';
const CROSS_VERSION_SCRIPT = 'scripts/release/cross-version-gate.mjs';
const SMOKE_INIT_SCRIPT = 'scripts/release/smoke-init.mjs';
const SMOKE_FLAGS = Object.freeze({ line: '--expect-line', file: '--expect-file' });

export const STAGES = Object.freeze([
  'commit',
  'preflight-remote',
  'push',
  'smoke-candidate',
  'cross-version-gate',
  'live',
  'verify',
  'smoke-init',
]);

export const RELEASE_IDENTITY = Object.freeze({
  name: 'coder-tool',
  email: 'coder-tools@proton.me',
});

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, refusal: 3 });

const buildIdentityEnv = (baseEnv) => ({
  ...baseEnv,
  ...NON_INTERACTIVE_ENV,
  GIT_AUTHOR_NAME: RELEASE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email,
  GIT_COMMITTER_NAME: RELEASE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email,
});

const buildDispatchArgs = (record, mode) => [
  DISPATCH_SCRIPT,
  'all',
  '--ref',
  record.ref,
  '--expect',
  `memory=${record.expect.memory}`,
  '--expect',
  `engine=${record.expect.engine}`,
  '--expect',
  `kit=${record.expect.kit}`,
  '--token-file',
  record.tokenFile,
  mode,
];

const buildSmokeArgs = (record) => [
  SMOKE_INIT_SCRIPT,
  '--expect-line',
  `installed v${record.expect.kit}`,
  ...record.smoke.flatMap((entry) => [SMOKE_FLAGS[entry.kind], entry.value]),
];

export const stageCommand = (name, record, baseEnv = {}) => {
  const buildNodeCommand = (argv) => ({ command: NODE_COMMAND, argv, env: { ...baseEnv } });
  if (name === STAGES[0]) {
    return { command: GIT_COMMAND, argv: ['commit', '--cleanup=verbatim', '-F', record.messageFile], env: buildIdentityEnv(baseEnv) };
  }
  if (name === STAGES[1]) return buildNodeCommand([PREFLIGHT_SCRIPT, '--ref', record.ref]);
  if (name === STAGES[2]) {
    return { command: GIT_COMMAND, argv: ['push', 'origin', `${record.head ?? 'HEAD'}:refs/heads/${record.ref}`], env: { ...baseEnv, ...NON_INTERACTIVE_ENV } };
  }
  if (name === STAGES[3]) return buildNodeCommand([SMOKE_CANDIDATE_SCRIPT]);
  if (name === STAGES[4]) return buildNodeCommand([CROSS_VERSION_SCRIPT]);
  if (name === STAGES[5]) return buildNodeCommand(buildDispatchArgs(record, '--live'));
  if (name === STAGES[6]) return buildNodeCommand(buildDispatchArgs(record, '--verify-only'));
  if (name === STAGES[7]) return buildNodeCommand(buildSmokeArgs(record));
  throw new Error(`unknown release stage: ${name}`);
};

export const liveOutcome = (exit) => {
  if (exit === EXIT.ok || exit === INCONCLUSIVE_EXIT) return { status: 'pass', exit };
  if (exit === EXIT.usage || exit === EXIT.refusal) return { status: 'fail', exit, resumable: true };
  return { status: 'fail', exit, dispatched: 'unknown' };
};

export const verifyOutcome = (exit, { liveUnknown = false } = {}) => {
  if (exit === EXIT.ok) return { status: 'pass', exit };
  if (exit === INCONCLUSIVE_EXIT && !liveUnknown) return { status: 'pass', exit, inconclusive: true };
  return { status: 'fail', exit };
};
