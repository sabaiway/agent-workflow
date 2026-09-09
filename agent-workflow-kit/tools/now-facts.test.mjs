import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFileBytes } from './core-evidence.mjs';
import { makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';
import { planWith } from './plan-shape-harness.test.mjs';

// The CLI's own first act (now-cli.mjs): buildSummaryState spawns git under process.env alone.
process.env.GIT_OPTIONAL_LOCKS = '0';

const loadFacts = () => import('./now-facts.mjs').catch(() => ({}));
const loadPlanFacts = () => import('./now-plan-facts.mjs').catch(() => ({}));

const PLAN = planWith({
  title: '# Plan: alpha',
  ledger: [
    'n01 | create | src/landed.mjs | Add the reader | 40 | src/base.mjs:1',
    'n02 | modify | src/staged.mjs | Rewrite the staged reader | 40 | src/base.mjs:1',
    'n03 | modify | src/unstaged.mjs | Rewrite the unstaged reader | 40 | src/base.mjs:1',
    'n04 | modify | docs/excluded.md | Refresh the excluded document | n/a | src/base.mjs:1',
    'n05 | create | src/absent.mjs | Add the absent reader | 40 | src/base.mjs:1',
    'total: 5 to 9 lines',
  ].join('\n'),
});
const BROKEN_PLAN = '# Plan: broken\n\n## Goal and boundary\n\nThe ledger and the verification are missing.\n';
export const QUEUE = [
  '---',
  'title: queue fixture',
  '---',
  '',
  '- **Leading work item - id `LEAD-ID`, queued 2026-09-01.** Body.',
  '',
  '## Pending / backlog',
  '',
  '### Active work',
  '',
  '- **Priority work item - id `PRIORITY-ID`, queued 2026-09-01.** Body.',
  '',
  '## History',
  '',
  '### Active work',
  '',
  '- **Archived work item - id `ARCHIVE-ID`, queued 2026-09-01.** Body.',
  '',
].join('\n');
const CONFIG = `${JSON.stringify({
  _README: 'the size practice of the fixture repository',
  schema: 1,
  defaults: { maxLines: 400, maxLineBytes: 1000 },
  roots: ['src'],
  exclude: ['src/generated'],
  extensions: ['.mjs'],
  baseline: { 'src/landed.mjs': { lines: 420, reason: 'recorded debt' } },
  aggregate: { src: { lines: 420, reason: 'recorded debt' } },
}, null, 2)}\n`;

export const NOW_FILES = Object.freeze({
  'docs/plans/alpha.md': PLAN,
  'docs/plans/queue.md': QUEUE,
  'docs/ai/source-size.json': CONFIG,
  'src/base.mjs': 'base\n',
  'src/landed.mjs': 'one\ntwo\n',
  'src/staged.mjs': 'staged\n',
  'src/unstaged.mjs': 'unstaged\n',
});
export const filesWithout = (...names) =>
  Object.fromEntries(Object.entries(NOW_FILES).filter(([name]) => !names.includes(name)));
export const makeNowRepo = (label, files = NOW_FILES) => makeRepo(label, files);

// Every regular file's BYTES in sorted path order: a listing cannot see a byte change to a file already there.
export const hashGitDir = (gitDir) => {
  const paths = readdirSync(gitDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return createHash('sha256')
    .update(paths.map((path) => `${path}:${hashFileBytes(path)}`).join('|'))
    .digest('hex');
};

export const makeMutatedRepo = (label) => {
  const repo = makeNowRepo(label);
  repo.write('.git/info/exclude', 'docs/excluded.md\n');
  repo.write('docs/excluded.md', 'excluded\n');
  repo.write('src/staged.mjs', 'staged\nagain\n');
  repo.must(['add', 'src/staged.mjs']);
  repo.write('src/unstaged.mjs', 'unstaged\nagain\n');
  return repo;
};

const lineOf = (text, needle) => text.split('\n').indexOf(needle) + 1;
const makeSummary = (over = {}) => ({
  fingerprint: 'tree-fixture', receiptsPath: null, finalRun: null, redProofs: [], verdicts: [],
  storeMalformed: 0, storeReadError: null, receiptsMalformed: 0, receiptsReadError: null, ...over,
});
const paths = (block) => block.entries.map((entry) => entry.path);
export const withRepos = (repos, body) => {
  try {
    body(repos);
  } finally {
    for (const repo of Object.values(repos)) repo.cleanup();
  }
};

describe('now facts - the four blocks over a real repository', { skip: skipWithoutGit }, () => {
  // spec:now/S6
  it('names exactly the plans in flight, one, several or none, and keeps an unreadable ledger as an entry', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    withRepos({
      several: makeNowRepo('now-several', {
        ...NOW_FILES,
        'docs/plans/beta.md': planWith({ title: '# Plan: beta' }),
        'docs/plans/broken.md': BROKEN_PLAN,
        'docs/plans/EXECUTE-scratch.md': PLAN,
        'docs/plans/notes-handoff.md': PLAN,
      }),
      one: makeNowRepo('now-one'),
      none: makeNowRepo('now-none', filesWithout('docs/plans/alpha.md', 'docs/plans/queue.md')),
    }, ({ several, one, none }) => {
      const many = gatherNowFacts({ cwd: several.dir, env: several.env });
      assert.deepEqual(paths(many.plans), ['docs/plans/alpha.md', 'docs/plans/beta.md', 'docs/plans/broken.md']);
      const broken = many.plans.entries[2];
      assert.equal(broken.parsed, null);
      assert.match(broken.parseError, /Verification/);
      const alpha = many.plans.entries[0];
      assert.equal(alpha.parseError, null);
      assert.equal(alpha.rows.length, 5);
      assert.equal(alpha.phases, undefined);
      assert.deepEqual(paths(gatherNowFacts({ cwd: one.dir, env: one.env }).plans), ['docs/plans/alpha.md']);
      const empty = gatherNowFacts({ cwd: none.dir, env: none.env });
      assert.deepEqual(empty.plans.entries, []);
      assert.match(empty.queue.withheld, /queue\.md/);
    });
  });

  it('carries every queue row full line-numbered heading path, two same-named headings staying distinct', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    withRepos({ repo: makeNowRepo('now-queue') }, ({ repo }) => {
      const { queue } = gatherNowFacts({ cwd: repo.dir, env: repo.env });
      assert.equal(queue.path, 'docs/plans/queue.md');
      assert.equal(queue.total, 3);
      const buckets = queue.rows.map((row) => row.buckets);
      assert.deepEqual(buckets[0], []);
      assert.deepEqual(buckets[1], [
        { level: 2, text: '## Pending / backlog', line: lineOf(QUEUE, '## Pending / backlog') },
        { level: 3, text: '### Active work', line: lineOf(QUEUE, '### Active work') },
      ]);
      assert.deepEqual(buckets[2], [
        { level: 2, text: '## History', line: lineOf(QUEUE, '## History') },
        { level: 3, text: '### Active work', line: QUEUE.split('\n').lastIndexOf('### Active work') + 1 },
      ]);
      assert.notDeepEqual(buckets[1], buckets[2]);
    });
  });

  it('reads the staged set, the working set and the exclusion fact into one evidence record per row', async () => {
    const { gatherPlanFacts } = await loadPlanFacts();
    assert.equal(typeof gatherPlanFacts, 'function');
    withRepos({ repo: makeMutatedRepo('now-evidence') }, ({ repo }) => {
      const facts = gatherPlanFacts({ cwd: repo.dir, env: repo.env });
      assert.deepEqual(facts.changed.staged, ['src/staged.mjs']);
      assert.deepEqual(facts.changed.unstaged, ['src/unstaged.mjs']);
      assert.deepEqual(facts.changed.untracked, []);
      assert.deepEqual(facts.excluded, ['docs/excluded.md']);
      const evidence = facts.plans[0].rows.map(({ evidence: fact }) => fact);
      assert.deepEqual(evidence.map((fact) => fact.pathFact.kind), ['regular', 'regular', 'regular', 'regular', 'absent']);
      assert.deepEqual(evidence.map((fact) => fact.staged), [false, true, false, false, false]);
      assert.deepEqual(evidence.map((fact) => fact.unstaged), [false, false, true, false, false]);
      assert.deepEqual(evidence.map((fact) => fact.excluded), [false, false, false, true, false]);
      assert.deepEqual(facts.pathFacts['src/landed.mjs'].lines, 2);
      assert.deepEqual(Object.keys(facts).sort(), ['changed', 'excluded', 'pathFacts', 'plans']);
    });
  });

  it('lists both sides of a staged rename, so a delete row on the old path and a sweep over it read in progress', async () => {
    const { gatherPlanFacts } = await loadPlanFacts();
    assert.equal(typeof gatherPlanFacts, 'function');
    const renamePlan = planWith({ title: '# Plan: rename', ledger: ['n01 | delete | src/staged.mjs | Retire the staged reader | \u2014 | \u2014', 'n02 | modify | src/** | Sweep the sources (3 files) | n/a | src/base.mjs:1', 'total: 0 to 0 lines'].join('\n') });
    withRepos({ repo: makeNowRepo('now-rename', { ...filesWithout('docs/plans/alpha.md'), 'docs/plans/rename.md': renamePlan }) }, ({ repo }) => {
      repo.write('moved/staged.mjs', 'staged\n');
      rmSync(join(repo.dir, 'src/staged.mjs'));
      repo.must(['add', '-A']);
      const facts = gatherPlanFacts({ cwd: repo.dir, env: repo.env });
      assert.deepEqual(facts.changed.staged, ['moved/staged.mjs', 'src/staged.mjs']);
      assert.deepEqual(facts.plans[0].rows.map(({ evidence }) => evidence.staged), [true, true]);
    });
  });

  it('reads a row path spelled with a dot-slash or a doubled slash against the same git facts as its canonical form', async () => {
    const { gatherPlanFacts } = await loadPlanFacts();
    assert.equal(typeof gatherPlanFacts, 'function');
    const spelledPlan = planWith({ title: '# Plan: spelled', ledger: ['n01 | modify | ./src/staged.mjs | Rewrite the staged reader | 40 | src/base.mjs:1', 'n02 | modify | src//unstaged.mjs | Rewrite the unstaged reader | 40 | src/base.mjs:1', 'n03 | modify | ./docs/excluded.md | Refresh the excluded document | n/a | src/base.mjs:1', 'n04 | create | ./src/new.mjs | Add the new reader | 40 | src/base.mjs:1', 'n05 | modify | ./src/** | Sweep the sources (4 files) | n/a | src/base.mjs:1', 'total: 0 to 0 lines'].join('\n') });
    withRepos({ repo: makeMutatedRepo('now-spelled') }, ({ repo }) => {
      repo.write('docs/plans/spelled.md', spelledPlan);
      rmSync(join(repo.dir, 'docs/plans/alpha.md'));
      repo.write('src/new.mjs', 'new\n');
      repo.must(['add', 'src/new.mjs']);
      const facts = gatherPlanFacts({ cwd: repo.dir, env: repo.env });
      const rows = facts.plans[0].rows;
      assert.deepEqual(rows.map(({ row }) => row.path), ['./src/staged.mjs', 'src//unstaged.mjs', './docs/excluded.md', './src/new.mjs', './src/**']);
      assert.deepEqual(rows.map(({ evidence }) => evidence.pathFact.kind), ['regular', 'regular', 'regular', 'regular', 'sweep']);
      assert.deepEqual(rows.map(({ evidence }) => evidence.staged), [true, false, false, true, true]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.unstaged), [false, true, false, false, true]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.excluded), [false, false, true, false, false]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.path), ['src/staged.mjs', 'src/unstaged.mjs', 'docs/excluded.md', 'src/new.mjs', 'src/**']);
    });
  });

  it('keeps a ledger line that is not six fields as a pathless row and never withholds the plans half for it', async () => {
    const { gatherPlanFacts } = await loadPlanFacts();
    assert.equal(typeof gatherPlanFacts, 'function');
    const midEditPlan = planWith({ title: '# Plan: mid-edit', ledger: ['n01 | modify | src/staged.mjs | Rewrite the staged reader | 40 | src/base.mjs:1', 'n02 | modify | src/unstaged.mjs | Rewrite the unstaged reader | 40', 'total: 0 to 0 lines'].join('\n') });
    withRepos({ repo: makeMutatedRepo('now-mid-edit') }, ({ repo }) => {
      repo.write('docs/plans/mid-edit.md', midEditPlan);
      rmSync(join(repo.dir, 'docs/plans/alpha.md'));
      const facts = gatherPlanFacts({ cwd: repo.dir, env: repo.env });
      const rows = facts.plans[0].rows;
      assert.equal(facts.plans[0].parseError, null);
      assert.deepEqual(rows.map(({ row }) => row.valid), [true, false]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.path), ['src/staged.mjs', null]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.pathFact?.kind ?? null), ['regular', null]);
      assert.deepEqual(rows.map(({ evidence }) => evidence.staged), [true, false]);
    });
  });

  it('keeps the plans half when the summary cannot be read, withholding the tree with that cause alone', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    withRepos({ repo: makeNowRepo('now-summary-throws') }, ({ repo }) => {
      const deps = { get summary() { throw new Error('the store is on fire'); } };
      const facts = gatherNowFacts({ cwd: repo.dir, env: repo.env, deps });
      assert.match(facts.tree.withheld, /the evidence summary: the store is on fire/);
      assert.deepEqual(paths(facts.plans), ['docs/plans/alpha.md']);
    });
  });

  it('withholds each block by its own cause and never lets a failed git read read as an empty success', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    const outside = mkdtempSync(join(tmpdir(), 'now-outside-'));
    withRepos({
      repo: makeNowRepo('now-withheld'),
      malformed: makeNowRepo('now-malformed', { ...NOW_FILES, 'docs/ai/source-size.json': '{ not json\n' }),
    }, ({ repo, malformed }) => {
      const nowhere = gatherNowFacts({ cwd: outside, env: repo.env });
      for (const block of ['plans', 'tree', 'queue', 'campaign']) {
        assert.match(nowhere[block].withheld, /not a git work tree/, block);
      }
      const killed = gatherNowFacts({
        cwd: repo.dir,
        env: repo.env,
        deps: {
          spawn: (command, args, options) => args[0] === 'diff'
            ? { status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: '' }
            : spawnSync(command, args, options),
        },
      });
      assert.match(killed.plans.withheld, /SIGKILL/);
      assert.equal(killed.queue.total, 3);
      assert.equal(killed.campaign.state, 'minted');
      const bad = gatherNowFacts({ cwd: malformed.dir, env: malformed.env });
      assert.match(bad.campaign.withheld, /source-size\.json/);
      assert.match(bad.plans.withheld, /source-size\.json/);
      const spawnAs = (answer) => (command, args, options) => (args[0] === 'diff' ? answer(args) : spawnSync(command, args, options));
      const exited = gatherNowFacts({ cwd: repo.dir, env: repo.env, deps: { spawn: spawnAs(() => ({ status: 128, signal: null, stdout: '', stderr: 'fatal: boom\n' })) } });
      assert.match(exited.plans.withheld, /git diff exited 128 \(fatal: boom\)/);
      const threw = gatherNowFacts({ cwd: repo.dir, env: repo.env, deps: { spawn: spawnAs(() => { throw new Error('no runner'); }) } });
      assert.match(threw.plans.withheld, /git diff threw synchronously \(no runner\)/);
    });
  });

  it('keeps a plan the tokenizer refuses as an entry, and maps the summary: verdict lines, the withheld stores, the final run', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    const gather = (repo, summary) => gatherNowFacts({ cwd: repo.dir, env: repo.env, deps: { summary: makeSummary(summary) } });
    withRepos({ repo: makeNowRepo('now-summary', { ...NOW_FILES, 'docs/plans/ambiguous.md': '---\n# Plan: ambiguous\n---\n' }) }, ({ repo }) => {
      const facts = gather(repo, { verdicts: [
        { backend: 'codex', summary: { state: 'current', receipt: { verdict: 'ship', timestamp: '2026-09-05T00:00:00Z' } } },
        { backend: 'agy', summary: { state: 'stale', probeExcluded: 0, markerRejected: 0, unmarkedRejected: 0 } },
      ] });
      const ambiguous = facts.plans.entries.find(({ path }) => path === 'docs/plans/ambiguous.md');
      assert.equal(ambiguous.parsed, null);
      assert.match(ambiguous.parseError, /cannot be parsed .*leading/);
      assert.deepEqual(facts.tree.verdicts, [
        { backend: 'codex', line: 'codex: ship (attesting, 2026-09-05T00:00:00Z)' },
        { backend: 'agy', line: 'agy: no fresh code receipt exists for the current tree' },
      ]);
      const receipts = gather(repo, { receiptsUnavailable: true, receiptsMalformed: 2 });
      assert.match(receipts.tree.withheld, /review receipts store .*2 malformed line/);
      assert.deepEqual([receipts.plans.entries.length, receipts.queue.total], [2, 3]);
      assert.match(gather(repo, { evidenceUnavailable: true, storeReadError: 'EACCES' }).tree.withheld, /core-evidence store .*EACCES/);
      const red = gather(repo, { finalRun: { status: 'red', results: [{ id: 'a', ok: true }, { id: 'b', ok: false }], fingerprintBefore: 'fp', timestamp: 't', coverage: 'certified', lcovSha256: 'x' } });
      assert.deepEqual(red.tree.finalRun, { status: 'RED', gates: '1/2', fingerprintBefore: 'fp', timestamp: 't', coverage: 'coverage=certified' });
      const legacy = gather(repo, { finalRun: { status: 'green', fingerprintBefore: 'fp', timestamp: 't', lcovSha256: null } });
      assert.equal(legacy.tree.finalRun.gates, 'unknown');
      assert.match(legacy.tree.finalRun.coverage, /^coverage=unknown: this legacy receipt/);
      assert.doesNotMatch(legacy.tree.finalRun.coverage, /coverage=.*coverage=/);
    });
  });

  it('judges a sweep row over its expansion on disk and the full git sets, and claims exclusion only for a wholly excluded sweep', async () => {
    const { gatherPlanFacts } = await loadPlanFacts();
    assert.equal(typeof gatherPlanFacts, 'function');
    const sweepPlan = planWith({
      title: '# Plan: sweep',
      ledger: [
        'n06 | modify | src/** | Sweep the sources (3 files) | n/a | src/base.mjs:1',
        'n07 | modify | gen/** | Sweep the generated files (1 files) | n/a | src/base.mjs:1',
        'n08 | modify | nowhere/** | Sweep nothing (0 files) | n/a | src/base.mjs:1',
        'total: 0 to 0 lines',
      ].join('\n'),
    });
    const sweepFiles = { ...filesWithout('docs/plans/alpha.md'), 'docs/plans/sweep.md': sweepPlan };
    const rowsOf = (repo) => Object.fromEntries(gatherPlanFacts({ cwd: repo.dir, env: repo.env }).plans[0].rows.map(({ row, evidence }) => [row.id, evidence]));
    withRepos({
      edited: makeNowRepo('now-sweep-edited', sweepFiles),
      stagedDeletion: makeNowRepo('now-sweep-staged-rm', sweepFiles),
      lastDeleted: makeNowRepo('now-sweep-last-rm', sweepFiles),
    }, ({ edited, stagedDeletion, lastDeleted }) => {
      edited.write('src/unstaged.mjs', 'unstaged\nagain\n');
      edited.write('.git/info/exclude', 'gen/\n');
      edited.write('gen/out.mjs', 'generated, never tracked\n');
      const editedRows = rowsOf(edited);
      assert.deepEqual([editedRows.n06.pathFact.kind, editedRows.n06.pathFact.members, editedRows.n06.unstaged, editedRows.n06.excluded], ['sweep', 4, true, false]);
      assert.deepEqual([editedRows.n07.pathFact.kind, editedRows.n07.untracked, editedRows.n07.excluded], ['sweep', false, true]);
      assert.deepEqual([editedRows.n08.pathFact.kind, editedRows.n08.unstaged, editedRows.n08.excluded], ['absent', false, false]);
      stagedDeletion.must(['rm', '-q', 'src/staged.mjs']);
      const stagedRows = rowsOf(stagedDeletion);
      assert.deepEqual([stagedRows.n06.pathFact.members, stagedRows.n06.staged, stagedRows.n06.unstaged], [3, true, false]);
      lastDeleted.must(['rm', '-q', 'src/base.mjs', 'src/landed.mjs', 'src/staged.mjs']);
      lastDeleted.must(['commit', '-qm', 'drop three']);
      rmSync(join(lastDeleted.dir, 'src/unstaged.mjs'));
      const lastRows = rowsOf(lastDeleted);
      assert.deepEqual([lastRows.n06.pathFact.kind, lastRows.n06.unstaged], ['absent', true]);
    });
  });

  it('writes nothing: the recursive content hash of .git is identical before and after the gather', async () => {
    const { gatherNowFacts } = await loadFacts();
    assert.equal(typeof gatherNowFacts, 'function');
    withRepos({ repo: makeMutatedRepo('now-readonly') }, ({ repo }) => {
      const gitDir = join(repo.dir, '.git');
      const before = hashGitDir(gitDir);
      const facts = gatherNowFacts({ cwd: repo.dir, env: repo.env });
      assert.equal(hashGitDir(gitDir), before);
      assert.equal(facts.plans.entries.length, 1);
      assert.equal(typeof facts.tree.fingerprint, 'string');
      gatherNowFacts({ cwd: repo.dir, env: repo.env });
      assert.equal(hashGitDir(gitDir), before);
    });
  });
});
