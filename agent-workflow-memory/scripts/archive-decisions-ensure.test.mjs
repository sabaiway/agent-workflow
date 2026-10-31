// Pins the ADR rotator's `--ensure-current` mode and the whole-file writes of every mode: scenarios S3-S13 of
// docs/ai/specs/memory/adr-navigator.md. The memory package's own suite, never deployed.
// Seams of runCli(argv, deps), each defaulting to node:fs:
//   writeFileSync(path, data, enc) — every file the rotator writes (each snapshot file, and the temporary file of
//     every whole-file write);
//   renameSync(from, to) — every rename (a temporary file onto its target; a record under another slug onto its
//     canonical name);
//   rmSync(path, opts) — every removal (a retired monolith, a leftover temporary file, a partial snapshot directory);
//   fsyncSync(fd) — every sync (a temporary file before its rename, then its directory).
// A whole-file write of target <dir>/<name> writes its temporary file in <dir> under a name that starts with
// `<name>.` and never ends in `.md` (e.g. decisions.md.4242-1a2b3c4d.tmp), then renames it onto the target.
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, renameSync, appendFileSync, fstatSync, writeSync, fsyncSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The rotator under test: memory's canon, or the byte-equal copy AW_ARCHIVE_DECISIONS names, so a mirror runs this suite too.
const ROTATOR = process.env.AW_ARCHIVE_DECISIONS;
const {
  runCli, HOT_REL, WARM_REL, COLD_REL, ADR_DIR_REL, NAV_REL, parseDecisionsText, explode, renderRecord, lineCountOf,
} = await import(ROTATOR ? pathToFileURL(ROTATOR).href : '../references/scripts/archives/index.mjs');

const tempDirs = [];
const makeRoot = () => { const dir = mkdtempSync(join(tmpdir(), 'ensure-')); tempDirs.push(dir); return dir; };
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true }); });

const fm = (cap) =>
  `---\ntype: reference\nlastUpdated: 2026-01-01\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n`;
const block = (id, extra) =>
  `## AD-${id} — Decision ${id}\n\n**Date:** 2026-01-01 · **Status:** Accepted\n\nbody of AD-${id}${extra ? `\n${extra}` : ''}`;
const tier = (cap, preamble, blocks) => `${fm(cap)}\n${preamble}\n\n${blocks.join('\n\n')}\n`;
const fits = (pre, blocks) => lineCountOf(tier(9999, pre, blocks)) + 50;
const recName = (id) => `AD-${id}-decision-${id}.md`;
const SPEC = 'docs/ai/pages/spec.md';
const PAGE = 'docs/ai/pages/p.md';
const SNAP = 'agent-workflow-adr-migration-snapshot-STAMP';
const snap = (root) => join(root, '.git', SNAP);

const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const hot = (root, blocks, cap = fits('# ADRs', blocks), pre = '# ADRs') => put(root, HOT_REL, tier(cap, pre, blocks));
const ids4 = (extra) => ['001', '002', '003', '004'].map((id, i) => block(id, i === 0 ? extra : undefined));
// HOT [001..004] from which exactly the k oldest move, plus the adr/ dir.
const hotK = (root, k, extra) => {
  const blocks = ids4(extra);
  hot(root, blocks, lineCountOf(tier(9999, '# ADRs', blocks.slice(k))));
  mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
};
const rec = (id, extra) => renderRecord(explode(parseDecisionsText(tier(999, '# T', [block(id, extra)]), 'x').entries, '2026-01-01')[0]);
const record = (root, id, { extra, name } = {}) => put(root, `${ADR_DIR_REL}/${name ?? recName(id)}`, rec(id, extra));
// `dead`, when given, ends both the HOT and the WARM preamble.
const legacy = (root, hotBlocks, warm, cold, cap, dead = '') => {
  hot(root, hotBlocks, cap, `# ADRs${dead}`);
  put(root, WARM_REL, tier(fits('# W', warm), `# W${dead}`, warm));
  if (cold) put(root, COLD_REL, tier(fits('# C', cold), '# C', cold));
};
const legacy4 = (root) => legacy(root, [block('005'), block('006')], [block('003'), block('004')], [block('001'), block('002')]);

const fakeGit = (root) => (cmd) => (cmd === 'git' ? { status: 0, stdout: `${join(root, '.git')}\n` } : { status: 1 });
const noGit = () => ({ status: 1 });

const run = (argv, root, o = {}) => {
  const out = [];
  const err = [];
  const calls = [];
  const code = runCli(argv, {
    root, log: (l) => out.push(l), logError: (l) => err.push(l), stamp: o.stamp ?? 'STAMP', snapshotFallbackBase: o.fallbackBase,
    regenerateIndex: (r, t) => { calls.push([r, t]); return { ok: true, detail: '' }; }, spawnSync: o.spawnSync ?? fakeGit(root), ...o.fs,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n'), calls };
};
const ens = (root, o = {}, today = '2026-07-09') => run(['--ensure-current', `--today=${today}`], root, o);
const nav = (root) => assert.equal(run(['--write-navigator', '--today=2026-07-09'], root).code, 0);
const checks = (root) => { const r = run(['--check'], root); assert.equal(r.code, 0, `--check: ${r.errText}`); };
const rerun = (root, argv = ['--ensure-current', '--today=2026-07-09']) => {
  const r = run(argv, root, { stamp: 'RERUN' });
  assert.equal(r.code, 0, `re-run ${argv.join(' ')}: ${r.errText}`);
  checks(root);
};

// Every FILE under root except the git dir: rel path -> `${mtimeMs}|${content}`.
const treeOf = (root) => {
  const map = new Map();
  for (const rel of readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = rel === '.git' || rel.startsWith('.git/') ? null : statSync(join(root, rel));
    if (st?.isFile()) map.set(rel, `${st.mtimeMs}|${readFileSync(join(root, rel), 'utf8')}`);
  }
  return map;
};
const recordFiles = (root) => readdirSync(join(root, ADR_DIR_REL)).filter((n) => /^AD-\d{3,}-/.test(n)).sort();
const idsOf = (root, rel) => parseDecisionsText(read(root, rel), rel).entries.map((e) => e.id);

// An fs error carries a code and no exitCode; a refusal carries exitCode 1, as the rotator's own do.
const fault = (shape) => Object.assign(new Error(`injected ${shape}`), shape === 'fs' ? { code: 'ENOSPC' } : { exitCode: 1 });
const failWrite = (hit, shape) => ({
  writeFileSync: (p, data, enc) => {
    if (!hit(String(p))) return writeFileSync(p, data, enc);
    writeFileSync(p, String(data).slice(0, 3), enc);
    throw fault(shape);
  },
});
const isTempOf = (target, p) => dirname(p) === dirname(target) && basename(p).startsWith(`${basename(target)}.`);
const failAt = (target, step, shape) => ({
  ...failWrite((p) => step === 'write' && isTempOf(target, p), shape),
  renameSync: (from, to) => {
    if (step === 'rename' && to === target && basename(String(from)).startsWith(`${basename(target)}.`)) throw fault(shape);
    return renameSync(from, to);
  },
});
const noTemp = (target) => !existsSync(dirname(target))
  || !readdirSync(dirname(target)).some((n) => n.startsWith(`${basename(target)}.`));

// The S3 store: a HOT that fits, two records and a fresh navigator.
const s3 = (root) => { hot(root, [block('005'), block('006')]); record(root, '001'); record(root, '002'); nav(root); };
// A HOT at exactly its maxLines whose blocks carry no blank line between them: within its cap, though its render is not.
const packed = (root) => { const t = tier(0, '# ADRs', ids4()).replace(/\n\n## /g, '\n## '); put(root, HOT_REL, t.replace('maxLines: 0', `maxLines: ${lineCountOf(t)}`)); nav(root); };

// spec:adr-navigator/S3
it('S3 a current store exits 0 printing already-current, changes no byte and never regenerates the index', () => {
  for (const seed of [s3, packed]) {
    const root = makeRoot();
    seed(root);
    const before = treeOf(root);
    for (const today of ['2026-07-09', '2027-03-01']) {
      const r = ens(root, {}, today);
      assert.equal(r.code, 0, r.errText);
      assert.equal(r.out.at(-1), 'already-current', `${seed.name}: ${r.text}`);
      assert.deepEqual(treeOf(root), before, `${seed.name}: tree changed at --today=${today}`);
      assert.ok(!existsSync(join(root, '.git')), 'a git-dir write on a current store');
      assert.equal(r.calls.length, 0, 'index regenerated');
    }
  }
});

// spec:adr-navigator/S4
it('S4 a retired monolith beside decisions.md is migrated, the snapshot named, the check passing', () => {
  const root = makeRoot();
  legacy4(root);
  const r = ens(root);
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'brought-current: migrated, navigator written');
  assert.ok(r.out.at(-2).includes(snap(root)), `snapshot dir not named: ${r.out.at(-2)}`);
  assert.ok(existsSync(snap(root)), 'snapshot dir missing');
  assert.ok(!existsSync(join(root, WARM_REL)) && !existsSync(join(root, COLD_REL)), 'a monolith remains');
  assert.deepEqual(readdirSync(join(root, ADR_DIR_REL)).sort(), [...['001', '002', '003', '004'].map(recName), 'log.md']);
  checks(root);
});

// spec:adr-navigator/S5
it('S5 a decisions.md over its cap is rotated and an inbound link points at its record', () => {
  const root = makeRoot();
  hotK(root, 1);
  nav(root);
  put(root, SPEC, 'see [AD-001](../decisions.md#ad-001--decision-001)\n');
  const r = ens(root);
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'brought-current: rotated, navigator written');
  assert.ok(existsSync(join(root, ADR_DIR_REL, recName('001'))), 'AD-001 record missing');
  assert.deepEqual(idsOf(root, HOT_REL), ['002', '003', '004']);
  assert.equal(read(root, SPEC), 'see [AD-001](../adr/AD-001-decision-001.md#ad-001--decision-001)\n');
  checks(root);
});

// spec:adr-navigator/S6
it('S6 a store whose only defect is a stale navigator gets the navigator alone written', () => {
  const root = makeRoot();
  s3(root);
  appendFileSync(join(root, NAV_REL), 'stale\n');
  const before = treeOf(root);
  const r = ens(root, {}, '2026-07-10');
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'brought-current: navigator written');
  const after = treeOf(root);
  assert.notEqual(after.get(NAV_REL), before.get(NAV_REL), 'navigator unchanged');
  assert.match(read(root, NAV_REL), /^lastUpdated: 2026-07-10$/m);
  [after, before].forEach((tree) => tree.delete(NAV_REL));
  assert.deepEqual(after, before, 'a file other than the navigator changed');
  assert.equal(r.calls.length, 1, 'index regenerated not exactly once');
  checks(root);
});

// spec:adr-navigator/S7
it('S7 no substrate exits 0 printing already-current; a matching ADR reference over it exits 1', () => {
  const root = makeRoot();
  put(root, 'docs/ai/notes.md', '# N\n');
  const before = treeOf(root);
  const r = ens(root);
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'already-current');
  assert.deepEqual(treeOf(root), before);
  assert.ok(!existsSync(join(root, ADR_DIR_REL)), 'adr/ created');
  assert.ok(!existsSync(join(root, '.git')), 'a git-dir write with no substrate');
  assert.equal(r.calls.length, 0, 'index regenerated');
  put(root, PAGE, '# P\nsee [x](../decisions.md#ad-001--a)\n');
  const before2 = treeOf(root);
  const r2 = ens(root);
  assert.equal(r2.code, 1, r2.errText);
  assert.ok(r2.errText.includes(`${PAGE}:2`), r2.errText);
  assert.deepEqual(treeOf(root), before2);
});

// spec:adr-navigator/S8
it('S8 an adr/ store with no decisions.md is never rotated and its navigator is written only when stale', () => {
  const root = makeRoot();
  record(root, '001');
  record(root, '002');
  nav(root);
  const before = treeOf(root);
  const r = ens(root);
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'already-current');
  assert.deepEqual(treeOf(root), before);
  assert.ok(!existsSync(join(root, HOT_REL)), 'decisions.md created');
  appendFileSync(join(root, NAV_REL), 'stale\n');
  const r2 = ens(root);
  assert.equal(r2.code, 0, r2.errText);
  assert.equal(r2.out.at(-1), 'brought-current: navigator written');
  assert.ok(!existsSync(join(root, HOT_REL)), 'decisions.md created');
  checks(root);
});

const big = block('005', Array(12).fill('more').join('\n'));
const bigCap = lineCountOf(tier(9999, '# ADRs', [big])) - 1;
const S9_ROWS = [
  { n: 1, seed: (root) => hot(root, [block('001'), '## Not an ADR\n\ntext']), code: 1 },
  { n: 2, seed: (root) => { hot(root, [block('005')]); record(root, '001'); record(root, '001', { name: 'AD-001-other.md' }); }, code: 1 },
  { n: 3, seed: (root) => { hotK(root, 1); record(root, '001', { extra: 'DIVERGENT' }); }, code: 1 },
  { n: 4, seed: (root) => put(root, WARM_REL, tier(fits('# W', [block('003')]), '# W', [block('003')])), code: 1 },
  { n: 5, seed: (root) => { put(root, WARM_REL, tier(fits('# W', [block('003')]), '# W', [block('003')])); mkdirSync(join(root, ADR_DIR_REL)); }, code: 1 },
  { n: 6, seed: (root) => { hotK(root, 1); record(root, '001', { name: 'AD-001-legacy-slug.md' }); put(root, PAGE, 'see [x](../adr/AD-001-legacy-slug.md)\n'); }, code: 1 },
  { n: 7, seed: (root) => legacy(root, [block('005')], [block('003')]), code: 1, o: (root) => ({ spawnSync: noGit, fallbackBase: join(root, 'snap') }) },
  { n: 8, seed: (root) => hot(root, [block('004'), big], bigCap), code: 1 },
  { n: 9, seed: (root) => legacy(root, [big], [block('003')], undefined, bigCap), code: 1 },
  { n: 10, seed: (root) => { hotK(root, 1); put(root, PAGE, '# P\nsee [x](../decisions.md#ad-999--gone)\n'); }, code: 1, at: PAGE },
  { n: 11, seed: (root) => hotK(root, 1, 'see [g](decisions.md#ad-999--gone)'), code: 1, at: HOT_REL },
  { n: 12, seed: (root) => legacy(root, [block('005')], [block('003', 'see [g](../decisions.md#ad-999--gone)')]), code: 1, at: WARM_REL },
  { n: 13, seed: (root) => hotK(root, 1, 'see [r](decisions.md#ad-004--decision-004)'), code: 1 },
  { n: 14, seed: (root) => { hotK(root, 1, 'see [r](adr/AD-000-x.md)'); record(root, '000', { name: 'AD-000-x.md' }); }, code: 1 },
  { n: 15, seed: (root) => legacy(root, [block('005')], [block('003', 'links [AD-005](../decisions.md#ad-005--decision-005)')]), code: 0 },
  // A dead link in text the move retires (a monolith's preamble, the HOT archive line) is not refused.
  { n: 16, seed: (root) => legacy(root, [block('005')], [block('003')], undefined, undefined, '\n> **Archive:** [x](decisions.md#ad-999--gone)'), code: 0 },
];

// spec:adr-navigator/S9
it('S9 every refusal the judgment predicts exits 1 with zero bytes changed in the work tree', () => {
  for (const row of S9_ROWS) {
    const root = makeRoot();
    row.seed(root);
    const before = treeOf(root);
    const r = ens(root, row.o ? row.o(root) : {});
    assert.equal(r.code, row.code, `row ${row.n}: ${r.errText}`);
    if (row.code !== 1) continue;
    assert.deepEqual(treeOf(root), before, `row ${row.n}: the work tree changed`);
    if (row.n === 7) assert.ok(!existsSync(join(root, 'snap')), 'row 7: a snapshot was written inside the root');
    if (row.at) {
      const line = read(root, row.at).split('\n').findIndex((l) => l.includes('ad-999')) + 1;
      assert.ok(r.errText.includes(`${row.at}:${line}`), `row ${row.n}: ${row.at}:${line} not named in ${r.errText}`);
    }
  }
});

// spec:adr-navigator/S10
it('S10 an interrupted move exits 3, a failure before any work-tree change exits 1, and a re-run completes', () => {
  const adr = (root, id) => join(root, ADR_DIR_REL, recName(id));
  const expect3 = (r, root, label) => {
    assert.equal(r.code, 3, `${label}: ${r.errText}`);
    assert.match(r.errText, /a re-run completes the move/, label);
  };
  for (const shape of ['fs', 'refusal']) {
    const root = makeRoot(); // (a) the migration fails after its first record write
    legacy4(root);
    const r = ens(root, { fs: failAt(adr(root, '002'), 'write', shape) });
    expect3(r, root, `(a) ${shape}`);
    assert.ok(r.errText.includes(snap(root)), `(a) ${shape}: snapshot dir not named`);
    rerun(root);
  }
  {
    const root = makeRoot(); // (b) the migration fails at the monolith removal
    legacy4(root);
    const rm = (p, o) => { if (p === join(root, WARM_REL)) throw fault('fs'); return rmSync(p, o); };
    const r = ens(root, { fs: { rmSync: rm } });
    assert.equal(r.code, 3, `(b): ${r.errText}`);
    rerun(root);
  }
  for (const shape of ['fs', 'refusal']) {
    const root = makeRoot(); // (c) the rotate fails at its second record write, whichever id it writes first
    hotK(root, 2);
    let seen = 0;
    const second = (p) => dirname(p) === join(root, ADR_DIR_REL) && /^AD-\d{3,}-.*\.md\./.test(basename(p)) && ++seen === 2;
    expect3(ens(root, { fs: failWrite(second, shape) }), root, `(c) ${shape}`);
    rerun(root);
  }
  {
    const root = makeRoot(); // (d) a record renamed to its canonical slug whose body write then fails
    hotK(root, 1);
    record(root, '001', { name: 'AD-001-legacy-slug.md' });
    const L = read(root, `${ADR_DIR_REL}/AD-001-legacy-slug.md`);
    const r = ens(root, { fs: failAt(adr(root, '001'), 'write', 'fs') });
    assert.equal(r.code, 3, `(d): ${r.errText}`);
    assert.deepEqual(recordFiles(root), [recName('001')]);
    assert.equal(read(root, `${ADR_DIR_REL}/${recName('001')}`), L, '(d): the canonical record lost its old bytes');
    rerun(root);
  }
  {
    const root = makeRoot(); // (e) the migration fails at the rename of its first record write
    legacy4(root);
    const before = treeOf(root);
    const r = ens(root, { fs: failAt(adr(root, '001'), 'rename', 'fs') });
    assert.equal(r.code, 1, `(e): ${r.errText}`);
    assert.ok(r.errText.includes(snap(root)), '(e): snapshot dir not named');
    assert.deepEqual(treeOf(root), before, '(e): the work tree changed');
  }
  {
    const root = makeRoot(); // (f) the closing check fails after the writes
    s3(root);
    appendFileSync(join(root, NAV_REL), 'stale\n');
    put(root, PAGE, '# P\n');
    const rename = (from, to) => { renameSync(from, to); if (to === join(root, NAV_REL)) appendFileSync(join(root, PAGE), 'see [x](../decisions.md#ad-999--gone)\n'); };
    const r = ens(root, { fs: { renameSync: rename } });
    assert.equal(r.code, 3, `(f): ${r.errText}`);
    assert.match(r.errText, /written and does not pass/);
    assert.ok(r.errText.includes(`${PAGE}:2`), `(f): ${r.errText}`);
    assert.ok(!r.out.some((l) => /^(already-current|brought-current)/.test(l)), '(f): a summary line was printed');
  }
});

// spec:adr-navigator/S11
it('S11 a git-dir snapshot base failing partway leaves no partial directory and the temp-dir snapshot is named', () => {
  const flat = 'docs__ai__history__decisions-archive.md';
  {
    const root = makeRoot();
    const fallback = makeRoot();
    legacy(root, [block('005')], [block('003')]);
    mkdirSync(join(snap(root), flat), { recursive: true });
    const r = run(['--migrate', '--apply', '--today=2026-07-09'], root, { fallbackBase: fallback });
    assert.equal(r.code, 0, `(a): ${r.errText}`);
    assert.ok(!existsSync(snap(root)), '(a): the partial git-dir snapshot directory remains');
    assert.ok(r.text.includes(join(fallback, SNAP)) && !r.text.includes(snap(root)), `(a): fallback snapshot not the one named: ${r.text}`);
  }
  {
    const root = makeRoot();
    const fallback = makeRoot();
    legacy(root, [block('005')], [block('003')]);
    const write = (p, data, enc) => {
      if (String(p) === join(snap(root), flat)) throw fault('fs');
      return writeFileSync(p, data, enc);
    };
    const r = ens(root, { fallbackBase: fallback, fs: { writeFileSync: write } });
    assert.equal(r.code, 0, `(b): ${r.errText}`);
    assert.ok(!existsSync(snap(root)), '(b): the partial git-dir snapshot directory remains');
    assert.ok(String(r.out.at(-2)).includes(join(fallback, SNAP)) && !r.text.includes(snap(root)), `(b): fallback snapshot not the one named: ${r.text}`);
  }
});

const KINDS = { record: `${ADR_DIR_REL}/${recName('001')}`, rewrite: SPEC, navigator: NAV_REL, hot: HOT_REL };
const rotateFx = (root) => { hotK(root, 1); nav(root); put(root, SPEC, 'see [AD-001](../decisions.md#ad-001--decision-001)\n'); };
const migrateFx = (root) => { legacy4(root); put(root, SPEC, 'see [AD-003](../history/decisions-archive.md#ad-003--decision-003)\n'); };
const navFx = (root) => { hot(root, [block('005')]); record(root, '001'); nav(root); appendFileSync(join(root, NAV_REL), 'stale\n'); };
const ALL = Object.keys(KINDS);
const S12_MODES = [
  { argv: [], fx: rotateFx, kinds: ALL, label: 'rotate' },
  { argv: ['--migrate', '--apply'], fx: migrateFx, kinds: ALL, label: 'migrate' },
  { argv: ['--write-navigator'], fx: navFx, kinds: ['navigator'], label: 'write-navigator' },
  { argv: ['--ensure-current'], fx: rotateFx, kinds: ALL, label: 'ensure-current rotate' },
  { argv: ['--ensure-current'], fx: migrateFx, kinds: ALL, label: 'ensure-current migrate' },
];

// spec:adr-navigator/S12
it('S12 a failure at the temporary write or the rename leaves the old bytes and no temporary file, and a re-run completes', () => {
  for (const mode of S12_MODES) {
    for (const kind of mode.kinds) {
      for (const step of ['write', 'rename']) {
        const label = `${mode.label} × ${kind} × ${step}`;
        const root = makeRoot();
        mode.fx(root);
        const target = join(root, KINDS[kind]);
        const old = existsSync(target) ? readFileSync(target, 'utf8') : null;
        const argv = [...mode.argv, '--today=2026-08-01'];
        const r = run(argv, root, { fs: failAt(target, step, 'fs') });
        assert.equal(existsSync(target) ? readFileSync(target, 'utf8') : null, old, `${label}: the target lost its old bytes`);
        assert.ok(noTemp(target), `${label}: a temporary file remains`);
        if (mode.argv[0] === '--ensure-current') assert.equal(r.code, kind === 'record' ? 1 : 3, `${label}: ${r.errText}`);
        else assert.notEqual(r.code, 0, `${label}: exited 0`);
        rerun(root, argv);
      }
    }
  }
});

// spec:adr-navigator/S13
it('S13 --ensure-current beside another mode flag is a usage error naming the combination and the mode', () => {
  const root = makeRoot();
  for (const flag of ['--check', '--migrate', '--apply', '--write-navigator', '--dry-run']) {
    for (const argv of [['--ensure-current', flag], [flag, '--ensure-current']]) {
      const r = run(argv, root);
      assert.doesNotMatch(r.errText, /Unknown argument/, `${argv.join(' ')}: ${r.errText}`);
      assert.equal(r.code, 2, `${argv.join(' ')}: ${r.errText}`);
      const first = r.errText.split('\n')[0];
      assert.ok(first.includes('--ensure-current') && first.includes(flag), `first stderr line: ${first}`);
      assert.match(r.errText, /Usage: archive-decisions\.mjs[^\n]*--ensure-current/);
    }
  }
});

const staleNav = (root) => { s3(root); appendFileSync(join(root, NAV_REL), 'stale\n'); };

// Windows' FlushFileBuffers refuses a read-only handle (EPERM), a directory's included; a zero-byte write refuses a
// read-only file handle the same way on every OS.
it('a whole-file write syncs its temporary file through a writable descriptor, as Windows requires', () => {
  const root = makeRoot();
  staleNav(root);
  const synced = [];
  const fsync = (fd) => {
    if (fstatSync(fd).isDirectory()) throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });
    writeSync(fd, Buffer.alloc(0));
    synced.push(fd);
    return fsyncSync(fd);
  };
  const r = ens(root, { fs: { fsyncSync: fsync } });
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'brought-current: navigator written');
  assert.ok(synced.length > 0, 'no sync went through deps.fsyncSync');
});

it('a temporary file a killed run left under this pid never stops the re-run', () => {
  const root = makeRoot();
  staleNav(root);
  put(root, `${NAV_REL}.${process.pid}.tmp`, 'partial');
  const r = ens(root);
  assert.equal(r.code, 0, r.errText);
  assert.equal(r.out.at(-1), 'brought-current: navigator written');
  checks(root);
});

it('a temporary name another writer holds keeps its bytes, and the run exits 1', () => {
  const root = makeRoot();
  staleNav(root);
  let taken = null;
  const write = (p, data, o) => {
    if (taken === null && isTempOf(join(root, NAV_REL), String(p))) { taken = String(p); writeFileSync(p, 'foreign'); }
    return writeFileSync(p, data, o);
  };
  const r = ens(root, { fs: { writeFileSync: write } });
  assert.equal(r.code, 1, r.errText);
  assert.equal(readFileSync(taken, 'utf8'), 'foreign');
});

it('a partial snapshot directory the rotator cannot remove is named when no snapshot base succeeds', () => {
  const root = makeRoot();
  legacy(root, [block('005')], [block('003')]);
  const write = (p, data, enc) => {
    if (String(p).endsWith(`${SNAP}/docs__ai__history__decisions-archive.md`)) throw fault('fs');
    return writeFileSync(p, data, enc);
  };
  const rm = (p, o) => { if (String(p) === snap(root)) throw fault('fs'); return rmSync(p, o); };
  const r = ens(root, { fallbackBase: makeRoot(), fs: { writeFileSync: write, rmSync: rm } });
  assert.equal(r.code, 1, r.errText);
  assert.match(r.errText, /its partial directory was left: injected fs/);
});

// The script tree a deployment copies from: the canon, or the tree AW_ARCHIVE_DECISIONS's <tree>/archives/ file sits in.
const TREE = ROTATOR ? dirname(dirname(ROTATOR)) : fileURLToPath(new URL('../references/scripts/', import.meta.url));
const KIT = 'scripts/agent-workflow';
const deploy = (root, modules) => modules.forEach((m) => cpSync(join(TREE, m), join(root, KIT, m), { recursive: true, filter: (src) => !src.endsWith('.test.mjs') }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const node = (args) => spawnSync(process.execPath, args, { cwd: makeRoot(), encoding: 'utf8', env });
const deployed = (root, args) => node([join(root, KIT, 'archives', 'archive-decisions.mjs'), ...args]);
const SPECIFIERS = [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g, /\bimport\s*(['"])([^'"\n]+)\1/g, /\bimport\(\s*(['"])([^'"\n]+)\1\s*[,)]/g];

it('S14 a deployed rotator runs the deployed docs checker when it stands, notes the stable command when it fails or is absent, and prints its own commands as the stable command (spec:adr-navigator/S14)', () => {
  const INDEX = join('docs', 'ai', 'index.md');
  const stands = makeRoot();
  deploy(stands, ['archives', 'shared', 'docs-size', 'spec-schema']);
  hot(stands, [block('005')]);
  const w = deployed(stands, ['--write-navigator', '--today=2026-07-09']);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.ok(existsSync(join(stands, INDEX)), `the deployed docs checker wrote no index: ${w.stdout}${w.stderr}`);
  const fresh = node([join(stands, KIT, 'docs-size', 'check-docs-size.mjs'), '--check-index', `--root=${stands}`]);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);

  const [absent, fails] = [makeRoot(), makeRoot()].map((root) => { deploy(root, ['archives', 'shared']); hot(root, [block('005')]); return root; });
  put(fails, `${KIT}/docs-size/check-docs-size.mjs`, 'process.exit(3);\n');
  for (const [root, upgrade] of [[absent, true], [fails, false]]) {
    const r = deployed(root, ['--write-navigator', '--today=2026-07-09']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(root, NAV_REL)) && !existsSync(join(root, INDEX)), `the navigator was not written, or an index was: ${r.stderr}`);
    const note = r.stderr.split('\n').find((line) => line.includes('docs/ai/index.md NOT regenerated')) ?? '';
    assert.match(note, upgrade ? /^(?!.*docs-size\/|.*check-docs-size).*\bupgrade\b.*node scripts\/agent-workflow\/run\.mjs docs-size --write-index(?![\w-])/ : /^(?!.*docs-size\/|.*check-docs-size|.*upgrade).*node scripts\/agent-workflow\/run\.mjs docs-size --write-index(?![\w-])/, r.stderr);
  }

  const source = readFileSync(join(TREE, 'archives', 'archive-decisions.mjs'), 'utf8');
  const specifiers = SPECIFIERS.flatMap((re) => [...source.matchAll(re)].map((m) => m[2]));
  assert.ok(specifiers.length > 0, 'no import found in the rotator — the scan is vacuous');
  assert.deepEqual(specifiers.filter((s) => s.includes('docs-size')), [], 'the rotator imports a file of the docs-size module');

  const monolith = makeRoot();
  deploy(monolith, ['archives', 'shared']);
  legacy(monolith, [block('005')], [block('003')]);
  const overCap = makeRoot();
  deploy(overCap, ['archives', 'shared']);
  hotK(overCap, 1);
  const CMD = 'node scripts/agent-workflow/run.mjs archive-decisions';
  for (const [root, args, commands] of [[monolith, ['--check'], [`${CMD} --migrate --apply`]], [overCap, ['--check'], [CMD, `${CMD} --write-navigator`]], [monolith, ['--today=2026-07-09'], [`${CMD} --migrate --apply`]]]) {
    const c = deployed(root, args);
    assert.equal(c.status, 1, c.stdout + c.stderr);
    assert.deepEqual([...c.stderr.matchAll(/`(node [^`]+)`/g)].map((m) => m[1]), commands, c.stderr);
  }
});
