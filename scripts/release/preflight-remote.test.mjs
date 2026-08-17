import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  REMOTE,
  DEFAULT_REF,
  HELP,
  parseArgs,
  preflightRefFor,
  sanitize,
  renderTopology,
  runCli,
  main,
} from './preflight-remote.mjs';

// ── harness ───────────────────────────────────────────────────────────────────────────
//
// The stub answers by ARGV PREFIX, and an unscripted call THROWS rather than defaulting: a silent
// default would let a mutant reorder or skip a git call and still pass.

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
const FIXED_LANDING = preflightRefFor({ pid: 4242, nonce: 'nonce' });
const REMOTE_URL = 'https://example.invalid/repo.git';

const healthyPrefix = (ref = DEFAULT_REF) => ({
  [`check-ref-format --branch ${ref}`]: { stdout: `${ref}\n` },
  [`rev-parse --verify --quiet refs/tags/${ref}`]: { status: 1 },
  'rev-parse --abbrev-ref @{push}': { stdout: `${REMOTE}/${ref}\n` },
  [`remote get-url --push --all ${REMOTE}`]: { stdout: `${REMOTE_URL}\n` },
  [`remote get-url ${REMOTE}`]: { stdout: `${REMOTE_URL}\n` },
});

const topologyPrefix = (behind, ahead) => ({
  'fetch --no-tags': {},
  [`rev-parse ${FIXED_LANDING}`]: { stdout: `${FETCHED_OID}\n` },
  'rev-list --left-right --count': { stdout: `${behind}\t${ahead}\n` },
  'update-ref -d': {},
});

const runMain = async (argv, script) => {
  const git = gitStub(script);
  const out = [];
  const err = [];
  const code = await main(argv, {
    runGit: git.run, log: (l) => out.push(l), logError: (l) => err.push(l), pid: 4242, nonce: 'nonce',
  });
  return { code, calls: git.calls, out: out.join('\n'), err: err.join('\n') };
};

const networkCalls = (calls) => calls.filter((line) => line.startsWith('fetch'));
const tagProbes = (calls) => calls.filter((line) => line.startsWith('rev-parse --verify --quiet refs/tags'));

// ── argument contract ─────────────────────────────────────────────────────────────────

describe('preflight-remote — the argument contract', () => {
  it('defaults --ref to the dispatcher\'s own default', () => {
    assert.equal(parseArgs([]).ref, DEFAULT_REF);
    assert.equal(DEFAULT_REF, 'main');
  });

  it('--help exits 0 and prints the help — exit 2 is for usage ERRORS only', async () => {
    const run = await runMain(['--help'], {});
    assert.equal(run.code, EXIT.ok);
    assert.equal(run.out, HELP);
    assert.deepEqual(run.calls, [], 'help runs no git at all');
  });

  it('refuses an unknown argument with exit 2, naming it, and runs no git', async () => {
    const run = await runMain(['--force'], {});
    assert.equal(run.code, EXIT.usage);
    assert.match(run.err, /unknown argument "--force"/);
    assert.deepEqual(run.calls, []);
  });

  it('refuses --ref with no value', async () => {
    const run = await runMain(['--ref'], {});
    assert.equal(run.code, EXIT.usage);
    assert.match(run.err, /--ref requires a branch-name argument/);
  });

  it('refuses a FULL REF, and never fetches it', async () => {
    const run = await runMain(['--ref', 'refs/heads/main'], {});
    assert.equal(run.code, EXIT.usage);
    assert.match(run.err, /must be a SHORT branch name, not a full ref/);
    assert.deepEqual(networkCalls(run.calls), []);
  });

  it('refuses a name git REWRITES — measured: check-ref-format --branch @{-1} exits 0 and hands back another branch', async () => {
    const run = await runMain(['--ref', '@{-1}'], {
      'check-ref-format --branch @{-1}': { stdout: 'ci/oidc-trusted-publishing\n' },
    });
    assert.equal(run.code, EXIT.usage);
    assert.match(run.err, /is a shorthand git resolves to "ci\/oidc-trusted-publishing"/);
    assert.deepEqual(networkCalls(run.calls), []);
  });

  it('refuses a name git rejects, carrying git\'s EXACT first stderr line', async () => {
    const run = await runMain(['--ref', 'has space'], {
      'check-ref-format --branch has space': { status: 128, stderr: "fatal: 'has space' is not a valid branch name\nhint: something\n" },
    });
    assert.equal(run.code, EXIT.usage);
    assert.ok(
      run.err.includes("fatal: 'has space' is not a valid branch name"),
      `git's own first line must reach the operator, not merely our paraphrase; got:\n${run.err}`,
    );
    assert.doesNotMatch(run.err, /hint: something/, 'only the first line is carried');
  });
});

// ── the shell-safety refusal ──────────────────────────────────────────────────────────
//
// Measured: every name below is a LEGAL git branch name, and `git branch "release;uname"` really
// creates one. Interpolated into a printed remedy, the semicolon splits the force-push line and leaves
// `git push --force-with-lease=refs/heads/release` as its own command — a lease with NO VALUE, the one
// form this script exists never to print.

describe('preflight-remote — a shell-significant byte in the ref is refused, not escaped', () => {
  for (const ref of ['release;uname', "quo'te", 'amp&and', 'dollar$sub', 'back`tick', 'pipe|d', 'sub$(cmd)']) {
    it(`refuses ${JSON.stringify(ref)} with exit 2, BEFORE the tag probe and BEFORE the fetch`, async () => {
      const run = await runMain(['--ref', ref], {
        [`check-ref-format --branch ${ref}`]: { stdout: `${ref}\n` },
      });
      assert.equal(run.code, EXIT.usage);
      assert.match(run.err, /carries a shell-significant byte/);
      assert.deepEqual(tagProbes(run.calls), [], 'the refusal precedes the tag probe');
      assert.deepEqual(networkCalls(run.calls), [], 'the refusal precedes the network act');
    });
  }

  it('ACCEPTS an ordinary nested branch name', async () => {
    const run = await runMain(['--ref', 'feature/nested-name'], {
      ...healthyPrefix('feature/nested-name'),
      ...topologyPrefix(0, 1),
    });
    assert.equal(run.code, EXIT.ok, `a normal nested name must not be caught by the shell-safety rule; stderr:\n${run.err}`);
  });

  it('ACCEPTS dots, underscores and digits', async () => {
    const run = await runMain(['--ref', 'release_1.2.x'], {
      ...healthyPrefix('release_1.2.x'),
      ...topologyPrefix(0, 0),
    });
    assert.equal(run.code, EXIT.ok);
  });
});

// ── the tag / branch distinction ──────────────────────────────────────────────────────

describe('preflight-remote — a tag is a usage mistake, and a broken probe never passes', () => {
  it('refuses a TAG name as a USAGE error, not as a fetch failure', async () => {
    const run = await runMain(['--ref', 'v5.10.0'], {
      'check-ref-format --branch v5.10.0': { stdout: 'v5.10.0\n' },
      'rev-parse --verify --quiet refs/tags/v5.10.0': { stdout: `${FETCHED_OID}\n` },
      'rev-parse --verify --quiet refs/heads/v5.10.0': { status: 1 },
    });
    assert.equal(run.code, EXIT.usage, 'a tag is a usage mistake — exit 3 would read as a network refusal');
    assert.match(run.err, /names a TAG here, not a branch/);
    assert.deepEqual(networkCalls(run.calls), []);
  });

  it('proceeds when a branch and a tag SHARE the name — the explicit refspec settles it', async () => {
    const run = await runMain(['--ref', 'release'], {
      ...healthyPrefix('release'),
      'rev-parse --verify --quiet refs/tags/release': { stdout: `${FETCHED_OID}\n` },
      'rev-parse --verify --quiet refs/heads/release': { stdout: `${FETCHED_OID}\n` },
      ...topologyPrefix(0, 0),
    });
    assert.equal(run.code, EXIT.ok);
    assert.ok(
      run.calls.some((line) => line.endsWith(`+refs/heads/release:${FIXED_LANDING}`)),
      `the fetch names refs/heads explicitly; got ${JSON.stringify(run.calls)}`,
    );
  });

  it('refuses fail-closed when the tag probe itself did not answer — a broken guard never lets the fetch run', async () => {
    for (const broken of [{ status: 128, stderr: 'fatal: something\n' }, { status: null, signal: 'SIGKILL' }, { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }]) {
      const run = await runMain([], {
        ...healthyPrefix(),
        [`rev-parse --verify --quiet refs/tags/${DEFAULT_REF}`]: broken,
      });
      assert.equal(run.code, EXIT.refusal, `outcome ${JSON.stringify(broken)} must refuse`);
      assert.match(run.err, /did not answer/);
      assert.deepEqual(networkCalls(run.calls), []);
    }
  });
});

// ── the @{push} guard and the EFFECTIVE URLs (Decision 3) ─────────────────────────────

describe('preflight-remote — @{push} guards the OPERATOR\'s push, it never sources the destination', () => {
  it('refuses when @{push} does not resolve, naming that condition', async () => {
    const run = await runMain([], {
      ...healthyPrefix(),
      'rev-parse --abbrev-ref @{push}': { status: 128, stderr: "fatal: cannot resolve 'simple' push to a single destination\n" },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /@\{push\} does not resolve/);
    assert.match(run.err, /cannot resolve 'simple' push to a single destination/);
    assert.deepEqual(networkCalls(run.calls), [], 'the guard refuses BEFORE the network act');
  });

  it('refuses when @{push} points somewhere other than the checked destination', async () => {
    const run = await runMain([], {
      ...healthyPrefix(),
      'rev-parse --abbrev-ref @{push}': { stdout: 'fork/main\n' },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /@\{push\} resolves to "fork\/main" but this run verifies "origin\/main"/);
    assert.deepEqual(networkCalls(run.calls), []);
  });

  // Measured: with url.<base>.pushInsteadOf set, raw remote.<name>.url reads the ORIGINAL and raw
  // pushurl is ABSENT — so a raw-config comparison sees "nothing configured" and PASSES while the push
  // goes to another host. Only the effective values expose it.
  it('reads the EFFECTIVE push URLs, so a pushInsteadOf rewrite cannot pass unseen', async () => {
    const run = await runMain([], {
      ...healthyPrefix(),
      [`remote get-url --push --all ${REMOTE}`]: { stdout: 'https://redirected.invalid/\n' },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /pushes somewhere it does not fetch from/);
    assert.match(run.err, /1 of 1 effective push URL\(s\) differ .* at position\(s\) 1/);
    assert.deepEqual(networkCalls(run.calls), []);
    assert.deepEqual(
      run.calls.filter((line) => line.startsWith('config')),
      [],
      'raw config is never consulted — it is exactly what misses the rewrite',
    );
  });

  // The VALUE is never printed. A redaction rule is a filter and a filter can be wrong; not printing
  // the URL at all cannot be. So the diagnostic names positions, and the operator reads the values with
  // the command it hands them.
  it('names the DIVERGENT entries by position and never prints a URL value', async () => {
    const run = await runMain([], {
      ...healthyPrefix(),
      [`remote get-url --push --all ${REMOTE}`]: { stdout: `${REMOTE_URL}\nssh://elsewhere.invalid/other.git\nhttps://third.invalid/x.git\n` },
    });
    assert.equal(run.code, EXIT.refusal);
    assert.match(run.err, /2 of 3 effective push URL\(s\) differ .* at position\(s\) 2, 3/, 'the MATCHING entry is excluded and the others are located');
    assert.doesNotMatch(run.err, /elsewhere\.invalid/, 'no URL value is printed at all');
    assert.doesNotMatch(run.err, /third\.invalid/);
    assert.doesNotMatch(run.err, /example\.invalid/);
    assert.match(run.err, /git remote get-url --push --all origin/, 'and the operator is handed the command that shows them');
  });

  // The userinfo half of the redaction rule stays here, where it has always been; the QUERY half moved to
  // the sanitizer's own suite when the rule got its own module. Splitting it that way keeps this arm's
  // identity — a red-proof record is keyed by {file, test name}, and a moved test orphans its record with
  // no way to satisfy it again on the same base.
  it('REDACTS every credential shape, including a bare token used AS the username', () => {
    assert.equal(sanitize('https://user:ghp_secret@host/r.git'), 'https://<redacted>@host/r.git');
    assert.equal(sanitize('https://ghp_SECRET@host/r.git'), 'https://<redacted>@host/r.git', 'a colon-less userinfo IS a secret when it is a token');
    assert.equal(sanitize('ssh://git:pw@host/r.git'), 'ssh://<redacted>@host/r.git');
    assert.equal(sanitize('git@github.com:org/repo.git'), '<redacted>@github.com:org/repo.git', 'scp-form userinfo is masked too — a token there is indistinguishable from a username');
    assert.equal(sanitize('/tmp/local/origin.git'), '/tmp/local/origin.git', 'a plain path is untouched');
    assert.equal(sanitize('fatal: could not read Username for https://host'), 'fatal: could not read Username for https://host');
  });

  it('accepts push URLs that equal the fetch URL', async () => {
    const run = await runMain([], { ...healthyPrefix(), ...topologyPrefix(0, 3) });
    assert.equal(run.code, EXIT.ok);
  });

  it('refuses when either URL read fails', async () => {
    for (const key of [`remote get-url ${REMOTE}`, `remote get-url --push --all ${REMOTE}`]) {
      const run = await runMain([], { ...healthyPrefix(), [key]: { status: 128, stderr: 'fatal: no such remote\n' } });
      assert.equal(run.code, EXIT.refusal, `${key} failing must refuse`);
      assert.match(run.err, /could not be read/);
    }
  });

});

// ── the verdicts (Decision 1) and the bound remedies (Decision 2) ─────────────────────

describe('preflight-remote — every printed command is bound to what this run verified', () => {
  const BARE_PULL = /git pull --ff-only/;
  const CATCH_UP = `git merge --ff-only ${FETCHED_OID}`;
  const FORCE_PUSH = `git push --force-with-lease=refs/heads/main:${FETCHED_OID} ${REMOTE} HEAD:refs/heads/main`;

  it('passes on 0 behind, naming both counts and refusing to overclaim', () => {
    const verdict = renderTopology({ ref: 'main', oid: FETCHED_OID, behind: 0, ahead: 4 });
    assert.equal(verdict.exitCode, EXIT.ok);
    assert.match(verdict.message, /behind 0, ahead 4/);
    assert.match(verdict.message, /not push permission/);
    assert.ok(!verdict.message.includes(CATCH_UP) && !verdict.message.includes(FORCE_PUSH), 'a pass offers no remedy');
  });

  it('passes on 0/0 too', () => {
    assert.equal(renderTopology({ ref: 'main', oid: FETCHED_OID, behind: 0, ahead: 0 }).exitCode, EXIT.ok);
  });

  it('names the catch-up lane BOUND TO THE FETCHED OID when the branch can still fast-forward', () => {
    const verdict = renderTopology({ ref: 'main', oid: FETCHED_OID, behind: 7, ahead: 0 });
    assert.equal(verdict.exitCode, EXIT.refusal);
    assert.match(verdict.message, /behind 7, ahead 0/);
    assert.ok(verdict.message.includes(CATCH_UP), `the remedy must be bound to the OID; got:\n${verdict.message}`);
    assert.doesNotMatch(verdict.message, BARE_PULL, 'a bare pull resolves through the upstream this run deliberately does not verify');
    assert.ok(!verdict.message.includes(FORCE_PUSH), 'no force lane is offered where a fast-forward works');
    assert.doesNotMatch(verdict.message, /force-with-lease/);
  });

  // A fast-forward is impossible by definition on a divergence, so `merge --ff-only` would be a command
  // guaranteed to refuse. Printing one that cannot work is worse than printing none: it also discredits
  // the command beside it.
  it('names BOTH lanes on a divergence but prints ONLY the command that can actually run', () => {
    const verdict = renderTopology({ ref: 'main', oid: FETCHED_OID, behind: 292, ahead: 300 });
    assert.equal(verdict.exitCode, EXIT.refusal);
    assert.match(verdict.message, /behind 292, ahead 300/);
    assert.match(verdict.message, /DIVERGED/);
    assert.ok(verdict.message.includes(FORCE_PUSH), `the force lane must be present in the diverged arm; got:\n${verdict.message}`);
    assert.ok(!verdict.message.includes(CATCH_UP), `merge --ff-only cannot succeed on a divergence and must NOT be printed; got:\n${verdict.message}`);
    assert.doesNotMatch(verdict.message, /--ff-only/, 'no fast-forward command belongs in this arm at all');
    assert.match(verdict.message, /take the remote history instead: no command is printed/);
    assert.match(verdict.message, /300 local commit\(s\)/, 'the count of what is at stake is named');
    assert.match(verdict.message, /it is yours to make/);
    assert.match(verdict.message, /tags are not rewritten/);
    assert.doesNotMatch(verdict.message, BARE_PULL);
  });

  it('pins the lease to the FETCHED OID and binds remote AND refspec — never a bare push', () => {
    const verdict = renderTopology({ ref: 'main', oid: FETCHED_OID, behind: 1, ahead: 1 });
    assert.ok(verdict.message.includes(FORCE_PUSH), `got:\n${verdict.message}`);
    assert.doesNotMatch(verdict.message, /--force-with-lease=refs\/heads\/main\s/, 'a lease with no value would lease against the tracking ref — the value that is stale in exactly this case');
    assert.doesNotMatch(verdict.message, /origin\/main:/, 'the lease is never expressed against a tracking ref');
  });

  it('states what the run DID write — it never claims to have changed nothing', () => {
    for (const [behind, ahead] of [[7, 0], [1, 1]]) {
      const verdict = renderTopology({ ref: 'main', oid: FETCHED_OID, behind, ahead });
      assert.doesNotMatch(verdict.message, /changes nothing/, 'the fetch DOES write a ref — claiming otherwise is the loose wording this plan set out to remove');
      assert.match(verdict.message, /No remedy was run/);
      // Only the ref write is guaranteed: a tip already present locally means no object is written.
      assert.match(verdict.message, /may have written local objects and did write one temporary ref/);
      assert.doesNotMatch(verdict.message, /did write local objects/, 'an object write is not guaranteed, so it must not be asserted');
    }
  });

  it('reports a PASS on stdout and a REFUSAL on stderr, and deletes its own landing ref either way', async () => {
    const pass = await runMain([], { ...healthyPrefix(), ...topologyPrefix(0, 1) });
    assert.equal(pass.code, EXIT.ok);
    assert.match(pass.out, /PASS/);
    assert.equal(pass.err, '');
    assert.ok(pass.calls.includes(`update-ref -d ${FIXED_LANDING}`));

    const refused = await runMain([], { ...healthyPrefix(), ...topologyPrefix(5, 5) });
    assert.equal(refused.code, EXIT.refusal);
    assert.match(refused.err, /DIVERGED/);
    assert.equal(refused.out, '');
    assert.ok(refused.calls.includes(`update-ref -d ${FIXED_LANDING}`), 'the landing ref is cleaned up on a refusal too');
  });
});

// ── the landing ref is this run's own ─────────────────────────────────────────────────

describe('preflight-remote — the counted OID is the one THIS run fetched', () => {
  it('never reads FETCH_HEAD — the count is taken against a process-unique ref', async () => {
    const run = await runMain([], { ...healthyPrefix(), ...topologyPrefix(0, 0) });
    assert.equal(run.code, EXIT.ok);
    assert.deepEqual(run.calls.filter((line) => line.includes('FETCH_HEAD') && !line.startsWith('fetch')), [], 'a shared FETCH_HEAD can be overwritten by a concurrent fetch between two commands');
    assert.ok(run.calls.includes(`rev-list --left-right --count ${FIXED_LANDING}...HEAD`));
  });

  it('process.exitCode carries main\'s code out through runCli', async () => {
    const previous = process.exitCode;
    try {
      await runCli(['--not-a-flag'], { log: () => {}, logError: () => {} });
      assert.equal(process.exitCode, EXIT.usage, 'the CLI edge must report a real refusal, not a bare 0');
    } finally {
      process.exitCode = previous;
    }
  });

  it('derives the landing ref from the pid AND a per-run nonce', () => {
    assert.notEqual(preflightRefFor({ pid: 1, nonce: 'a' }), preflightRefFor({ pid: 1, nonce: 'b' }));
    assert.notEqual(preflightRefFor({ pid: 1, nonce: 'a' }), preflightRefFor({ pid: 2, nonce: 'a' }));
    assert.match(preflightRefFor({ pid: 1, nonce: 'a' }), /^refs\/aw-preflight\//);
  });
});
