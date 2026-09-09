import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipWithoutGit } from './hostile-git-harness.test.mjs';
import { filesWithout, hashGitDir, makeMutatedRepo, makeNowRepo, withRepos } from './now-facts.test.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'now-cli.mjs');
const BLOCKS = ['now', 'steps', 'queue', 'campaign'];
const loadCli = () => import('./now-cli.mjs').catch(() => ({}));

const runRaw = (cwd, args, env) => {
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv, encoding: 'utf8' });
};
const run = (repo, args = []) => runRaw(repo.dir, ['--dir', repo.dir, ...args], repo.env);

describe('now CLI - argv, the exit table and the write-nothing claim', { skip: skipWithoutGit }, () => {
  // spec:now/S7
  it('writes nothing and renders an unchanged tree byte for byte alike, in every state', async () => {
    const { main } = await loadCli();
    assert.equal(typeof main, 'function');
    withRepos({
      mutated: makeMutatedRepo('now-cli-mutated'),
      clean: makeNowRepo('now-cli-clean'),
      noPlan: makeNowRepo('now-cli-no-plan', filesWithout('docs/plans/alpha.md')),
      noQueue: makeNowRepo('now-cli-no-queue', filesWithout('docs/plans/queue.md')),
    }, (repos) => {
      for (const [label, repo] of Object.entries(repos)) {
        const gitDir = join(repo.dir, '.git');
        const before = hashGitDir(gitDir);
        const first = run(repo);
        assert.equal(first.status, 0, `${label}: ${first.stderr}`);
        assert.equal(hashGitDir(gitDir), before, label);
        const second = run(repo);
        assert.equal(second.stdout, first.stdout, label);
        assert.equal(hashGitDir(gitDir), before, label);
      }
    });
  });

  // spec:now/S8
  it('exits 0 whenever anything rendered, 1 when nothing did and 2 on every usage refusal', async () => {
    const { main } = await loadCli();
    assert.equal(typeof main, 'function');
    const outside = mkdtempSync(join(tmpdir(), 'now-cli-outside-'));
    withRepos({
      repo: makeMutatedRepo('now-cli-exit'),
      noPlan: makeNowRepo('now-cli-exit-no-plan', filesWithout('docs/plans/alpha.md')),
      noConfig: makeNowRepo('now-cli-exit-no-config', filesWithout('docs/ai/source-size.json')),
    }, ({ repo, noPlan, noConfig }) => {
      const planless = run(noPlan);
      assert.equal(planless.status, 0, planless.stderr);
      assert.match(planless.stdout, /NOW[\s\S]*no plan in flight/);
      assert.match(planless.stdout, /QUEUE[\s\S]*CAMPAIGN/);
      const configless = run(noConfig);
      assert.equal(configless.status, 0, configless.stderr);
      assert.match(configless.stdout, /CAMPAIGN[\s\S]*state: absent/);

      const nowhere = runRaw(outside, ['--dir', outside], repo.env);
      assert.equal(nowhere.status, 1, nowhere.stderr);
      assert.equal(nowhere.stdout, '');
      assert.match(nowhere.stderr, /not a git work tree/);

      const help = runRaw(repo.dir, ['--help'], repo.env);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage:[\s\S]*--dir[\s\S]*--format/);
      assert.equal(runRaw(repo.dir, ['--dir'], repo.env).status, 2);

      for (const [args, code] of [
        [['--json', '--format=plain'], 2],
        [['--format=plain', '--json'], 2],
        [['--unknown'], 2],
        [['--format=nope'], 2],
        [['--format'], 2],
        [['--dir', ''], 2],
        [['--help'], 2],
        [['--json'], 0],
        [['--json', '--format=json'], 0],
        [['--format', 'ansi'], 0],
      ]) {
        const result = run(repo, args);
        assert.equal(result.status, code, `${args.join(' ')}: ${result.stderr || result.stdout}`);
      }
    });
  });

  it('carries every block as a value or a withheld cause, and every status with its evidence and annotations', async () => {
    const { main } = await loadCli();
    assert.equal(typeof main, 'function');
    withRepos({
      repo: makeMutatedRepo('now-cli-json'),
      noQueue: makeNowRepo('now-cli-json-no-queue', filesWithout('docs/plans/queue.md')),
    }, ({ repo, noQueue }) => {
      const result = run(repo, ['--json']);
      assert.equal(result.status, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      for (const block of BLOCKS) assert.equal(typeof envelope[block], 'object', block);
      const plan = envelope.now.plans[0];
      assert.equal(plan.phase.name, 'ledger');
      assert.equal(plan.phase.current.row.id, 'n04');
      assert.equal(plan.phase.next.row.id, 'n05');
      const rows = envelope.steps.entries[0].rows;
      assert.deepEqual(rows.map(({ status }) => status), ['landed', 'in progress', 'in progress', 'unjudged', 'pending']);
      for (const row of rows) {
        assert.equal(typeof row.evidenceSource, 'string');
        assert.ok(Array.isArray(row.annotations));
      }
      assert.match(rows[3].detail, /excluded from git here/);
      assert.equal(envelope.queue.buckets.length > 0, true);

      const withheld = JSON.parse(run(noQueue, ['--json']).stdout);
      assert.match(withheld.queue.withheld, /queue\.md/);
      assert.equal(typeof withheld.campaign.state, 'string');
      assert.match(run(noQueue).stdout, /QUEUE — WITHHELD: [\s\S]*queue\.md/);
    });
  });
});
