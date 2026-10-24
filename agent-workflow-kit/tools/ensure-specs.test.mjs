// ensure-specs.test.mjs — the spec-layer ensure by its cells: every plain run writes the four pair files
// and the store root by the part scripts' rule (a prior refreshed, an edit replaced in place, an absent
// file placed, the store root seeded create-only) in the write order reader pair, checker pair, store
// root, with the part's lines and the one hook-run line; the single run token by precedence; and every
// fail-closed arm writing nothing (or saying exactly what it had already written). Real temp projects;
// the fixture bytes are the shipped prior bodies.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WRITE_TOKENS } from './ensure-vocabulary.mjs';

const { PRIOR_FILES, READER_PAIR, CHECKER_PAIR } = await import('./script-priors.mjs');
const { ensureSpecs } = await import('./ensure-specs.mjs').catch(() => ({}));
const { SCRIPT_CHANNEL, fileLine, hookLine } = await import('./distribution-files/index.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const READER = ['spec-schema.mjs', 'spec-schema.test.mjs'];
const CHECKER = ['check-docs-size.mjs', 'check-docs-size.test.mjs'];
const STORE = 'docs/ai/specs/index.md';
const TODAY = '2026-08-23';
const CUSTOM = '// my own body\n';

const bundle = (name) => readFileSync(join(BUNDLE, name), 'utf8');
// One shipped prior body per refreshable script: the 4.5.1..4.5.4 / 4.0.0..4.5.4 checker pair and
// the 4.6.0..4.6.1 reader pair.
const PRIOR_DIR = {
  'check-docs-size.mjs': '4.5.1',
  'check-docs-size.test.mjs': '4.0.0',
  'spec-schema.mjs': '4.6.0',
  'spec-schema.test.mjs': '4.6.0',
};
const prior = (name) => readFileSync(join(FIXTURES, PRIOR_DIR[name], `${name}.txt`), 'utf8');

// withProject(table, fn) materializes one cell: each script current | prior | custom | absent |
// wrong-kind, the store root present | absent | wrong-kind.
const place = (dir, name, state) => {
  const path = join(dir, 'scripts', name);
  if (state === 'absent') return;
  if (state === 'wrong-kind') return mkdirSync(path, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(path, state === 'current' ? bundle(name) : state === 'prior' ? prior(name) : CUSTOM);
};
const withProject = (table, fn, { node = true, prefix = 'ensure-specs-' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    READER.forEach((name, i) => place(dir, name, table.reader?.[i] ?? 'absent'));
    CHECKER.forEach((name, i) => place(dir, name, table.checker?.[i] ?? 'absent'));
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
const allCurrent = (dir) => {
  for (const name of [...READER, ...CHECKER]) assert.equal(read(dir, `scripts/${name}`), bundle(name), `${name} is the bundled body`);
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
const pairLine = (name, state, tail = 'written') => {
  if (state === 'current') return `scripts/${name}: already the bundled body — nothing written`;
  const [verb, done] = DONE[state];
  const end = { written: done, would: `would be ${done}`, refused: `not ${verb}; its write was refused (above)`, stopped: `not ${verb}; the run stopped before it` }[tail];
  return `scripts/${name}: ${HEADS[state]} — ${end}${state === 'custom' ? `; an edit meant to last goes in ${CHANNEL}` : ''}`;
};
const STORE_LINES = {
  present: `${STORE}: already present — preserved byte-for-byte, nothing written`,
  written: `${STORE}: created from the bundled template (today's date rendered)`,
  would: `${STORE}: absent — would be created from the bundled template`,
  stopped: `${STORE}: absent — not created`,
};
const statesOf = (table) => [...READER.map((n, i) => [n, table.reader?.[i] ?? 'absent']), ...CHECKER.map((n, i) => [n, table.checker?.[i] ?? 'absent'])];
// Every line of a run over `table` that lands every write (or, dry, would).
const linesFor = (table, dry = false) => {
  const states = statesOf(table);
  const writes = states.some(([, s]) => s !== 'current') || table.store !== 'present';
  return [...states.map(([n, s]) => pairLine(n, s, dry ? 'would' : 'written')), STORE_LINES[table.store === 'present' ? 'present' : dry ? 'would' : 'written'], ...(writes ? [dry ? DRY_HOOK : HOOK] : [])];
};
const tokenFor = (table, dry = false) => {
  const states = statesOf(table).map(([, s]) => s);
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

describe('spec:distribution-files/S1 the write order and the failures of one plain run', () => {
  it('prior, edited and absent pair files and an absent store root: the reader pair, then the checker pair, then the store root', () => withProject({ reader: ['prior', 'absent'], checker: ['custom', 'prior'] }, (dir) => {
    const { order, deps } = recorder(dir);
    const r = run(dir, { deps });
    assert.deepEqual([order, r.token], [[...READER, ...CHECKER].map((n) => `scripts/${n}`).concat(STORE), 'seeded'], r.lines.join('\n'));
    allCurrent(dir);
    storeSeeded(dir);
  }));
  it('a write refused at the second file: write-refused, the first written and kept, PARTWAY counting it, every later file not refreshed, replaced or placed, no store root', () => withProject({ reader: ['prior', 'absent'], checker: ['custom', 'prior'] }, (dir) => {
    const r = run(dir, { deps: recorder(dir, { refuseAt: 2 }).deps });
    assert.deepEqual({ token: r.token, lines: r.lines }, { token: 'failed', lines: [`write-refused — scripts/${READER[1]}: EACCES: refused`, pairLine(READER[0], 'prior'), pairLine(READER[1], 'absent', 'refused'),
      pairLine(CHECKER[0], 'custom', 'stopped'), pairLine(CHECKER[1], 'prior', 'stopped'), STORE_LINES.stopped, HOOK, PARTWAY] });
    assert.deepEqual([read(dir, `scripts/${READER[0]}`), read(dir, `scripts/${READER[1]}`), read(dir, `scripts/${CHECKER[0]}`), read(dir, `scripts/${CHECKER[1]}`), existsSync(join(dir, STORE))], [bundle(READER[0]), null, CUSTOM, prior(CHECKER[1]), false]);
    assertNoRetired(r);
  }));
  it('a write refused at the store root: write-refused naming it, the pair file written and kept, the store line claims no reason, the hook-run line and PARTWAY', () => withProject({ reader: ['prior', 'current'], checker: ['current', 'current'] }, (dir) => {
    const r = run(dir, { deps: recorder(dir, { refuseAt: 2 }).deps });
    assert.deepEqual({ token: r.token, lines: r.lines }, { token: 'failed', lines: [`write-refused — ${STORE}: EACCES: refused`, pairLine(READER[0], 'prior'), pairLine(READER[1], 'current'), pairLine(CHECKER[0], 'current'), pairLine(CHECKER[1], 'current'), STORE_LINES.stopped, HOOK, PARTWAY] });
    assert.deepEqual([read(dir, `scripts/${READER[0]}`), existsSync(join(dir, STORE))], [bundle(READER[0]), false]);
    assertNoRetired(r);
  }));
  it('beside the absent store root, an unreadable store template is template-unreadable with nothing written, the due pair files included', () => withProject({ reader: ['prior', 'custom'], checker: ['absent', 'prior'] }, (dir) => {
    const kit = mkdtempSync(join(tmpdir(), 'ensure-specs-kit-'));
    try {
      mkdirSync(join(kit, 'references', 'scripts'), { recursive: true });
      mkdirSync(join(kit, 'references', 'templates', 'specs'), { recursive: true });
      for (const name of [...READER, ...CHECKER]) writeFileSync(join(kit, 'references', 'scripts', name), bundle(name));
      writeFileSync(join(kit, 'references', 'templates', 'specs', 'index.md'), '---\nowner: {{OWNER}}\n---\n');
      const before = snapshot(dir);
      const r = run(dir, { kitRoot: kit });
      assert.match(r.lines[0] ?? '', /^template-unreadable — docs\/ai\/specs\/index\.md: /, r.lines.join('\n'));
      assert.deepEqual([r.token, snapshot(dir), r.lines.filter((l) => l === HOOK)], ['failed', before, []]);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  }));
  it('an edited or prior pair file changed after the survey and before its own write still ends the bundled bytes (last writer wins)', () => withProject({ reader: ['custom', 'prior'], checker: ['prior', 'custom'], store: 'present' }, (dir) => {
    const before = (n) => { if (n === 1) for (const name of [READER[1], CHECKER[1]]) writeFileSync(join(dir, 'scripts', name), '// changed after the survey\n'); };
    const r = run(dir, { deps: recorder(dir, { before }).deps });
    assert.deepEqual([r.token, r.failed], ['refreshed', false], r.lines.join('\n'));
    allCurrent(dir);
  }));
  it('an absent pair file that appears with the bundled body before its create-only write stands, and the later writes proceed', () => withProject({ checker: ['prior', 'prior'] }, (dir) => {
    const r = run(dir, { deps: appearing(READER[0], bundle(READER[0])) });
    assert.equal(r.token, 'seeded', r.lines.join('\n'));
    assert.ok(r.lines.includes(`scripts/${READER[0]}: appeared while this run was placing it — the bundled body stands, nothing written`), r.lines.join('\n'));
    allCurrent(dir);
    storeSeeded(dir);
  }));
  it('one that appears with other bytes is race-unresolved: it stands, nothing further written, the later files named not placed, not refreshed and not created', () => withProject({ checker: ['prior', 'prior'] }, (dir) => {
    const r = run(dir, { deps: appearing(READER[0], CUSTOM) });
    assert.match(r.lines[0], /^race-unresolved — scripts\/spec-schema\.mjs: /);
    assert.deepEqual([r.token, read(dir, `scripts/${READER[0]}`), read(dir, `scripts/${READER[1]}`), read(dir, `scripts/${CHECKER[0]}`), existsSync(join(dir, STORE))], ['failed', CUSTOM, null, prior(CHECKER[0]), false]);
    for (const line of [pairLine(READER[1], 'absent', 'stopped'), pairLine(CHECKER[0], 'prior', 'stopped'), pairLine(CHECKER[1], 'prior', 'stopped'), STORE_LINES.stopped]) assert.ok(r.lines.includes(line), `${line}\n${r.lines.join('\n')}`);
    assert.doesNotMatch(r.lines.join('\n'), /— (refreshed|placed|created) /, 'no line claims a write that did not happen');
  }));
});

describe('spec:distribution-files/S2 the hook-run line and the lines of the part scripts', () => {
  const CONVERGED = { reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' };
  // → [the plain form's count, the dry form's count], each after every file line.
  const hookCounts = (r) => {
    const last = r.lines.findLastIndex(isFileLine);
    const at = r.lines.flatMap((l, i) => (l === HOOK || l === DRY_HOOK ? [i] : []));
    assert.ok(at.every((i) => i > last), `the hook-run line follows every file line:\n${r.lines.join('\n')}`);
    return [HOOK, DRY_HOOK].map((form) => r.lines.filter((l) => l === form).length);
  };
  it('once on a run that wrote, the store root alone included, failed or not; none on one that wrote none; the would-be form once on a dry run that would write', () => {
    const rows = [
      ['a plain run that wrote a pair file', { ...CONVERGED, reader: ['prior', 'current'] }, () => ({}), [1, 0]],
      ['a plain run that wrote the store root alone', { ...CONVERGED, store: 'absent' }, () => ({}), [1, 0]],
      ['a failed run after one write', { ...CONVERGED, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), [1, 0]],
      ['a failed run before any write', { ...CONVERGED, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 1 }).deps }), [0, 0]],
      ['a plain run whose one placement found the store root standing', { ...CONVERGED, store: 'absent' }, () => ({ deps: appearing('index.md', '# theirs\n') }), [0, 0]],
      ['a plain run that wrote none', CONVERGED, () => ({}), [0, 0]],
      ['a dry run that would write', { ...CONVERGED, checker: ['custom', 'current'] }, () => ({ dryRun: true }), [0, 1]],
      ['a dry run that would write none', CONVERGED, () => ({ dryRun: true }), [0, 0]],
    ];
    const got = rows.map(([label, table, extra]) => [label, withProject(table, (dir) => hookCounts(run(dir, extra(dir))))]);
    assert.deepEqual(got, rows.map(([label, , , want]) => [label, want]));
  });
  it("every line of a pair file that is not current is the index's fileLine, an edited one naming SCRIPT_CHANNEL, and the hook-run line is the index's hookLine", () => {
    const table = { reader: ['prior', 'absent'], checker: ['custom', 'current'], store: 'present' };
    const file = (name, state) => ({ rel: `scripts/${name}`, name, state });
    for (const dryRun of [false, true]) withProject(table, (dir) => {
      const fate = dryRun ? undefined : 'written';
      assert.deepEqual(run(dir, { dryRun }).lines, [fileLine(file(READER[0], 'prior'), fate, dryRun), fileLine(file(READER[1], 'absent'), fate, dryRun), fileLine(file(CHECKER[0], 'custom'), fate, dryRun),
        pairLine(CHECKER[1], 'current'), STORE_LINES.present, hookLine(false, dryRun)]);
    });
    assert.deepEqual([hookLine(false, false), hookLine(false, true), SCRIPT_CHANNEL, fileLine(file(CHECKER[0], 'custom'), 'written', false).endsWith(`; an edit meant to last goes in ${SCRIPT_CHANNEL}`)], [HOOK, DRY_HOOK, CHANNEL, true]);
  });
});

// The five cells a custom file once withheld: the rule writes every one of them on one plain run.
const FORMERLY_WITHHELD = [
  ['a custom checker .mjs beside a prior test', { reader: ['current', 'current'], checker: ['custom', 'prior'] }],
  ['a custom reader .mjs before a prior checker pair', { reader: ['custom', 'current'], checker: ['prior', 'prior'] }],
  ['a custom reader test beside an absent reader .mjs', { reader: ['absent', 'custom'], checker: ['absent', 'prior'] }],
  ['a custom checker beside a present store root', { reader: ['current', 'current'], checker: ['custom', 'current'], store: 'present' }],
  ['a custom reader test beside a prior reader .mjs', { reader: ['prior', 'custom'], checker: ['prior', 'prior'] }],
];
describe('spec:distribution-files/S6 the rule over every cell a custom file once withheld', () => {
  for (const [label, table] of FORMERLY_WITHHELD) {
    it(`${label}: one plain run leaves every pair file the bundled bytes, the edit's line naming its channel, the store root seeded where absent`, () => withProject(table, (dir) => {
      const r = run(dir);
      assert.deepEqual({ token: r.token, failed: r.failed, lines: r.lines }, { token: tokenFor(table), failed: false, lines: linesFor(table) });
      allCurrent(dir);
      if (table.store === 'present') assert.equal(read(dir, STORE), '---\nkind: index\n---\n# mine\n', 'a present store root stands byte for byte');
      else storeSeeded(dir);
      assertNoRetired(r);
    }));
  }
});

describe('spec:distribution-files/S7 the dry run, the quiet cells and the token', () => {
  const DRY = [{}, ...FORMERLY_WITHHELD.map(([, table]) => table), { reader: ['prior', 'prior'], checker: ['current', 'current'], store: 'present' }, { reader: ['current', 'current'], checker: ['current', 'current'] }];
  for (const table of DRY) {
    it(`${JSON.stringify(table)}: the dry run gives the plain run's lines in their would-be forms and writes nothing`, () => withProject(table, (dir) => withProject(table, (twin) => {
      const before = snapshot(dir);
      const [dry, real] = [run(dir, { dryRun: true }), run(twin)];
      assert.deepEqual([dry.token, dry.lines, real.lines], [tokenFor(table, true), linesFor(table, true), linesFor(table)]);
      assert.equal(WRITE_TOKENS.includes(dry.token), false);
      assert.deepEqual(snapshot(dir), before);
      assertNoRetired(dry);
    })));
  }
  it('a converged tree: already-present, nothing written, no hook-run line', () => withProject({ reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' }, (dir) => {
    const before = snapshot(dir);
    for (const dryRun of [false, true]) assert.deepEqual(run(dir, { dryRun }), { op: 'specs', token: 'already-present', failed: false, lines: [...[...READER, ...CHECKER].map((n) => pairLine(n, 'current')), STORE_LINES.present] });
    assert.deepEqual(snapshot(dir), before);
  }));
  it('one token by adjacent cells: failed over seeded, seeded over refreshed, refreshed over already-present, the dry forms, skipped-no-node-evidence unchanged; never customized-preserved', () => {
    const present = { reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' };
    const rows = [
      ['failed over seeded: a placement refused after a refresh', { ...present, reader: ['prior', 'absent'] }, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), 'failed'],
      ['seeded over refreshed: an absent file placed beside a replaced edit', { ...present, reader: ['current', 'absent'], checker: ['custom', 'current'] }, () => ({}), 'seeded'],
      ['seeded by the store root alone', { ...present, store: 'absent' }, () => ({}), 'seeded'],
      ['refreshed by a replaced edit alone', { ...present, checker: ['custom', 'current'] }, () => ({}), 'refreshed'],
      ['refreshed over already-present', { ...present, reader: ['prior', 'current'] }, () => ({}), 'refreshed'],
      ['already-present', present, () => ({}), 'already-present'],
      ['would-seed in the place of seeded', { ...present, reader: ['current', 'absent'], checker: ['custom', 'current'] }, () => ({ dryRun: true }), 'would-seed'],
      ['would-refresh in the place of refreshed', { ...present, checker: ['custom', 'current'] }, () => ({ dryRun: true }), 'would-refresh'],
    ];
    const got = rows.map(([label, table, extra]) => [label, withProject(table, (dir) => run(dir, extra(dir)).token)]);
    assert.deepEqual(got, rows.map(([label, , , token]) => [label, token]));
    assert.equal(withProject({}, (dir) => run(dir).token, { node: false }), 'skipped-no-node-evidence');
  });
});

// ── the table: one row per cell class, the token and the tree after ───────────────────────────────
const ROWS = [
  { label: 'everything absent (a pre-spec deployment with no checker at all)', table: {}, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
  { label: 'everything current + store present (a converged tree)', table: { reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' }, token: 'already-present', after: (dir, before) => assert.deepEqual(snapshot(dir), before) },
  { label: 'pairs current, store absent (only the root is missing)', table: { reader: ['current', 'current'], checker: ['current', 'current'] }, token: 'seeded', after: storeSeeded },
  { label: 'reader current, checker on a shipped prior, store present', table: { reader: ['current', 'current'], checker: ['prior', 'prior'], store: 'present' }, token: 'refreshed', after: allCurrent },
  { label: 'reader absent, checker on a shipped prior (the 4.5.4 deployment)', table: { checker: ['prior', 'prior'] }, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
  { label: 'checker .mjs absent beside a current test', table: { reader: ['current', 'current'], checker: ['absent', 'current'] }, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
  { label: 'the 4.6.x deployment: reader pair on the 4.6.0 bodies, checker current, store present', table: { reader: ['prior', 'prior'], checker: ['current', 'current'], store: 'present' }, token: 'refreshed', after: allCurrent },
  { label: 'reader prior + checker prior + store absent: the whole chain refreshes, then the store seeds', table: { reader: ['prior', 'prior'], checker: ['prior', 'prior'] }, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
];

describe('the state table — the writes and the run token', () => {
  for (const row of ROWS) {
    it(row.label, () => {
      withProject(row.table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir);
        assert.equal(r.token, row.token, r.lines.join('\n'));
        assert.equal(r.failed, false);
        row.after(dir, before);
        const again = run(dir);
        assert.equal(again.token, 'already-present', 'a re-run converges and claims nothing');
      });
    });
  }

  it("the spec-layer pairs are script-priors.mjs's READER_PAIR and CHECKER_PAIR: the catalog domain but the scripts family", () => {
    const family = 'install-git-hooks.mjs install-git-hooks.test.mjs install-git-hooks-repo-exec.test.mjs _expect-shim.mjs archive-caps.mjs archive-caps.test.mjs archive-changelog.mjs archive-changelog.test.mjs archive-conservation.test.mjs archive-decisions.mjs archive-decisions.test.mjs archive-issues.mjs archive-issues.test.mjs archiver-structure.test.mjs check-docs-size-cli.test.mjs check-docs-size-ensure.test.mjs markdown-blocks.mjs markdown-blocks.test.mjs migrate-gates-branches.test.mjs migrate-gates.mjs migrate-gates.test.mjs'.split(' ');
    assert.deepEqual([READER_PAIR, CHECKER_PAIR], [READER, CHECKER]);
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

  it('a deployed kit checker WITHOUT a package.json is Node evidence — the layer seeds', () => {
    withProject({ checker: ['current', 'current'] }, (dir) => {
      const r = run(dir);
      assert.equal(r.token, 'seeded', r.lines.join('\n'));
      allCurrent(dir);
      storeSeeded(dir);
    }, { node: false });
  });

  it('an UNREADABLE Node probe fails closed — nothing is written', () => {
    withProject({ checker: ['prior', 'prior'] }, (dir) => {
      const before = snapshot(dir);
      const lstat = (p) => { if (p.endsWith('package.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return lstatSync(p); };
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY, lstat } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^node-evidence-unverifiable — scripts\/: whether Node runs here could not be read \(EACCES on package\.json\)/);
      assert.deepEqual(snapshot(dir), before);
    }, { node: false });
  });

  for (const [label, table, rel] of [
    ['a DIRECTORY where the reader belongs', { reader: ['wrong-kind', 'absent'] }, 'scripts/spec-schema.mjs'],
    ['a DIRECTORY where the checker test belongs', { checker: ['prior', 'wrong-kind'] }, 'scripts/check-docs-size.test.mjs'],
    ['a DIRECTORY where the store root belongs', { reader: ['current', 'current'], checker: ['current', 'current'], store: 'wrong-kind' }, STORE],
  ]) {
    it(`${label} fails loudly, naming the kind, and writes nothing`, () => {
      withProject(table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir);
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], new RegExp(`^wrong-node-kind — ${rel.replace(/[.]/g, '\\.')}: exists but is a directory`));
        assert.deepEqual(snapshot(dir), before);
      });
    });
  }

  it('a SYMLINKED store root is refused before any read', () => {
    withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
      mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
      symlinkSync(join(dir, 'package.json'), join(dir, STORE));
      const r = run(dir);
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
    });
  });

  it('an unreadable bundled script fails closed and writes nothing', () => {
    withProject({}, (dir) => {
      const r = run(dir, { kitRoot: mkdtempSync(join(tmpdir(), 'ensure-specs-empty-')) });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^bundle-unreadable — scripts\/spec-schema\.mjs: /);
      assert.equal(existsSync(join(dir, 'scripts')), false);
    });
  });

  it('an unreadable DEPLOYED script throws (the CLI catch-all names it) and writes nothing', () => {
    withProject({ reader: ['current', 'current'], checker: ['prior', 'prior'] }, (dir) => {
      const before = snapshot(dir);
      const deps = { today: TODAY, readFile: (p, enc) => { if (String(p).endsWith('scripts/check-docs-size.mjs') && !String(p).startsWith(KIT_ROOT)) throw new Error('EACCES: deployed'); return readFileSync(p, enc); } };
      assert.throws(() => ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps }), /EACCES: deployed/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  // The store template is read and rendered BEFORE the first write: a kit whose template is missing
  // or carries a placeholder this op cannot render fails as template-unreadable with no script written.
  for (const [label, setup] of [
    ['missing', () => {}],
    ['carrying an unknown placeholder', (tpl) => writeFileSync(tpl, '---\nlastUpdated: {{DATE}}\nowner: {{OWNER}}\n---\n')],
  ]) {
    it(`a bundled store template ${label} is template-unreadable, and nothing is written`, () => {
      withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
        const kit = mkdtempSync(join(tmpdir(), 'ensure-specs-kit-'));
        mkdirSync(join(kit, 'references', 'templates', 'specs'), { recursive: true });
        for (const name of [...READER, ...CHECKER]) {
          mkdirSync(join(kit, 'references', 'scripts'), { recursive: true });
          writeFileSync(join(kit, 'references', 'scripts', name), bundle(name));
        }
        setup(join(kit, 'references', 'templates', 'specs', 'index.md'));
        const before = snapshot(dir);
        const r = run(dir, { kitRoot: kit });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^template-unreadable — docs\/ai\/specs\/index\.md: /);
        assert.deepEqual(snapshot(dir), before);
        assert.doesNotMatch(r.lines.join('\n'), /— (copied|refreshed|created) /, 'no line claims a write that did not happen');
      });
    });
  }

  it('a refresh refused by the atomic core is write-refused with nothing else claimed', () => {
    withProject({ reader: ['current', 'current'], checker: ['prior', 'prior'], store: 'present' }, (dir) => {
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY, rename: () => { throw new Error('EROFS: read-only'); } } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^write-refused — scripts\/check-docs-size\.mjs: EROFS/);
      assert.equal(read(dir, 'scripts/check-docs-size.mjs'), prior('check-docs-size.mjs'));
      assert.doesNotMatch(r.lines.join('\n'), /PARTWAY/);
    });
  });

  it('a file that appears under the seed stands, and a temp file the cleanup could not remove is named', () => {
    withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
      const deps = {
        today: TODAY,
        link: (from, to) => { writeFileSync(to, '# theirs\n'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
        rm: () => { throw new Error('EBUSY'); },
      };
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'already-present', r.lines.join('\n'));
      assert.equal(read(dir, STORE), '# theirs\n');
      assert.match(r.lines.join('\n'), /appeared while this run was seeding it/);
      assert.match(r.lines.join('\n'), /temp file could not be removed/);
    });
  });
});
