import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EPIC_SECTIONS } from './epic-shape.mjs';
import { checkPlan, parseLedger, verifyPlan } from './plan-shape.mjs';
import { codes, ledgerOf, makeTree as makeNamedTree, planWith, write, writeJson } from './plan-shape-harness.test.mjs';
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
    assert.equal(facts.pathFacts['src/file.mjs'].lines, 2);
    assert.equal(facts.pathFacts['src/new/deep.mjs'].contained, true);
    assert.equal(facts.pathFacts['escape/new.mjs'].contained, false);
    assert.equal(facts.pathFacts['../outside.mjs'].contained, false);
    assert.equal(facts.pathFacts['src/dangling.mjs'].contained, true);
    assert.equal(facts.pathFacts['src/out.mjs'].contained, false);
    assert.equal(facts.pathFacts['src/file.mjs'].shipped, 'unknown');
    assert.equal(facts.pathFacts['src/file.mjs'].pinSkip, 'package ownership is unknown');
  });

  it('derives declared scope, cap and recorded line ceilings from the source-size declaration', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'docs/ai/source-size.json', sourceSize({
      baseline: { 'src/large.mjs': { lines: 450, reason: 'recorded debt' } },
      aggregate: { src: { lines: 450, reason: 'recorded debt' } },
    }));
    write(root, 'src/large.mjs', 'source\n');
    write(root, 'src/generated/skip.mjs', 'generated\n');
    write(root, 'docs/readme.md', 'doc\n');
    const facts = buildFacts(root, { paths: ['src/large.mjs', 'src/generated/skip.mjs', 'docs/readme.md'] });
    assert.equal(facts.capDeclared, true);
    assert.equal(facts.cap, 400);
    assert.equal(facts.pathFacts['src/large.mjs'].inScope, true);
    assert.equal(facts.pathFacts['src/large.mjs'].recordedLines, 450);
    assert.equal(facts.pathFacts['src/generated/skip.mjs'].inScope, false);
    assert.equal(facts.pathFacts['docs/readme.md'].inScope, false);
  });

  it('counts every declared-extension path under the root "." when a schema-2 declaration names no roots', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'docs/ai/source-size.json', { schema: 2, exclude: ['src/gen'], extensions: ['.mjs'] });
    const paths = ['src/a.mjs', 'a.mjs', 'docs/readme.md', 'src/gen/b.mjs'];
    for (const path of paths) write(root, path, 'source\n');
    const facts = buildFacts(root, { paths });
    assert.deepEqual(paths.map((path) => facts.pathFacts[path].inScope), [true, true, false, false]);
    assert.deepEqual([facts.capDeclared, facts.cap], [true, 400]);
  });

  it('refuses a malformed declaration as usage instead of guessing the cap', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'docs/ai/source-size.json', { schema: 99 });
    assert.throws(() => buildFacts(root), (error) => error.exitCode === 2 && /source-size/.test(error.message));
    write(root, 'docs/ai/source-size.json', '{');
    assert.throws(() => buildFacts(root), (error) => error.exitCode === 2 && /not valid JSON/.test(error.message));
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
    const sweep = makePlanDocument('verify', 'R1 | modify | **/file.mjs | update (2 files) | n/a | src/file.mjs:1');
    assert.equal(judgePlan(root, sweep, { repo, rules: verifyPlan }).accepted, true);
    const authoring = makePlanDocument('check', 'R1 | create | src/new.mjs | add source | n/a | src/file.mjs:1',
      'R2 | modify | src/file.mjs | update source | n/a | file.mjs:1');
    const { result } = judgePlan(root, authoring, { repo, rules: checkPlan, plan: authoring.identity });
    assert.match(result.findings.map(({ code, message }) => `${code}: ${message}`).join('\n'), /^anchor: .*\b2 candidates\b.*$/);
  });

  it('spec:plan-review-loop/S39 defers reads, limits directory listings and repeats declaration failures', async (t) => {
    const { expandSweepPaths, judgePlan, openRepo, readPlansInFlight } = await loadFacts();
    const root = makeCleanTree(t);
    for (const path of ['closed/hidden.mjs', 'docs/x.md', 'src/a.mjs', 'src/sub/b.mjs']) write(root, path, 'one\n');
    write(root, 'docs/ai/source-size.json', '{');
    write(root, 'docs/plans/notes.md', '# Notes\n');
    const closed = join(root, 'closed'), mode = statSync(closed).mode;
    chmodSync(closed, 0);
    try {
      try { readdirSync(closed); return t.skip('mode 0 allows listing closed'); } catch (error) { assert.equal(error.code, 'EACCES'); }
      const repo = openRepo(root);
      const document = makePlanDocument('document', 'R1 | modify | docs/x.md | update | n/a | docs/x.md:1');
      const sweep = makePlanDocument('sweep', 'R1 | modify | src/**/*.mjs | update (2 files) | n/a | src/a.mjs:1');
      for (const plan of [document, sweep]) assert.equal(judgePlan(root, plan, { repo }).accepted, true);
      assert.deepEqual(expandSweepPaths(root, ['src/**/*.mjs']), { 'src/**/*.mjs': ['src/a.mjs', 'src/sub/b.mjs'] });
      for (const identity of [document.identity, 'docs/plans/another.md']) assert.throws(() => judgePlan(root, { ...document, identity }, { repo, rules: checkPlan, plan: identity }), { name: 'Error', exitCode: 2, message: /source-size/ });
      assert.deepEqual(readPlansInFlight(root).plans, []);
    } finally { chmodSync(closed, mode); }
  });
  it('reads an unreadable file only when a rule needs its row facts', async (t) => {
    const { judgePlan, openRepo } = await loadFacts();
    const root = makeCleanTree(t);
    for (const path of ['docs/x.md', 'docs/locked.md']) write(root, path, 'one\n');
    const locked = join(root, 'docs/locked.md'), mode = statSync(locked).mode;
    chmodSync(locked, 0);
    try {
      try { readFileSync(locked); return t.skip('mode 0 allows reading docs/locked.md'); } catch (error) { assert.equal(error.code, 'EACCES'); }
      const repo = openRepo(root);
      const document = makePlanDocument('locked', 'R1 | modify | docs/locked.md | update | n/a | docs/x.md:1');
      assert.equal(judgePlan(root, document, { repo }).accepted, true, 'structural rules accept a row on an unreadable regular file');
      for (const identity of [document.identity, 'docs/plans/another.md']) assert.deepEqual(codes(judgePlan(root, { ...document, identity }, { repo, rules: checkPlan, plan: identity }).result), ['facts']);
      const anchor = makePlanDocument('anchor', 'R1 | modify | docs/x.md | update | n/a | docs/locked.md:1');
      assert.equal(judgePlan(root, anchor, { repo, rules: checkPlan, plan: anchor.identity }).accepted, true);
    } finally { chmodSync(locked, mode); }
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
      const invalid = makePlanDocument('invalid', 'R1 | modify | closed/x.mjs | update | n/a | src/a.mjs:1',
        'R2 | modify | src/[a.mjs | update (1 files) | n/a | src/a.mjs:1');
      const { result } = judgePlan(root, invalid, { repo });
      assert.match(result.findings.map(({ code, message }) => `${code}: ${message}`).join('\n'), /^facts: .*unsupported glob.*$/);
      const fallback = makePlanDocument('fallback', 'R1 | modify | src/a.mjs | update | n/a | a.mjs:1');
      const sweep = makePlanDocument('sweep', 'R1 | modify | **/*.mjs | update (2 files) | n/a | src/a.mjs:1');
      const refusal = { name: 'Error', exitCode: 2, message: /closed/ };
      assert.throws(() => judgePlan(root, fallback, { repo, rules: checkPlan, plan: fallback.identity }), refusal);
      assert.throws(() => judgePlan(root, sweep, { repo }), refusal);
    } finally { chmodSync(closed, mode); }
  });

  it('spec:plan-review-loop/S37 exposes reader facts only with a plan identity', async (t) => {
    const { buildFacts } = await loadFacts();
    const root = makeCleanTree(t);
    const paths = ['area/index.md', 'area/draft/index.md', 'area/draft/rates.md', 'refused.md'].map((path) => STORE + path);
    const [index, draft, part, refused] = paths;
    write(root, index, indexDoc('Area', ['- [draft](./draft/index.md)']));
    write(root, draft, specDoc('draft', { parts: ['- [rates](./rates.md)'] }).replace('status: live', 'status: draft'));
    write(root, part, `${FRONT('part', 150)}\n# Part: rates\n\nRates.\n`);
    write(root, refused, specDoc('refused', { module: '- ../escape.mjs' }));
    const baseline = buildFacts(root, { paths });
    assert.ok(Object.values(baseline.pathFacts).every((fact) => !Object.hasOwn(fact, 'contract')));
    assert.equal(Object.hasOwn(baseline, 'otherPlanCreates'), false);
    const { pathFacts } = buildFacts(root, { paths, plan: 'docs/plans/current.md' });
    const contract = pathFacts[draft].contract;
    assert.deepEqual([contract?.kind, contract?.status, contract?.parts], ['spec', 'draft', [part]], 'check facts carry the draft spec reader verdict');
    assert.deepEqual([pathFacts[index].contract?.kind, pathFacts[index].contract?.children], ['index', [draft]]);
    assert.equal(pathFacts[part].contract?.kind, 'part');
    assert.equal(pathFacts[refused].contract?.refused, true);
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
      const create = `R1 | create | ${path} | add a spec | 100 | ${path}:1`;
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
