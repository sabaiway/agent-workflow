// scripts-component.test.mjs — the scripts op's component: the tree it judges before anything else is
// read, the seed names derived from the bundled bytes, and a declined project's standing seed files.
// The op and SEED_NAMES are imported dynamically, so a tree without them fails each cell, never the load.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_SCRIPT_NAMES } from '../node-evidence.mjs';
import { CHECKER_PAIR, INSTALLER_SET, READER_PAIR, SCRIPT_PRIORS } from '../script-priors.mjs';

const { ensureScripts, SCRIPT_CHANNEL, SEED_NAMES } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
const PAIRS = [...READER_PAIR, ...CHECKER_PAIR];
const FAMILY = BUNDLED_SCRIPT_NAMES.filter((n) => !PAIRS.includes(n));
// The family in write order: the installer set, then every other family name in code-unit order.
const ORDER = [...INSTALLER_SET, ...FAMILY.filter((n) => !INSTALLER_SET.includes(n)).sort()];
const bundled = (n) => readFileSync(join(BUNDLE, n));
// Every bundled `./` import target of a bundled script: static (`from './x'`) and dynamic (`import('./x')`).
const importsOf = (n) => [...bundled(n).toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)'\.\/([^']+)'/g)].map((m) => m[1]);
const ROTATOR = ['archive-decisions.mjs', 'archive-decisions.test.mjs'];
const SOURCES = [...ROTATOR, ...READER_PAIR];
const SEEDS = [...new Set([...SOURCES.flatMap(importsOf).filter((n) => FAMILY.includes(n)), ...ROTATOR])].sort();
const SUBSETS = Array.from({ length: 2 ** SEEDS.length - 1 }, (_, i) => SEEDS.filter((_, bit) => ((i + 1) >> bit) & 1));
// The seed files reached from `standing` through bundled `./` imports, transitively, `standing` included.
const closureOf = (standing) => {
  const reached = new Set(standing);
  for (const n of reached) for (const dep of importsOf(n)) if (SEEDS.includes(dep)) reached.add(dep);
  return reached;
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);
// The catalog seam: OLD(name) catalogued as a body a release shipped, for every seed name.
const PRIORS = [...SCRIPT_PRIORS, ...SEEDS.map((file) => ({ file, digest: sha(OLD(file)) }))];
const PAIR_BODIES = Object.fromEntries(PAIRS.map((n) => [n, bundled(n)]));
const rel = (n) => `scripts/${n}`;

const L = {
  refreshed: (n) => `${rel(n)}: matches a body an earlier release shipped — refreshed to the bundled one`,
  replaced: (n) => `${rel(n)}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in ${SCRIPT_CHANNEL}`,
  placed: (n) => `${rel(n)}: absent — placed from the bundled scripts`,
  count: (k) => `scripts/: ${k} other kit scripts are already the bundled body — nothing written`,
};
const NOT_PLACED = 'scripts/: no kit script stands in it, so none is placed';
const NOT_ACCEPTED = 'scripts/: the enforcement scripts were not accepted in this project, so no other kit script is placed';
const HOOK_IF = 'if a commit hook runs the files written above, they may stop the next commit';
const HOOK_ACCEPTED = 'the commit hook runs the files written above, so they may stop the next commit';

const put = (dir, bodies) => {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const [n, body] of Object.entries(bodies)) writeFileSync(join(dir, 'scripts', n), body);
};
// A temp project: docs/ai, a package.json unless `node` is false, then whatever `setup` lays down.
const withTree = (setup, fn, { node = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-component-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    setup(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
// Every file under `dir`, rel → base64 bytes (a link as `<link>`): "nothing written" is asserted against it.
const snapshot = (dir, at = dir, out = {}) => {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    if (e.isDirectory()) snapshot(dir, join(at, e.name), out);
    else out[relative(dir, join(at, e.name))] = e.isFile() ? readFileSync(join(at, e.name), 'base64') : '<link>';
  }
  return out;
};
const listing = (dir) => readdirSync(join(dir, 'scripts')).sort();
const bytesOf = (dir, n) => (existsSync(join(dir, 'scripts', n)) ? readFileSync(join(dir, 'scripts', n)) : null);
// File bytes are compared by digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
const digestOf = (bytes) => (bytes === null ? null : sha(bytes));
const run = (dir, deps = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, deps });
const spy = (paths) => (p, ...rest) => {
  paths.push(String(p));
  return readFileSync(p, ...rest);
};
const failedWith = (line) => ({ op: 'scripts', token: 'failed', failed: true, lines: [line] });
const wrongKind = (at, kind) => failedWith(`wrong-node-kind — ${at}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`);

describe('spec:distribution-files/S13 the scripts component, the seed names and a declined project', () => {
  it('no Node evidence: skipped-no-node-evidence, no path read and nothing written', () => withTree((dir) => put(dir, { 'archive-caps.test.mjs': EDIT('archive-caps.test.mjs') }), (dir) => {
    const paths = [];
    const before = snapshot(dir);
    assert.equal(run(dir, { readFile: spy(paths) }).token, 'skipped-no-node-evidence');
    assert.deepEqual([paths, snapshot(dir)], [[], before]);
  }, { node: false }));

  it('no scripts/, an empty one, or one holding only the four spec-layer pair files: not-placed, one line, nothing written', () => {
    for (const setup of [() => {}, (dir) => mkdirSync(join(dir, 'scripts')), (dir) => put(dir, PAIR_BODIES)]) withTree(setup, (dir) => {
      const before = snapshot(dir);
      const r = run(dir);
      assert.deepEqual(r, { op: 'scripts', token: 'not-placed', failed: false, lines: [NOT_PLACED] });
      assert.equal('entries' in r, false);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  it('a symlinked scripts/, a regular file named scripts, a linked family file beside no regular one: wrong-node-kind, nothing read', () => {
    const rows = [
      ['scripts/', 'a symlink', (dir) => { put(join(dir, 'real'), PAIR_BODIES); symlinkSync(join(dir, 'real', 'scripts'), join(dir, 'scripts')); }],
      ['scripts/', 'a regular file', (dir) => writeFileSync(join(dir, 'scripts'), 'not a directory\n')],
      [rel(SEEDS[0]), 'a symlink', (dir) => { put(dir, PAIR_BODIES); symlinkSync(join(dir, 'scripts', READER_PAIR[0]), join(dir, 'scripts', SEEDS[0])); }],
    ];
    for (const [at, kind, setup] of rows) withTree(setup, (dir) => {
      const paths = [];
      const before = snapshot(dir);
      assert.deepEqual(run(dir, { readFile: spy(paths) }), wrongKind(at, kind));
      assert.deepEqual([paths, snapshot(dir)], [[], before]);
    });
  });

  it('SEED_NAMES is frozen and equals the family members of the four sources\' bundled ./ imports plus the rotator and its suite', () => {
    assert.ok(Array.isArray(SEED_NAMES) && Object.isFrozen(SEED_NAMES), 'SEED_NAMES is a frozen export of scripts.mjs');
    assert.deepEqual(SEEDS, [...SEED_NAMES]);
  });

  for (const variant of ['prior', 'edited']) it(`every non-empty seed subset on ${variant} bodies beside the pairs: the standing seeds and their import closure current, nothing else placed`, () => {
    for (const standing of SUBSETS) withTree((dir) => put(dir, { ...PAIR_BODIES, ...Object.fromEntries(standing.map((n) => [n, variant === 'prior' ? OLD(n) : EDIT(n)])) }), (dir) => {
      const reached = [...closureOf(standing)].sort();
      const placed = reached.filter((n) => !standing.includes(n));
      const before = listing(dir);
      const r = run(dir, { priors: PRIORS });
      const fileLine = (n) => (placed.includes(n) ? L.placed(n) : variant === 'prior' ? L.refreshed(n) : L.replaced(n));
      const at = `standing ${standing.join(', ')}`;
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines }, { token: placed.length > 0 ? 'seeded' : 'refreshed', failed: false, lines: [...reached.map(fileLine), NOT_ACCEPTED, HOOK_IF] }, at);
      assert.equal('entries' in r, false, at);
      // A run over a current store (no ADR substrate here) prints no store line, the rotator judged or not.
      assert.deepEqual([r.lines.filter((l) => l === HOOK_IF).length, r.lines.includes(HOOK_ACCEPTED), r.lines.filter((l) => l.startsWith('ADR store: '))], [1, false, []], at);
      for (const n of reached) assert.equal(digestOf(bytesOf(dir, n)), sha(bundled(n)), `${at}: ${n} holds the bundled bytes`);
      for (const n of listing(dir).filter((f) => SEEDS.includes(f))) for (const dep of importsOf(n)) assert.ok(existsSync(join(dir, 'scripts', dep)), `${at}: ${n} imports ./${dep}, present`);
      assert.deepEqual(listing(dir), [...new Set([...before, ...reached])].sort(), `${at}: no other absent family file written`);
    });
  });

  it('one family file outside SEED_NAMES standing accepts the component: every other family file placed create-only, seeded, one hook-run line', () => {
    const outside = FAMILY.filter((n) => !SEEDS.includes(n)).sort()[0];
    withTree((dir) => put(dir, { ...PAIR_BODIES, [outside]: bundled(outside) }), (dir) => {
      const [links, renames] = [[], []];
      const record = (out, real) => (from, to) => {
        out.push(relative(join(dir, 'scripts'), to));
        return real(from, to);
      };
      const others = ORDER.filter((n) => n !== outside);
      const r = run(dir, { link: record(links, linkSync), rename: record(renames, renameSync) });
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines }, { token: 'seeded', failed: false, lines: [...others.map(L.placed), L.count(1), HOOK_ACCEPTED] });
      assert.equal('entries' in r, false);
      assert.deepEqual([links, renames], [others, []], 'every placement a create-only link, no replacing rename');
      for (const n of others) assert.equal(digestOf(bytesOf(dir, n)), sha(bundled(n)), `${n} holds the bundled bytes`);
    });
  });
});
