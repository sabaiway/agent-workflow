import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FLAT_STORE, ROOT, ROOT_DOC, STORE, groundOf, indexDoc, marker, op, relOf, repoOf, rulesOf, specDoc } from './spec-check-harness.test.mjs';

// The --all lane: the census walk and the cross-document invariants no single document can answer
// about itself. The session lane and the op grammar are spec-check.test.mjs; both share
// test/fixtures/spec-check/harness.mjs.
//
// Dynamic import: the suite LOADS without the module under test, so the red proof observes real
// assertion failures rather than an unresolvable import (red-proof custody, the family rule).
const { checkSpecs } = await import('./spec-check.mjs').catch(() => ({}));
const run = (files, extra = {}, options = {}) => {
  const deps = repoOf(files, options);
  return { ...checkSpecs({ root: ROOT, ops: [], all: true, ...extra }, deps), deps };
};

const ORPHAN_STORE = {
  [`${STORE}index.md`]: ROOT_DOC([]),
  [`${STORE}stray/deep.md`]: specDoc('deep', { scenario: '- S1 ok :: unbound' }),
  ...groundOf('deep'),
};
const UNLISTED_STORE = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC([]) };

describe('spec-check --all — the census walk observes the store, and never guesses past it', () => {
  it('a directory it cannot list is a FINDING, never an empty directory quietly walked past', () => {
    const files = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [g](./g/index.md)']), [`${STORE}g/index.md`]: indexDoc('g', []) };
    const r = run(files, {}, { listFails: [`${STORE}g`] });
    assert.deepEqual(rulesOf(r, 'census'), [`${STORE}g`], JSON.stringify(r.findings));
    assert.equal(r.exit, 1, 'an incomplete census can never report a clean store');
  });

  it('a NON-REGULAR .md inside the store is a finding, not a silent skip', () => {
    const files = { ...FLAT_STORE, [`${STORE}sneak.md`]: specDoc('sneak') };
    const r = run(files, {}, { states: { [`${STORE}sneak.md`]: 'symlink' } });
    assert.deepEqual(rulesOf(r, 'census'), [`${STORE}sneak.md`], JSON.stringify(r.findings));
  });

  it('a store directory whose realpath leaves the root is refused BEFORE it is listed', () => {
    const files = { ...FLAT_STORE, [`${STORE}g/index.md`]: indexDoc('g', []) };
    const r = run(files, {}, { escapes: { [`${STORE}g`]: '/elsewhere/g' } });
    assert.deepEqual(rulesOf(r, 'census'), [`${STORE}g`], JSON.stringify(r.findings));
  });

  // A symlinked DIRECTORY is the hole a `.md`-only census leaves: judgeEdges would happily resolve a
  // document through it, so the edge exists while the document was never censused, read or judged.
  it('a symlinked DIRECTORY inside the store is a finding, not an entry the census walks past', () => {
    const files = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [g](./g/index.md)']), [`${STORE}g/index.md`]: indexDoc('g', []) };
    const r = run(files, {}, { states: { [`${STORE}g`]: 'symlink' } });
    assert.ok(rulesOf(r, 'census').includes(`${STORE}g`), JSON.stringify(r.findings));
    assert.equal(r.exit, 1);
  });

  it('an edge the census never observed is refused, so --all can never ACCEPT past a hidden document', () => {
    const files = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [g](./g/index.md)']), [`${STORE}g/index.md`]: indexDoc('g', []) };
    const r = run(files, {}, { listFails: [`${STORE}g`], states: {} });
    assert.ok(rulesOf(r, 'census').includes(`${STORE}g`), JSON.stringify(r.findings));
    assert.equal(r.exit, 1);
  });

  // A census that observed nothing still OBSERVED something: its own refusal. Collapsing that into
  // the generic empty-closure usage error would throw away the one fact the run established.
  it('an unlistable STORE ROOT keeps its census finding instead of collapsing to a bare usage error', () => {
    const r = run(FLAT_STORE, {}, { listFails: [STORE.slice(0, -1)] });
    assert.equal(r.exit, 1, JSON.stringify(r.lines));
    assert.deepEqual(rulesOf(r, 'census'), [STORE.slice(0, -1)]);
  });

  // The census and the read are two separate observations. A document that changed between them was
  // still OBSERVED by the census, so dropping it silently would let --all accept a store whose
  // contents it can no longer vouch for.
  it('a document that changes state BETWEEN the census and the read is stated, never silently dropped', () => {
    const deps = repoOf(FLAT_STORE);
    const censused = new Set();
    const probe = (p) => {
      const rel = relOf(p);
      if (rel !== `${STORE}login.md`) return deps.probe(p);
      if (censused.has(rel)) return 'symlink';
      censused.add(rel);
      return 'file';
    };
    const r = { ...checkSpecs({ root: ROOT, ops: [], all: true }, { ...deps, probe }), deps };
    assert.deepEqual(rulesOf(r, 'post-state'), [`${STORE}login.md`], JSON.stringify(r.findings));
    assert.equal(r.exit, 1);
  });

  it('an ABSENT store root refuses the whole run (exit 2), never reports an empty clean store', () => {
    const r = run({});
    assert.equal(r.exit, 2);
    assert.equal(r.verdict, 'REFUSE');
    assert.match(r.lines.join('\n'), /store root/);
  });
});

describe('spec-check --all — the cross-document invariants', () => {
  // spec:spec-check/S6
  it('an unlisted child is DISTINCT from an orphan — a reached index skips it vs no index reaches it', () => {
    const unlisted = run(UNLISTED_STORE);
    assert.deepEqual(rulesOf(unlisted, 'unlisted-child'), [`${STORE}login.md`]);
    assert.deepEqual(rulesOf(unlisted, 'orphan'), [], 'its parent index IS reached — that is not an orphan');
    const orphan = run(ORPHAN_STORE);
    assert.deepEqual(rulesOf(orphan, 'orphan'), [`${STORE}stray/deep.md`]);
    assert.deepEqual(rulesOf(orphan, 'unlisted-child'), [], 'no index reaches its folder — that is not an unlisted child');
  });

  // A link to a document that is not there must not make that path "reached": a phantom edge would
  // launder an orphan into a reached document and hide the very thing this lane exists to find.
  it('a listed child that does not exist is a broken EDGE, and is never counted as reached', () => {
    const files = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [ghost](./ghost.md)']) };
    const r = run(files);
    assert.deepEqual(rulesOf(r, 'link'), [`${STORE}index.md`]);
    assert.deepEqual(rulesOf(r, 'orphan'), [], 'a phantom target is not a document, so it is not an orphan either');
    assert.equal(r.exit, 1);
  });

  it('the child graph is acyclic — a link cycle REFUSES instead of walking forever', () => {
    const files = {
      [`${STORE}index.md`]: ROOT_DOC(['- [a](./a/index.md)']),
      [`${STORE}a/index.md`]: indexDoc('a', ['- [b](./b/index.md)']),
      [`${STORE}a/b/index.md`]: indexDoc('b', ['- [a](./a/index.md)']),
      [`${STORE}a/b/a/index.md`]: indexDoc('a', ['- [b](./b/index.md)']),
    };
    const r = run(files, {}, { escapes: { [`${STORE}a/b/a`]: `${ROOT}/${STORE}a` } });
    assert.ok(rulesOf(r, 'acyclic').length >= 1, JSON.stringify(r.findings));
  });

  it('a slug is unique store-wide — the same slug in two folders REFUSES', () => {
    const files = {
      [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [g](./g/index.md)']),
      [`${STORE}login.md`]: specDoc('login'),
      [`${STORE}g/index.md`]: indexDoc('g', ['- [login](./login.md)']),
      [`${STORE}g/login.md`]: specDoc('login'),
      'probe/login.txt': marker('login', 2),
      ...groundOf('login'),
    };
    const r = run(files);
    assert.deepEqual(rulesOf(r, 'slug-unique').sort(), [`${STORE}g/login.md`, `${STORE}login.md`].sort());
  });

  it('two specs never claim overlapping module ground, compared on PROVEN canonical paths', () => {
    const files = {
      [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [sign-in](./sign-in.md)']),
      [`${STORE}login.md`]: specDoc('login', { module: '- src/shared/' }),
      [`${STORE}sign-in.md`]: specDoc('sign-in', { module: '- src/shared/auth.mjs' }),
      'src/shared/auth.mjs': '// shared ground\n',
      'probe/login.txt': marker('login'),
      'probe/sign-in.txt': marker('sign-in'),
    };
    const r = run(files);
    assert.deepEqual(rulesOf(r, 'overlap').sort(), [`${STORE}login.md`, `${STORE}sign-in.md`].sort(), JSON.stringify(r.findings));
  });

  // Nesting is a question about path COMPONENTS, and the platform's own path model is the only thing
  // that answers it. Reading `\` as a separator on POSIX invents an overlap between two distinct
  // files whose names merely happen to contain a backslash.
  it('overlap uses the platform path model — a literal backslash on POSIX is a NAME, not a nesting', () => {
    const files = {
      [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [sign-in](./sign-in.md)']),
      [`${STORE}login.md`]: specDoc('login', { module: '- src/shared/' }),
      [`${STORE}sign-in.md`]: specDoc('sign-in', { module: '- src/shared/auth.mjs' }),
      'src/shared/auth.mjs': '// shared ground\n',
      'probe/login.txt': marker('login'),
      'probe/sign-in.txt': marker('sign-in'),
    };
    const escapes = { 'src/shared': `${ROOT}/src/shared`, 'src/shared/auth.mjs': `${ROOT}/src/shared\\auth.mjs` };
    const r = run(files, {}, { escapes });
    assert.deepEqual(rulesOf(r, 'overlap'), [], JSON.stringify(r.findings));
  });

  // The index must report what a pairwise sweep reported: one finding per document per CONFLICTING
  // PAIR. Counting per ground path instead would repeat a pair once per descendant, and a chain
  // would fuse unrelated pairs into one lumped message.
  const overlapStore = (modules) => ({
    [`${STORE}index.md`]: ROOT_DOC(Object.keys(modules).map((slug) => `- [${slug}](./${slug}.md)`)),
    ...Object.fromEntries(Object.entries(modules).map(([slug, module]) => [`${STORE}${slug}.md`, specDoc(slug, { module })])),
    ...Object.fromEntries(Object.keys(modules).map((slug) => [`probe/${slug}.txt`, marker(slug)])),
    'src/shared/a.mjs': '// ground\n',
    'src/shared/b.mjs': '// ground\n',
    'src/shared/deep/c.mjs': '// ground\n',
  });

  it('overlap — ONE ancestor against TWO files of the same owner is ONE pair, not one finding per file', () => {
    const r = run(overlapStore({ login: '- src/shared/', 'sign-in': '- src/shared/a.mjs\n- src/shared/b.mjs' }));
    assert.deepEqual(rulesOf(r, 'overlap').sort(), [`${STORE}login.md`, `${STORE}sign-in.md`].sort(), JSON.stringify(r.findings));
  });

  it('overlap — a THREE-level chain reports all three pairs, each at its own granularity', () => {
    const r = run(overlapStore({ login: '- src/shared/', 'sign-in': '- src/shared/deep/', totals: '- src/shared/deep/c.mjs' }));
    const hits = rulesOf(r, 'overlap');
    assert.equal(hits.length, 6, `three pairs, two documents each: ${JSON.stringify(r.findings)}`);
    for (const slug of ['login', 'sign-in', 'totals']) {
      assert.equal(hits.filter((p) => p === `${STORE}${slug}.md`).length, 2, `${slug} conflicts with both of the others`);
    }
  });

  // The census lists what is ON DISK, so a document path can carry a space long before the reader
  // refuses its slug. A pair key that joins two such paths with a separator they may contain is not
  // injective, and the pair that collides is lost in silence — the one outcome a checker must not
  // have. These four paths make two DISTINCT pairs whose space-joined keys are byte-identical.
  it('overlap — two distinct owner pairs whose joined paths collide are both reported', () => {
    const [p, q, r] = [`${STORE}p.md`, `${STORE}q.md ${STORE}r.md`, `${STORE}r.md`];
    const pq = `${STORE}p.md ${STORE}q.md`;
    assert.equal([p, q].sort().join(' '), [pq, r].sort().join(' '), 'sanity: the naive key really collides');
    const doc = (slug, module) => specDoc(slug, { module, scenario: '- S1 ok :: unbound' });
    const files = {
      [`${STORE}index.md`]: ROOT_DOC([]),
      [p]: doc('p', '- src/one/'),
      [q]: doc('q', '- src/one/x.mjs'),
      [pq]: doc('pq', '- src/two/'),
      [r]: doc('r', '- src/two/x.mjs'),
      'src/one/x.mjs': '// ground\n',
      'src/two/x.mjs': '// ground\n',
    };
    const r2 = run(files);
    assert.deepEqual(rulesOf(r2, 'overlap').sort(), [p, pq, q, r].sort(), JSON.stringify(r2.findings));
  });

  it('a clean, fully listed store ACCEPTS with exit 0', () => {
    const r = run(FLAT_STORE);
    assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
    assert.equal(r.exit, 0);
  });

  it('the all-only matrix fires ONLY under --all — the same store is clean in the session lane', () => {
    const deps = repoOf(UNLISTED_STORE);
    const session = { ...checkSpecs({ root: ROOT, ops: [op('modify', `${STORE}login.md`)] }, deps), deps };
    for (const rule of ['unlisted-child', 'orphan', 'slug-unique', 'acyclic', 'overlap', 'census']) {
      assert.deepEqual(rulesOf(session, rule), [], `${rule} is an --all invariant, never a session one`);
    }
  });
});
