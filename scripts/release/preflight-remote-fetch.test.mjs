import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, REMOTE, DEFAULT_REF, HELP, preflightRefFor, main } from './preflight-remote.mjs';

const OK = { status: 0, stdout: '', stderr: '', error: null, signal: null };

const gitStub = (script) => {
  const calls = [];
  const run = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    const key = Object.keys(script).find((prefix) => line.startsWith(prefix));
    if (key === undefined) throw new Error(`the test scripted no answer for: git ${line}`);
    return { ...OK, ...script[key] };
  };
  return { calls, run };
};

const FETCHED_OID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LANDING = preflightRefFor({ pid: 4242, nonce: 'nonce' });
const REMOTE_URL = 'https://example.invalid/repo.git';
const FETCH_ARGV = `fetch --no-tags --no-recurse-submodules --no-write-fetch-head ${REMOTE} +refs/heads/${DEFAULT_REF}:${LANDING}`;

const healthy = {
  [`check-ref-format --branch ${DEFAULT_REF}`]: { stdout: `${DEFAULT_REF}\n` },
  [`rev-parse --verify --quiet refs/tags/${DEFAULT_REF}`]: { status: 1 },
  'rev-parse --abbrev-ref @{push}': { stdout: `${REMOTE}/${DEFAULT_REF}\n` },
  [`remote get-url --push --all ${REMOTE}`]: { stdout: `${REMOTE_URL}\n` },
  [`remote get-url ${REMOTE}`]: { stdout: `${REMOTE_URL}\n` },
  // The completeness guard runs before the fetch; a healthy fixture is a whole repository.
  'rev-parse --is-shallow-repository': { stdout: 'false\n' },
  'update-ref -d': {},
};

const runMain = async (script) => {
  const git = gitStub(script);
  const out = [];
  const err = [];
  const code = await main([], {
    runGit: git.run, log: (l) => out.push(l), logError: (l) => err.push(l), pid: 4242, nonce: 'nonce',
  });
  return { code, calls: git.calls, out: out.join('\n'), err: err.join('\n') };
};

const afterFetch = (calls) => calls.filter((line) => line.startsWith('rev-list') || line.startsWith(`rev-parse ${LANDING}`));

// ── the help text promises exactly what the run guarantees ─────────────────────────────

describe('preflight-remote — --help never overstates what the run writes', () => {
  it('says objects MAY be written and the ref IS, because a tip already present locally writes nothing', () => {
    assert.match(HELP, /May write objects and does write one temporary ref/);
    assert.doesNotMatch(HELP, /Writes objects and one temporary ref/, 'the guaranteed form is untrue when the objects already exist');
  });

  it('still states every narrow claim a PASS is allowed to make', () => {
    assert.match(HELP, /NOT push permission/);
    assert.match(HELP, /NOT branch protection/);
    assert.match(HELP, /9 inconclusive/);
    assert.doesNotMatch(HELP, /unreachable/, 'exit 9 no longer claims a cause it cannot know');
  });
});

// ── the fetch is bounded to the surface the header declares ────────────────────────────

describe('preflight-remote — the fetch writes only what the honesty claim admits to', () => {
  it('narrows the fetch: no tag auto-follow, no submodule recursion, no FETCH_HEAD write', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': {},
      [`rev-parse ${LANDING}`]: { stdout: `${FETCHED_OID}\n` },
      'rev-list --left-right --count': { stdout: '0\t0\n' },
    });
    assert.equal(run.code, EXIT.ok);
    assert.ok(run.calls.includes(FETCH_ARGV), `the fetch must carry all three narrowing flags; got ${JSON.stringify(run.calls)}`);
  });
});

// ── the fetch outcome ─────────────────────────────────────────────────────────────────

describe('preflight-remote — the fetch classifies only what git actually distinguishes', () => {
  // The message is asserted WHOLE, not screened against a word blacklist: a blacklist of four words
  // cannot prove the absence of a causal claim (a sentence like "the network failure caused this
  // signal" would sail through one), while an exact match admits nothing that was not written on
  // purpose. This run's own deadline and an external kill produce the identical process result, so
  // naming either as the cause would be a fiction.
  it('maps a SIGNAL KILL to 9 as INCONCLUSIVE, with the message pinned WHOLE so no cause can creep in', async () => {
    const run = await runMain({ ...healthy, 'fetch --no-tags': { status: null, signal: 'SIGKILL' } });
    assert.equal(run.code, EXIT.inconclusive);
    assert.equal(
      run.err,
      '[preflight-remote] git fetch origin main was killed by a signal (SIGKILL) — nothing about the divergence was verified.\n'
        + '  INCONCLUSIVE, not a pass. Re-run this check; if it keeps ending this way, run it where the\n'
        + '  fetch can complete.',
    );
    assert.deepEqual(afterFetch(run.calls), [], 'no topology command may run after the fetch failed');
  });

  it('maps EVERY non-signal non-zero fetch to 3 and surfaces git\'s own stderr UNPARAPHRASED', async () => {
    const gitSaid = "fatal: couldn't find remote ref refs/heads/main";
    const run = await runMain({ ...healthy, 'fetch --no-tags': { status: 128, stderr: `${gitSaid}\n` } });
    assert.equal(run.code, EXIT.refusal, 'git returns the same status for transport, auth and a missing ref — inventing a category would rest on parsing prose');
    assert.ok(run.err.includes(gitSaid), `git's own message must reach the operator verbatim; got:\n${run.err}`);
    assert.match(run.err, /refusing fail-closed/);
    assert.notEqual(run.code, EXIT.inconclusive);
    assert.deepEqual(afterFetch(run.calls), []);
  });

  // The regression the earlier fix LACKED: the previous stderr arm carried only harmless text, so
  // replacing the redaction with raw stderr stayed green. git echoes the remote URL — credentials
  // included — in its own failure messages, so a secret in stderr is the realistic case, not an exotic
  // one.
  it('redacts a CREDENTIAL that arrives inside git\'s own stderr', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': {
        status: 128,
        stderr: "fatal: unable to access 'https://bot:ghp_TOPSECRET@example.invalid/repo.git/': auth failed\n",
      },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.doesNotMatch(run.err, /ghp_TOPSECRET/, 'a credential in git stderr must never reach the operator');
    assert.match(run.err, /<redacted>@example\.invalid/);
    assert.match(run.err, /auth failed/, 'the rest of git\'s message still arrives');
    assert.match(run.err, /verbatim except credential redaction/, 'and the promise printed beside it is the honest one');
  });

  // The boundary is the OUTPUT, not a list of call sites: a guard's own stderr and the final err.message
  // both bypassed a per-site redaction while the comment claimed full coverage.
  it('redacts a credential arriving through a GUARD\'s stderr, not only the fetch\'s', async () => {
    const run = await runMain({
      ...healthy,
      'rev-parse --abbrev-ref @{push}': {
        status: 128,
        stderr: "fatal: cannot read 'https://bot:ghp_GUARDLEAK@example.invalid/repo.git/'\n",
      },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.doesNotMatch(run.err, /ghp_GUARDLEAK/, 'every printed line passes the one boundary, including a guard refusal');
    assert.match(run.err, /<redacted>@example\.invalid/);
  });

  it('redacts EVERY query-parameter value, not a list of known secret names', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': { status: 128, stderr: 'fatal: https://example.invalid/r.git?oauth_token=AAA&client_secret=BBB&X-Amz-Signature=CCC failed\n' },
    });
    assert.equal(run.code, EXIT.refusal);
    for (const secret of ['AAA', 'BBB', 'CCC']) {
      assert.doesNotMatch(run.err, new RegExp(secret), `a name-denylist would have missed ${secret}`);
    }
  });

  // Measured: an allowlist of name CHARACTERS leaks just as a name denylist does — ?access[token]=,
  // ?token~= and ?a:b= all passed a [A-Za-z0-9_.%-]+ class.
  it('redacts a query value whatever its parameter NAME looks like', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': { status: 128, stderr: 'fatal: https://h/r?access[token]=AAA&token~=BBB&a:b=CCC failed\n' },
    });
    assert.equal(run.code, EXIT.refusal);
    for (const secret of ['AAA', 'BBB', 'CCC']) {
      assert.doesNotMatch(run.err, new RegExp(secret), `a name-character allowlist would have missed ${secret}`);
    }
  });

  // The last two shapes every PARSER of parameter names missed: an empty name and a quoted one. The rule
  // no longer parses names at all, which is why these pass.
  it('redacts a query whose parameter name is EMPTY or carries a quote', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': { status: 128, stderr: "fatal: https://h/a?=AAA and https://h/b?access'token=BBB failed\n" },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.doesNotMatch(run.err, /AAA/, 'an EMPTY parameter name leaked past every name parser');
    assert.doesNotMatch(run.err, /BBB/, 'and so did a quoted one');
  });
});

// ── a guard that could not RUN is not a verdict on the operator's input ─────────────────

describe('preflight-remote — a structural non-answer never becomes a usage error', () => {
  it('refuses fail-closed when check-ref-format is killed or cannot spawn, instead of blaming the ref', async () => {
    for (const broken of [
      { status: null, signal: 'SIGKILL' },
      { status: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) },
    ]) {
      const run = await runMain({ ...healthy, [`check-ref-format --branch ${DEFAULT_REF}`]: broken });
      assert.equal(run.code, EXIT.refusal, `outcome ${JSON.stringify(broken)} is a broken probe, not an invalid name`);
      assert.match(run.err, /did not answer/);
      assert.match(run.err, /the name was never judged/);
      assert.doesNotMatch(run.err, /is not a valid branch name/, 'the operator must not be told their ref is invalid when nothing judged it');
      assert.deepEqual(run.calls.filter((line) => line.startsWith('fetch')), [], 'and the network act never runs');
    }
  });

  it('maps a transport-level non-zero exit to 3 as well — no signal, no exit 9', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': { status: 128, stderr: 'fatal: unable to access: Could not resolve host: github.com\n' },
    });
    assert.equal(run.code, EXIT.refusal, 'a genuine network refusal without a signal classifies as 3, not 9');
    assert.match(run.err, /Could not resolve host/);
  });

  it('maps a SPAWN failure to 3, carrying the error code', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': { status: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /could not run \(ENOENT\)/);
    assert.deepEqual(afterFetch(run.calls), []);
  });

  it('performs EXACTLY ONE fetch on the happy path', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': {},
      [`rev-parse ${LANDING}`]: { stdout: `${FETCHED_OID}\n` },
      'rev-list --left-right --count': { stdout: '0\t2\n' },
    });
    assert.equal(run.code, EXIT.ok);
    assert.equal(run.calls.filter((line) => line.startsWith('fetch')).length, 1, 'the fetch is the ONE network act');
  });

  it('runs its git calls in the contract order — guards first, then the network, then the count', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': {},
      [`rev-parse ${LANDING}`]: { stdout: `${FETCHED_OID}\n` },
      'rev-list --left-right --count': { stdout: '0\t0\n' },
    });
    assert.deepEqual(run.calls, [
      `check-ref-format --branch ${DEFAULT_REF}`,
      `rev-parse --verify --quiet refs/tags/${DEFAULT_REF}`,
      'rev-parse --abbrev-ref @{push}',
      `remote get-url ${REMOTE}`,
      `remote get-url --push --all ${REMOTE}`,
      // The completeness guard is the LAST thing before the network act and the FIRST thing that
      // could refuse on the shape of the local graph — a shallow clone never reaches the fetch.
      'rev-parse --is-shallow-repository',
      FETCH_ARGV,
      `rev-parse ${LANDING}`,
      `rev-list --left-right --count ${LANDING}...HEAD`,
      `update-ref -d ${LANDING}`,
    ]);
  });
});

// ── reading back the fetched OID, and the count ───────────────────────────────────────

describe('preflight-remote — the count is fail-closed on anything it cannot read', () => {
  const withFetch = (extra) => ({
    ...healthy,
    'fetch --no-tags': {},
    [`rev-parse ${LANDING}`]: { stdout: `${FETCHED_OID}\n` },
    ...extra,
  });

  it('refuses when the fetched ref cannot be read back', async () => {
    const run = await runMain({ ...healthy, 'fetch --no-tags': {}, [`rev-parse ${LANDING}`]: { status: 1 } });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /could not be read back/);
  });

  it('refuses when the fetched ref reads back EMPTY', async () => {
    const run = await runMain({ ...healthy, 'fetch --no-tags': {}, [`rev-parse ${LANDING}`]: { stdout: '\n' } });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /could not be read back/);
  });

  it('refuses when rev-list exits non-zero, carrying git\'s message', async () => {
    const run = await runMain(withFetch({ 'rev-list --left-right --count': { status: 128, stderr: 'fatal: bad revision\n' } }));
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /rev-list --left-right --count failed/);
    assert.match(run.err, /bad revision/);
  });

  // The separator is a TAB and nothing else. A looser \s+ accepts a NEWLINE, and "0\n4\n" would then
  // parse as behind 0 — a FALSE PASS on malformed output.
  it('refuses UNPARSEABLE counts instead of parsing a NaN or a newline-separated pair', async () => {
    for (const stdout of ['', 'garbage\n', '3\n', '0\n4\n', '-1\t2\n', 'x\ty\n', '3\t2\t1\n', '0 4\n', ' 0\t4\n']) {
      const run = await runMain(withFetch({ 'rev-list --left-right --count': { stdout } }));
      assert.equal(run.code, EXIT.refusal, `output ${JSON.stringify(stdout)} must refuse`);
      assert.match(run.err, /cannot parse/, `output ${JSON.stringify(stdout)} must name the cause`);
    }
  });

  it('accepts the real tab-separated shape and reads left as BEHIND, right as AHEAD', async () => {
    const run = await runMain(withFetch({ 'rev-list --left-right --count': { stdout: '292\t300\n' } }));
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /behind 292, ahead 300/, 'left is the REMOTE-only side — the AD-098 incident measured 292 remote-only');
  });

  it('deletes its landing ref even when the fetch itself failed', async () => {
    const run = await runMain({ ...healthy, 'fetch --no-tags': { status: 128, stderr: 'fatal: nope\n' } });
    assert.ok(run.calls.includes(`update-ref -d ${LANDING}`), 'the cleanup rides a finally, so a failure never leaks a ref');
  });

  // Nothing else will remove this ref — the next run's landing ref carries a different pid and nonce —
  // so a failed delete accumulates one leftover per failure. It must be surfaced, and it must not change
  // the verdict that was already computed.
  it('WARNS with the exact stale ref when the cleanup fails, without changing the verdict', async () => {
    const run = await runMain({
      ...healthy,
      'fetch --no-tags': {},
      [`rev-parse ${LANDING}`]: { stdout: `${FETCHED_OID}\n` },
      'rev-list --left-right --count': { stdout: '0\t0\n' },
      'update-ref -d': { status: 1, stderr: 'error: cannot lock ref\n' },
    });
    assert.equal(run.code, EXIT.ok, 'a bookkeeping failure never overturns the divergence answer');
    assert.match(run.out, /PASS/, 'and the answer is still delivered');
    // The claim is bounded: a failed delete does NOT prove the ref exists — if the fetch never ran there
    // was nothing to remove — so the warning says the removal is unconfirmed, not that a ref was left.
    assert.match(run.err, /could not be confirmed/, 'no silent failure, and no overclaim either');
    assert.match(run.err, /the ref may remain/);
    assert.doesNotMatch(run.err, /was left behind/, 'that phrasing asserts an existence this run never checked');
    assert.match(run.err, /git said: error: cannot lock ref/, "git's own reason is shown — it explains whether the printed command would fail the same way");
    assert.ok(run.err.includes(`git update-ref -d ${LANDING}`), `the recovery names the exact ref; got:\n${run.err}`);
  });
});

// ── the effective push URL must be nameable ────────────────────────────────────────────

describe('preflight-remote — an EMPTY effective push URL refuses', () => {
  // Measured: `remote.<name>.pushurl=` makes `git remote get-url --push --all` exit 0 with stdout "\n".
  // Filtering that away let the guard pass over a destination nothing can name.
  it('refuses when the effective push URL list carries an empty entry', async () => {
    const run = await runMain({ ...healthy, [`remote get-url --push --all ${REMOTE}`]: { stdout: '\n' } });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /EMPTY effective push URL/);
    assert.deepEqual(run.calls.filter((line) => line.startsWith('fetch')), [], 'the refusal precedes the network act');
  });

  it('refuses when one of SEVERAL push URLs is empty', async () => {
    const run = await runMain({ ...healthy, [`remote get-url --push --all ${REMOTE}`]: { stdout: `${REMOTE_URL}\n\n` } });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /EMPTY effective push URL/);
  });
});
