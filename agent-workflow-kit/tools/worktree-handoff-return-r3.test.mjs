// worktree-handoff-return-r3.test.mjs — the round-3 council fold (delegation Plan 3, Phase 3):
// once the handoff is read and the prepared pair attested, the DELIVERY is a fact — a later
// measurement failure (diff-tree, the parser, cat-file, the numerator) must not erase the primary
// return channel, and the PROOF line prints only after the final re-attestation has held. Its OWN
// suite: the earlier suites' bytes are frozen under standing red-proofs and never move (D13).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeProvisionRecordSection } from './worktrees-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-handoff-return-r3-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const USER_NOTES = 'user notes that must survive every late refusal →\n';

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
  return { main, wt, slug, head: sh(['rev-parse', 'HEAD'], main).trim() };
};

const writeHandoff = (f, { prepared, preparedHead }) => {
  const record = composeProvisionRecordSection({
    slug: f.slug, branch: `aw/${f.slug}`, includes: [], nodeModules: 'skipped', vscode: 'skipped', prepared, preparedHead,
  });
  writeFileSync(join(f.wt, 'docs/plans', `handoff-${f.slug}.md`), `# Handoff — ${f.slug}\n\n${USER_NOTES}\n${record}`);
};

const stageAndTree = (f) => {
  writeFileSync(join(f.main, 'feature.txt'), 'x\n');
  sh(['add', '--', 'feature.txt'], f.main);
  return sh(['write-tree'], f.main).trim();
};

const runRung = async (f, deps) => {
  const { handoffReturn } = await import('./worktree-handoff-return.mjs');
  return handoffReturn({ cwd: f.main, slug: f.slug, waveId: 'w1', planId: 'delegation-3', phase: 3, env: process.env, deps });
};

const storeAbsent = (main) => !existsSync(join(main, '.git', 'agent-workflow-delegation.jsonl'));

describe('handoff-return — delivery survives every post-read refusal, proof waits for the re-attestation', () => {
  it('a measurement failure after the handoff was read preserves the delivery and prints no proof', async () => {
    const cases = [
      { name: 'diff-tree', deps: { gitBuf: () => ({ status: 128, stdout: Buffer.alloc(0), stderr: 'diff-tree exploded' }) }, want: /cannot enumerate the prepared change set/ },
      { name: 'cat-file', deps: { git: (args, cwd) => (args[0] === 'cat-file' && args[1] === '-t' ? { status: 0, stdout: 'tree\n', stderr: '' } : realGit(args, cwd)) }, want: /is a tree, not a blob/ },
    ];
    for (const c of cases) {
      const f = makeFixture(`r3-${c.name}`, `e-${c.name}`);
      const tree = stageAndTree(f);
      writeHandoff(f, { prepared: tree, preparedHead: f.head });
      const r = await runRung(f, c.deps);
      assert.equal(r.code, 1, `${c.name}: ${r.stdout}`);
      assert.match(r.stderr, c.want, `${c.name}: ${r.stderr}`);
      assert.ok(r.stdout.includes(USER_NOTES), `${c.name}: the delivery survives the refusal`);
      assert.ok(r.stdout.includes('before "## Provision record"'), `${c.name}: the fragment boundaries survive too`);
      assert.equal(r.stdout.includes('proof —'), false, `${c.name}: no proof line rides a refusal that precedes the final re-attestation`);
      assert.ok(storeAbsent(f.main), `${c.name}: nothing was appended`);
    }
  });

  it('a re-attestation drift refusal preserves the delivery and carries no proof line', async () => {
    const f = makeFixture('r3-drift', 'e-drift');
    const tree = stageAndTree(f);
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    let calls = 0;
    const git = (args, cwd) => {
      if (args.length === 1 && args[0] === 'write-tree') {
        calls += 1;
        return { status: 0, stdout: `${calls === 1 ? tree : 'f'.repeat(40)}\n`, stderr: '' };
      }
      return realGit(args, cwd);
    };
    const r = await runRung(f, { git });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /write-tree moved while the return was being computed/);
    assert.ok(r.stdout.includes(USER_NOTES), 'the delivery survives the drift refusal');
    assert.equal(r.stdout.includes('proof —'), false, 'the proof prints only after the final re-attestation held');
    assert.ok(storeAbsent(f.main), 'nothing was appended');
  });
});
