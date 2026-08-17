import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every assumption that CAUSED this plan was found by running real git, and a stub runner cannot check
// one of them. So these tests build real repositories: a bare "remote" and a working clone in a temp
// directory, and drive the preflight as a SUBPROCESS so the real process leaf and the real git are both
// in the loop. No network — every remote is a local bare repo.

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = join(HERE, 'preflight-remote.mjs');
const AUTHOR = ['-c', 'user.name=preflight test', '-c', 'user.email=test@example.invalid'];

const runGit = (args, cwd) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
};

const runGitOrFail = (args, cwd) => {
  const res = runGit(args, cwd);
  assert.equal(res.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
};

const commitFile = (cwd, name, body) => {
  writeFileSync(join(cwd, name), body);
  runGitOrFail(['add', name], cwd);
  runGitOrFail([...AUTHOR, 'commit', '-m', `add ${name}`], cwd);
  return runGitOrFail(['rev-parse', 'HEAD'], cwd);
};

const runPreflight = (cwd, args = ['--ref', 'main']) => {
  const res = spawnSync(process.execPath, [PREFLIGHT, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

const listRefs = (repo) => runGitOrFail(['for-each-ref', '--format=%(refname) %(objectname)'], repo).split('\n').sort().join('\n');

const findPrintedCommand = (text, marker) => {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker));
  assert.ok(line, `expected a printed command starting with ${JSON.stringify(marker)}; got:\n${text}`);
  return line;
};

// The temp root is registered for removal IMMEDIATELY, before anything inside it can throw: registering
// after a successful build leaks the directory whenever the build itself fails.
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const createFixture = (label) => {
  const root = mkdtempSync(join(tmpdir(), `aw-preflight-${label}-`));
  roots.push(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  runGitOrFail(['init', '--bare', '-b', 'main', bare], root);
  runGitOrFail(['init', '-b', 'main', work], root);
  const first = commitFile(work, 'a.txt', 'one\n');
  runGitOrFail(['remote', 'add', 'origin', bare], work);
  runGitOrFail(['push', '-u', 'origin', 'main'], work);
  return { root, bare, work, first };
};

// ── the git facts the plan rests on ────────────────────────────────────────────────────

describe('preflight-remote (real git) — a refspec-less remote', () => {
  it('really does leave the tracking ref unset and @{u} unresolvable, and the preflight refuses for that reason', () => {
    const fx = createFixture('norefspec');
    runGitOrFail(['config', '--unset', 'remote.origin.fetch'], fx.work);
    runGitOrFail(['config', '--unset', 'branch.main.merge'], fx.work);
    runGitOrFail(['config', '--unset', 'branch.main.remote'], fx.work);
    runGitOrFail(['update-ref', '-d', 'refs/remotes/origin/main'], fx.work);

    assert.equal(runGit(['rev-parse', '--abbrev-ref', '@{u}'], fx.work).status, 128, 'no upstream is configured');
    assert.equal(runGit(['fetch', 'origin', 'main'], fx.work).status, 0, 'the fetch itself still works');
    assert.equal(
      runGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], fx.work).status,
      1,
      'and it does NOT advance a tracking ref — which is why the count must never read one',
    );

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3, 'an unresolvable @{push} is a refusal, which is the safe direction');
    assert.match(run.stderr, /@\{push\} does not resolve/);
    assert.equal(runGit(['rev-parse', '--verify', '--quiet', 'refs/aw-preflight'], fx.work).status, 1, 'and no landing ref was created');
  });
});

// ── the three topologies, end to end ──────────────────────────────────────────────────

describe('preflight-remote (real git) — the verdicts', () => {
  it('PASSES when the branch is in sync', () => {
    const fx = createFixture('insync');
    const run = runPreflight(fx.work);
    assert.equal(run.status, 0, `expected a pass; stderr:\n${run.stderr}`);
    assert.match(run.stdout, /PASS — no remote-only commits on origin\/main/);
    assert.match(run.stdout, /behind 0, ahead 0/);
  });

  it('names a catch-up command that REALLY fast-forwards when the remote is ahead', () => {
    const fx = createFixture('behind');
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    const remoteTip = commitFile(other, 'b.txt', 'two\n');
    runGitOrFail(['push', 'origin', 'main'], other);

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /behind 1, ahead 0/);
    assert.doesNotMatch(run.stderr, /force-with-lease/, 'no force lane where a fast-forward works');

    const command = findPrintedCommand(run.stderr, 'git merge --ff-only ');
    assert.ok(command.endsWith(remoteTip), `the remedy must be bound to the fetched OID ${remoteTip}; got ${command}`);
    assert.equal(spawnSync('git', command.split(' ').slice(1), { cwd: fx.work, encoding: 'utf8' }).status, 0, 'and the printed command must actually work');
    assert.equal(runGitOrFail(['rev-parse', 'HEAD'], fx.work), remoteTip);
    assert.equal(runPreflight(fx.work).status, 0, 'after the catch-up the check passes');
  });

  it('reports a real divergence with both counts and offers no fast-forward', () => {
    const fx = createFixture('diverged');
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    commitFile(other, 'theirs.txt', 'theirs\n');
    commitFile(other, 'theirs2.txt', 'theirs2\n');
    runGitOrFail(['push', 'origin', 'main'], other);
    commitFile(fx.work, 'mine.txt', 'mine\n');

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /DIVERGED/);
    assert.match(run.stderr, /behind 2, ahead 1/);
    assert.doesNotMatch(run.stderr, /--ff-only/, 'a fast-forward is impossible here, so no such command is printed');
    assert.match(run.stderr, /no command is printed/);
  });
});

// ── the printed force-push is real, leased, and NARROW ──────────────────────────────────

describe('preflight-remote (real git) — the force-push it prints', () => {
  it('succeeds against a matching remote, is refused on a stale lease, and moves NO other ref', () => {
    const fx = createFixture('lease');
    runGitOrFail([...AUTHOR, 'branch', 'keep-me'], fx.work);
    runGitOrFail(['push', 'origin', 'keep-me'], fx.work);
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    commitFile(other, 'theirs.txt', 'theirs\n');
    runGitOrFail(['push', 'origin', 'main'], other);
    const mine = commitFile(fx.work, 'mine.txt', 'mine\n');

    // The narrowness claim needs a fixture where a WIDE push would be VISIBLE. With keep-me identical on
    // both sides and push.default=simple, "keep-me did not move" holds even for a command that pushes
    // everything — there is nothing to move. So the local keep-me is advanced and the default is widened
    // to `matching`: now an unbound refspec really would carry it along.
    runGitOrFail(['config', 'push.default', 'matching'], fx.work);
    runGitOrFail(['update-ref', 'refs/heads/keep-me', mine], fx.work);
    const keepRemoteBefore = runGitOrFail(['rev-parse', 'refs/heads/keep-me'], fx.bare);
    assert.notEqual(runGitOrFail(['rev-parse', 'refs/heads/keep-me'], fx.work), keepRemoteBefore, 'the fixture must make a wide push visible');

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3);
    const command = findPrintedCommand(run.stderr, 'git push --force-with-lease=');

    const pushed = spawnSync('git', [...AUTHOR, ...command.split(' ').slice(1)], { cwd: fx.work, encoding: 'utf8' });
    assert.equal(pushed.status, 0, `the printed push must succeed against the matching remote; stderr:\n${pushed.stderr}`);
    assert.equal(runGitOrFail(['rev-parse', 'refs/heads/main'], fx.bare), mine, 'and it must land exactly this branch');
    assert.equal(
      runGitOrFail(['rev-parse', 'refs/heads/keep-me'], fx.bare),
      keepRemoteBefore,
      'keep-me had a newer local tip and push.default=matching, so only a BOUND refspec leaves it alone',
    );

    // Re-running the command verbatim would be a NO-OP — the remote already carries this HEAD — and git
    // answers "Everything up-to-date" without ever weighing the lease. So the local branch moves first:
    // now the push WOULD change the remote while the lease still names the OID this run fetched.
    commitFile(fx.work, 'later.txt', 'later\n');
    const again = spawnSync('git', [...AUTHOR, ...command.split(' ').slice(1)], { cwd: fx.work, encoding: 'utf8' });
    assert.notEqual(again.status, 0, 'a stale lease must be refused, which is the whole point of the lease');
    assert.match(`${again.stderr}${again.stdout}`, /stale info|rejected|non-fast-forward/i);
    assert.equal(runGitOrFail(['rev-parse', 'refs/heads/main'], fx.bare), mine, 'and the refused push changed nothing');
  });
});

// ── the count is taken against THIS run's fetch ────────────────────────────────────────

describe("preflight-remote (real git) — the counted OID is this run's own", () => {
  it('ignores a STALE tracking ref and counts against what it just fetched', () => {
    const fx = createFixture('stale');
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    const remoteTip = commitFile(other, 'theirs.txt', 'theirs\n');
    runGitOrFail(['push', 'origin', 'main'], other);
    // Point the tracking ref at the OLD commit deliberately: a run that read it would report "in sync".
    runGitOrFail(['update-ref', 'refs/remotes/origin/main', fx.first], fx.work);
    assert.equal(runGitOrFail(['rev-parse', 'refs/remotes/origin/main'], fx.work), fx.first, 'the tracking ref is stale on purpose');

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3, 'the stale tracking ref would have said in-sync; the fetched OID says otherwise');
    assert.match(run.stderr, /behind 1, ahead 0/);
    assert.ok(run.stderr.includes(remoteTip), `the verdict must name the FETCHED oid ${remoteTip}`);
  });

  it('neither reads nor writes FETCH_HEAD, so a concurrent fetch cannot lend it an OID', () => {
    const fx = createFixture('fetchhead');
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    commitFile(other, 'theirs.txt', 'theirs\n');
    runGitOrFail(['push', 'origin', 'main'], other);
    // A FETCH_HEAD left by someone else, naming a commit that is NOT the remote tip.
    const fetchHeadPath = join(fx.work, '.git', 'FETCH_HEAD');
    const decoy = `${fx.first}\t\tbranch 'main' of somewhere-else\n`;
    writeFileSync(fetchHeadPath, decoy);
    const bytesBefore = readFileSync(fetchHeadPath);

    const run = runPreflight(fx.work);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /behind 1, ahead 0/, 'the decoy would have produced 0/0');
    // Compared as BYTES, not through rev-parse: rev-parse reads only the first resolvable OID, so an
    // appended or rewritten file with the same first line would slip past it.
    assert.deepEqual(
      readFileSync(fetchHeadPath),
      bytesBefore,
      'FETCH_HEAD is left byte-identical — the run passes --no-write-fetch-head and reads its own landing ref',
    );
  });
});

// ── the branch/tag ambiguity, and the bookkeeping ─────────────────────────────────────

describe('preflight-remote (real git) — a branch and a tag sharing one name', () => {
  it('fetches the BRANCH, because the refspec addresses refs/heads explicitly', () => {
    const fx = createFixture('sharedname');
    const other = join(fx.root, 'other');
    runGitOrFail(['clone', fx.bare, other], fx.root);
    runGitOrFail(['checkout', '-b', 'release'], other);
    const branchTip = commitFile(other, 'branch.txt', 'branch\n');
    runGitOrFail(['push', 'origin', 'release'], other);
    runGitOrFail(['checkout', 'main'], other);
    const tagTarget = commitFile(other, 'tag.txt', 'tagged\n');
    runGitOrFail([...AUTHOR, 'tag', 'release', tagTarget], other);
    runGitOrFail(['push', 'origin', 'refs/tags/release'], other);

    runGitOrFail(['fetch', 'origin', 'refs/heads/release:refs/heads/release'], fx.work);
    runGitOrFail(['checkout', 'release'], fx.work);
    runGitOrFail(['branch', '--set-upstream-to=origin/release', 'release'], fx.work);
    assert.notEqual(branchTip, tagTarget, 'the fixture is only meaningful if the two differ');

    const run = runPreflight(fx.work, ['--ref', 'release']);
    assert.ok(run.stdout.includes(branchTip) || run.stderr.includes(branchTip), `the BRANCH tip must be the fetched oid; got:\n${run.stdout}${run.stderr}`);
    assert.ok(!run.stdout.includes(tagTarget) && !run.stderr.includes(tagTarget), 'the tag of the same name must never be what was verified');
  });

  it('leaves no landing ref behind and moves no remote-tracking ref', () => {
    const fx = createFixture('cleanup');
    const before = listRefs(fx.work);
    assert.equal(runPreflight(fx.work).status, 0);
    assert.equal(listRefs(fx.work), before, 'the temporary landing ref is deleted and nothing else is touched');
  });
});
