import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renameSync, rmSync, symlinkSync } from 'node:fs';
import { ledgerOf, makeTree, planWith, write } from './plan-shape-harness.test.mjs';
import { FRONT, indexDoc, specDoc, STORE } from './spec-check-harness.test.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'plan-shape-cli.mjs');
const LINK_REFUSALS = ['EPERM', 'EACCES', 'ENOTSUP'];
const loadCli = () => import('./plan-shape-cli.mjs');
const makeRepo = () => {
  const root = makeTree('plan-shape-cli');
  write(root, 'docs/readme.md', 'ten\n');
  return root;
};
const run = (root, args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
};
const buildEpic = (ownedPath) => ['---', 'type: epic', 'lastUpdated: 2026-09-10', 'scope: permanent', 'staleAfter: 90d', 'owner: none',
  'maxLines: 60', 'state: open', '---', '# Epic: Ownership', '## Intent', 'Keep ownership visible.',
  '## Value', 'Keep work separate.', '## Non-goals', 'No implementation choices.', '## Acceptance', 'Result line: 2026-09-10',
  '## Specs', 'docs/ai/specs/kit/example.md', '## Stories ledger',
  `- S1 | Boundary | depends-on: none | owns: ${ownedPath} | shared: none | state: planned`, '## Queue', 'Row ALPHA in Now'].join('\n');
const planOf = (row) => planWith({ ledger: row });
const checkExit = (root, operand, status) => {
  const result = run(root, ['--check', operand]);
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result.stderr;
};

describe('plan-shape CLI — arms, in-flight scope and exit contract', () => {
  it('judges story collisions in both arms and in-flight, and refuses every plan over a refused store', async (t) => {
    await loadCli();
    const root = makeRepo();
    const outside = makeRepo();
    t.after(() => [root, outside].forEach((path) => rmSync(path, { recursive: true, force: true })));
    write(root, 'docs/ai/epics/ALPHA.md', buildEpic('docs/x.md'));
    write(root, 'docs/x.md', 'Owned document.\n');
    const ledger = ledgerOf('R1 | modify | docs/x.md | update the document | docs/x.md:1');
    write(root, 'docs/plans/collide.md', planWith({ ledger }));
    for (const args of [['--check', 'docs/plans/collide.md'], ['--verify', 'docs/plans/collide.md'], ['--check', '--in-flight']]) {
      const result = run(root, args);
      assert.ifError(result.error); assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /story-owns/);
    }
    write(root, 'docs/plans/mine.md', planWith({ ledger, goal: '- Spec: docs/ai/specs/example.md\nStory: S1 of ALPHA' }));
    const mine = run(root, ['--check', 'docs/plans/mine.md']);
    assert.ifError(mine.error); assert.equal(mine.status, 0, mine.stderr || mine.stdout);
    const store = join(root, 'docs/ai/epics');
    const target = join(outside, 'epics');
    renameSync(store, target);
    try { symlinkSync(target, store); }
    catch (error) {
      if (!LINK_REFUSALS.includes(error.code)) throw error;
      t.diagnostic(`sandbox refused symlinkSync: ${error.code}: ${store}`); return;
    }
    const refused = run(root, ['--check', '--in-flight']);
    assert.ifError(refused.error); assert.equal(refused.status, 1, refused.stderr);
    for (const name of ['collide', 'mine']) {
      assert.ok(refused.stdout.split('\n').some((line) => line.startsWith(`docs/plans/${name}.md:`) && line.includes('story-store')));
    }
  });

  it('S10/S11 runs authoring state only on --check and post-state without line counts on --verify (spec:plan-review-loop/S10, spec:plan-review-loop/S11)', async (t) => {
    const { main } = await loadCli();
    assert.equal(typeof main, 'function');
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, 'docs/plans/modify.md', planWith());
    write(root, 'docs/new.md', 'landed\n');
    write(root, 'docs/plans/create.md', planOf('R1 | create | docs/new.md | create it | docs/readme.md:1'));
    write(root, 'package.json', '{"files":["docs/"]}\n');
    write(root, 'test/package-content.test.mjs', 'pin\n');
    write(root, 'docs/plans/pin.md', planOf('R1 | create | docs/shipped.md | create it | docs/readme.md:1'));
    write(root, 'private/package.json', '{"private":true}\n');
    write(root, 'docs/plans/private.md', planOf('R1 | create | private/new.md | create it | docs/readme.md:1'));
    write(root, 'unknown/package.json', '{"files":["+(src)/**"]}\n');
    write(root, 'docs/plans/unknown.md', planOf('R1 | create | unknown/new.md | create it | docs/readme.md:1'));
    write(root, 'nopin/package.json', '{"files":["new.md"]}\n');
    write(root, 'docs/plans/nopin.md', planOf('R1 | create | nopin/new.md | create it | docs/readme.md:1'));
    write(root, 'docs/plans/delete.md', planOf('R1 | delete | docs/gone.md | delete it | —'));
    const checked = run(root, ['--check', 'docs/plans/modify.md']);
    const refusedBefore = run(root, ['--check', 'docs/plans/create.md']);
    const verifiedAfter = run(root, ['--verify', 'docs/plans/create.md']);
    const pinRefusal = run(root, ['--check', 'docs/plans/pin.md']);
    const privateSkip = run(root, ['--check', 'docs/plans/private.md']);
    const unknownSkip = run(root, ['--check', 'docs/plans/unknown.md']);
    const noPinSkip = run(root, ['--check', 'docs/plans/nopin.md']);
    const deletedAfter = run(root, ['--verify', 'docs/plans/delete.md']);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.match(checked.stdout, /ACCEPT/);
    assert.equal(refusedBefore.status, 1);
    assert.match(refusedBefore.stdout, /expects absent, observed regular/);
    assert.equal(verifiedAfter.status, 0, verifiedAfter.stderr || verifiedAfter.stdout);
    assert.equal(pinRefusal.status, 1);
    assert.match(pinRefusal.stdout, /package-pin/);
    assert.equal(privateSkip.status, 0, privateSkip.stderr || privateSkip.stdout);
    assert.match(privateSkip.stdout, /package pin skipped — private package/);
    assert.match(unknownSkip.stdout, /package pin skipped — shipping state is unknown/);
    assert.match(noPinSkip.stdout, /package pin skipped — no package-content\.test\.mjs/);
    assert.equal(deletedAfter.status, 0, deletedAfter.stderr || deletedAfter.stdout);
    const after = 'docs/plans/after.md';
    write(root, 'docs/new.md', 'landed\n'.repeat(500));
    write(root, after, planOf('R1 | create | docs/new.md | create it | 10 | docs/readme.md:1'));
    const legacy = run(root, ['--verify', after]);
    assert.doesNotMatch(legacy.stdout, /: (post-budget|after-total): /);
    write(root, after, planWith({ ledger: 'R1 | create | docs/new.md | create it | missing-anchor.md:1' }));
    const accepted = run(root, ['--verify', after]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /^plan-shape: ACCEPT/m);

    write(root, after, planWith({ ledger: [
      'R1 | create | docs/missing.md | add the document | missing-anchor.md:1',
      'R2 | modify | docs/*.md | update (3 files) | missing-anchor.md:1',
    ].join('\n') }));
    const postState = run(root, ['--verify', after]);
    assert.equal(postState.status, 1, postState.stderr || postState.stdout);
    assert.deepEqual(Array.from(postState.stdout.matchAll(/: R\d: ([a-z-]+): /g), (match) => match[1]), ['post-kind', 'sweep-count']);
    assert.doesNotMatch(postState.stdout, /: (anchor|package-pin|red-first|post-budget|after-total): /);
    write(root, after, planWith({ ledger: 'R1 | move | docs/new.md | move it | docs/readme.md:1' }));
    const structural = run(root, ['--verify', after]);
    assert.equal(structural.status, 1, structural.stderr || structural.stdout);
    assert.match(structural.stdout, /: R1: row-grammar: /);
  });

  it('S12 judges titled plans structurally, counts skipped shapes, and refuses any judged defect (spec:plan-review-loop/S12)', async () => {
    await loadCli();
    const root = makeRepo();
    write(root, 'docs/plans/good.md', planWith());
    write(root, 'docs/plans/notes.md', '# Notes\n\nNot a plan.\n');
    const accepted = run(root, ['--check', '--in-flight']);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /skipped by shape: 1/);
    assert.match(accepted.stdout, /judged plans: 1/);
    assert.equal(run(root, ['--verify', '--in-flight']).status, 0);
    write(root, 'docs/plans/landed.md', planOf('R1 | create | docs/readme.md | executed, awaiting its commit | docs/readme.md:1'));
    assert.equal(run(root, ['--check', 'docs/plans/landed.md']).status, 1, 'the authoring arm refuses a create on an existing path');
    const structuralOnly = run(root, ['--check', '--in-flight']);
    assert.equal(structuralOnly.status, 0, structuralOnly.stderr || structuralOnly.stdout);
    assert.match(structuralOnly.stdout, /judged plans: 2/);
    write(root, 'docs/plans/bad.md', planOf('R1 | move | docs/readme.md | wrong verb | docs/readme.md:1'));
    write(root, 'docs/plans/glob.md', planOf('R1 | modify | docs/[a.md | update (1 files) | docs/readme.md:1'));
    const refused = run(root, ['--check', '--in-flight']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /bad\.md/);
    assert.match(refused.stdout, /row-grammar/);
    assert.match(refused.stdout, /glob\.md:1: facts: unsupported glob/);
    assert.match(refused.stdout, /ACCEPT — docs\/plans\/good\.md/);
    assert.match(refused.stdout, /skipped by shape: 1/);
    const explicit = run(root, ['--check', 'docs/plans/glob.md']);
    assert.equal(explicit.status, 1, 'a plan-level facts failure is a listed finding on the explicit arm too');
    assert.match(explicit.stdout, /glob\.md:1: facts: unsupported glob/);
  });

  it('spec:plan-review-loop/S41 refuses retired ledger syntax on both arms and excludes its creates in flight', async (t) => {
    const { buildFacts, readPlansInFlight } = await import('./plan-shape-facts.mjs');
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const plans = [
      { identity: 'docs/plans/size.md', path: STORE + 'size.md', code: 'retired-size-field', fix: /drop.*(?:fifth|size) field/i },
      { identity: 'docs/plans/total.md', path: STORE + 'total.md', code: 'retired-total-line', fix: /\bdrop\b.*\b(?:it|line|total)\b/i },
    ];
    for (const { identity, path, code } of plans) {
      const row = 'R1 | create | ' + path + ' | add a document';
      const ledger = code === 'retired-size-field'
        ? row + ' | n/a | docs/readme.md:1'
        : row + ' | docs/readme.md:1\ntotal: 0 → 0 lines';
      write(root, identity, planWith({ ledger }));
    }
    for (const arm of ['--check', '--verify']) {
      const inFlight = run(root, [arm, '--in-flight']);
      for (const { identity, code, fix } of plans) {
        for (const result of [run(root, [arm, identity]), inFlight]) {
          assert.ifError(result.error);
          assert.equal(result.status, 1, result.stderr || result.stdout);
          const finding = result.stdout.split('\n').find((line) => line.startsWith(identity + ':') && line.includes(': ' + code + ': '));
          assert.ok(finding, result.stdout);
          assert.match(finding, fix);
        }
      }
    }
    const { plans: judged } = readPlansInFlight(root);
    assert.deepEqual(judged.map(({ identity, accepted }) => [identity, accepted]), plans.map(({ identity }) => [identity, false]));
    const current = 'docs/plans/current.md';
    const validPath = STORE + 'valid.md';
    write(root, 'docs/plans/valid.md', planWith({ ledger: 'R1 | create | ' + validPath + ' | add a document | docs/readme.md:1' }));
    assert.deepEqual(buildFacts(root, { plan: current }).otherPlanCreates, [validPath]);
  });

  it('S12 ambiguous pins exit 2 only for a plan whose rules read them, on both arms', (t) => {
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, 'docs/plans/good.md', planWith());
    write(root, 'package.json', '{"files":["docs/"]}\n');
    write(root, 'test/package-content.test.mjs', 'one\n');
    write(root, 'other/package-content.test.mjs', 'two\n');
    const ambiguity = /several package-content\.test\.mjs files: other\/package-content\.test\.mjs, test\/package-content\.test\.mjs/;
    for (const operand of ['docs/plans/good.md', '--in-flight']) checkExit(root, operand, 0);
    write(root, 'docs/plans/shipped.md', planOf('R1 | create | docs/new.md | create it | docs/readme.md:1'));
    assert.match(checkExit(root, 'docs/plans/shipped.md', 2), ambiguity);
    checkExit(root, '--in-flight', 0);
    write(root, 'docs/plans/pins.md', planOf(`R1 | create | docs/first.md | create it | docs/readme.md:1
R2 | modify | test/package-content.test.mjs | pin the first document | docs/readme.md:1
R3 | create | docs/second.md | create it | docs/readme.md:1
R4 | modify | test/package-content.test.mjs | pin the second document | docs/readme.md:1`));
    assert.match(checkExit(root, '--in-flight', 2), ambiguity);
  });

  it('S12 a malformed size declaration exits 2 only where a rule reads it, on both arms', (t) => {
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, 'docs/plans/good.md', planWith());
    write(root, 'docs/ai/source-size.json', '{');
    checkExit(root, '--in-flight', 0);
    assert.match(checkExit(root, 'docs/plans/good.md', 2), /source-size/);
    write(root, 'docs/ai/epics/ALPHA.md', buildEpic('docs/readme.md'));
    write(root, 'docs/plans/mine.md', planWith({ goal: '- Spec: docs/ai/specs/example.md\nStory: S1 of ALPHA' }));
    assert.match(checkExit(root, '--in-flight', 2), /source-size/);
  });

  it('prints every refusal and reserves exit 2 for usage, an unreadable plan or an unreadable plans directory', async () => {
    await loadCli();
    const root = makeRepo();
    write(root, 'docs/plans/broken.md', planWith({ title: '# Plan: ', verification: 'plain prose' }));
    const refused = run(root, ['--check', 'docs/plans/broken.md']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /title/);
    assert.match(refused.stdout, /acceptance/);
    const usage = run(root, ['--unknown']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
    const missing = run(root, ['--check', 'docs/plans/missing.md']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /readable regular plan file/);
    const noPlans = makeTree('plan-shape-cli');
    assert.equal(run(noPlans, ['--check', '--in-flight']).status, 0);
    write(noPlans, 'docs/plans', 'a file where the directory should be\n');
    const unreadable = run(noPlans, ['--check', '--in-flight']);
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /docs\/plans could not be read \(ENOTDIR\)/);
  });

  it('refuses a plan the block model refuses as a listed finding, on both arms, even when the title is not its first line', async () => {
    await loadCli();
    const root = makeRepo();
    write(root, 'docs/plans/fence.md', `\n${planWith()}\n\`\`\`\nnever closed\n`);
    const explicit = run(root, ['--check', 'docs/plans/fence.md']);
    assert.equal(explicit.status, 1);
    assert.match(explicit.stdout, /block-model/);
    const inFlight = run(root, ['--check', '--in-flight']);
    assert.equal(inFlight.status, 1);
    assert.match(inFlight.stdout, /fence\.md.*block-model/);
    assert.match(inFlight.stdout, /judged plans: 1/);
  });

  it('S38 accepts its own draft, part and navigator in both plan spellings and keeps kind for a competing create (spec:plan-review-loop/S38)', (t) => {
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const slug = 'billing';
    const group = `${STORE}commerce`;
    const draft = `${group}/${slug}/index.md`;
    const partName = 'rates';
    const part = `${group}/${slug}/${partName}.md`;
    const navigator = `${group}/index.md`;
    write(root, draft, specDoc(slug, {
      scenario: '- S1 ok :: unbound',
      parts: [`- [${partName}](./${partName}.md)`],
    }).replace('status: live', 'status: draft'));
    write(root, part, `${FRONT('part', 150)}\n# Part: ${partName}\n\nRates.\n`);
    write(root, navigator, indexDoc('Commerce', [`- [${slug}](./${slug}/index.md)`]));
    const rows = [draft, part, navigator].map((path, index) =>
      `R${index + 1} | create | ${path} | write the contract document | docs/readme.md:1`);
    const planPath = 'docs/plans/billing.md';
    write(root, planPath, planOf(rows.join('\n')));

    const ownChecks = [planPath, `./${planPath}`].map((operand) => {
      const result = run(root, ['--check', operand]);
      assert.ifError(result.error);
      return result;
    });
    write(root, 'docs/plans/competing.md', planOf(rows[0]));
    const conflict = run(root, ['--check', planPath]);
    assert.ifError(conflict.error);
    assert.equal(conflict.status, 1, conflict.stderr || conflict.stdout);
    assert.match(conflict.stdout, /^docs\/plans\/billing\.md:\d+: R1: kind:/m);
    assert.deepEqual(ownChecks.map((result) => result.status), [0, 0],
      ownChecks.map((result) => result.stderr || result.stdout).join('\n'));
  });

  it('S38 counts plain in-flight plans and skips, and refuses a symlinked plans directory as usage', (t) => {
    const root = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, 'docs/plans/good.md', planWith());
    write(root, 'docs/plans/notes.md', '# Notes\n\nNot a plan.\n');
    const args = ['--check', '--in-flight'];
    const plain = run(root, args);
    assert.ifError(plain.error);
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    assert.match(plain.stdout, /^plan-shape: judged plans: 1$/m);
    assert.match(plain.stdout, /^plan-shape: skipped by shape: 1$/m);

    const plans = join(root, 'docs/plans');
    const target = join(root, 'saved-plans');
    renameSync(plans, target);
    try {
      symlinkSync(target, plans, 'dir');
    } catch (error) {
      if (!LINK_REFUSALS.includes(error.code)) throw error;
      t.diagnostic(`sandbox refused symlinkSync: ${error.code}: ${plans}`);
      return;
    }
    const linked = run(root, args);
    assert.ifError(linked.error);
    assert.equal(linked.status, 2, `symlinked docs/plans must be a usage error\n${linked.stderr || linked.stdout}`);
  });
});
