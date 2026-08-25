import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA } from '../references/scripts/spec-schema.mjs';
import { FLAT_STORE, FRONT, ROOT, ROOT_DOC, STORE, groundOf, indexDoc, marker, op, relOf, rename, repoOf, rulesOf, specDoc } from './spec-check-harness.test.mjs';

// The OP GRAMMAR, the corpus at the reader layer, and the SESSION lane. The --all lane is
// spec-check-store.test.mjs; both share test/fixtures/spec-check/harness.mjs.
//
// Dynamic import: the suite LOADS without the modules under test, so the red proof observes real
// assertion failures rather than an unresolvable import (red-proof custody, the family rule).
const { SPEC_OPS_GRAMMAR, parseSpecOps, buildClosure } = await import('./spec-check-ops.mjs').catch(() => ({}));
const { checkSpecs } = await import('./spec-check.mjs').catch(() => ({}));
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-workflow-engine', 'test', 'fixtures', 'specs');
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const run = (files, opList, extra = {}, options = {}) => {
  const deps = repoOf(files, options);
  return { ...checkSpecs({ root: ROOT, ops: opList, ...extra }, deps), deps };
};

describe('spec-check ops — the frozen grammar (four verbs, D-schema targets, one role per path)', () => {
  it('freezes exactly four verbs and the unambiguous separator', () => {
    assert.deepEqual([...SPEC_OPS_GRAMMAR.verbs], ['add', 'modify', 'remove', 'rename']);
    assert.equal(SPEC_OPS_GRAMMAR.separator, ':');
    assert.equal(SPEC_OPS_GRAMMAR.storePrefix, SPEC_SCHEMA.storePrefix);
    assert.ok(Object.isFrozen(SPEC_OPS_GRAMMAR));
  });

  const REFUSALS = [
    ['nope=docs/ai/specs/a.md', 'op-grammar', 'verb'],
    ['add', 'op-grammar', 'verb=<target>'],
    ['add=', 'op-grammar', 'verb=<target>'],
    ['add=./docs/ai/specs/a.md', 'op-target', 'outside'],
    ['add=docs/ai/specs/', 'op-target', 'directory'],
    ['add=docs/ai/specs//a.md', 'op-target', 'doubled slash'],
    ['add=docs\\ai\\specs\\a.md', 'op-target', 'backslash'],
    ['add=C:/docs/ai/specs/a.md', 'op-target', 'drive'],
    ['add=/docs/ai/specs/a.md', 'op-target', 'absolute'],
    ['add=docs/ai/specs/../a.md', 'op-target', 'dot segment'],
    ['add=docs/ai/specs/./a.md', 'op-target', 'dot segment'],
    ['add=docs/other/a.md', 'op-target', 'outside'],
    ['add=docs/ai/specs/a.txt', 'op-target', '.md'],
    ['add=docs/ai/specs/Login.md', 'op-segment', 'Login'],
    ['add=docs/ai/specs/a_b.md', 'op-segment', 'a_b'],
    ['add=docs/ai/specs/deep/-x/a.md', 'op-segment', '-x'],
    ['add=docs/ai/specs/index.md', 'op-root', 'store root'],
    ['remove=docs/ai/specs/index.md', 'op-root', 'store root'],
    ['rename=docs/ai/specs/a.md', 'op-grammar', 'separator'],
    ['rename=docs/ai/specs/a.md:docs/ai/specs/b.md:docs/ai/specs/c.md', 'op-grammar', 'separator'],
    [' add=docs/ai/specs/a.md', 'op-grammar', 'whitespace'],
    ['add=docs/ai/specs/a.md ', 'op-grammar', 'whitespace'],
  ];
  for (const [spec, code, token] of REFUSALS) {
    it(`refuses "${spec}" as ${code}`, () => {
      const parsed = parseSpecOps([spec]);
      assert.deepEqual(parsed.ops, [], 'a refused op never reaches the checker');
      assert.equal(parsed.errors.length, 1, JSON.stringify(parsed.errors));
      assert.equal(parsed.errors[0].code, code);
      assert.ok(parsed.errors[0].message.includes(token), `"${parsed.errors[0].message}" names ${token}`);
    });
  }

  it('accepts the four verbs on D-schema targets — flat, promoted, part and a domain leaf', () => {
    const accepted = [
      'add=docs/ai/specs/login.md',
      'modify=docs/ai/specs/billing/index.md',
      'remove=docs/ai/specs/billing/rates.md',
      'rename=docs/ai/specs/a/b/old-name.md:docs/ai/specs/a/b/new-name.md',
    ];
    const parsed = parseSpecOps(accepted);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.ops, [
      op('add', 'docs/ai/specs/login.md'),
      op('modify', 'docs/ai/specs/billing/index.md'),
      op('remove', 'docs/ai/specs/billing/rates.md'),
      rename('docs/ai/specs/a/b/old-name.md', 'docs/ai/specs/a/b/new-name.md'),
    ]);
  });

  const ROLES = [
    [['rename=docs/ai/specs/a.md:docs/ai/specs/a.md'], 'self'],
    [['rename=docs/ai/specs/a.md:docs/ai/specs/b.md', 'rename=docs/ai/specs/a.md:docs/ai/specs/c.md'], 'fan-out'],
    [['rename=docs/ai/specs/a.md:docs/ai/specs/c.md', 'rename=docs/ai/specs/b.md:docs/ai/specs/c.md'], 'fan-in'],
    [['rename=docs/ai/specs/a.md:docs/ai/specs/b.md', 'rename=docs/ai/specs/b.md:docs/ai/specs/c.md'], 'chain'],
    [['add=docs/ai/specs/a.md', 'remove=docs/ai/specs/a.md'], 'two roles'],
    [['modify=docs/ai/specs/a.md', 'rename=docs/ai/specs/a.md:docs/ai/specs/b.md'], 'two roles'],
  ];
  for (const [specs, shape] of ROLES) {
    it(`refuses ${shape}: ${specs.join(' + ')}`, () => {
      const parsed = parseSpecOps(specs);
      assert.deepEqual(parsed.ops, []);
      assert.equal(parsed.errors[0]?.code, 'op-role');
      assert.ok(parsed.errors[0].message.includes(shape), parsed.errors[0].message);
    });
  }

  it('dedups by identity, and NO spelling aliases a path — the accepted form is the only form', () => {
    const parsed = parseSpecOps(['add=docs/ai/specs/a.md', 'add=docs/ai/specs/a.md']);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.ops, [op('add', 'docs/ai/specs/a.md')], 'an identical op is one op, never a conflict');
    const aliased = parseSpecOps(['add=docs/ai/specs/a.md', 'add=docs/ai/specs//a.md']);
    assert.equal(aliased.errors[0]?.code, 'op-target', 'the second spelling refuses rather than aliasing the first');
    assert.deepEqual(aliased.ops, []);
    assert.equal(parseSpecOps([]).errors[0]?.code, 'op-empty', 'an empty op source is usage');
  });

  const CLOSURE = [
    ['a flat spec under a folder', [op('add', `${STORE}g/x.md`)], [`${STORE}g/x.md`, `${STORE}g/index.md`]],
    ['a flat spec at the store top', [op('add', `${STORE}x.md`)], [`${STORE}x.md`, `${STORE}index.md`]],
    ['a promoted root — ONE up, never its own folder', [op('modify', `${STORE}g/x/index.md`)], [`${STORE}g/x/index.md`, `${STORE}g/index.md`]],
    ['a part beside a promoted root', [op('add', `${STORE}billing/rates.md`)], [`${STORE}billing/rates.md`, `${STORE}billing/index.md`]],
    ['a domain leaf', [op('remove', `${STORE}a/b/c.md`)], [`${STORE}a/b/c.md`, `${STORE}a/b/index.md`]],
    ['same parent dedups', [op('add', `${STORE}g/x.md`), op('add', `${STORE}g/y.md`)], [`${STORE}g/index.md`, `${STORE}g/x.md`, `${STORE}g/y.md`]],
    ['cross-parent adds BOTH', [op('add', `${STORE}g/x.md`), op('add', `${STORE}h/y.md`)], [`${STORE}g/index.md`, `${STORE}g/x.md`, `${STORE}h/index.md`, `${STORE}h/y.md`]],
    ['a rename across parents carries both sides and both parents', [rename(`${STORE}g/x.md`, `${STORE}h/x.md`)], [`${STORE}g/index.md`, `${STORE}g/x.md`, `${STORE}h/index.md`, `${STORE}h/x.md`]],
  ];
  for (const [name, opList, expected] of CLOSURE) {
    it(`closure — ${name}`, () => assert.deepEqual(buildClosure(opList).map((e) => e.path).sort(), [...expected].sort()));
  }

  it('the closure keeps the op role on a path that is also a listing parent', () => {
    const closure = buildClosure([op('add', `${STORE}g/index.md`), op('add', `${STORE}g/x.md`)]);
    assert.deepEqual(closure.find((e) => e.path === `${STORE}g/index.md`).roles, ['add']);
    assert.deepEqual(closure.find((e) => e.path === `${STORE}index.md`).roles, ['listing-parent']);
  });
});

describe('spec-check — the corpus read BOTH ways at the reader layer (no second parser)', () => {
  const accepts = readdirSync(join(CORPUS, 'accept'));
  const refuses = readdirSync(join(CORPUS, 'refuse'));
  const judge = (base, file) => {
    const path = `${STORE}${relative(base, file).split('\\').join('/')}`;
    return run({ [path]: readFileSync(file, 'utf8') }, [op('modify', path)]);
  };

  it(`every accept case (${accepts.length}) raises NO reader finding`, () => {
    assert.ok(accepts.length >= 7, `${accepts.length} accept cases`);
    for (const name of accepts) {
      const base = join(CORPUS, 'accept', name);
      for (const file of walk(base)) assert.deepEqual(rulesOf(judge(base, file), 'reader'), [], `accept/${name}/${relative(base, file)}`);
    }
  });

  it(`every refuse rule (${refuses.length}) surfaces as EXACTLY its reader rule id, relayed not re-derived`, () => {
    assert.deepEqual(refuses.filter((r) => !SPEC_SCHEMA.rules.includes(r)), [], 'no refuse folder outside the rule list');
    for (const rule of refuses) {
      for (const name of readdirSync(join(CORPUS, 'refuse', rule))) {
        const base = join(CORPUS, 'refuse', rule, name);
        for (const file of walk(base)) {
          const result = judge(base, file);
          const relayed = result.findings.filter((f) => f.rule === 'reader').map((f) => f.readerRule);
          assert.deepEqual(relayed, [rule], `refuse/${rule}/${name}/${relative(base, file)}`);
          assert.equal(result.exit, 1, 'a reader finding refuses');
        }
      }
    }
  });
});

describe('spec-check — the session lane: post-state, probe, thresholds, bindings, containment', () => {
  const POST = [
    ['add', 'file', null], ['add', 'absent', 'post-state'], ['add', 'dir', 'post-state'],
    ['add', 'symlink', 'post-state'], ['add', 'unreadable', 'post-state'],
    ['modify', 'file', null], ['modify', 'absent', 'post-state'], ['modify', 'dir', 'post-state'],
    ['remove', 'absent', null], ['remove', 'file', 'post-state'], ['remove', 'dir', 'post-state'],
    ['remove', 'symlink', 'post-state'], ['remove', 'unreadable', 'post-state'],
  ];
  for (const [verb, state, expected] of POST) {
    it(`post-state — ${verb} on a ${state} target ${expected ? 'REFUSES' : 'passes'}`, () => {
      const path = `${STORE}login.md`;
      const files = { ...FLAT_STORE };
      if (state !== 'file') delete files[path];
      const r = run(files, [op(verb, path)], {}, { states: { [path]: state } });
      assert.deepEqual(rulesOf(r, 'post-state'), expected ? [path] : [], JSON.stringify(r.findings));
    });
  }

  it('post-state — a rename wants its OLD side absent and its NEW side a file', () => {
    const [from, to] = [`${STORE}login.md`, `${STORE}sign-in.md`];
    const files = { [`${STORE}index.md`]: ROOT_DOC(['- [sign-in](./sign-in.md)']), [to]: specDoc('sign-in'), 'probe/sign-in.txt': marker('sign-in'), ...groundOf('sign-in') };
    assert.deepEqual(rulesOf(run(files, [rename(from, to)]), 'post-state'), []);
    const stillThere = { ...files, [from]: specDoc('login'), 'probe/login.txt': marker('login'), ...groundOf('login') };
    assert.deepEqual(rulesOf(run(stillThere, [rename(from, to)]), 'post-state'), [from], 'the old side survived');
  });

  it('listing — the new side is listed ONCE by its parent, the removed side not at all', () => {
    const unlisted = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC([]) };
    assert.deepEqual(rulesOf(run(unlisted, [op('add', `${STORE}login.md`)]), 'listed'), [`${STORE}login.md`]);
    const twice = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [login](./login.md)']) };
    assert.deepEqual(rulesOf(run(twice, [op('add', `${STORE}login.md`)]), 'listed'), [`${STORE}login.md`], 'twice is not once');
    const lingering = { [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)']) };
    assert.deepEqual(rulesOf(run(lingering, [op('remove', `${STORE}login.md`)]), 'listed'), [`${STORE}login.md`]);
    assert.deepEqual(rulesOf(run(FLAT_STORE, [op('add', `${STORE}login.md`)]), 'listed'), [], 'the clean store lists it once');
  });

  it('listing — a part is listed under ## Parts of its promoted root, and `./x.md` never matches `./x/index.md`', () => {
    const part = `${FRONT('part', 150)}\n# Part: rates\n\nRates.\n`;
    const files = { [`${STORE}billing/index.md`]: specDoc('billing', { parts: ['- [rates](./rates.md)'] }), [`${STORE}billing/rates.md`]: part, 'probe/billing.txt': marker('billing'), ...groundOf('billing') };
    assert.deepEqual(rulesOf(run(files, [op('add', `${STORE}billing/rates.md`)]), 'listed'), []);
    const promoted = { [`${STORE}index.md`]: ROOT_DOC(['- [billing](./billing.md)']), [`${STORE}billing/index.md`]: specDoc('billing'), 'probe/billing.txt': marker('billing'), ...groundOf('billing') };
    assert.deepEqual(rulesOf(run(promoted, [op('add', `${STORE}billing/index.md`)]), 'listed'), [`${STORE}billing/index.md`],
      'the flat link is a DIFFERENT target string from the promoted one');
  });

  // Every listed edge is judged, in BOTH lanes: a link is a claim about a document, and an unchecked
  // claim is exactly what lets a broken or escaping target ride into the reachability graph.
  it('link — a listed child that does not exist REFUSES on the parent that lists it', () => {
    const files = { ...FLAT_STORE, [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [ghost](./ghost.md)']) };
    assert.deepEqual(rulesOf(run(files, [op('modify', `${STORE}login.md`)]), 'link'), [`${STORE}index.md`]);
  });

  it('link — a listed child that is a symlink REFUSES: a foreign document is never an edge', () => {
    const r = run(FLAT_STORE, [op('modify', `${STORE}login.md`)], {}, { states: { [`${STORE}login.md`]: 'symlink' } });
    assert.ok(rulesOf(r, 'link').includes(`${STORE}index.md`), JSON.stringify(r.findings));
  });

  const BINDINGS = [
    ['the marker occurs exactly once', { 'probe/login.txt': marker('login') }, {}, false],
    ['the marker is absent from the bound file', { 'probe/login.txt': '// nothing here\n' }, {}, true],
    ['the marker occurs twice', { 'probe/login.txt': marker('login', 2) }, {}, true],
    ['the bound file is absent', {}, {}, true],
    ['the bound path is unreadable', {}, { 'probe/login.txt': 'unreadable' }, true],
    ['the bound path is a directory', {}, { 'probe/login.txt': 'dir' }, true],
    ['the bound path is a symlink', {}, { 'probe/login.txt': 'symlink' }, true],
  ];
  for (const [name, probeFiles, states, refuses] of BINDINGS) {
    const files = { [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)']), [`${STORE}login.md`]: specDoc('login'), ...groundOf('login'), ...probeFiles };
    it(`binding (D4) — ${name}`, () => assert.deepEqual(rulesOf(run(files, [op('modify', `${STORE}login.md`)], {}, { states }), 'binding'), refuses ? [`${STORE}login.md`] : []));
  }

  it('an unbound scenario is never probed (the reader warns; the checker has nothing to bind)', () => {
    const files = { ...FLAT_STORE, [`${STORE}login.md`]: specDoc('login', { scenario: '- S1 ok :: unbound' }) };
    const r = run(files, [op('modify', `${STORE}login.md`)]);
    assert.deepEqual(rulesOf(r, 'binding'), []);
    assert.ok(!r.deps.reads.includes('probe/login.txt'), 'no bound path, no probe read');
  });

  // A module names the code the contract governs. Ground that is absent, unreadable or of the other
  // kind is a claim about code that is not there — the checker states it rather than passing it.
  const MODULES = [
    ['a directory root that exists', '- src/login/', {}, false],
    ['a file list whose files exist', '- src/login/a.mjs', {}, false],
    ['a directory root that does not exist', '- src/nowhere/', {}, true],
    ['a file list naming an absent file', '- src/login/gone.mjs', {}, true],
    ['a directory root that is really a file', '- src/login/a.mjs/', {}, true],
    ['a file entry that is really a directory', '- src/login', {}, true],
    ['ground that is unreadable', '- src/login/', { 'src/login': 'unreadable' }, true],
  ];
  for (const [name, module, states, refuses] of MODULES) {
    const files = { ...FLAT_STORE, [`${STORE}login.md`]: specDoc('login', { module }), 'src/login/a.mjs': '// ground\n' };
    it(`module — ${name}`, () => assert.deepEqual(rulesOf(run(files, [op('modify', `${STORE}login.md`)], {}, { states }), 'module'), refuses ? [`${STORE}login.md`] : []));
  }

  it('threshold — a document over its kind cap REFUSES, at the cap it passes', () => {
    const filler = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}.`).join('\n\n');
    const long = specDoc('login').replace('A contract.', filler(80));
    const files = { ...FLAT_STORE, [`${STORE}login.md`]: long };
    const r = run(files, [op('modify', `${STORE}login.md`)]);
    assert.ok(long.split('\n').length > SPEC_SCHEMA.maxLines.spec, 'sanity: the fixture is really over the cap');
    assert.deepEqual(rulesOf(r, 'threshold'), [`${STORE}login.md`]);
    assert.deepEqual(rulesOf(run(FLAT_STORE, [op('modify', `${STORE}login.md`)]), 'threshold'), []);
  });

  it('a leaf swapped to a symlink BETWEEN the probe and the read REFUSES — the read is descriptor-bound', () => {
    const path = `${STORE}login.md`;
    const deps = repoOf(FLAT_STORE);
    const swapped = { ...deps, read: (p) => (relOf(p) === path ? { outcome: 'foreign', className: 'symlink' } : deps.read(p)) };
    const r = checkSpecs({ root: ROOT, ops: [op('modify', path)] }, swapped);
    assert.deepEqual(rulesOf(r, 'unreadable'), [path], 'the probe said file; the descriptor says otherwise and wins');
  });

  it('containment — a parent whose realpath leaves the root REFUSES BEFORE the leaf is read', () => {
    const path = `${STORE}g/x.md`;
    const files = { ...FLAT_STORE, [path]: specDoc('x'), [`${STORE}g/index.md`]: indexDoc('g', ['- [x](./x.md)']) };
    const r = run(files, [op('modify', path)], {}, { escapes: { [`${STORE}g`]: '/elsewhere/g' } });
    assert.deepEqual(rulesOf(r, 'contained').sort(), [`${STORE}g/index.md`, path].sort(),
      'EVERY document in the escaping directory is refused — the leaf and the listing parent alike');
    assert.ok(!r.deps.reads.includes(path), 'fail closed BEFORE the read, never after it');
    assert.ok(!r.deps.reads.includes(`${STORE}g/index.md`), 'and the parent is never opened through either');
  });

  // Fail-closed means PROVEN contained, not "not proven to escape": an unresolvable directory is a
  // path whose containment was never observed, so the read never happens.
  it('containment — an UNRESOLVABLE directory is refused too, and its leaf is never read', () => {
    const path = `${STORE}login.md`;
    const r = run(FLAT_STORE, [op('modify', path)], {}, { escapes: { [STORE.slice(0, -1)]: null } });
    assert.ok(rulesOf(r, 'contained').includes(path), JSON.stringify(r.findings));
    assert.ok(!r.deps.reads.includes(path), 'an unobserved containment never becomes a read');
  });

  // Containment is a question about PATH COMPONENTS, and only the platform's own path model answers
  // it. A textual prefix test says "/repo\outside" sits under "/repo" on a POSIX host, where the
  // backslash is an ordinary filename character — and it mis-reads a filesystem root either way.
  it('containment — a sibling whose name merely BEGINS with the root is outside it', () => {
    const path = `${STORE}login.md`;
    const r = run(FLAT_STORE, [op('modify', path)], {}, { escapes: { [STORE.slice(0, -1)]: `${ROOT}\\outside` } });
    assert.ok(rulesOf(r, 'contained').includes(path), JSON.stringify(r.findings));
    assert.ok(!r.deps.reads.includes(path), 'and it is never read');
  });

  it('containment — a child whose name merely STARTS with two dots is inside, not a traversal', () => {
    const r = run(FLAT_STORE, [op('modify', `${STORE}login.md`)], {}, { escapes: { 'probe/login.txt': `${ROOT}/probe/..keep.txt` } });
    assert.deepEqual(rulesOf(r, 'contained'), [], JSON.stringify(r.findings));
  });

  it('binding — a bound path that does NOT resolve is refused before it is probed or read', () => {
    const r = run(FLAT_STORE, [op('modify', `${STORE}login.md`)], {}, { escapes: { 'probe/login.txt': null } });
    assert.deepEqual(rulesOf(r, 'binding'), [`${STORE}login.md`]);
    assert.ok(!r.deps.reads.includes('probe/login.txt'), 'an unresolved binding is never opened');
  });

  for (const field of ['probe/login.txt', 'src/login']) {
    it(`containment — the path-bearing field "${field}" is judged on its OWN realpath`, () => {
      const r = run(FLAT_STORE, [op('modify', `${STORE}login.md`)], {}, { escapes: { [field]: '/elsewhere/x' } });
      assert.deepEqual(rulesOf(r, 'contained'), [`${STORE}login.md`]);
    });
  }

  it('a bound file swapped BETWEEN its probe and its read REFUSES as a binding, never as a marker count', () => {
    const deps = repoOf(FLAT_STORE);
    const swapped = { ...deps, read: (p) => (relOf(p) === 'probe/login.txt' ? { outcome: 'foreign', className: 'symlink' } : deps.read(p)) };
    const r = checkSpecs({ root: ROOT, ops: [op('modify', `${STORE}login.md`)] }, swapped);
    assert.deepEqual(rulesOf(r, 'binding'), [`${STORE}login.md`]);
  });

  it('a closure path outside the store is refused by the judge itself, not only by the op grammar', () => {
    const r = run(FLAT_STORE, [op('modify', 'docs/other/x.md')]);
    assert.deepEqual(rulesOf(r, 'contained'), ['docs/other/x.md'], 'the judge never trusts its caller to have parsed');
  });

  it('an uninjected IO dependency throws rather than judging against a filesystem it does not own', () => {
    assert.throws(() => checkSpecs({ root: ROOT, ops: [op('modify', `${STORE}login.md`)] }), /not injected/);
  });

  it('a clean store, judged as a session, ACCEPTS with an exit of 0 and says how much it judged', () => {
    const r = run(FLAT_STORE, [op('modify', `${STORE}login.md`)]);
    assert.deepEqual(r.findings, []);
    assert.equal(r.exit, 0);
    assert.equal(r.verdict, 'ACCEPT');
    assert.match(r.lines[0], /^spec-check: ACCEPT/);
    assert.match(r.lines[0], /2 document\(s\)/, 'the closure carried the leaf and its listing parent');
  });
});
