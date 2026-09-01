import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeTree as makeNamedTree, write, writeJson } from './plan-shape-harness.test.mjs';

const loadFacts = () => import('./plan-shape-facts.mjs');
const makeTree = () => makeNamedTree('plan-shape-facts');
const sourceSize = (extra = {}) => ({
  _README: 'test declaration',
  schema: 1,
  defaults: { maxLines: 400, maxLineBytes: 1000 },
  roots: ['src'],
  exclude: ['src/generated'],
  extensions: ['.mjs'],
  ...extra,
});

describe('plan-shape facts — filesystem-only evidence', () => {
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

  it('refuses a malformed declaration as usage instead of guessing the cap', async () => {
    const { buildFacts } = await loadFacts();
    const root = makeTree();
    writeJson(root, 'docs/ai/source-size.json', { schema: 99 });
    assert.throws(() => buildFacts(root), (error) => error.exitCode === 2 && /source-size/.test(error.message));
    write(root, 'docs/ai/source-size.json', '{');
    assert.throws(() => buildFacts(root), (error) => error.exitCode === 2 && /not valid JSON/.test(error.message));
  });

  it('reuses an opened repository snapshot instead of walking the tree per call', async () => {
    const { buildFacts, openRepo } = await loadFacts();
    const root = makeTree();
    write(root, 'src/a.mjs', 'a\n');
    const repo = openRepo(root);
    write(root, 'src/late.mjs', 'late\n');
    const facts = buildFacts(root, { paths: ['src/late.mjs'], repo });
    assert.deepEqual(facts.repoFiles, ['src/a.mjs']);
    assert.deepEqual(facts.candidates('late.mjs', []), []);
    assert.equal(facts.pathFacts['src/late.mjs'].kind, 'regular');
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
