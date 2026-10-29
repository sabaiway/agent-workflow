// ensure-specs.test.mjs — the spec-layer ensure by its cells: every plain run writes the pair files, the
// files they import and the store root by the part scripts' rule (a prior refreshed, an edit replaced in
// place, an absent file placed, the store root seeded create-only) in the write order the pairs' imports,
// reader pair, checker pair, store root, with the part's lines and the one hook-run line; the single run token
// by precedence; and every fail-closed arm writing nothing (or saying exactly what it had already written).
// Real temp projects in the kit folder; a prior body is built through the deps.priors seam, since the catalog
// names no file there.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WRITE_TOKENS } from './ensure-vocabulary.mjs';

const { PRIOR_FILES, READER_PAIR, CHECKER_PAIR, SCRIPT_PRIORS } = await import('./script-priors.mjs');
const { ensureSpecs } = await import('./ensure-specs.mjs').catch(() => ({}));
const { SCRIPT_CHANNEL, fileLine, hookLine } = await import('./distribution-files/index.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const STORE = 'docs/ai/specs/index.md';
const TODAY = '2026-08-23';
const CUSTOM = '// my own body\n';

// withProject(table, fn) lays down one temp project: docs/ai, a package.json unless node is false, and
// the store root present | absent | wrong-kind; the scripts are the caller's.
const withProject = (table, fn, { node = true, prefix = 'ensure-specs-' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (table.store === 'present') {
      mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, STORE), '---\nkind: index\n---\n# mine\n');
    }
    if (table.store === 'wrong-kind') mkdirSync(join(dir, STORE), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const run = (dir, extra = {}) => ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY }, ...extra });
const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null);
const snapshot = (dir) => {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full), entry.isFile() ? readFileSync(full, 'utf8') : `<${entry.name}>`);
    }
  };
  walk(dir);
  return out;
};
const storeSeeded = (dir) => {
  const body = read(dir, STORE);
  assert.ok(body, 'the store root exists');
  assert.match(body, /^kind: index$/m);
  assert.equal(body.includes('{{'), false, 'every placeholder rendered');
  assert.match(body, new RegExp(`^lastUpdated: ${TODAY}$`, 'm'));
};

// The part scripts' lines, written out: a pair file that is not current, the current line, the store
// root's lines and the conditional (not-accepted) hook-run line.
const CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
const SHIPPED = 'matches a body an earlier release shipped';
const DIFFERS = 'differs from every body this kit knows it shipped';
const HOOK = 'if a commit hook runs the files written above, they may stop the next commit';
const DRY_HOOK = 'if a commit hook runs the files named above, writing them may stop the next commit';
const PARTWAY = 'the writes stopped PARTWAY — the 1 file(s) named above were already written and are NOT rolled back';
const HEADS = { prior: SHIPPED, custom: DIFFERS, absent: 'absent' };
const DONE = { prior: ['refreshed', 'refreshed to the bundled one'], custom: ['replaced', 'replaced by the bundled body'], absent: ['placed', 'placed from the bundled scripts'] };
// tail: 'written' | 'would' | 'refused' | 'stopped'
const pairLine = (name, state, tail = 'written', at = 'scripts') => {
  if (state === 'current') return `${at}/${name}: already the bundled body — nothing written`;
  const [verb, done] = DONE[state];
  const end = { written: done, would: `would be ${done}`, refused: `not ${verb}; its write was refused (above)`, stopped: `not ${verb}; the run stopped before it` }[tail];
  return `${at}/${name}: ${HEADS[state]} — ${end}${state === 'custom' ? `; an edit meant to last goes in ${CHANNEL}` : ''}`;
};
const STORE_LINES = {
  present: `${STORE}: already present — preserved byte-for-byte, nothing written`,
  written: `${STORE}: created from the bundled template (today's date rendered)`,
  would: `${STORE}: absent — would be created from the bundled template`,
  stopped: `${STORE}: absent — not created`,
};
// A table names a state per group of the kit folder — `shared` (the files the pairs import), `reader` and
// `checker`, in write order — as one state for the whole group or one per position, absent past the given ones.
const statesOf = (K, table) => [['shared', K.closure], ['reader', K.reader], ['checker', K.checker]]
  .flatMap(([group, paths]) => paths.map((p, i) => [p, typeof table[group] === 'string' ? table[group] : table[group]?.[i] ?? 'absent']));
// Every line of a run over `table` that lands every write (or, dry, would).
const linesFor = (K, table, dry = false) => {
  const states = statesOf(K, table);
  const writes = states.some(([, s]) => s !== 'current') || table.store !== 'present';
  return [...states.map(([p, s]) => pairLine(p, s, dry ? 'would' : 'written', KF)), STORE_LINES[table.store === 'present' ? 'present' : dry ? 'would' : 'written'], ...(writes ? [dry ? DRY_HOOK : HOOK] : [])];
};
const tokenFor = (K, table, dry = false) => {
  const states = statesOf(K, table).map(([, s]) => s);
  if (states.includes('absent') || table.store !== 'present') return dry ? 'would-seed' : 'seeded';
  return states.some((s) => s !== 'current') ? (dry ? 'would-refresh' : 'refreshed') : 'already-present';
};
// The retired words, judged by stems: no line says withheld, customized, kept aside, the user's yes,
// the block below or that the user edited a file; no pair line says preserved.
const RETIRED = /withh|customi|aside|\byes\b|\bblock\b|\bedited\b|carr(?:ies|ied) an edit/i;
const assertNoRetired = (r) => {
  assert.deepEqual(r.lines.filter((l) => RETIRED.test(l) || (l.startsWith('scripts/') && /preserv/i.test(l))), [], r.lines.join('\n'));
  assert.equal('entries' in r, false, 'no outcome carries an entries field');
};

// A recording writer: every write's temp file passes through writeFile, so its target is recorded in
// order; the `refuseAt`-th throws EACCES before it touches the tree, and `before` runs ahead of each.
const recorder = (dir, { refuseAt = 0, before = () => {} } = {}, order = []) => ({ order, deps: {
  today: TODAY,
  writeFile: (p, body, opts) => {
    if (order.push(relative(dir, String(p)).replace(/\.[0-9a-f]+\.tmp$/, '')) === refuseAt) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
    before(order.length);
    return writeFileSync(p, body, opts);
  },
} });
// The create-only link finds `name` already there with `bytes`.
const appearing = (name, bytes) => ({
  today: TODAY,
  link: (from, to) => {
    if (!String(to).endsWith(name)) return linkSync(from, to);
    writeFileSync(to, bytes);
    throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  },
});
const isFileLine = (l) => l.startsWith('scripts/') || l.startsWith(`${STORE}:`);

// ── the kit folder (revision 17): the reader pair is the spec-schema module's deployed entries, the checker pair
// the docs-size module's, each with its bundled import closure, all read from the KIT mirror's manifest in the cell.
const KF = 'scripts/agent-workflow';
const kb = (p) => readFileSync(join(BUNDLE, ...p.split('/')), 'utf8');
const IMPORT = /(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g;
const importsOf = (p, within) => [...kb(p).matchAll(IMPORT)].map(([, spec]) => posix.join(posix.dirname(p), spec)).filter((dep) => within.includes(dep));
// Dependencies before importers, code-unit order of the manifest path otherwise.
const writeOrder = (paths) => { const left = new Set(paths), out = []; while (left.size) { const next = [...left].sort().find((p) => importsOf(p, paths).every((d) => !left.has(d))); assert.ok(next, `an import cycle among ${[...left]}`); out.push(next); left.delete(next); } return out; };
const kitPairs = async () => {
  const { readFamily } = await import('../references/scripts/family.mjs');
  const deployed = readFamily(BUNDLE).filter((e) => e.role === 'deployed');
  const all = deployed.map((e) => e.path);
  const [reader, checker] = ['spec-schema', 'docs-size'].map((m) => writeOrder(deployed.filter((e) => e.module === m).map((e) => e.path)));
  const reached = new Set([...reader, ...checker]);
  for (const p of reached) for (const dep of importsOf(p, all)) reached.add(dep);
  const closure = writeOrder([...reached].filter((p) => !reader.includes(p) && !checker.includes(p)));
  assert.ok(reader.length > 1 && checker.length > 0 && closure.length > 1, 'two reader files, a checker and at least two files they import');
  return { reader, checker, closure, order: [...closure, ...reader, ...checker] };
};
const relK = (p) => `${KF}/${p}`;
const OLDK = (p) => `// an earlier ${p}\n`;
// The catalog seam: OLDK(path) catalogued under its manifest path as a body a release shipped.
const priorsK = (...paths) => [...SCRIPT_PRIORS, ...paths.map((file) => ({ file, digest: createHash('sha256').update(OLDK(file)).digest('hex') }))];
// One cell in the kit folder: each file of `K.order` current unless `states` names it prior | custom | absent.
const withKit = (K, states, fn, { store = 'absent' } = {}) => withProject({ store }, (dir) => {
  for (const p of K.order) {
    const state = states[p] ?? 'current';
    if (state === 'absent') continue;
    mkdirSync(dirname(join(dir, relK(p))), { recursive: true });
    writeFileSync(join(dir, relK(p)), state === 'current' ? kb(p) : state === 'prior' ? OLDK(p) : CUSTOM);
  }
  return fn(dir);
});
const allCurrentK = (dir, K) => { for (const p of K.order) assert.equal(read(dir, relK(p)), kb(p), `${p} is the bundled body`); };
// One table cell in the kit folder: each file current | prior | custom | absent | wrong-kind as `statesOf` reads it.
const withTable = (K, table, fn, opts) => withProject(table, (dir) => {
  for (const [p, state] of statesOf(K, table)) {
    if (state === 'absent') continue;
    if (state === 'wrong-kind') { mkdirSync(join(dir, relK(p)), { recursive: true }); continue; }
    mkdirSync(dirname(join(dir, relK(p))), { recursive: true });
    writeFileSync(join(dir, relK(p)), state === 'current' ? kb(p) : state === 'prior' ? OLDK(p) : CUSTOM);
  }
  return fn(dir);
}, opts);
// A run whose catalog seam lists OLDK of every file of the kit folder the spec layer judges.
const runK = (K, dir, extra = {}) => run(dir, { ...extra, deps: { today: TODAY, priors: priorsK(...K.order), ...extra.deps } });
const CONVERGED = { shared: 'current', reader: 'current', checker: 'current', store: 'present' };
// Every pair file loads in a child node: its imports resolve where the run left them.
const loads = (dir, paths) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', paths.map((p) => `await import(${JSON.stringify(pathToFileURL(join(dir, relK(p))).href)});`).join('\n')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
};
// Prior, edited and absent pair files, an absent and an edited file they import, and (by default) no store root.
const MIXED = (K) => ({ [K.closure[0]]: 'absent', [K.closure[1]]: 'custom', [K.reader[0]]: 'prior', [K.reader[1]]: 'absent', [K.checker[0]]: 'custom' });

describe('spec:distribution-files/S1 the write order and the failures of one plain run', () => {
  it('prior, edited and absent pair files at their deployed paths, an absent and an edited file the checker imports and an absent store root: the closure, the reader pair, the checker pair, the store root, and every pair file loads', async () => {
    const K = await kitPairs();
    withKit(K, MIXED(K), (dir) => {
      const { order, deps } = recorder(dir);
      const r = run(dir, { deps: { ...deps, priors: priorsK(K.reader[0]) } });
      const due = K.order.filter((p) => MIXED(K)[p]);
      assert.deepEqual([order, r.token], [[...due.map(relK), STORE], 'seeded'], r.lines.join('\n'));
      allCurrentK(dir, K);
      storeSeeded(dir);
      loads(dir, [...K.reader, ...K.checker]);
    });
  });
  it('a write refused at a file the pairs import leaves no reader or checker file written', async () => {
    const K = await kitPairs();
    withKit(K, MIXED(K), (dir) => {
      const r = run(dir, { deps: { ...recorder(dir, { refuseAt: 1 }).deps, priors: priorsK(K.reader[0]) } });
      assert.match(r.lines[0] ?? '', new RegExp(`^write-refused — ${relK(K.closure[0]).replace(/[.]/g, '\\.')}: `), r.lines.join('\n'));
      assert.deepEqual([r.token, ...[K.reader[0], K.reader[1], K.checker[0]].map((p) => read(dir, relK(p))), existsSync(join(dir, STORE))], ['failed', OLDK(K.reader[0]), null, CUSTOM, false]);
    });
  });
  it('a write refused at the second file: write-refused, the first written and kept, PARTWAY counting it, every later file not refreshed, replaced or placed, no store root', async () => {
    const K = await kitPairs();
    const states = MIXED(K);
    const due = K.order.filter((p) => states[p]);
    withKit(K, states, (dir) => {
      const r = run(dir, { deps: { ...recorder(dir, { refuseAt: 2 }).deps, priors: priorsK(K.reader[0]) } });
      const lines = K.order.map((p) => (states[p] ? pairLine(p, states[p], ['written', 'refused'][due.indexOf(p)] ?? 'stopped', KF) : pairLine(p, 'current', 'written', KF)));
      assert.deepEqual({ token: r.token, lines: r.lines }, { token: 'failed', lines: [`write-refused — ${relK(due[1])}: EACCES: refused`, ...lines, STORE_LINES.stopped, HOOK, PARTWAY] });
      assert.deepEqual([...due.map((p) => read(dir, relK(p))), existsSync(join(dir, STORE))], [kb(due[0]), CUSTOM, OLDK(K.reader[0]), null, CUSTOM, false]);
      assertNoRetired(r);
    });
  });
  it('a write refused at the store root: write-refused naming it, the pair file written and kept, the store line claims no reason, the hook-run line and PARTWAY', async () => {
    const K = await kitPairs();
    withKit(K, { [K.reader[0]]: 'prior' }, (dir) => {
      const r = run(dir, { deps: { ...recorder(dir, { refuseAt: 2 }).deps, priors: priorsK(K.reader[0]) } });
      const lines = K.order.map((p) => pairLine(p, p === K.reader[0] ? 'prior' : 'current', 'written', KF));
      assert.deepEqual({ token: r.token, lines: r.lines }, { token: 'failed', lines: [`write-refused — ${STORE}: EACCES: refused`, ...lines, STORE_LINES.stopped, HOOK, PARTWAY] });
      assert.deepEqual([read(dir, relK(K.reader[0])), existsSync(join(dir, STORE))], [kb(K.reader[0]), false]);
      assertNoRetired(r);
    });
  });
  it('beside the absent store root, an unreadable store template is template-unreadable with nothing written, the due pair and imported files included', async () => {
    const K = await kitPairs();
    const template = join(KIT_ROOT, 'references', 'templates', 'specs', 'index.md');
    const readFile = (p, ...rest) => { if (String(p) === template) throw Object.assign(new Error('EACCES: template'), { code: 'EACCES' }); return readFileSync(p, ...rest); };
    withKit(K, MIXED(K), (dir) => {
      const before = snapshot(dir);
      const r = run(dir, { deps: { today: TODAY, readFile, priors: priorsK(K.reader[0]) } });
      assert.match(r.lines[0] ?? '', /^template-unreadable — docs\/ai\/specs\/index\.md: /, r.lines.join('\n'));
      assert.deepEqual([r.token, snapshot(dir), r.lines.filter((l) => l === HOOK)], ['failed', before, []]);
    });
  });
  it('an edited or prior pair file changed after the survey and before its own write still ends the bundled bytes (last writer wins)', async () => {
    const K = await kitPairs();
    const states = { [K.reader[0]]: 'prior', [K.checker[0]]: 'custom' };
    withKit(K, states, (dir) => {
      const before = (n) => { if (n === 1) for (const p of Object.keys(states)) writeFileSync(join(dir, relK(p)), '// changed after the survey\n'); };
      const r = run(dir, { deps: { ...recorder(dir, { before }).deps, priors: priorsK(K.reader[0]) } });
      assert.deepEqual([r.token, r.failed], ['refreshed', false], r.lines.join('\n'));
      allCurrentK(dir, K);
    }, { store: 'present' });
  });
  it('an absent pair file that appears with the bundled body before its create-only write stands, and the later writes proceed', async () => {
    const K = await kitPairs();
    withKit(K, { [K.reader[1]]: 'absent', [K.checker[0]]: 'prior' }, (dir) => {
      const r = run(dir, { deps: { ...appearing(relK(K.reader[1]), kb(K.reader[1])), priors: priorsK(K.checker[0]) } });
      assert.equal(r.token, 'seeded', r.lines.join('\n'));
      assert.ok(r.lines.includes(`${relK(K.reader[1])}: appeared while this run was placing it — the bundled body stands, nothing written`), r.lines.join('\n'));
      allCurrentK(dir, K);
      storeSeeded(dir);
    });
  });
  it('one that appears with other bytes is race-unresolved: it stands, nothing further written, the later files named not refreshed and not created', async () => {
    const K = await kitPairs();
    withKit(K, { [K.reader[1]]: 'absent', [K.checker[0]]: 'prior' }, (dir) => {
      const r = run(dir, { deps: { ...appearing(relK(K.reader[1]), CUSTOM), priors: priorsK(K.checker[0]) } });
      assert.match(r.lines[0] ?? '', new RegExp(`^race-unresolved — ${relK(K.reader[1]).replace(/[.]/g, '\\.')}: `), r.lines.join('\n'));
      assert.deepEqual([r.token, read(dir, relK(K.reader[1])), read(dir, relK(K.checker[0])), existsSync(join(dir, STORE))], ['failed', CUSTOM, OLDK(K.checker[0]), false]);
      for (const line of [pairLine(K.checker[0], 'prior', 'stopped', KF), STORE_LINES.stopped]) assert.ok(r.lines.includes(line), `${line}\n${r.lines.join('\n')}`);
      assert.doesNotMatch(r.lines.join('\n'), /— (refreshed|placed|created) /, 'no line claims a write that did not happen');
    });
  });
});

describe('spec:distribution-files/S2 the hook-run line and the lines of the part scripts', () => {
  // → [the plain form's count, the dry form's count], each after every file line.
  const hookCounts = (r) => {
    const last = r.lines.findLastIndex(isFileLine);
    const at = r.lines.flatMap((l, i) => (l === HOOK || l === DRY_HOOK ? [i] : []));
    assert.ok(at.every((i) => i > last), `the hook-run line follows every file line:\n${r.lines.join('\n')}`);
    return [HOOK, DRY_HOOK].map((form) => r.lines.filter((l) => l === form).length);
  };
  it('once on a run that wrote, the store root alone included, failed or not; none on one that wrote none; the would-be form once on a dry run that would write', async () => {
    const K = await kitPairs();
    const rows = [
      ['a plain run that wrote a pair file', { ...CONVERGED, reader: ['prior', 'current'] }, () => ({}), [1, 0]],
      ['a plain run that wrote the store root alone', { ...CONVERGED, store: 'absent' }, () => ({}), [1, 0]],
      ['a failed run after one write', { ...CONVERGED, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), [1, 0]],
      ['a failed run before any write', { ...CONVERGED, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 1 }).deps }), [0, 0]],
      ['a plain run whose one placement found the store root standing', { ...CONVERGED, store: 'absent' }, () => ({ deps: appearing('index.md', '# theirs\n') }), [0, 0]],
      ['a plain run that wrote none', CONVERGED, () => ({}), [0, 0]],
      ['a dry run that would write', { ...CONVERGED, checker: ['custom'] }, () => ({ dryRun: true }), [0, 1]],
      ['a dry run that would write none', CONVERGED, () => ({ dryRun: true }), [0, 0]],
    ];
    const got = rows.map(([label, table, extra]) => [label, withTable(K, table, (dir) => hookCounts(runK(K, dir, extra(dir))))]);
    assert.deepEqual(got, rows.map(([label, , , want]) => [label, want]));
  });
  it("every line of a pair file that is not current is the index's fileLine, an edited one naming SCRIPT_CHANNEL, and the hook-run line is the index's hookLine", async () => {
    const K = await kitPairs();
    const table = { shared: 'current', reader: ['prior', 'absent'], checker: ['custom'], store: 'present' };
    const file = (path, state) => ({ rel: relK(path), path, state });
    for (const dryRun of [false, true]) withTable(K, table, (dir) => {
      const fate = dryRun ? undefined : 'written';
      assert.deepEqual(runK(K, dir, { dryRun }).lines, [...K.closure.map((p) => pairLine(p, 'current', 'written', KF)), fileLine(file(K.reader[0], 'prior'), fate, dryRun), fileLine(file(K.reader[1], 'absent'), fate, dryRun),
        fileLine(file(K.checker[0], 'custom'), fate, dryRun), STORE_LINES.present, hookLine(false, dryRun)]);
    });
    assert.deepEqual([hookLine(false, false), hookLine(false, true), SCRIPT_CHANNEL, fileLine(file(K.checker[0], 'custom'), 'written', false).endsWith(`; an edit meant to last goes in ${SCRIPT_CHANNEL}`)], [HOOK, DRY_HOOK, CHANNEL, true]);
  });
});

// The five cells a custom file once withheld, in the kit folder: the reader .mjs is the spec-schema module's
// spec-schema.mjs, the reader's second file its index, and the checker test's place is taken by the files the
// checker imports. The rule writes every one of them on one plain run.
const FORMERLY_WITHHELD = [
  ['a custom checker .mjs beside prior files it imports', { shared: 'prior', reader: 'current', checker: ['custom'] }],
  ['a custom reader .mjs before a prior checker and the prior files it imports', { shared: 'prior', reader: ['custom', 'current'], checker: ['prior'] }],
  ['a custom reader index beside an absent reader .mjs', { shared: 'prior', reader: ['absent', 'custom'], checker: ['absent'] }],
  ['a custom checker beside a present store root', { shared: 'current', reader: 'current', checker: ['custom'], store: 'present' }],
  ['a custom reader index beside a prior reader .mjs', { shared: 'prior', reader: ['prior', 'custom'], checker: ['prior'] }],
];
describe('spec:distribution-files/S6 the rule over every cell a custom file once withheld', () => {
  for (const [label, table] of FORMERLY_WITHHELD) {
    it(`${label}: one plain run leaves every pair file the bundled bytes, the edit's line naming its channel, the store root seeded where absent`, async () => {
      const K = await kitPairs();
      withTable(K, table, (dir) => {
        const r = runK(K, dir);
        assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines }, { token: tokenFor(K, table), failed: false, lines: linesFor(K, table) });
        allCurrentK(dir, K);
        if (table.store === 'present') assert.equal(read(dir, STORE), '---\nkind: index\n---\n# mine\n', 'a present store root stands byte for byte');
        else storeSeeded(dir);
        assertNoRetired(r);
      });
    });
  }
});

describe('spec:distribution-files/S7 the dry run, the quiet cells and the token', () => {
  const DRY = [{}, ...FORMERLY_WITHHELD.map(([, table]) => table), { shared: 'current', reader: ['prior', 'prior'], checker: 'current', store: 'present' }, { shared: 'current', reader: 'current', checker: 'current' }];
  for (const table of DRY) {
    it(`${JSON.stringify(table)}: the dry run gives the plain run's lines in their would-be forms and writes nothing`, async () => {
      const K = await kitPairs();
      withTable(K, table, (dir) => withTable(K, table, (twin) => {
        const before = snapshot(dir);
        const [dry, real] = [runK(K, dir, { dryRun: true }), runK(K, twin)];
        assert.deepEqual([dry.token, dry.lines, real.lines], [tokenFor(K, table, true), linesFor(K, table, true), linesFor(K, table)]);
        assert.equal(WRITE_TOKENS.includes(dry.token), false);
        assert.deepEqual(snapshot(dir), before);
        assertNoRetired(dry);
      }));
    });
  }
  it('a converged tree: already-present, nothing written, no hook-run line', async () => {
    const K = await kitPairs();
    withTable(K, CONVERGED, (dir) => {
      const before = snapshot(dir);
      for (const dryRun of [false, true]) assert.deepEqual(runK(K, dir, { dryRun }), { op: 'specs', token: 'already-present', failed: false, lines: [...K.order.map((p) => pairLine(p, 'current', 'written', KF)), STORE_LINES.present] });
      assert.deepEqual(snapshot(dir), before);
    });
  });
  it('one token by adjacent cells: failed over seeded, seeded over refreshed, refreshed over already-present, the dry forms, skipped-no-node-evidence unchanged; never customized-preserved', async () => {
    const K = await kitPairs();
    const present = CONVERGED;
    const rows = [
      ['failed over seeded: a placement refused after a refresh', { ...present, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), 'failed'],
      ['seeded over refreshed: an absent file placed beside a replaced edit', { ...present, reader: ['current', 'absent'], checker: ['custom'] }, () => ({}), 'seeded'],
      ['seeded by the store root alone', { ...present, store: 'absent' }, () => ({}), 'seeded'],
      ['refreshed by a replaced edit alone', { ...present, checker: ['custom'] }, () => ({}), 'refreshed'],
      ['refreshed over already-present', { ...present, reader: ['prior', 'current'] }, () => ({}), 'refreshed'],
      ['already-present', present, () => ({}), 'already-present'],
      ['would-seed in the place of seeded', { ...present, reader: ['current', 'absent'], checker: ['custom'] }, () => ({ dryRun: true }), 'would-seed'],
      ['would-refresh in the place of refreshed', { ...present, checker: ['custom'] }, () => ({ dryRun: true }), 'would-refresh'],
    ];
    const got = rows.map(([label, table, extra]) => [label, withTable(K, table, (dir) => runK(K, dir, extra(dir)).token)]);
    assert.deepEqual(got, rows.map(([label, , , token]) => [label, token]));
    assert.equal(withProject({}, (dir) => run(dir).token, { node: false }), 'skipped-no-node-evidence');
  });
});

// ── the table: one row per cell class, the token and the tree after ───────────────────────────────
// A prior is a body the catalog seam lists, standing for an earlier release's.
const both = (K) => (dir) => { allCurrentK(dir, K); storeSeeded(dir); };
const ROWS = [
  { label: 'everything absent (a pre-spec deployment with no checker at all)', table: {}, token: 'seeded', after: both },
  { label: 'everything current + store present (a converged tree)', table: CONVERGED, token: 'already-present', after: () => (dir, before) => assert.deepEqual(snapshot(dir), before) },
  { label: 'pairs current, store absent (only the root is missing)', table: { ...CONVERGED, store: 'absent' }, token: 'seeded', after: () => storeSeeded },
  { label: 'reader current, the checker and the files it imports on an earlier body, store present', table: { shared: 'prior', reader: 'current', checker: 'prior', store: 'present' }, token: 'refreshed', after: (K) => (dir) => allCurrentK(dir, K) },
  { label: 'reader absent, the checker and the files it imports on an earlier body', table: { shared: 'prior', checker: 'prior' }, token: 'seeded', after: both },
  { label: 'checker absent beside the current files it imports', table: { shared: 'current', reader: 'current', checker: ['absent'] }, token: 'seeded', after: both },
  { label: 'the reader pair on earlier bodies, the checker current, store present', table: { shared: 'current', reader: ['prior', 'prior'], checker: 'current', store: 'present' }, token: 'refreshed', after: (K) => (dir) => allCurrentK(dir, K) },
  { label: 'every script on an earlier body + store absent: the whole chain refreshes, then the store seeds', table: { shared: 'prior', reader: 'prior', checker: 'prior' }, token: 'seeded', after: both },
];

describe('the state table — the writes and the run token', () => {
  for (const row of ROWS) {
    it(row.label, async () => {
      const K = await kitPairs();
      withTable(K, row.table, (dir) => {
        const before = snapshot(dir);
        const r = runK(K, dir);
        assert.equal(r.token, row.token, r.lines.join('\n'));
        assert.equal(r.failed, false);
        row.after(K)(dir, before);
        const again = runK(K, dir);
        assert.equal(again.token, 'already-present', 'a re-run converges and claims nothing');
      });
    });
  }

  it("the spec-layer pairs are script-priors.mjs's READER_PAIR and CHECKER_PAIR: the catalog domain but the scripts family", () => {
    const family = 'install-git-hooks.mjs install-git-hooks.test.mjs install-git-hooks-repo-exec.test.mjs _expect-shim.mjs archive-caps.mjs archive-caps.test.mjs archive-changelog.mjs archive-changelog.test.mjs archive-conservation.test.mjs archive-decisions.mjs archive-decisions.test.mjs archive-issues.mjs archive-issues.test.mjs archiver-structure.test.mjs check-docs-size-cli.test.mjs check-docs-size-ensure.test.mjs markdown-blocks.mjs markdown-blocks.test.mjs migrate-gates-branches.test.mjs migrate-gates.mjs migrate-gates.test.mjs'.split(' ');
    assert.deepEqual([READER_PAIR, CHECKER_PAIR], [['spec-schema.mjs', 'spec-schema.test.mjs'], ['check-docs-size.mjs', 'check-docs-size.test.mjs']]);
    assert.deepEqual([...READER_PAIR, ...CHECKER_PAIR].sort(), PRIOR_FILES.filter((file) => !family.includes(file)).sort());
  });
});

describe('fail-closed arms', () => {
  // spec:node-evidence/S7 — the same three evidence arms as the scripts ensure, on the spec layer.
  it('a project with NO Node evidence is a stated skip naming every probe', () => {
    withProject({}, (dir) => {
      const r = run(dir);
      assert.equal(r.token, 'skipped-no-node-evidence');
      assert.equal(r.failed, false);
      assert.equal(existsSync(join(dir, 'scripts')), false);
      assert.match(r.lines.join('\n'), /probed package\.json and the kit-seeded scripts\/ files/);
    }, { node: false });
  });

  it('a deployed kit checker WITHOUT a package.json is Node evidence — the layer seeds', async () => {
    const K = await kitPairs();
    withTable(K, { checker: 'current' }, (dir) => {
      const r = runK(K, dir);
      assert.equal(r.token, 'seeded', r.lines.join('\n'));
      allCurrentK(dir, K);
      storeSeeded(dir);
    }, { node: false });
  });

  it('an UNREADABLE Node probe fails closed — nothing is written', async () => {
    withTable(await kitPairs(), { checker: 'prior' }, (dir) => {
      const before = snapshot(dir);
      const lstat = (p) => { if (p.endsWith('package.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return lstatSync(p); };
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY, lstat } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^node-evidence-unverifiable — scripts\/: whether Node runs here could not be read \(EACCES on package\.json\)/);
      assert.deepEqual(snapshot(dir), before);
    }, { node: false });
  });

  // `at` names the refused path from the kit-folder layout: a reader file, a file the checker imports, the store root.
  for (const [label, table, at] of [
    ['a DIRECTORY where the reader belongs', { reader: ['wrong-kind', 'absent'] }, (K) => relK(K.reader[0])],
    ['a DIRECTORY where a file the checker imports belongs', { shared: ['wrong-kind'], checker: ['prior'] }, (K) => relK(K.closure[0])],
    ['a DIRECTORY where the store root belongs', { ...CONVERGED, store: 'wrong-kind' }, () => STORE],
  ]) {
    it(`${label} fails loudly, naming the kind, and writes nothing`, async () => {
      const K = await kitPairs();
      withTable(K, table, (dir) => {
        const before = snapshot(dir);
        const r = runK(K, dir);
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], new RegExp(`^wrong-node-kind — ${at(K).replace(/[.]/g, '\\.')}: exists but is a directory`));
        assert.deepEqual(snapshot(dir), before);
      });
    });
  }

  it('a SYMLINKED store root is refused before any read', async () => {
    const K = await kitPairs();
    withTable(K, { ...CONVERGED, store: 'absent' }, (dir) => {
      mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
      symlinkSync(join(dir, 'package.json'), join(dir, STORE));
      const r = runK(K, dir);
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
    });
  });

  it('an unreadable bundled script fails closed and writes nothing', () => {
    withProject({}, (dir) => {
      const r = run(dir, { kitRoot: mkdtempSync(join(tmpdir(), 'ensure-specs-empty-')) });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^bundle-unreadable — scripts\/agent-workflow\/spec-schema\/[^:/]+\.mjs: /);
      assert.equal(existsSync(join(dir, 'scripts')), false);
    });
  });

  it('an unreadable DEPLOYED script throws (the CLI catch-all names it) and writes nothing', async () => {
    const K = await kitPairs();
    withTable(K, { shared: 'current', reader: 'current', checker: 'prior' }, (dir) => {
      const before = snapshot(dir);
      const deps = { readFile: (p, enc) => { if (String(p).endsWith(relK(K.checker[0])) && !String(p).startsWith(KIT_ROOT)) throw new Error('EACCES: deployed'); return readFileSync(p, enc); } };
      assert.throws(() => runK(K, dir, { deps }), /EACCES: deployed/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  // The store template is read and rendered BEFORE the first write: a kit whose template is missing
  // or carries a placeholder this op cannot render fails as template-unreadable with no script written.
  for (const [label, setup] of [
    ['missing', () => {}],
    ['carrying an unknown placeholder', (tpl) => writeFileSync(tpl, '---\nlastUpdated: {{DATE}}\nowner: {{OWNER}}\n---\n')],
  ]) {
    it(`a bundled store template ${label} is template-unreadable, and nothing is written`, async () => {
      const K = await kitPairs();
      withTable(K, { shared: 'current', reader: 'current', checker: 'current' }, (dir) => {
        const kit = mkdtempSync(join(tmpdir(), 'ensure-specs-kit-'));
        mkdirSync(join(kit, 'references', 'templates', 'specs'), { recursive: true });
        for (const p of K.order) {
          mkdirSync(dirname(join(kit, 'references', 'scripts', p)), { recursive: true });
          writeFileSync(join(kit, 'references', 'scripts', p), kb(p));
        }
        setup(join(kit, 'references', 'templates', 'specs', 'index.md'));
        const before = snapshot(dir);
        const r = runK(K, dir, { kitRoot: kit });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^template-unreadable — docs\/ai\/specs\/index\.md: /);
        assert.deepEqual(snapshot(dir), before);
        assert.doesNotMatch(r.lines.join('\n'), /— (copied|refreshed|created) /, 'no line claims a write that did not happen');
      });
    });
  }

  it('a refresh refused by the atomic core is write-refused with nothing else claimed', async () => {
    const K = await kitPairs();
    withTable(K, { shared: 'current', reader: 'current', checker: 'prior', store: 'present' }, (dir) => {
      const r = runK(K, dir, { deps: { rename: () => { throw new Error('EROFS: read-only'); } } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], new RegExp(`^write-refused — ${relK(K.checker[0]).replace(/[.]/g, '\\.')}: EROFS`));
      assert.equal(read(dir, relK(K.checker[0])), OLDK(K.checker[0]));
      assert.doesNotMatch(r.lines.join('\n'), /PARTWAY/);
    });
  });

  it('a file that appears under the seed stands, and a temp file the cleanup could not remove is named', async () => {
    const K = await kitPairs();
    withTable(K, { shared: 'current', reader: 'current', checker: 'current' }, (dir) => {
      const deps = {
        link: (from, to) => { writeFileSync(to, '# theirs\n'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
        rm: () => { throw new Error('EBUSY'); },
      };
      const r = runK(K, dir, { deps });
      assert.equal(r.token, 'already-present', r.lines.join('\n'));
      assert.equal(read(dir, STORE), '# theirs\n');
      assert.match(r.lines.join('\n'), /appeared while this run was seeding it/);
      assert.match(r.lines.join('\n'), /temp file could not be removed/);
    });
  });
});
