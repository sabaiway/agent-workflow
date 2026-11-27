import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';
import { EPIC_SECTIONS } from './epic-shape.mjs';
import { checkPlan, checkPlanStructure, parseLedger, verifyPlan } from './plan-shape.mjs';
import { stripGitLocationEnv } from './git-env.mjs';
import { canonicalFlowDigest } from './flow-record-identity.mjs';
import { codes, ledgerOf, makeTree as makeNamedTree, planWith, UNREADABLE_PLAN_BYTES, write, writeJson } from './plan-shape-harness.test.mjs';
import { FRONT, indexDoc, specDoc, STORE } from './spec-check-harness.test.mjs';

const loadFacts = () => import('./plan-shape-facts.mjs');
const makePlanDocument = (name, ...rows) => {
  const text = planWith({ ledger: ledgerOf(rows.join('\n')) });
  return { identity: `docs/plans/${name}.md`, text, rows: parseLedger(text).rows.filter((row) => row.valid) };
};
const makeTree = () => makeNamedTree('plan-shape-facts');
const makeCleanTree = (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const trySymlink = (t, target, path) => {
  try { symlinkSync(target, path); } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic(`sandbox refused symlinkSync: ${error.code}: ${path}`);
    return false;
  }
  return true;
};
const sourceSize = (extra = {}) => ({
  _README: 'test declaration',
  schema: 1,
  defaults: { maxLines: 400, maxLineBytes: 1000 },
  roots: ['src'],
  exclude: ['src/generated'],
  extensions: ['.mjs'],
  ...extra,
});
const makeEpicText = () => {
  const bodies = ['Keep boundaries visible.', 'Keep work separate.', 'No implementation choices.', 'The boundary is observable.',
    'docs/ai/specs/kit/example.md', '- S1 | Boundary | depends-on: none | owns: src/x.mjs | shared: none | state: planned', 'Row ALPHA in Now'];
  return ['---', 'type: epic', 'lastUpdated: 2026-09-10', 'scope: permanent', 'staleAfter: 90d', 'owner: none',
    'maxLines: 60', 'state: open', '---', '# Epic: Boundary', ...EPIC_SECTIONS.flatMap((heading, index) => [heading, bodies[index]])].join('\n');
};

it('spec:plan-shape-ownership/S12 reads other plans without recursion and holds only current digests', async (t) => {
  const { buildFacts, judgePlan, readPlanDocument } = await loadFacts();
  const { digestPlan, composeEntry, readApprovalFacts, APPROVAL_RECORD_BASENAME } = await import('./plan-approval/index.mjs');
  assert.equal(typeof readApprovalFacts, 'function');
  const root = makeCleanTree(t);
  const current = 'docs/plans/current.md';
  const other = 'docs/plans/other.md';
  const renamed = 'docs/plans/renamed.md';
  const draft = 'docs/plans/draft.md';
  const story = { epic: 'ALPHA', id: 'S1' };
  const env = stripGitLocationEnv(process.env);
  delete env.AW_REVIEW_RECEIPTS;
  const approvalFacts = { digestPlan, heldDigests: new Set() };
  assert.equal(Object.hasOwn(buildFacts(root, { plan: current, approvalFacts }), 'otherPlans'), true);
  assert.deepEqual(buildFacts(root, { plan: current, approvalFacts }).otherPlans, []);
  write(root, 'docs/ai/epics/ALPHA.md', makeEpicText());
  for (const path of ['src/x.mjs', 'src/y.mjs', 'src/z.mjs', 'docs/readme.md']) write(root, path, 'content\n');
  const text = planWith({ goal: 'Spec: not adopted.\nStory: S1 of ALPHA',
    ledger: 'R1 | modify | src/[xy].mjs | update (2 files) | src/x.mjs:1\namendments:\nA1 | modify | src/z.mjs | update | src/x.mjs:1' });
  write(root, other, text);
  write(root, current, planWith());
  write(root, draft, planWith({ goal: 'Spec: not adopted. Another draft.' }));
  write(root, 'docs/plans/broken.md', planWith({ verification: 'plain prose' }));
  const document = readPlanDocument(root, current);
  const verdict = judgePlan(root, readPlanDocument(root, other));
  assert.equal(verdict.accepted, true, JSON.stringify(verdict.result.findings));
  assert.deepEqual(verdict.story, buildFacts(root).stories[0]);
  assert.equal(judgePlan(root, document).story, null);
  const digest = digestPlan(text, verdict);
  const draftVerdict = judgePlan(root, readPlanDocument(root, draft));
  const draftDigest = digestPlan(draftVerdict.text, draftVerdict);
  approvalFacts.heldDigests.add(digest);
  const expected = { identity: other, digest, held: true, story, paths: ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'] };
  const expectedDraft = { identity: draft, digest: draftDigest, held: false, story: null, paths: ['docs/readme.md'] };
  const readOthers = (facts = approvalFacts) => [...buildFacts(root, { plan: current, approvalFacts: facts }).otherPlans]
    .map((plan) => ({ ...plan, paths: [...plan.paths].sort() })).sort((left, right) => left.identity.localeCompare(right.identity));
  assert.deepEqual(readOthers(), [expectedDraft, expected]);
  for (const options of [{}, { plan: current }, { approvalFacts }, { plan: current, approvalFacts }]) {
    const named = Object.hasOwn(options, 'plan') && Object.hasOwn(options, 'approvalFacts');
    assert.equal(Object.hasOwn(buildFacts(root, options), 'otherPlans'), named);
    const rules = (body, facts) => {
      assert.equal(Object.hasOwn(facts, 'otherPlans'), named);
      return checkPlanStructure(body, facts);
    };
    assert.equal(judgePlan(root, document, { ...options, rules }).accepted, true);
  }
  renameSync(join(root, other), join(root, renamed));
  assert.deepEqual(readOthers(), [expectedDraft, { ...expected, identity: renamed }]);
  write(root, other, text.replace('update (2 files)', 'revise (2 files)'));
  const reused = readOthers().find(({ identity }) => identity === other);
  assert.equal(reused.held, false);
  assert.notEqual(reused.digest, digest);
  write(root, 'docs/plans/copy.md', document.text);
  assert.ok(!readOthers().some(({ identity }) => identity.endsWith('/copy.md')));
  if (trySymlink(t, join(root, renamed), join(root, 'docs/plans/linked.md'))) {
    assert.ok(!readOthers().some(({ identity }) => identity.endsWith('/linked.md')));
  }
  const outside = 'docs/outside.md';
  const listOthers = (plan) => buildFacts(root, { plan, approvalFacts }).otherPlans.map(({ identity }) => identity);
  assert.ok(listOthers(outside).includes(current));
  write(root, outside, document.text);
  assert.ok(!listOthers(outside).some((identity) => identity === current || identity.endsWith('/copy.md')));
  rmSync(join(root, outside));
  mkdirSync(join(root, outside));
  assert.throws(() => listOthers(outside), (error) => error.message.includes(outside));
  rmSync(join(root, outside), { recursive: true });
  assert.deepEqual(readApprovalFacts({ cwd: root, env }).heldDigests, new Set());
  const receipt = join(root, 'receipts', 'review.jsonl');
  const record = join(root, 'receipts', APPROVAL_RECORD_BASENAME);
  const entries = [digest, draftDigest].map((planDigest, index) => composeEntry({
    plan: index === 0 ? other : draft, date: '2026-09-10', planDigest, contractsDigest: canonicalFlowDigest([]),
    contracts: [], essence: 'Approved scope.', from: index === 0 ? 'approval' : 'provision',
  }));
  const recordText = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  makeFixtureRepo((args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }, root);
  write(root, '.git/' + APPROVAL_RECORD_BASENAME, JSON.stringify(entries[0]) + '\n');
  assert.deepEqual(readApprovalFacts({ cwd: root, env }).heldDigests, new Set([digest]));
  write(root, 'receipts/' + APPROVAL_RECORD_BASENAME, recordText);
  const override = { ...env, AW_REVIEW_RECEIPTS: receipt };
  const recorded = readApprovalFacts({ cwd: root, env: override });
  assert.equal(recorded.digestPlan, digestPlan);
  assert.deepEqual(recorded.heldDigests, new Set([digest, draftDigest]));
  assert.equal(readOthers(recorded).find(({ identity }) => identity === draft).held, true);
  rmSync(record);
  mkdirSync(record);
  assert.throws(() => readApprovalFacts({ cwd: root, env: override }), (error) => error instanceof Error && error.message.includes(record));
  const plans = join(root, 'docs/plans');
  const saved = join(root, 'saved-plans');
  renameSync(plans, saved);
  assert.deepEqual(readOthers(), []);
  if (trySymlink(t, saved, plans)) {
    assert.throws(readOthers, { exitCode: 2, message: /docs\/plans/ });
    rmSync(plans);
  }
  renameSync(saved, plans);
  const mode = statSync(plans).mode;
  chmodSync(plans, 0);
  try {
    const unreadable = (() => {
      try { readdirSync(plans); return false; } catch (error) { assert.equal(error.code, 'EACCES'); return true; }
    })();
    if (unreadable) assert.throws(readOthers, { exitCode: 2, message: /docs\/plans/ });
    else t.diagnostic('mode 0 allows listing docs/plans; unreadable-directory case unavailable');
  } finally { chmodSync(plans, mode); }
  const locked = join(root, renamed);
  const lockedMode = statSync(locked).mode;
  chmodSync(locked, 0);
  try {
    const unreadable = (() => {
      try { readFileSync(locked); return false; } catch (error) { assert.equal(error.code, 'EACCES'); return true; }
    })();
    if (unreadable) assert.throws(readOthers, { exitCode: 2, message: /renamed\.md/ });
    else t.diagnostic('mode 0 allows reading renamed.md; unreadable-plan case unavailable');
  } finally { chmodSync(locked, lockedMode); }
  write(root, renamed, UNREADABLE_PLAN_BYTES);
  assert.throws(readOthers, { exitCode: 2, message: /renamed\.md/ });
});

describe('plan-shape facts — filesystem-only evidence', () => {
  it('spec:plan-shape-ownership/S10 snapshots open stories, names landed epics and carries store refusals', async (t) => {
    const { buildFacts, openRepo } = await loadFacts();
    const roots = [makeTree(), makeTree(), makeTree()];
    t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
    const [root, absent, linked] = roots;
    const empty = buildFacts(absent);
    assert.deepEqual([empty.stories, empty.landedEpics, empty.storeRefusal], [[], [], null]);
    write(root, 'docs/ai/epics/ALPHA.md', makeEpicText());
    write(root, 'docs/ai/epics/OLD.md', '---\ntype: epic\nstate: landed\n---\nAny body.');
    const repo = openRepo(root);
    const facts = buildFacts(root, { repo });
    assert.deepEqual(facts.stories.map(({ path, id, state, claims, reachable }) => ({ path, id, state, claims, reachable })), [
      { path: 'docs/ai/epics/ALPHA.md', id: 'S1', state: 'planned', reachable: new Set(), claims: [
        { field: 'owns', path: 'src/x.mjs', ground: ['src/x.mjs', 'src/x.test.mjs', 'src/x.test/'] },
      ] },
    ]);
    assert.ok(facts.stories[0].line > 0);
    assert.deepEqual(facts.landedEpics, ['OLD']);
    assert.equal(facts.storeRefusal, null);
    write(root, 'docs/ai/epics/ALPHA.md', makeEpicText().replace('- S1 |', '* S1 |'));
    assert.equal(buildFacts(root, { repo }).stories, facts.stories);
    assert.equal(buildFacts(root, { repo }).landedEpics, facts.landedEpics);
    const refused = buildFacts(root);
    assert.match(refused.storeRefusal, /docs\/ai\/epics\/ALPHA\.md/);
    assert.deepEqual([refused.stories, refused.landedEpics], [[], []]);
    mkdirSync(join(linked, 'docs/ai'), { recursive: true });
    symlinkSync(join(root, 'docs/ai/epics'), join(linked, 'docs/ai/epics'));
    const symlinked = buildFacts(linked);
    assert.match(symlinked.storeRefusal, /docs\/ai\/epics.*symlink/);
    assert.deepEqual([symlinked.stories, symlinked.landedEpics], [[], []]);
  });

  it('classifies leaves without following them and contains absent leaves through their real parent', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    const outside = makeTree();
    write(root, 'src/file.mjs', 'one\ntwo\n');
    mkdirSync(join(root, 'src/dir'), { recursive: true });
    symlinkSync(join(root, 'src/file.mjs'), join(root, 'src/link.mjs'));
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, 'src/absent.mjs'), join(root, 'src/dangling.mjs'));
    write(outside, 'target.mjs', 'outside\n');
    symlinkSync(join(outside, 'target.mjs'), join(root, 'src/out.mjs'));
    const paths = ['src/file.mjs', 'src/dir', 'src/link.mjs', 'src/new/deep.mjs', 'escape/new.mjs', '../outside.mjs', 'src/dangling.mjs', 'src/out.mjs'];
    const facts = buildFacts(root, { paths });
    assert.ok(facts.robustClasses.includes('git-location'), 'the kit-anchored shipped list supplies the class ids');
    assert.deepEqual(paths.map((path) => facts.pathFacts[path].kind), ['regular', 'other', 'other', 'absent', 'absent', 'absent', 'other', 'other']);
    assert.equal(Object.hasOwn(facts.pathFacts['src/file.mjs'], 'lines'), false);
    assert.equal(facts.pathFacts['src/new/deep.mjs'].contained, true);
    assert.equal(facts.pathFacts['escape/new.mjs'].contained, false);
    assert.equal(facts.pathFacts['../outside.mjs'].contained, false);
    assert.equal(facts.pathFacts['src/dangling.mjs'].contained, true);
    assert.equal(facts.pathFacts['src/out.mjs'].contained, false);
    assert.equal(facts.pathFacts['src/file.mjs'].shipped, 'unknown');
    assert.equal(facts.pathFacts['src/file.mjs'].pinSkip, 'package ownership is unknown');
  });

  it('derives source scope from the declaration without exporting the cap or recorded line ceilings', async (t) => {
    const { buildFacts } = await loadFacts();
    const root = makeCleanTree(t);
    writeJson(root, 'docs/ai/source-size.json', sourceSize({
      baseline: { 'src/large.mjs': { lines: 450, reason: 'recorded debt' } },
      aggregate: { src: { lines: 450, reason: 'recorded debt' } },
    }));
    const paths = ['src/large.mjs', 'src/generated/skip.mjs', 'docs/readme.md'];
    for (const path of paths) write(root, path, 'content\n');
    const facts = buildFacts(root, { paths });
    assert.deepEqual(paths.map((path) => facts.pathFacts[path].inScope), [true, false, false]);
    assert.deepEqual(['capDeclared', 'cap'].filter((field) => Object.hasOwn(facts, field)), []);
    assert.deepEqual(['recordedLines', 'lines'].filter((field) => Object.hasOwn(facts.pathFacts[paths[0]], field)), []);
  });

  it('classifies scope from root "." for schema 2 without reporting its default cap', async (t) => {
    const { buildFacts } = await loadFacts();
    const root = makeCleanTree(t);
    writeJson(root, 'docs/ai/source-size.json', { schema: 2, exclude: ['src/gen'], extensions: ['.mjs'] });
    const paths = ['src/a.mjs', 'a.mjs', 'docs/readme.md', 'src/gen/b.mjs'];
    for (const path of paths) write(root, path, 'source\n');
    const facts = buildFacts(root, { paths });
    assert.deepEqual(paths.map((path) => facts.pathFacts[path].inScope), [true, true, false, false]);
    assert.deepEqual(['capDeclared', 'cap'].filter((field) => Object.hasOwn(facts, field)), []);
  });

  it('takes repository reads at their first use and reuses them on the same handle', async () => {
    const { buildFacts, openRepo } = await loadFacts();
    const root = makeTree();
    write(root, 'src/a.mjs', 'a\n');
    const repo = openRepo(root);
    write(root, 'src/late.mjs', 'late\n');
    const facts = buildFacts(root, { paths: ['src/late.mjs'], repo });
    assert.deepEqual(facts.repoFiles, ['src/a.mjs', 'src/late.mjs']);
    assert.deepEqual(facts.candidates('late.mjs', []), ['src/late.mjs']);
    write(root, 'src/later.mjs', 'later\n');
    const reused = buildFacts(root, { paths: ['src/later.mjs'], repo });
    assert.deepEqual(reused.repoFiles, ['src/a.mjs', 'src/late.mjs']);
    assert.deepEqual(reused.candidates('later.mjs', []), []);
    assert.equal(reused.pathFacts['src/later.mjs'].kind, 'regular');
  });

  it('refuses as usage a glob it cannot compile and a path the filesystem cannot inspect', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    write(root, 'src/a.mjs', 'source\n');
    assert.throws(() => buildFacts(root, { paths: ['src/[a.mjs'] }), (error) => error.exitCode === 2 && /unsupported glob/.test(error.message));
    assert.throws(() => buildFacts(root, { paths: [`src/${'x'.repeat(300)}.mjs`] }), (error) => error.exitCode === 2 && /cannot inspect/.test(error.message));
  });

  it('uses the nearest package owner and resolves private, nested, later-win and unknown shipping states', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'package.json', { files: ['src/', '!src/private/**', 'src/private/included.mjs'] });
    write(root, 'test/package-content.test.mjs', 'pin\n');
    write(root, 'src/public.mjs', 'public\n');
    write(root, 'src/private/hidden.mjs', 'hidden\n');
    write(root, 'src/private/included.mjs', 'included\n');
    writeJson(root, 'src/nested/package.json', { private: true, files: ['*.mjs'] });
    write(root, 'src/nested/private.mjs', 'private\n');
    writeJson(root, 'unknown/package.json', { files: ['src/', '+(src)/**'] });
    write(root, 'unknown/src/file.mjs', 'unknown\n');
    writeJson(root, 'all/package.json', {});
    write(root, 'all/file.mjs', 'all\n');
    writeJson(root, 'dot/package.json', { files: ['.'] });
    write(root, 'dot/deep/file.mjs', 'dot\n');
    writeJson(root, 'negated/package.json', { files: ['src/[!a]*.mjs'] });
    write(root, 'negated/src/b.mjs', 'negated\n');
    const paths = ['src/public.mjs', 'src/private/hidden.mjs', 'src/private/included.mjs', 'src/nested/private.mjs', 'unknown/src/file.mjs', 'all/file.mjs', 'dot/deep/file.mjs', 'negated/src/b.mjs'];
    const facts = buildFacts(root, { paths });
    assert.deepEqual(paths.map((path) => facts.pathFacts[path].shipped), [true, false, true, false, 'unknown', true, true, 'unknown']);
    assert.equal(facts.pathFacts['src/public.mjs'].pinTest, 'test/package-content.test.mjs');
    assert.match(facts.pathFacts['src/nested/private.mjs'].pinSkip, /private package/);
    assert.match(facts.pathFacts['unknown/src/file.mjs'].pinSkip, /unknown/);
  });

  it('binds a pin per package root, and refuses two pins under ONE root naming both', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'package.json', { files: ['src/'] });
    write(root, 'test/package-content.test.mjs', 'one\n');
    write(root, 'src/file.mjs', 'source\n');
    writeJson(root, 'packages/a/package.json', {});
    write(root, 'packages/a/test/package-content.test.mjs', 'nested\n');
    write(root, 'packages/a/src/file.mjs', 'nested source\n');
    const nested = buildFacts(root, { paths: ['src/file.mjs', 'packages/a/src/file.mjs'] });
    assert.equal(nested.pathFacts['src/file.mjs'].pinTest, 'test/package-content.test.mjs');
    assert.equal(nested.pathFacts['packages/a/src/file.mjs'].pinTest, 'packages/a/test/package-content.test.mjs');
    write(root, 'other/package-content.test.mjs', 'two\n');
    assert.throws(
      () => buildFacts(root, { paths: ['src/file.mjs'] }),
      (error) => error.exitCode === 2 && /test\/package-content\.test\.mjs/.test(error.message) && /other\/package-content\.test\.mjs/.test(error.message),
    );
  });

  it('expands supported globs and chooses exact, prior-row, then repository suffix candidates', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    for (const path of ['src/a.mjs', 'src/b.js', 'nested/src/a.mjs', 'nested/data.mjs']) write(root, path, `${path}\n`);
    const patterns = ['src/*.{mjs,js}', 'nested/?ata.mjs', 'src/**/*.mjs'];
    const facts = buildFacts(root, { paths: patterns });
    assert.deepEqual(facts.expansions[patterns[0]], ['src/a.mjs', 'src/b.js']);
    assert.deepEqual(facts.expansions[patterns[1]], ['nested/data.mjs']);
    assert.deepEqual(facts.expansions[patterns[2]], ['src/a.mjs']);
    assert.deepEqual(facts.candidates('src/a.mjs', ['other/src/a.mjs']), ['src/a.mjs']);
    assert.deepEqual(facts.candidates('a.mjs', ['nested/src/a.mjs']), ['nested/src/a.mjs']);
    assert.deepEqual(facts.candidates('a.mjs', []), ['nested/src/a.mjs', 'src/a.mjs']);
  });

  it('spec:plan-review-loop/S35 the repository walk never enters a NEVER_WALKED directory, at the top or nested', async (t) => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeJson(root, 'package.json', { files: ['src/'] });
    write(root, 'src/file.mjs', 'live\n');
    write(root, '.agent-workflow-notes/file.mjs', 'near name\n');
    const plant = (dir) => {
      write(root, `${dir}/file.mjs`, 'copy\n');
      write(root, `${dir}/test/package-content.test.mjs`, 'pin\n');
    };
    const walked = ['.agent-workflow-notes/file.mjs', 'src/file.mjs'];
    const judge = (label) => {
      const facts = buildFacts(root, { paths: ['src/file.mjs', '**/file.mjs'] });
      assert.deepEqual([...facts.candidates('file.mjs', [])].sort(), walked, `no anchor candidate under ${label}`);
      assert.deepEqual([...facts.expansions['**/file.mjs']].sort(), walked, `no sweep expansion under ${label}`);
      assert.equal(facts.pathFacts['src/file.mjs'].pinTest, null, `no pin under ${label}`);
    };
    plant('.agent-workflow/kept-aside/0123456789abcdef');
    judge('.agent-workflow');
    const { NEVER_WALKED } = await import('./repo-lex.mjs');
    for (const name of NEVER_WALKED) {
      plant(name);
      plant(`pkg/${name}`);
    }
    judge(NEVER_WALKED.join(', '));
    const { judgePlan, openRepo } = await loadFacts();
    const linked = trySymlink(t, join(root, 'src'), join(root, 'linked'));
    const facts = buildFacts(root);
    for (const name of NEVER_WALKED) assert.deepEqual(facts.candidates(`pkg/${name}/file.mjs`, []), [], name);
    if (linked) assert.deepEqual(facts.candidates('linked/file.mjs', []), []);
    const repo = openRepo(root);
    const sweep = makePlanDocument('verify', 'R1 | modify | **/file.mjs | update (2 files) | src/file.mjs:1');
    assert.equal(judgePlan(root, sweep, { repo, rules: verifyPlan }).accepted, true);
    const authoring = makePlanDocument('check', 'R1 | create | src/new.mjs | add source | src/file.mjs:1',
      'R2 | modify | src/file.mjs | update source | file.mjs:1');
    const { result } = judgePlan(root, authoring, { repo, rules: checkPlan, plan: authoring.identity });
    assert.match(result.findings.map(({ code, message }) => `${code}: ${message}`).join('\n'), /^anchor: .*\b2 candidates\b.*$/);
  });

  it('spec:plan-review-loop/S39 defers reads, limits listings and reads the declaration only on demand', async (t) => {
    const { buildFacts, expandSweepPaths, judgePlan, openRepo, readPlansInFlight } = await loadFacts();
    const root = makeCleanTree(t);
    for (const path of ['closed/hidden.mjs', 'docs/x.md', 'docs/locked.md', 'src/a.mjs', 'src/sub/b.mjs']) write(root, path, 'one\n');
    write(root, 'docs/ai/source-size.json', '{');
    write(root, 'docs/plans/notes.md', '# Notes\n');
    const closed = join(root, 'closed'), mode = statSync(closed).mode;
    chmodSync(closed, 0);
    try {
      try { readdirSync(closed); return t.skip('mode 0 allows listing closed'); } catch (error) { assert.equal(error.code, 'EACCES'); }
      const repo = openRepo(root);
      const document = makePlanDocument('document', 'R1 | modify | docs/x.md | update | docs/x.md:1');
      const sweep = makePlanDocument('sweep', 'R1 | modify | src/**/*.mjs | update (2 files) | src/a.mjs:1');
      for (const plan of [document, sweep]) assert.equal(judgePlan(root, plan, { repo }).accepted, true);
      assert.deepEqual(expandSweepPaths(root, ['src/**/*.mjs']), { 'src/**/*.mjs': ['src/a.mjs', 'src/sub/b.mjs'] });
      const create = makePlanDocument('create', 'R1 | create | src/new.test.mjs | add a test | src/a.mjs:1');
      for (const identity of [create.identity, 'docs/plans/another.md']) assert.throws(() => judgePlan(root, { ...create, identity }, { repo, rules: checkPlan, plan: identity }), { name: 'Error', exitCode: 2, message: /source-size/ });
      assert.deepEqual(readPlansInFlight(root).plans, []);
    } finally { chmodSync(closed, mode); }
    const locked = join(root, 'docs/locked.md');
    chmodSync(locked, 0);
    try { readFileSync(locked); return t.skip('mode 0 allows reading docs/locked.md'); } catch (error) { assert.equal(error.code, 'EACCES'); }
    const document = makePlanDocument('locked', 'R1 | modify | docs/locked.md | update | docs/x.md:1');
    const repo = openRepo(root);
    assert.equal(judgePlan(root, document, { repo }).accepted, true);
    for (const [rules, identity] of [[checkPlan, document.identity], [verifyPlan, 'docs/plans/another.md']]) {
      const { result } = judgePlan(root, { ...document, identity }, { repo, rules, ...(rules === checkPlan ? { plan: identity } : {}) });
      assert.deepEqual(codes(result), ['facts']);
      assert.match(result.findings[0].message, /docs\/locked\.md/);
    }
    writeJson(root, 'docs/ai/source-size.json', sourceSize());
    const anchor = makePlanDocument('anchor', 'R1 | modify | docs/x.md | update | docs/locked.md:1');
    assert.equal(judgePlan(root, anchor, { rules: checkPlan, plan: anchor.identity }).accepted, true);
    for (const [body, cause] of [['{"schema":99}', /source-size/], ['{', /not valid JSON/]]) {
      write(root, 'docs/ai/source-size.json', body);
      const repo = openRepo(root);
      const facts = buildFacts(root, { repo });
      assert.deepEqual(facts.pathFacts, {});
      assert.ok(facts.repoFiles.includes('docs/x.md'));
      assert.throws(() => buildFacts(root, { paths: ['src/a.mjs'], repo }), { name: 'Error', exitCode: 2, message: cause });
    }
  });
  it('bounds sweep listings, compiles globs first and reports root listing failures', async (t) => {
    const { expandSweepPaths, judgePlan, openRepo } = await loadFacts();
    const root = makeCleanTree(t);
    for (const path of ['src/a.mjs', 'src/sub/b.mjs', 'node_modules/c.mjs', 'closed/x.mjs']) write(root, path, 'one\n');
    const linked = trySymlink(t, join(root, 'src'), join(root, 'linked'));
    const segment = 'x'.repeat(300);
    assert.throws(() => expandSweepPaths(root, [`src/${segment}/*.mjs`]), { name: 'Error', exitCode: 2, message: new RegExp(segment) });
    const closed = join(root, 'closed'), mode = statSync(closed).mode;
    chmodSync(closed, 0);
    try {
      try { readdirSync(closed); return t.skip('mode 0 allows listing closed'); } catch (error) { assert.equal(error.code, 'EACCES'); }
      for (const pattern of ['absent/*.mjs', 'node_modules/*.mjs', './src/*.mjs', ...(linked ? ['linked/*.mjs'] : [])]) assert.deepEqual(expandSweepPaths(root, [pattern]), { [pattern]: [] });
      const repo = openRepo(root);
      const invalid = makePlanDocument('invalid', 'R1 | modify | closed/x.mjs | update | src/a.mjs:1',
        'R2 | modify | src/[a.mjs | update (1 files) | src/a.mjs:1');
      const { result } = judgePlan(root, invalid, { repo });
      assert.match(result.findings.map(({ code, message }) => `${code}: ${message}`).join('\n'), /^facts: .*unsupported glob.*$/);
      const fallback = makePlanDocument('fallback', 'R1 | modify | src/a.mjs | update | a.mjs:1');
      const sweep = makePlanDocument('sweep', 'R1 | modify | **/*.mjs | update (2 files) | src/a.mjs:1');
      const refusal = { name: 'Error', exitCode: 2, message: /closed/ };
      assert.throws(() => judgePlan(root, fallback, { repo, rules: checkPlan, plan: fallback.identity }), refusal);
      assert.throws(() => judgePlan(root, sweep, { repo }), refusal);
    } finally { chmodSync(closed, mode); }
  });

  it('spec:plan-review-loop/S37 exposes reader facts only with a plan identity and drops the size fields', async (t) => {
    const { buildFacts, readPlansInFlight } = await loadFacts();
    const root = makeCleanTree(t);
    const paths = ['area/index.md', 'area/draft/index.md', 'area/draft/rates.md', 'refused.md'].map((path) => STORE + path);
    const [index, draft, part, refused] = paths;
    write(root, index, indexDoc('Area', ['- [draft](./draft/index.md)']));
    write(root, draft, specDoc('draft', { parts: ['- [rates](./rates.md)'] }).replace('status: live', 'status: draft'));
    write(root, part, [FRONT('part', 150), '# Part: rates', '', 'Rates.', ''].join('\n'));
    write(root, refused, specDoc('refused', { module: '- ../escape.mjs' }));
    const [plan, other] = ['docs/plans/current.md', 'docs/plans/other.md'];
    for (const [identity, path] of [[plan, draft], [other, part]]) {
      write(root, identity, planWith({ ledger: ledgerOf('R1 | create | ' + path + ' | add document | ' + index + ':1') }));
    }
    const baseline = buildFacts(root, { paths });
    const { pathFacts, otherPlanCreates } = buildFacts(root, { paths, plan });
    assert.deepEqual(pathFacts[draft].contract, { kind: 'spec', status: 'draft', parts: [part], children: [], refused: false });
    assert.deepEqual([pathFacts[index].contract?.kind, pathFacts[index].contract?.children], ['index', [draft]]);
    assert.equal(pathFacts[part].contract?.kind, 'part');
    assert.equal(pathFacts[refused].contract?.refused, true);
    const flight = readPlansInFlight(root).plans.find(({ identity }) => identity === other);
    assert.deepEqual([flight.accepted, otherPlanCreates], [true, [part]]);
    assert.deepEqual(flight.rows.map(({ verb, path }) => [verb, path]), [['create', part]]);
    assert.deepEqual(Object.keys(baseline).sort(), ['candidates', 'expansions', 'landedEpics', 'pathFacts', 'repoFiles', 'robustClasses', 'storeRefusal', 'stories']);
    const pathKeys = ['contained', 'inScope', 'kind', 'pinSkip', 'pinTest', 'shipped'];
    assert.deepEqual(Object.values(baseline.pathFacts).map((fact) => Object.keys(fact).sort()), paths.map(() => pathKeys));
  });
  it('gives a symlinked draft no contract and refuses a symlinked plans directory', async (t) => {
    const { buildFacts, readPlansInFlight } = await loadFacts();
    const root = makeCleanTree(t);
    const draft = `${STORE}draft.md`;
    const link = `${STORE}linked.md`;
    write(root, draft, specDoc('draft').replace('status: live', 'status: draft'));
    if (!trySymlink(t, join(root, draft), join(root, link))) return;
    const { pathFacts } = buildFacts(root, { paths: [draft, link], plan: 'docs/plans/current.md' });
    assert.equal(pathFacts[link].kind, 'other');
    assert.equal(Object.hasOwn(pathFacts[link], 'contract'), false);
    assert.equal(pathFacts[draft].contract?.status, 'draft', 'check facts read the same draft through the regular path');
    if (!trySymlink(t, join(root, STORE), join(root, 'docs/plans'))) return;
    assert.throws(() => readPlansInFlight(root), (error) => error instanceof Error && error.exitCode === 2);
  });

  it('reads in-flight plans when present and collects creates from accepted other plans', async (t) => {
    const { buildFacts, readPlansInFlight } = await loadFacts();
    const root = makeCleanTree(t);
    mkdirSync(join(root, 'docs'));
    const plans = ['current', 'other', 'refused'].map((name) => ({
      identity: `docs/plans/${name}.md`, accepted: name !== 'refused', rows: [{ verb: 'create', path: `${STORE}${name}.md` }],
    }));
    assert.deepEqual(readPlansInFlight(root).plans, []);
    for (const { identity, accepted, rows: [{ path }] } of plans) {
      const create = `R1 | create | ${path} | add a spec | ${path}:1`;
      write(root, identity, planWith({ ledger: ledgerOf(accepted ? create : `${create}\nR2 | invalid row`) }));
    }
    const facts = buildFacts(root, { plan: plans[0].identity });
    assert.deepEqual(facts.otherPlanCreates, [plans[1].rows[0].path], 'only accepted other plans contribute store creates');
    assert.deepEqual(readPlansInFlight(root).plans.map(({ identity, accepted, rows }) => ({
      identity, accepted, rows: rows.map(({ verb, path }) => ({ verb, path })),
    })), plans);
  });

  it('refuses an absent, symlinked, unreadable or malformed shipped robustness list as usage', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    const listRoot = makeTree();
    const valid = JSON.stringify({ schema: 1, version: 1, classes: [{
      id: 'sample', prove: 'Prove it.', members: [{ literal: 'x', kind: 'state', note: 'Measured.', source: 'src/x.mjs' }],
    }] });
    write(listRoot, 'target.json', valid);
    symlinkSync(join(listRoot, 'target.json'), join(listRoot, 'link.json'));
    write(listRoot, 'malformed.json', '{');
    const cases = [
      ['absent', join(listRoot, 'absent.json'), {}],
      ['symlink', join(listRoot, 'link.json'), {}],
      ['unreadable', join(listRoot, 'target.json'), { io: { open: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } }],
      ['malformed', join(listRoot, 'malformed.json'), {}],
    ];
    for (const [label, path, extra] of cases) {
      const robustnessDeps = { resolvePath: () => path, ...extra };
      assert.throws(() => buildFacts(root, { robustnessDeps }), (error) => error.exitCode === 2 && /robustness-literals/.test(error.message), label);
    }
  });
});
