// scripts-component.test.mjs — the scripts op's component in the kit folder: the tree it judges before anything
// else is read, the seed paths the manifest marks, and a declined project's seed entries.
// The op, SEED_NAMES and the family's manifest reader are imported dynamically, so a tree without them fails each
// cell, never the load.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIOR_FILES } from '../script-priors.mjs';

const { ensureScripts, SCRIPT_CHANNEL, SEED_NAMES } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
const bundled = (p) => readFileSync(join(BUNDLE, p));
// Every bundled relative import of a manifest path (static, dynamic or a re-export), resolved to the manifest path it names.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const importsOf = (p) => [...bundled(p).toString('utf8').matchAll(IMPORT)].map((m) => posix.join(posix.dirname(p), m[1]));
// The paths reached from `from` through bundled relative imports, transitively, within `within`, `from` included.
const closureOf = (from, within) => {
  const reached = new Set(from);
  for (const p of reached) for (const d of importsOf(p)) if (within.includes(d)) reached.add(d);
  return reached;
};

// The kit folder, read inside each cell from the kit mirror's manifest and node-evidence; every name below is a
// manifest path. The family is the deployed entries less the spec layer's modules, in write order: the installer,
// then each file after every family file it imports, by manifest path otherwise.
let layout;
let KD;
const kitLayout = () => (layout ??= (async () => {
  const [{ readFamily }, { KIT_SCRIPTS_DIR, INSTALLER_REL }] = await Promise.all([import('../../references/scripts/family.mjs'), import('../node-evidence.mjs')]);
  const entries = readFamily(BUNDLE), deployed = entries.filter((e) => e.role === 'deployed'), spec = (e) => ['spec-schema', 'docs-size'].includes(e.module);
  const installer = posix.relative(KIT_SCRIPTS_DIR, INSTALLER_REL);
  const [order, rest] = [[installer], deployed.filter((e) => !spec(e) && e.path !== 'run.mjs' && e.path !== installer).map((e) => e.path)];
  for (let next; (next = rest.filter((p) => importsOf(p).every((d) => !rest.includes(d))).sort()[0]);) order.push(...rest.splice(rest.indexOf(next), 1));
  assert.deepEqual(rest, [], "the family's imports close no cycle");
  KD = KIT_SCRIPTS_DIR;
  return { entries, order, deployed: deployed.map((e) => e.path), seeds: order.filter((p) => deployed.find((e) => e.path === p).seed), pairs: deployed.filter(spec).map((e) => e.path) };
})());

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EDIT = (p) => Buffer.from(`// mine: ${p}\n`);
const rel = (p) => `${KD}/${p}`;
const L = {
  replaced: (p) => `${rel(p)}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in ${SCRIPT_CHANNEL}`,
  placed: (p) => `${rel(p)}: absent — placed from the bundled scripts`,
  count: (k) => `${KD}/: ${k} other kit scripts are already the bundled body — nothing written`,
  notAccepted: () => `${KD}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`,
};
const HOOK_IF = 'if a commit hook runs the files written above, they may stop the next commit';
const HOOK_ACCEPTED = 'the commit hook runs the files written above, so they may stop the next commit';

// Writes `bodies` (manifest path → bytes) under `at` of `dir`, the kit folder unless named.
const put = (dir, bodies, at = KD) => {
  mkdirSync(join(dir, at), { recursive: true });
  for (const [p, body] of Object.entries(bodies)) {
    mkdirSync(dirname(join(dir, at, p)), { recursive: true });
    writeFileSync(join(dir, at, p), body);
  }
};
const pairBodies = (K) => Object.fromEntries(K.pairs.map((p) => [p, bundled(p)]));
const flatBody = (name) => {
  if (name === 'spec-schema.mjs') return bundled('spec-schema/spec-schema.mjs');
  if (name === 'markdown-blocks.mjs') return bundled('shared/markdown-blocks.mjs');
  const fixtures = join(KIT, 'test', 'fixtures', 'script-priors');
  const version = readdirSync(fixtures).filter((v) => existsSync(join(fixtures, v, `${name}.txt`))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  assert.ok(version, `a last-flat-release fixture for ${name}`);
  return readFileSync(join(fixtures, version, `${name}.txt`));
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
// The manifest paths standing in the kit folder.
const listing = (dir) => Object.keys(snapshot(join(dir, KD))).sort();
const run = (dir, deps = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, deps: { git: () => ({ status: 128, stdout: '', stderr: '' }), ...deps } });
// A recording store run answering already-current; each call as [cmd, args, cwd], against STORE_RUN(dir).
const spawner = (calls = []) => ({ calls, spawnSync: (cmd, args, opts) => { calls.push([cmd, args, opts?.cwd]); return { status: 0, signal: null, stdout: 'already-current\n', stderr: '' }; } });
const STORE_RUN = (dir) => [process.execPath, [join(dir, KD, 'archives', 'archive-decisions.mjs'), '--ensure-current'], dir];
// The kit folder's listing, none when it is absent.
const listed = (dir) => (existsSync(join(dir, KD)) ? listing(dir) : []);
const spy = (paths) => (p, ...rest) => {
  paths.push(String(p));
  return readFileSync(p, ...rest);
};
// A folder moved aside and linked back, so the link's target holds what the folder held.
const linkAway = (dir, at) => {
  renameSync(join(dir, at), join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, at));
};

describe('spec:distribution-files/S13 the scripts component, the seed names and a declined project', () => {
  it('no Node evidence: skipped-no-node-evidence, no path read and nothing written', async () => {
    const K = await kitLayout(), suite = K.entries.find((e) => e.role === 'suite' && e.module === 'archives').path;
    withTree((dir) => put(dir, { [suite]: EDIT(suite) }), (dir) => {
      const [paths, before] = [[], snapshot(dir)];
      assert.equal(run(dir, { readFile: spy(paths) }).token, 'skipped-no-node-evidence');
      assert.deepEqual([paths, snapshot(dir)], [[], before]);
    }, { node: false });
  });

  it("no kit folder, an empty one, or one holding only the spec layer's pair files and run.mjs: every seed entry placed create-only, the not-accepted line, the conditional hook-run line once, one store run, seeded", async () => {
    const K = await kitLayout();
    const setups = [() => {}, (dir) => mkdirSync(join(dir, 'scripts')), (dir) => mkdirSync(join(dir, KD), { recursive: true }), (dir) => put(dir, pairBodies(K)),
      (dir) => put(dir, { 'run.mjs': bundled('run.mjs') }), (dir) => put(dir, { ...pairBodies(K), 'run.mjs': bundled('run.mjs') })];
    for (const setup of setups) withTree(setup, (dir) => {
      const [links, store, before] = [[], spawner(), listed(dir)];
      const r = run(dir, { spawnSync: store.spawnSync, link: (from, to) => { links.push(relative(join(dir, KD), to)); return linkSync(from, to); } });
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines, entries: 'entries' in r }, { token: 'seeded', failed: false, lines: [...K.seeds.map(L.placed), L.notAccepted(), HOOK_IF], entries: false }, r.lines.join('\n'));
      assert.deepEqual([links, store.calls], [K.seeds, [STORE_RUN(dir)]], 'every seed entry placed create-only, then one store run');
      assert.deepEqual(listing(dir), [...new Set([...before, ...K.seeds])].sort(), 'no other family file written');
      for (const p of K.seeds) assert.equal(sha(readFileSync(join(dir, KD, p))), sha(bundled(p)), `${p} holds the bundled bytes`);
    });
  });

  it("only flat spec-pair, suite and support files beside run.mjs: every seed entry placed with the not-accepted line, suites and support removed, pairs kept, seeded", async () => {
    const K = await kitLayout(), pairs = ['spec-schema.mjs', 'check-docs-size.mjs'];
    const removed = PRIOR_FILES.filter((name) => !K.deployed.some((p) => posix.basename(p) === name));
    const flat = Object.fromEntries([...pairs, ...removed].map((name) => [name, flatBody(name)]));
    withTree((dir) => { put(dir, flat, 'scripts'); put(dir, { 'run.mjs': bundled('run.mjs') }); }, (dir) => {
      const [before, store] = [listing(dir), spawner()], r = run(dir, { spawnSync: store.spawnSync });
      assert.deepEqual([r.token, r.failed, 'entries' in r, store.calls.length], ['seeded', false, false, 1]);
      assert.deepEqual(r.lines.slice(0, K.seeds.length + 2), [...K.seeds.map(L.placed), L.notAccepted(), HOOK_IF]);
      for (const name of removed) {
        assert.equal(existsSync(join(dir, 'scripts', name)), false, `${name} removed`);
        assert.equal(r.lines.filter((l) => l === `scripts/${name}: removed — the kit's scripts live in scripts/agent-workflow/`).length, 1);
      }
      for (const name of pairs) {
        assert.equal(sha(readFileSync(join(dir, 'scripts', name))), sha(flat[name]));
        const path = K.pairs.find((p) => posix.basename(p) === name);
        assert.equal(r.lines.filter((l) => l === `scripts/${name}: kept — scripts/agent-workflow/${path} is not placed yet`).length, 1);
      }
      assert.deepEqual(listing(dir), [...before, ...K.seeds].sort(), 'only the seed entries written under the kit folder');
    });
  });

  it("only flat spec-pair, suite and support files with no kit folder: every seed entry placed, nothing removed, every kit file kept naming run.mjs", async () => {
    const K = await kitLayout(), names = PRIOR_FILES.filter((name) => ['spec-schema.mjs', 'check-docs-size.mjs'].includes(name) || !K.deployed.some((p) => posix.basename(p) === name));
    withTree((dir) => put(dir, Object.fromEntries(names.map((name) => [name, flatBody(name)])), 'scripts'), (dir) => {
      const store = spawner(), r = run(dir, { spawnSync: store.spawnSync });
      assert.deepEqual([r.token, r.failed, store.calls.length, listing(dir)], ['seeded', false, 1, [...K.seeds].sort()]);
      assert.deepEqual(r.lines, [...K.seeds.map(L.placed), L.notAccepted(), HOOK_IF, ...names.map((name) => `scripts/${name}: kept — scripts/agent-workflow/run.mjs is not placed yet`)]);
      for (const name of names) assert.equal(sha(readFileSync(join(dir, 'scripts', name))), sha(flatBody(name)), `${name} left as it stood`);
    });
  });

  it('the tree the specs op seeds on a package.json-only project: the rotator placed with the not-accepted line, the conditional hook-run line once and one store run, seeded; a second plain run writes nothing, already-present', async () => {
    const K = await kitLayout(), seeded = [...closureOf(K.pairs, K.deployed)];
    withTree((dir) => put(dir, Object.fromEntries([...seeded, 'run.mjs'].map((p) => [p, bundled(p)]))), (dir) => {
      const standing = K.seeds.filter((p) => seeded.includes(p)), absent = K.seeds.filter((p) => !seeded.includes(p));
      assert.ok(standing.length > 0 && absent.includes('archives/archive-decisions.mjs'), 'the spec layer carries seed files with it, never the rotator');
      const first = spawner(), r = run(dir, { spawnSync: first.spawnSync });
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines, spawns: first.calls, entries: 'entries' in r },
        { token: 'seeded', failed: false, lines: [...absent.map(L.placed), L.count(standing.length), L.notAccepted(), HOOK_IF], spawns: [STORE_RUN(dir)], entries: false });
      const [after, second] = [snapshot(dir), spawner()], again = run(dir, { spawnSync: second.spawnSync });
      assert.deepEqual({ token: again.token, lines: again.lines, spawns: second.calls.length }, { token: 'already-present', lines: [L.count(K.seeds.length), L.notAccepted()], spawns: 1 });
      assert.deepEqual(snapshot(dir), after, 'the second run writes nothing');
    });
  });

  it('a symlinked or non-directory scripts/, kit folder or module folder, or a linked family path in a kit folder holding no regular family file: wrong-node-kind naming it, nothing read or written', async () => {
    const K = await kitLayout(), rotator = 'archives/archive-decisions.mjs';
    const accepted = (dir, more = {}) => put(dir, { ...pairBodies(K), [K.order[0]]: bundled(K.order[0]), ...more });
    const shared = Object.fromEntries(K.order.filter((p) => p.startsWith('shared/')).map((p) => [p, bundled(p)]));
    const rows = [
      ['scripts', 'a symlink', (dir) => { accepted(dir); linkAway(dir, 'scripts'); }],
      ['scripts', 'a regular file', (dir) => writeFileSync(join(dir, 'scripts'), 'not a directory\n')],
      [KD, 'a symlink', (dir) => { accepted(dir); linkAway(dir, KD); }],
      [KD, 'a regular file', (dir) => { mkdirSync(join(dir, 'scripts')); writeFileSync(join(dir, KD), 'not a directory\n'); }],
      [`${KD}/shared`, 'a symlink', (dir) => { accepted(dir, shared); linkAway(dir, `${KD}/shared`); }],
      [`${KD}/archives`, 'a regular file', (dir) => { accepted(dir); writeFileSync(join(dir, KD, 'archives'), 'not a directory\n'); }],
      [rel(rotator), 'a symlink', (dir) => { put(dir, pairBodies(K)); mkdirSync(join(dir, KD, 'archives')); symlinkSync(join(dir, KD, K.pairs[0]), join(dir, rel(rotator))); }],
    ];
    assert.ok(K.seeds.includes(rotator), 'the rotator is a seed path');
    for (const [at, kind, setup] of rows) withTree(setup, (dir) => {
      const [paths, before] = [[], snapshot(dir)], r = run(dir, { readFile: spy(paths) });
      const named = [`${at}:`, `${at}/:`].some((head) => r.lines[0]?.startsWith(`wrong-node-kind — ${head} exists but is ${kind} — nothing was read or written`));
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines.length, named, paths, after: snapshot(dir) }, { token: 'failed', failed: true, lines: 1, named: true, paths: [], after: before }, `${at} ${kind}: ${r.lines.join('\n')}`);
    });
  });

  it("SEED_NAMES is frozen and equals the seed paths of the scripts op's family", async () => {
    const K = await kitLayout();
    assert.ok(Array.isArray(SEED_NAMES) && Object.isFrozen(SEED_NAMES), 'SEED_NAMES is a frozen export of scripts.mjs');
    assert.deepEqual([...SEED_NAMES].sort(), [...K.seeds].sort());
  });

  it("every non-empty subset of the seed files on edited bodies beside the spec layer's files: every seed entry the bundled bytes, each standing one replaced and each absent one placed, every import resolving, nothing else placed, one store run", async () => {
    const K = await kitLayout(), subsets = Array.from({ length: 2 ** K.seeds.length - 1 }, (_, i) => K.seeds.filter((_, bit) => ((i + 1) >> bit) & 1));
    for (const standing of subsets) withTree((dir) => put(dir, { ...pairBodies(K), ...Object.fromEntries(standing.map((p) => [p, EDIT(p)])) }), (dir) => {
      const [before, at, store] = [listing(dir), `standing ${standing.join(', ')}`, spawner()];
      const placed = K.seeds.filter((p) => !standing.includes(p)), r = run(dir, { spawnSync: store.spawnSync });
      const lines = [...K.seeds.map((p) => (placed.includes(p) ? L.placed(p) : L.replaced(p))), L.notAccepted(), HOOK_IF];
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines, spawns: store.calls.length, entries: 'entries' in r }, { token: placed.length > 0 ? 'seeded' : 'refreshed', failed: false, lines, spawns: 1, entries: false }, at);
      for (const p of K.seeds) assert.equal(sha(readFileSync(join(dir, KD, p))), sha(bundled(p)), `${at}: ${p} holds the bundled bytes`);
      for (const p of K.seeds) for (const d of importsOf(p)) assert.ok(existsSync(join(dir, KD, d)), `${at}: ${p} imports ${d}, present`);
      assert.deepEqual(listing(dir), [...new Set([...before, ...K.seeds])].sort(), `${at}: no other absent family file written`);
    });
  });

  it('one family file outside SEED_NAMES standing accepts the component: every other family file placed create-only, each absent module folder created, seeded, one hook-run line, no suite or support file', async () => {
    const K = await kitLayout(), outside = K.order.filter((p) => !K.seeds.includes(p)).sort()[0], others = K.order.filter((p) => p !== outside);
    withTree((dir) => put(dir, { ...pairBodies(K), [outside]: bundled(outside) }), (dir) => {
      const [links, renames] = [[], []];
      const record = (out, real) => (from, to) => {
        out.push(relative(join(dir, KD), to));
        return real(from, to);
      };
      const absent = [...new Set(others.map((p) => posix.dirname(p)))].filter((m) => !existsSync(join(dir, KD, m)));
      const r = run(dir, { link: record(links, linkSync), rename: record(renames, renameSync) });
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines, entries: 'entries' in r }, { token: 'seeded', failed: false, lines: [...others.map(L.placed), L.count(1), HOOK_ACCEPTED], entries: false });
      assert.deepEqual([links, renames], [others, []], 'every placement a create-only link, no replacing rename');
      assert.ok(absent.length > 0 && absent.every((m) => existsSync(join(dir, KD, m))), `each absent module folder created: ${absent.join(', ')}`);
      assert.deepEqual(listing(dir), [...K.pairs, ...K.order].sort(), 'no suite, support or skill-home file written');
      for (const p of others) assert.equal(sha(readFileSync(join(dir, KD, p))), sha(bundled(p)), `${p} holds the bundled bytes`);
    });
  });
});
