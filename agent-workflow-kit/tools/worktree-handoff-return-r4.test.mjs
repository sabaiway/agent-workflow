// worktree-handoff-return-r4.test.mjs — the round-4 council fold (delegation Plan 3, Phase 3): a
// git failure INSIDE the final re-attestation (the second write-tree or the second rev-parse HEAD)
// is itself a late refusal, so it keeps the already-established delivery on stdout and carries no
// proof line — the round-3 contract holds on its own failure arm too. Its OWN suite: the earlier
// suites' bytes are frozen under standing red-proofs and never move (D13).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeProvisionRecordSection } from './worktrees-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-handoff-return-r4-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const USER_NOTES = 'user notes that must survive the re-attestation probe failure →\n';

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const realGit = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const makeFixture = (name, slug) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'base.txt'), 'base content\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  const wt = join(TMP, `${name}--${slug}`);
  sh(['worktree', 'add', '-q', wt, '-b', `aw/${slug}`], main);
  mkdirSync(join(wt, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'feature.txt'), 'x\n');
  sh(['add', '--', 'feature.txt'], main);
  const tree = sh(['write-tree'], main).trim();
  const head = sh(['rev-parse', 'HEAD'], main).trim();
  const record = composeProvisionRecordSection({
    slug, branch: `aw/${slug}`, includes: [], nodeModules: 'skipped', vscode: 'skipped', prepared: tree, preparedHead: head,
  });
  writeFileSync(join(wt, 'docs/plans', `handoff-${slug}.md`), `# Handoff — ${slug}\n\n${USER_NOTES}\n${record}`);
  return { main, wt, slug, tree, head };
};

// The Nth exactly-matched probe call fails; every other call passes through to real git.
const failingNthGit = (probe, failAt, message) => {
  let calls = 0;
  return (args, cwd) => {
    if (probe.length === args.length && probe.every((v, i) => v === args[i])) {
      calls += 1;
      if (calls === failAt) return { status: 128, stdout: '', stderr: message };
    }
    return realGit(args, cwd);
  };
};

describe('handoff-return — the final re-attestation keeps its own failure arm honest', () => {
  it('a git failure inside the final re-attestation preserves the delivery and carries no proof line', async () => {
    const { handoffReturn } = await import('./worktree-handoff-return.mjs');
    const cases = [
      { name: 'second write-tree', fixture: makeFixture('r4-wt', 'f-wt'), git: () => failingNthGit(['write-tree'], 2, 'write-tree exploded'), want: /write-tree exploded|write-tree failed/ },
      { name: 'second rev-parse HEAD', fixture: makeFixture('r4-head', 'f-head'), git: () => failingNthGit(['rev-parse', 'HEAD'], 2, 'rev-parse exploded'), want: /rev-parse exploded|MAIN HEAD/ },
    ];
    for (const c of cases) {
      const f = c.fixture;
      const r = handoffReturn({ cwd: f.main, slug: f.slug, waveId: 'w1', planId: 'delegation-3', phase: 3, env: process.env, deps: { git: c.git() } });
      assert.equal(r.code, 1, `${c.name}: ${r.stdout}`);
      assert.match(r.stderr, c.want, `${c.name}: ${r.stderr}`);
      assert.ok(r.stdout.includes(USER_NOTES), `${c.name}: the delivery survives the probe failure`);
      assert.equal(r.stdout.includes('proof —'), false, `${c.name}: no proof line rides an unattested answer`);
      assert.ok(!existsSync(join(f.main, '.git', 'agent-workflow-delegation.jsonl')), `${c.name}: nothing was appended`);
    }
  });
});
