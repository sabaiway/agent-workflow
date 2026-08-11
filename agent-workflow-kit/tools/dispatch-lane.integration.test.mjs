// dispatch-lane.integration.test.mjs — the delegated EXEC lane end to end (delegation Plan 2,
// Phase 4.1.c). Every per-arm rule is unit-tested in dispatch.test.mjs; this file is the ONLY place
// the whole sequence runs as ONE sequence, through the REAL CLIs, against the REAL bridge wrapper —
// `check → open → codex-exec --nonce → await → return → fold → aggregate` — with a fake `codex` on
// PATH standing in for the subscription CLI (the flow-dogfood.integration.test.mjs precedent).
//
// What only a whole-lane fixture can catch: the two packages agree about WHERE the artifacts live
// and WHAT they contain, the ledger's own preflight accepts the record chain a real run produces,
// and the tree the producer measures is the tree the wrapper actually left. A unit test can assert
// any one of those against bytes it wrote itself; none of them can assert the agreement.
//
// Every subprocess runs under a per-fixture isolated git environment (the flow-dogfood pattern):
// AW_*, GIT_* and XDG_* stripped class-wide, then only the fixture's HOME + config added back, so
// host config (an inherited excludesFile, a diff.ignoreSubmodules cosmetic) can never move a
// fingerprint this lane binds or trip the concealing-tree guard.
//
// TWO separate failure fixtures, because a terminal-failure return is itself the thread's closure:
// (i) a wrapper KILLED mid-run leaves only its pre-spend reservation — `await` keeps waiting, the
// `--no-receipt` absorb closes the thread, and nothing may follow it; (ii) a dispatch that never
// produced a return at all is closed by `degrade`. Both report at L = 0.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DELEGATION_SCHEMA_VERSION } from './dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME } from './dispatch-store.mjs';
import { execReceiptBasename, execReportBasename } from './exec-receipt.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(TOOLS, 'dispatch.mjs');
const WRAPPER = join(resolve(TOOLS, '..', '..'), 'codex-cli-bridge', 'bin', 'codex-exec.sh');

// Synchronous at module load: `skip` options are evaluated when describe() is CALLED. spawnSync
// reports ENOENT via `.error`, it never throws.
const present = (bin, args) => {
  try {
    return spawnSync(bin, args).status === 0;
  } catch {
    return false;
  }
};
const TOOLING = ['git', 'bash', 'timeout'].filter((bin) => !present(bin, ['--version']));

const WAVE = 'lane-e2e';
const CAP_S = 600;
const GRACE_S = 15;
const DEADLINE_S = 900;
const REGISTER = ['register', '--wave', WAVE, '--step-classes', 'code', '--pairing-key', 'stepClass',
  '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1'];

// The delegate: it writes into the repo (cwd is the work tree), reports back through the wrapper's
// `-o` output file, and prints the thread event the session id is captured from. A heredoc, never
// `echo` — an unquoted JSON literal hits brace expansion and the thread id is lost.
const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-o" ]]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  'cat >/dev/null',
  'printf "the delegate wrote this line\\n" > delegated.txt',
  'if [[ -n "$out" ]]; then echo "the delegate reports what it changed" >"$out"; fi',
  'cat <<EOF',
  '{"type":"thread.started","thread_id":"sess-lane"}',
  'EOF',
  'exit 0',
  '',
].join('\n');

// The delegate that never finishes: the wrapper is SIGKILLed from outside while this one sleeps,
// which is exactly the state a reaped host leaves — the pre-spend reservation published, the
// terminal receipt never.
const SLEEPING_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
  'cat >/dev/null',
  'sleep 30',
  '',
].join('\n');

const made = [];
after(() => {
  while (made.length) {
    try {
      rmSync(made.pop(), { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

const contractFor = (nonce) => ({
  schema: DELEGATION_SCHEMA_VERSION,
  nonce,
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'write delegated.txt',
  inputs: 'the fixture repository',
  acceptance: 'the file exists and the report says so',
  returnShape: 'a diff plus a report',
  producerContract: 'wrapper-git',
  deadlineS: DEADLINE_S,
  retry: { cap: 1, index: 0 },
});

const gitIn = (cwd, env, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const makeFixture = (tag, codexScript) => {
  const home = mkdtempSync(join(tmpdir(), `${tag}-home-`));
  const root = mkdtempSync(join(tmpdir(), `${tag}-repo-`));
  // The contract file lives OUTSIDE the repository on purpose: written inside it, it would be an
  // untracked path and `open` would record a DIRTY baseline, so the eligible lane — the one an
  // aggregate can compute an L from — could never be exercised at all.
  const outside = mkdtempSync(join(tmpdir(), `${tag}-briefs-`));
  made.push(home, root, outside);
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), codexScript, { mode: 0o755 });
  const gcfg = join(home, '.gitconfig');
  writeFileSync(gcfg, '');
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('AW_') || key.startsWith('GIT_') || key.startsWith('XDG_')) delete inherited[key];
  }
  delete inherited.NODE_TEST_CONTEXT;
  delete inherited.NODE_OPTIONS;
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_GLOBAL: gcfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    // The wrapper writes its session sidecar to $PWD on a successful run, which would land an
    // untracked file in the work tree and count the WRAPPER's own bookkeeping into the delegate's
    // numerator. Redirected out of the repo here so the lane measures the delegate's change set;
    // the unredirected behaviour is queued as its own row.
    CODEX_SESSION_FILE: join(home, 'last-session'),
    // The cap `open` was told about must be the cap the wrapper will ACTUALLY apply: the receipt
    // records the real one and `return` refuses a receipt whose capS + killGraceS could outlive the
    // recorded deadline (D8). Declaring the floor from the wrapper's default while the wrapper runs
    // under another is precisely the mismatch that rule exists to catch — surfaced here by the lane
    // itself the first time it ran.
    CODEX_HARD_TIMEOUT: String(CAP_S),
  };
  gitIn(root, env, 'init', '-q', '-b', 'main');
  gitIn(root, env, 'config', 'user.email', 'coder-tools@proton.me');
  gitIn(root, env, 'config', 'user.name', 'coder-tool');
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (lane fixture).\n');
  gitIn(root, env, 'add', '-A');
  gitIn(root, env, 'commit', '-qm', 'base');
  return { root, home, outside, env, gitDir: join(root, '.git') };
};

const kit = (fx, argv) => spawnSync(process.execPath, [DISPATCH, ...argv], {
  cwd: fx.root, env: fx.env, encoding: 'utf8', timeout: 60000,
});

const brief = (fx, nonce) => {
  const path = join(fx.outside, `${nonce}.md`);
  const fence = '```';
  writeFileSync(path, `# a bounded sub-task\n\n${fence}aw-dispatch-contract\n${JSON.stringify(contractFor(nonce), null, 2)}\n${fence}\n`);
  return path;
};

// The wrapper's own stdio goes to a FILE, never an inherited pipe: the killed fixture orphans a
// sleeping grandchild, and a shared pipe would make spawnSync wait for IT rather than for the run.
const runWrapper = (fx, argv, { killAfterS = null } = {}) => {
  const log = join(fx.home, `wrapper-${argv.join('-').replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  const fd = openSync(log, 'w');
  try {
    const command = killAfterS === null
      ? { bin: 'bash', args: [WRAPPER, ...argv] }
      : { bin: 'timeout', args: ['-s', 'KILL', String(killAfterS), 'bash', WRAPPER, ...argv] };
    const r = spawnSync(command.bin, command.args, {
      cwd: fx.root, env: fx.env, timeout: 120000, stdio: ['ignore', fd, fd],
    });
    return { status: r.status, log: readFileSync(log, 'utf8') };
  } finally {
    closeSync(fd);
  }
};

const openArgv = (contract) => ['open', '--contract', contract, '--wave', WAVE, '--backend', 'codex',
  '--rationale', 'the lane fixture', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S)];

const ledgerKinds = (fx) => readFileSync(join(fx.gitDir, DELEGATION_STORE_BASENAME), 'utf8')
  .split('\n').filter((l) => l !== '').map((l) => JSON.parse(l).kind);

describe('the delegated exec lane, end to end', { skip: TOOLING.length === 0 ? false : `requires ${TOOLING.join(', ')} on PATH` }, () => {
  it('check → open → codex-exec --nonce → await → return → fold, and aggregate computes the thread\'s L', () => {
    const fx = makeFixture('lane-happy', FAKE_CODEX);
    const nonce = 'lane-1';
    const contract = brief(fx, nonce);

    assert.equal(kit(fx, REGISTER).status, 0);
    const checked = kit(fx, ['check', contract]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /FORM OK — nonce "lane-1"/);

    const opened = kit(fx, openArgv(contract));
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /baseline CLEAN/, 'the eligible lane needs a clean baseline');

    const dispatched = runWrapper(fx, ['--nonce', nonce, contract]);
    assert.equal(dispatched.status, 0, dispatched.log);
    assert.match(dispatched.log, /exec receipt: nonce=lane-1 outcome=success/);
    assert.equal(readFileSync(join(fx.root, 'delegated.txt'), 'utf8'), 'the delegate wrote this line\n');

    const awaited = kit(fx, ['await', '--nonce', nonce]);
    assert.equal(awaited.status, 0, awaited.stderr);
    assert.match(awaited.stdout, /ARRIVED — the TERMINAL exec receipt landed/);
    assert.match(awaited.stdout, /outcome success · exit 0 · session sess-lane/);
    assert.deepEqual(ledgerKinds(fx), ['pre-registration', 'dispatch'], 'the waiter writes NOTHING');

    const returned = kit(fx, ['return', '--nonce', nonce]);
    assert.equal(returned.status, 0, returned.stderr);
    assert.match(returned.stdout, /thread "lane-1" answered — outcome success/);
    assert.match(returned.stdout, /session sess-lane/);
    assert.match(returned.stdout, /L = \d+\.\d{3} \(\d+ B \/ \d+ B\)/, 'the metric is ELIGIBLE — a ratio, never a named ineligibility');

    const folded = kit(fx, ['fold', '--nonce', nonce, '--verdict', 'the delegate wrote what its report claims']);
    assert.equal(folded.status, 0, folded.stderr);
    assert.match(folded.stdout, /thread "lane-1" folded and CLOSED/);
    assert.deepEqual(ledgerKinds(fx), ['pre-registration', 'dispatch', 'return', 'fold']);

    const report = kit(fx, ['aggregate', '--wave', WAVE]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /lane-1 · retry 0 · folded success · L = \d+\.\d{3}/);
    assert.match(report.stdout, /acceptance, class "code": COMPUTED — PILOT evidence \(n = 1\)/);
  });

  it('a KILLED wrapper leaves only its reservation: await waits, --no-receipt closes the thread, nothing follows', () => {
    const fx = makeFixture('lane-killed', SLEEPING_CODEX);
    const nonce = 'lane-2';
    const contract = brief(fx, nonce);
    assert.equal(kit(fx, REGISTER).status, 0);
    assert.equal(kit(fx, openArgv(contract)).status, 0);

    const killed = runWrapper(fx, ['--nonce', nonce, contract], { killAfterS: 3 });
    assert.notEqual(killed.status, 0, 'the wrapper died mid-run');
    const receipt = JSON.parse(readFileSync(join(fx.gitDir, execReceiptBasename('codex', nonce)), 'utf8'));
    assert.equal(receipt.state, 'reserved', `the pre-spend reservation must be all there is: ${killed.log}`);
    assert.equal(receipt.sessionId, null);

    const waited = kit(fx, ['await', '--nonce', nonce, '--timeout', '1']);
    assert.equal(waited.status, 3, waited.stderr);
    assert.match(waited.stderr, /a RESERVED receipt at /);
    assert.match(waited.stderr, /TIMEOUT after 1s/);
    assert.match(waited.stderr, /NO writer slot was released/);

    const closed = kit(fx, ['return', '--nonce', nonce, '--no-receipt', '--exit-status', '137', '--outcome', 'transport-failure']);
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stdout, /absorbed from the RESERVATION, --no-receipt/);

    const after2 = kit(fx, ['fold', '--nonce', nonce, '--verdict', 'nothing to fold']);
    assert.equal(after2.status, 1, 'a failure-terminal return CLOSES the thread — nothing may follow it');
    assert.deepEqual(ledgerKinds(fx), ['pre-registration', 'dispatch', 'return']);

    const report = kit(fx, ['aggregate', '--wave', WAVE]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /lane-2 · retry 0 · failure-terminal \(transport-failure\) · L = 0\.000/);
  });

  it('a dispatch that never produced a return at all is closed by degrade, and reports at L = 0', () => {
    const fx = makeFixture('lane-degraded', FAKE_CODEX);
    const nonce = 'lane-3';
    const contract = brief(fx, nonce);
    assert.equal(kit(fx, REGISTER).status, 0);
    assert.equal(kit(fx, openArgv(contract)).status, 0);

    // Nothing was ever dispatched, so neither artifact name is taken and the waiter says so.
    const waited = kit(fx, ['await', '--nonce', nonce, '--timeout', '1']);
    assert.equal(waited.status, 3, waited.stderr);
    assert.match(waited.stderr, new RegExp(`${execReceiptBasename('codex', nonce)} does not exist`));

    const degraded = kit(fx, ['degrade', '--wave', WAVE, '--nonce', nonce, '--step-class', 'code',
      '--rationale', 'the backend never answered; closed with a recorded degrade']);
    assert.equal(degraded.status, 0, degraded.stderr);
    assert.match(degraded.stdout, /and CLOSED the thread/);

    const report = kit(fx, ['aggregate', '--wave', WAVE]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /lane-3 · retry 0 · degrade-closed · L = 0\.000/);
    assert.equal(kit(fx, ['return', '--nonce', nonce]).status, 1, 'a closed thread absorbs nothing');
    assert.equal(readFileSync(join(fx.gitDir, DELEGATION_STORE_BASENAME), 'utf8').includes(execReportBasename('codex', nonce)), false);
  });
});
