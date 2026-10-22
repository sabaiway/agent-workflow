// scripts.test.mjs — the upgrade's `scripts` op by its cells, from the component to the shipped text.
// The op's leaf and the index's re-export are imported dynamically, so a tree without them fails each
// cell, never the load.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../ensure-configs.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { BUNDLED_SCRIPT_NAMES } from '../node-evidence.mjs';
import { INSTALLER_SET, SCRIPT_PRIORS } from '../script-priors.mjs';

const { ensureScripts, SCRIPT_CHANNEL, LOCAL_HOOK_CHANNEL, DECISIONS_GROUP } = await import('./scripts.mjs').catch(() => ({}));
const { ensureScripts: indexEnsureScripts } = await import('./index.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
// The family in write order: the installer set, then every other family name in code-unit order.
const ORDER = ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs', '_expect-shim.mjs', 'archive-caps.mjs',
  'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs', 'archive-conservation.test.mjs', 'archive-decisions.mjs',
  'archive-decisions.test.mjs', 'archive-issues.mjs', 'archive-issues.test.mjs', 'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs',
  'check-docs-size-ensure.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs', 'migrate-gates-branches.test.mjs', 'migrate-gates.mjs', 'migrate-gates.test.mjs'];
const PAIRS = ['spec-schema.mjs', 'spec-schema.test.mjs', 'check-docs-size.mjs', 'check-docs-size.test.mjs'];
const [SET, LAST, D] = [[...INSTALLER_SET], ORDER.at(-1), 'd'.repeat(64)];
const PRIOR_AT = { 'install-git-hooks.mjs': '4.0.0', 'install-git-hooks.test.mjs': '7.2.0', 'install-git-hooks-repo-exec.test.mjs': '4.0.0' };
const bundled = (n) => readFileSync(join(BUNDLE, n));
const prior = (n) => readFileSync(join(KIT, 'test', 'fixtures', 'script-priors', PRIOR_AT[n], `${n}.txt`));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);
// The catalog seam: OLD(name) catalogued as a body a release shipped, for names with no row of their own.
const priorsWith = (...names) => [...SCRIPT_PRIORS, ...names.map((file) => ({ file, digest: sha(OLD(file)) }))];
const PRIORS = Object.fromEntries(SET.map((n) => [n, prior(n)]));
const PAIR_BODIES = Object.fromEntries(PAIRS.map((n) => [n, bundled(n)]));
const rel = (n) => `scripts/${n}`;

const SHIPPED = 'matches a body an earlier release shipped';
const L = {
  refreshed: (n) => `${rel(n)}: ${SHIPPED} — refreshed to the bundled one`,
  edited: (n) => `${rel(n)}: differs from every body this kit knows it shipped — left as it stands until the user's yes keeps it aside and replaces it (the block below)`,
  absent: (n) => `${rel(n)}: absent — the user's yes places the bundled body (the block below)`,
  waits: (n) => `${rel(n)}: left as it stands; the user's yes is asked once the ADR-store layout reads`,
  count: (k) => `scripts/: ${k} other kit scripts are already the bundled body — nothing written`,
  group: (layout) => `scripts/: archive-decisions.mjs, archive-decisions.test.mjs and archiver-structure.test.mjs are held back while this project is on the older ADR layout (${layout}) — run the opt-in /agent-workflow-kit migrate-adr-store (it previews, and never commits); the next upgrade judges them`,
  partway: (k) => `the writes stopped PARTWAY — the ${k} file(s) named above were already written and are NOT rolled back`,
};
const SURVEY_RACE = 'race-unresolved — the kit scripts to place or replace are not the set the yes was given for (another set or other bytes), so nothing was written';
const channelOf = (n) => (n === SET[0] ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL);
const absentEntry = (n) => ({ rel: rel(n), absent: true, channel: channelOf(n), hookRun: true });
const editedEntry = (n, bytes = EDIT(n)) => ({ rel: rel(n), sha256: sha(bytes), bytes, channel: channelOf(n), hookRun: true });

const put = (dir, bodies) => { mkdirSync(join(dir, 'scripts'), { recursive: true }); for (const [n, body] of Object.entries(bodies)) if (body !== null) writeFileSync(join(dir, 'scripts', n), body); };
// A temp project (package.json unless node is false, docs/ai). `bodies` maps a family name to its bytes or
// null (absent), every other family name on its bundled body; `bodies` null leaves scripts/ to `setup`.
const withTree = (bodies, fn, { node = true, setup = () => {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-op-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (bodies) put(dir, Object.fromEntries(ORDER.map((n) => [n, n in bodies ? bodies[n] : bundled(n)])));
    setup(dir);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
// Every file under `dir`, rel → base64 bytes (a link as `<link>`): "nothing written" is asserted against it.
const snapshot = (dir, at = dir, out = {}) => {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    if (e.isDirectory()) snapshot(dir, join(at, e.name), out);
    else out[relative(dir, join(at, e.name))] = e.isFile() ? readFileSync(join(at, e.name), 'base64') : '<link>';
  }
  return out;
};
const bytesOf = (dir, n) => (existsSync(join(dir, 'scripts', n)) ? readFileSync(join(dir, 'scripts', n)) : null);
const holds = (dir, want) => { for (const [n, body] of Object.entries(want)) assert.deepEqual(bytesOf(dir, n), body, `${n} holds the expected body`); };
const run = (dir, opts = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, ...opts });
const spy = (paths) => (p, ...rest) => { paths.push(String(p)); return readFileSync(p, ...rest); };
const oldLayout = (dir) => { mkdirSync(join(dir, 'docs', 'ai', 'history')); writeFileSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md'), '# archive\n'); };
const unrotated = (dir) => mkdirSync(join(dir, 'docs', 'ai', 'adr'));
// A recording writer: each atomic publish (rename) and create-only publish (link) records its target name,
// the `refuseAt`-th one throws EACCES before it touches the tree.
const recorder = (dir, { refuseAt = 0 } = {}, order = []) => {
  const record = (real) => (from, to) => {
    if (order.push(relative(join(dir, 'scripts'), to)) === refuseAt) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
    return real(from, to);
  };
  return { order, deps: { rename: record(renameSync), link: record(linkSync) } };
};

const cli = (dir, flags = [], ctx = {}) => main(['--reconcile', ...flags, '--cwd', dir], ctx);
const tokensOf = (out) => [...out.matchAll(/^ {2}([a-z-]+): ([a-z-]+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
const detailsOf = (out) => out.split('\n').filter((l) => l.startsWith('      ')).map((l) => l.slice(6));
const digestOf = (out) => out.match(/--replace-custom ([0-9a-f]{64})/)?.[1];
const blockRels = (out) => [...out.matchAll(/^ {2}(\S+): (?:carries an edit — on the user's yes|absent — the user's yes places)/gm)].map((m) => m[1]);
const keptAt = (digest, n) => `.agent-workflow/kept-aside/${digest.slice(0, 16)}/scripts/${n}`;

describe('spec:distribution-files/S13 the scripts component, judged before anything else is read', () => {
  it('no Node evidence: skipped-no-node-evidence and no path read; the index re-exports the op', () => withTree(null, (dir) => {
    const paths = [];
    assert.deepEqual([run(dir, { deps: { readFile: spy(paths) } }).token, paths, typeof indexEnsureScripts, indexEnsureScripts === ensureScripts], ['skipped-no-node-evidence', [], 'function', true]);
  }, { node: false }));
  it('no scripts/, an empty one, or one holding only the four pair files: not-placed, one line, no entry, nothing written', () => {
    for (const setup of [() => {}, (dir) => mkdirSync(join(dir, 'scripts')), (dir) => put(dir, PAIR_BODIES)]) withTree(null, (dir) => {
      const before = snapshot(dir);
      assert.deepEqual(run(dir), { op: 'scripts', token: 'not-placed', failed: false, lines: ['scripts/: no kit script stands in it, so none is placed'] });
      assert.deepEqual(snapshot(dir), before);
    }, { setup });
  });
  it('a symlinked scripts/, a regular file named scripts and a linked family file beside only pair files: wrong-node-kind, nothing read', () => {
    const rows = [
      ['scripts/', 'a symlink', (dir) => { put(join(dir, 'real'), PAIR_BODIES); symlinkSync(join(dir, 'real', 'scripts'), join(dir, 'scripts')); }],
      ['scripts/', 'a regular file', (dir) => writeFileSync(join(dir, 'scripts'), 'not a directory\n')],
      [rel(LAST), 'a symlink', (dir) => { put(dir, PAIR_BODIES); symlinkSync(join(dir, 'scripts', 'spec-schema.mjs'), join(dir, 'scripts', LAST)); }],
    ];
    for (const [at, kind, setup] of rows) withTree(null, (dir) => {
      const [paths, before] = [[], snapshot(dir)], r = run(dir, { deps: { readFile: spy(paths) } });
      assert.deepEqual(r, { op: 'scripts', token: 'failed', failed: true, lines: [`wrong-node-kind — ${at}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`] });
      assert.deepEqual([paths, snapshot(dir)], [[], before]);
    }, { setup });
  });
  it('one family file standing accepts the component: every other family file an absent entry, nothing written', () => withTree(null, (dir) => {
    const [before, r, others] = [snapshot(dir), run(dir), ORDER.filter((n) => n !== 'archive-caps.mjs')];
    assert.deepEqual({ token: r.token, lines: r.lines, entries: r.entries }, { token: 'pending', lines: [...others.map(L.absent), L.count(1)], entries: others.map(absentEntry) });
    assert.deepEqual([r.entries.length, snapshot(dir)], [20, before]);
  }, { setup: (dir) => put(dir, { 'archive-caps.mjs': bundled('archive-caps.mjs') }) }));
});

describe('spec:distribution-files/S14 the rule by its cells over an accepted component', () => {
  const check = (r, want) => {
    assert.deepEqual({ token: r.token, lines: r.lines, entries: r.entries }, want);
    assert.deepEqual(r.lines.filter((l) => /withheld|customized|preserved|you edited|edited it/.test(l)), [], 'no line says withheld, customized, preserved or edited it');
  };
  it('a prior refreshed, a current left and counted, an absent and an edited entry, each on its own channel', () => withTree({ [SET[0]]: null, [SET[1]]: prior(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs') }, (dir) => {
    check(run(dir), { token: 'pending', lines: [L.absent(SET[0]), L.refreshed(SET[1]), L.edited('archive-caps.mjs'), L.count(18)], entries: [absentEntry(SET[0]), editedEntry('archive-caps.mjs')] });
    holds(dir, { [SET[0]]: null, [SET[1]]: bundled(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs') });
    assert.deepEqual([LOCAL_HOOK_CHANNEL, SCRIPT_CHANNEL], ['the local hook file scripts/pre-commit.local, which the commit hook runs first', 'a script or suite of your own under its own name in scripts/, or a config the script reads']);
  }));
  it('each installer-set member edited in turn: the other two refreshed, the edited one an entry, pending', () => {
    for (const edited of SET) withTree({ ...PRIORS, [edited]: EDIT(edited) }, (dir) => {
      check(run(dir), { token: 'pending', lines: [...SET.map((n) => (n === edited ? L.edited(n) : L.refreshed(n))), L.count(18)], entries: [editedEntry(edited)] });
      holds(dir, Object.fromEntries(SET.map((n) => [n, n === edited ? EDIT(n) : bundled(n)])));
    });
  });
});

describe('spec:distribution-files/S15 the dry run and the quiet cells', () => {
  it('a dry run gives the entries of a real run of its twin, its lines would be refreshed, nothing written', () => {
    for (const [bodies, dryToken, token] of [[PRIORS, 'would-refresh', 'refreshed'], [{ ...PRIORS, [SET[0]]: EDIT(SET[0]), 'migrate-gates.mjs': null }, 'pending', 'pending']]) {
      const real = withTree(bodies, (dir) => run(dir));
      withTree(bodies, (dir) => {
        const [before, dry] = [snapshot(dir), run(dir, { dryRun: true })];
        assert.deepEqual([dry.token, real.token, dry.entries, dry.lines], [dryToken, token, real.entries, real.lines.map((l) => l.replace('— refreshed to', '— would be refreshed to'))]);
        assert.ok(dry.lines.some((l) => l.endsWith('— would be refreshed to the bundled one')), dry.lines.join('\n'));
        assert.deepEqual(snapshot(dir), before);
      });
    }
  });
  it('a fully current family: already-present, the one count line, no entry, nothing written', () => withTree({}, (dir) => {
    const before = snapshot(dir);
    assert.deepEqual(run(dir), { op: 'scripts', token: 'already-present', failed: false, lines: [L.count(21)], entries: [] });
    assert.deepEqual(snapshot(dir), before);
  }));
  it('a current family beside the old ADR layout: old-adr-layout-migration-instructed, nothing written', () => withTree({}, (dir) => {
    const before = snapshot(dir);
    assert.deepEqual(run(dir), { op: 'scripts', token: 'old-adr-layout-migration-instructed', failed: false, lines: [L.count(18), L.group('old')], entries: [] });
    assert.deepEqual(snapshot(dir), before);
  }, { setup: oldLayout }));
});

describe('spec:distribution-files/S16 the failure cells', () => {
  const rows = [
    ['a symlink', 'wrong-node-kind', 'exists but is a symlink', (dir) => { writeFileSync(join(dir, 'elsewhere.txt'), 'the link target\n'); symlinkSync(join(dir, 'elsewhere.txt'), join(dir, 'scripts', LAST)); }],
    ['a directory', 'wrong-node-kind', 'exists but is a directory', (dir) => mkdirSync(join(dir, 'scripts', LAST))],
    ['an unreadable bundled body', 'bundle-unreadable', 'the bundled script could not be read, so nothing was written — reinstall the kit.',
      (dir) => { writeFileSync(join(dir, 'scripts', LAST), bundled(LAST)); cpSync(BUNDLE, join(dir, 'kit', 'references', 'scripts'), { recursive: true }); rmSync(join(dir, 'kit', 'references', 'scripts', LAST)); }],
  ];
  for (const [kind, cause, says, setup] of rows) it(`${kind} at the last family path: ${cause} naming it, no entry, nothing written`, () => withTree({ ...PRIORS, [LAST]: null }, (dir) => {
    const before = snapshot(dir), r = run(dir, { kitRoot: existsSync(join(dir, 'kit')) ? join(dir, 'kit') : KIT });
    assert.deepEqual([r.token, 'entries' in r, r.lines[0].startsWith(`${cause} — ${rel(LAST)}: ${says}`)], ['failed', false, true], r.lines.join('\n'));
    assert.deepEqual(snapshot(dir), before);
  }, { setup }));
  it('a rename refused at the second write: write-refused, the installer kept, the later lines, PARTWAY counting 1, the entries carried', () => withTree({ ...PRIORS, 'migrate-gates.mjs': null }, (dir) => {
    const r = run(dir, { deps: recorder(dir, { refuseAt: 2 }).deps });
    assert.deepEqual({ token: r.token, lines: r.lines, entries: r.entries }, { token: 'failed', entries: [absentEntry('migrate-gates.mjs')], lines: [`write-refused — ${rel(SET[1])}: EACCES: refused`, L.refreshed(SET[0]),
      `${rel(SET[1])}: ${SHIPPED} — not refreshed; its write was refused (above)`, `${rel(SET[2])}: ${SHIPPED} — not refreshed; the run stopped before it`, L.absent('migrate-gates.mjs'), L.count(17), L.partway(1)] });
    holds(dir, { [SET[0]]: bundled(SET[0]), [SET[1]]: prior(SET[1]), [SET[2]]: prior(SET[2]), 'migrate-gates.mjs': null });
    assert.deepEqual(readdirSync(join(dir, 'scripts')).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
  }));
});

describe('spec:distribution-files/S17 the decisions layout gate', () => {
  it('the group derived from the bundled bytes equals the frozen DECISIONS_GROUP', () => {
    const reads = ORDER.filter((n) => /(['"])(?:\.\/)?archive-decisions\.mjs\1/.test(readFileSync(join(BUNDLE, n), 'utf8')));
    assert.deepEqual([[...DECISIONS_GROUP], Object.isFrozen(DECISIONS_GROUP)], [[...new Set([...reads, 'archive-decisions.mjs'])].sort(), true]);
  });
  const GROUP = { 'archive-decisions.mjs': OLD('archive-decisions.mjs'), 'archive-decisions.test.mjs': EDIT('archive-decisions.test.mjs'), 'archiver-structure.test.mjs': null };
  for (const [layout, setup] of [['old', oldLayout], ['old-unrotated', unrotated]]) it(`on ${layout}: a prior, an edited and an absent group file stay as found with no entry; the group line; a prior outside it refreshed`, () => withTree({ ...GROUP, [SET[0]]: prior(SET[0]) }, (dir) => {
    const r = run(dir, { deps: { priors: priorsWith('archive-decisions.mjs') } });
    assert.deepEqual(r, { op: 'scripts', token: 'old-adr-layout-migration-instructed', failed: false, lines: [L.refreshed(SET[0]), L.count(17), L.group(layout)], entries: [] });
    holds(dir, { ...GROUP, [SET[0]]: bundled(SET[0]) });
  }, { setup }));
  const denied = { statPath: () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } };
  const UNREAD = { [SET[0]]: prior(SET[0]), [SET[1]]: EDIT(SET[1]), [SET[2]]: null, 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'markdown-blocks.mjs': OLD('markdown-blocks.mjs'), 'archive-decisions.test.mjs': EDIT('archive-decisions.test.mjs') };
  const UNVERIFIABLE = 'adr-layout-unverifiable — scripts/: the ADR-store layout could not be read (EACCES: denied), so the other kit scripts wait for the layout';
  it('an unreadable layout: failed with no entry, the prior installer refreshed, the waiting lines name no block, every other file byte-identical', () => withTree(UNREAD, (dir) => {
    const before = snapshot(dir), r = run(dir, { deps: { ...denied, priors: priorsWith('markdown-blocks.mjs') } });
    assert.deepEqual(r, { op: 'scripts', token: 'failed', failed: true, lines: [UNVERIFIABLE, L.refreshed(SET[0]), L.waits(SET[1]), L.waits(SET[2])] });
    assert.deepEqual(snapshot(dir), { ...before, [join('scripts', SET[0])]: bundled(SET[0]).toString('base64') });
  }));
  it('through main: the block over the specs entry alone; its replace run prints scripts failed and never runs the op', () => withTree(UNREAD, (dir) => {
    const plain = cli(dir, [], { deps: denied }), digest = digestOf(plain.stdout);
    assert.deepEqual(blockRels(plain.stdout), ['scripts/check-docs-size.mjs'], plain.stdout);
    writeFileSync(join(dir, 'scripts', SET[0]), prior(SET[0]));
    const again = cli(dir, ['--replace-custom', digest], { deps: denied });
    assert.deepEqual([again.code, tokensOf(again.stdout)[0], detailsOf(again.stdout)[0]], [1, 'scripts: failed', UNVERIFIABLE], again.stdout);
    holds(dir, { [SET[0]]: prior(SET[0]) });
  }, { setup: (dir) => put(dir, { ...PAIR_BODIES, 'check-docs-size.mjs': EDIT('check-docs-size.mjs') }) }));
});

describe('spec:distribution-files/S18 one token precedence over the plain, dry and replace runs', () => {
  it('adjacent cells, one table: failed, old-adr…, pending, seeded, refreshed, already-present; would-refresh on a dry run', () => {
    const [plain, caps, installer] = [() => ({}), { 'archive-caps.mjs': EDIT('archive-caps.mjs') }, { [SET[0]]: prior(SET[0]) }];
    const replaced = (dir) => ({ replace: { digest: D, entries: run(dir, { dryRun: true }).entries } });
    const rows = [
      ['failed over old-adr-layout-migration-instructed', installer, oldLayout, (dir) => ({ deps: recorder(dir, { refuseAt: 1 }).deps }), 'failed'],
      ['old-adr-layout-migration-instructed over pending', { ...installer, ...caps }, oldLayout, plain, 'old-adr-layout-migration-instructed'],
      ['pending over refreshed on a plain run', { ...installer, ...caps }, undefined, plain, 'pending'],
      ['seeded over refreshed on a replace run', { ...installer, ...caps, 'migrate-gates.mjs': null }, undefined, replaced, 'seeded'],
      ['refreshed by a replaced edit', caps, undefined, replaced, 'refreshed'],
      ['refreshed over already-present', installer, undefined, plain, 'refreshed'],
      ['already-present', {}, undefined, plain, 'already-present'],
      ['would-refresh in its place on a dry run', installer, undefined, () => ({ dryRun: true }), 'would-refresh'],
      ['pending over would-refresh on a dry run', { ...installer, ...caps }, undefined, () => ({ dryRun: true }), 'pending'],
    ];
    const got = rows.map(([label, bodies, setup, opts]) => [label, withTree(bodies, (dir) => run(dir, opts(dir)).token, { setup })]);
    assert.deepEqual(got, rows.map(([label, , , , token]) => [label, token]));
    assert.deepEqual(got.filter(([, token]) => token === 'customized-preserved' || token === 'would-seed'), []);
  });
});

describe('spec:distribution-files/S19 write order through a recording writer', () => {
  const MORE = { 'archive-caps.mjs': OLD('archive-caps.mjs'), 'markdown-blocks.mjs': OLD('markdown-blocks.mjs'), [LAST]: OLD(LAST) };
  const priors = priorsWith(...Object.keys(MORE));
  const orderOf = (bodies) => ORDER.filter((n) => n in bodies);
  it('a plain run refreshes the installer, its two suites, then every other family file in code-unit name order', () => withTree({ ...PRIORS, ...MORE }, (dir) => {
    const { order, deps } = recorder(dir);
    run(dir, { deps: { ...deps, priors } });
    assert.deepEqual([order, [...ORDER].sort()], [orderOf({ ...PRIORS, ...MORE }), BUNDLED_SCRIPT_NAMES.filter((n) => !PAIRS.includes(n)).sort()]);
  }));
  it("a replace run's refreshes, replacements and placements follow the one order", () => {
    const bodies = { [SET[0]]: EDIT(SET[0]), [SET[1]]: prior(SET[1]), [SET[2]]: null, '_expect-shim.mjs': EDIT('_expect-shim.mjs'), 'archive-caps.mjs': null, 'markdown-blocks.mjs': OLD('markdown-blocks.mjs') };
    withTree(bodies, (dir) => {
      const [{ order, deps }, entries] = [recorder(dir), run(dir, { dryRun: true, deps: { priors } }).entries];
      assert.deepEqual([run(dir, { deps: { ...deps, priors }, replace: { digest: D, entries } }).token, order], ['seeded', orderOf(bodies)]);
    });
  });
  it('a write refused partway leaves every later file unwritten', () => withTree({ ...PRIORS, ...MORE }, (dir) => {
    const [before, { order, deps }, due] = [snapshot(dir), recorder(dir, { refuseAt: 2 }), orderOf({ ...PRIORS, ...MORE })];
    const now = (run(dir, { deps: { ...deps, priors } }), snapshot(dir));
    assert.deepEqual([order, due.slice(1).filter((n) => now[join('scripts', n)] !== before[join('scripts', n)])], [due.slice(0, 2), []]);
  }));
});

describe('spec:distribution-files/S20 the scripts op under the replace', () => {
  const BASE = { [SET[0]]: EDIT(SET[0]), [SET[1]]: prior(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'migrate-gates.mjs': null };
  it('through the replace command: each edit kept aside and replaced, the absent file placed, the lines naming the kept-aside path', () => withTree(BASE, (dir) => {
    const digest = digestOf(cli(dir, ['--only', 'scripts', '--dry-run']).stdout) ?? '', r = cli(dir, ['--replace-custom', digest]);
    const carried = (n) => `${rel(n)}: carried an edit — kept aside at ${keptAt(digest, n)}, then replaced by the bundled body on the user's yes`;
    assert.deepEqual([r.code, tokensOf(r.stdout)[0], detailsOf(r.stdout).slice(0, 5)], [0, 'scripts: seeded',
      [carried(SET[0]), L.refreshed(SET[1]), carried('archive-caps.mjs'), "scripts/migrate-gates.mjs: placed from the bundled scripts on the user's yes", L.count(17)]], r.stdout);
    assert.deepEqual(readFileSync(join(dir, keptAt(digest, SET[0]))), EDIT(SET[0]));
    holds(dir, Object.fromEntries(Object.keys(BASE).map((n) => [n, bundled(n)])));
  }));
  const races = [
    ['a file turned edited after the bind', BASE, (dir) => writeFileSync(join(dir, 'scripts', 'archive-changelog.mjs'), EDIT('archive-changelog.mjs'))],
    ['an edited file under an empty bound list', { [SET[1]]: prior(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs') }, () => {}, []],
    ['an absent file under an empty bound list', { [SET[1]]: prior(SET[1]), 'migrate-gates.mjs': null }, () => {}, []],
    ['a bound edited file whose bytes moved', BASE, (dir) => writeFileSync(join(dir, 'scripts', 'archive-caps.mjs'), OLD('archive-caps.mjs'))],
    ['a bound absent file present at the survey', BASE, (dir) => writeFileSync(join(dir, 'scripts', 'migrate-gates.mjs'), bundled('migrate-gates.mjs'))],
  ];
  for (const [label, bodies, change, bound] of races) it(`survey ≠ bound, ${label}: race-unresolved, nothing written, no block named`, () => withTree(bodies, (dir) => {
    const entries = bound ?? run(dir, { dryRun: true }).entries;
    change(dir);
    const before = snapshot(dir), r = run(dir, { replace: { digest: D, entries } });
    assert.deepEqual([r.token, r.lines[0], r.lines.filter((l) => /block below/.test(l)), snapshot(dir)], ['failed', SURVEY_RACE, [], before], r.lines.join('\n'));
  }));
  it('a bound edit moved after the survey, before its own write: race-unresolved, the earlier write kept and reported, PARTWAY', () => withTree({ [SET[1]]: prior(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'migrate-gates.mjs': null }, (dir) => {
    const entries = run(dir, { dryRun: true }).entries;
    let moved = false;
    const writeFile = (p, ...rest) => {
      if (!moved && String(p).startsWith(join(dir, 'scripts'))) { moved = true; writeFileSync(join(dir, 'scripts', 'archive-caps.mjs'), OLD('archive-caps.mjs')); }
      return writeFileSync(p, ...rest);
    };
    const r = run(dir, { deps: { writeFile }, replace: { digest: D, entries } });
    assert.deepEqual([r.token, r.lines], ['failed', ['race-unresolved — scripts/archive-caps.mjs: changed after this run read it — left as it stands and nothing further written', L.refreshed(SET[1]),
      `scripts/archive-caps.mjs: carries an edit — not replaced; its copy kept aside at ${keptAt(D, 'archive-caps.mjs')} stays`, 'scripts/migrate-gates.mjs: absent — not placed', L.count(18), L.partway(1)]]);
    holds(dir, { [SET[1]]: bundled(SET[1]), 'archive-caps.mjs': OLD('archive-caps.mjs'), 'migrate-gates.mjs': null });
  }));
  const appear = (body) => withTree({ 'migrate-gates.mjs': null }, (dir) => {
    const [entries, target] = [run(dir, { dryRun: true }).entries, join(dir, 'scripts', 'migrate-gates.mjs')];
    const link = (from, to) => { if (to === target) writeFileSync(to, body); return linkSync(from, to); };
    return run(dir, { deps: { link }, replace: { digest: D, entries } });
  });
  it('a bound absent file that appears with the bundled body stands, already-present; with other bytes race-unresolved', () => {
    const [stood, raced] = [appear(bundled('migrate-gates.mjs')), appear(OLD('migrate-gates.mjs'))];
    assert.deepEqual([stood.token, stood.lines], ['already-present', ['scripts/migrate-gates.mjs: appeared while this run was placing it — the bundled body stands, nothing written', L.count(20)]]);
    assert.deepEqual([raced.token, raced.lines], ['failed', ['race-unresolved — scripts/migrate-gates.mjs: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled',
      'scripts/migrate-gates.mjs: absent — not placed', L.count(20)]]);
  });
});

describe('spec:distribution-files/S21 the rule through real commits', () => {
  const home = mkdtempSync(join(tmpdir(), 'scripts-op-home-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  // An inherited NODE_TEST_CONTEXT makes the hook's `node --test` skip every file and exit 0: every spawn drops it.
  const env = Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home)).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_V8_COVERAGE'));
  const sh = (dir, cmd, ...args) => {
    const r = spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' }), out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(!r.error && r.signal === null, `${cmd} ${args.join(' ')} did not run to an exit (${r.error?.code ?? r.signal}): ${out}`);
    return { status: r.status, out };
  };
  const ok = (dir, ...cmd) => { const { status, out } = sh(dir, ...cmd); assert.equal(status, 0, out); };
  const commit = (dir, message) => { ok(dir, 'git', 'add', '-A'); return sh(dir, 'git', 'commit', '-q', '-m', message); };
  const passes = ({ status, out }) => {
    assert.deepEqual([status, /skipping running files/i.test(out)], [0, false], out);
    for (const re of [/(?:✔|(?<!not )ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/, /(?:✔|(?<!not )ok \d+ -) install-git-hooks — the in-place installer under a GIT_DIR-pinned fixture/, /(?:\u2139|#) fail 0(?!\d)/]) assert.match(out, re, out);
  };
  it('a prior set stops a commit until one plain run; an edited installer is kept aside and replaced by the printed command; an absent suite waits for it', { timeout: 240_000 }, () => withTree(PRIORS, (dir) => {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'fixture']]) ok(dir, 'git', ...args);
    for (const [doc, type, title] of [['changelog.md', 'log', 'Changelog'], ['known_issues.md', 'issues', 'Known issues']]) writeFileSync(join(dir, 'docs', 'ai', doc), `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${title}\n`);
    for (const args of [['scripts/check-docs-size.mjs', '--write-index'], ['scripts/install-git-hooks.mjs']]) ok(dir, process.execPath, ...args);
    const one = commit(dir, 'one');
    assert.ok(one.status !== 0 && /(?:✖|not ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/.test(one.out), one.out);
    const first = cli(dir, ['--only', 'scripts']);
    assert.deepEqual([first.code, tokensOf(first.stdout), detailsOf(first.stdout)], [0, ['scripts: refreshed'], [...SET.map(L.refreshed), L.count(18)]], first.stdout);
    passes(commit(dir, 'two'));
    put(dir, { ...PRIORS, [SET[0]]: EDIT(SET[0]) });
    const plain = cli(dir, ['--only', 'scripts']), digest = digestOf(plain.stdout) ?? '';
    const line = plain.stdout.split('\n').find((l) => l.startsWith(`  ${rel(SET[0])}: carries an edit`)) ?? '';
    assert.deepEqual([tokensOf(plain.stdout), blockRels(plain.stdout), [`kept aside at ${keptAt(digest, SET[0])}`, 'scripts/pre-commit.local'].filter((s) => !line.includes(s))], [['scripts: pending'], [rel(SET[0])], []], plain.stdout);
    holds(dir, { [SET[1]]: bundled(SET[1]), [SET[2]]: bundled(SET[2]) });
    assert.equal(cli(dir, ['--replace-custom', digest]).code, 0);
    assert.deepEqual(readFileSync(join(dir, keptAt(digest, SET[0]))), EDIT(SET[0]));
    holds(dir, Object.fromEntries(SET.map((n) => [n, bundled(n)])));
    passes(commit(dir, 'three'));
    rmSync(join(dir, 'scripts', SET[2]));
    const waits = [1, 2].map(() => cli(dir, ['--only', 'scripts'])).map((r) => [tokensOf(r.stdout), blockRels(r.stdout), bytesOf(dir, SET[2]), digestOf(r.stdout)]);
    assert.deepEqual(waits.map((w) => w.slice(0, 3)), [1, 2].map(() => [['scripts: pending'], [rel(SET[2])], null]));
    assert.equal(cli(dir, ['--replace-custom', waits[1][3]]).code, 0);
    holds(dir, { [SET[2]]: bundled(SET[2]) });
  }, { setup: (dir) => put(dir, PAIR_BODIES) }));
});

describe('spec:distribution-files/S22 the block of an --only run', () => {
  const tree = (fn, more = () => {}) => withTree({ 'archive-caps.mjs': EDIT('archive-caps.mjs') }, fn, { setup: (dir) => { put(dir, { ...PAIR_BODIES, 'check-docs-size.mjs': EDIT('check-docs-size.mjs') }); more(dir); } });
  it("--only scripts and --only specs print the full run's one block and no line of the other survey; --only gates none; the replace runs scripts, specs, index", () => tree((dir) => {
    const [full, scripts, specs, gates] = [[], ['--only', 'scripts'], ['--only', 'specs'], ['--only', 'gates']].map((flags) => cli(dir, flags).stdout);
    const d = digestOf(full);
    assert.deepEqual([digestOf(scripts), digestOf(specs), digestOf(gates), blockRels(scripts)], [d, d, undefined, ['scripts/archive-caps.mjs', 'scripts/check-docs-size.mjs']], scripts);
    assert.deepEqual([tokensOf(scripts).map((t) => t.split(':')[0]), tokensOf(specs).map((t) => t.split(':')[0])], [['scripts'], ['specs']]);
    assert.deepEqual([detailsOf(scripts).filter((l) => l.includes('check-docs-size')), detailsOf(specs).filter((l) => /archive-caps|other kit scripts/.test(l))], [[], []]);
    const replace = cli(dir, ['--replace-custom', d]);
    assert.deepEqual([replace.code, tokensOf(replace.stdout).map((t) => t.split(':')[0])], [0, ['scripts', 'specs', 'index']], replace.stdout);
  }));
  it("the other owning op's survey refused: its failed outcome prints, the block over the --only op's entries alone, exit 1", () => tree((dir) => {
    const r = cli(dir, ['--only', 'scripts']);
    assert.deepEqual([r.code, tokensOf(r.stdout), blockRels(r.stdout)], [1, ['scripts: pending', 'specs: failed'], ['scripts/archive-caps.mjs']], r.stdout);
    assert.ok(detailsOf(r.stdout).some((l) => l.startsWith('wrong-node-kind — scripts/spec-schema.mjs: exists but is a symlink')), r.stdout);
  }, (dir) => { rmSync(join(dir, 'scripts', 'spec-schema.mjs')); symlinkSync(join(dir, 'scripts', 'spec-schema.test.mjs'), join(dir, 'scripts', 'spec-schema.mjs')); }));
});

describe('spec:distribution-files/S24 shipped text of the one rule', () => {
  const [text, header] = [(...p) => readFileSync(join(KIT, ...p), 'utf8'), (src) => src.slice(0, src.indexOf('\nimport '))];
  const has = (body, yes, no = []) => assert.deepEqual([yes.filter((p) => !body.includes(p)), no.filter((p) => body.includes(p))], [[], []], 'missing phrases, then claimed ones');
  it('upgrade.md: the scripts token arm and the enforcement-script paragraph state the one rule', () => {
    const doc = text('references', 'modes', 'upgrade.md'), at = doc.indexOf('**What the enforcement-script ensure does.**');
    has(doc.slice(doc.indexOf('scripts → ')).split(';')[0], ['`refreshed`', '`pending`', '`already-present`', '`not-placed`', '`old-adr-layout-migration-instructed`', '`skipped-no-node-evidence`', '`seeded` on the replace run'], ['customized-preserved']);
    has(at === -1 ? '' : doc.slice(at, doc.indexOf('\n', at)), ['`not-placed`', "replaced or placed only on row 3's one yes", 'the commit hook runs it', 'migrate-adr-store', '`--write-baseline`',
      'the `enforcement` check line and apply, by the consent route'], ['withheld', 'customized', 'preserved', 'keeps all three', 'never seeded']);
  });
  it('the ensure-ops.mjs header and the ensure-vocabulary.mjs comments name the leaf and the placement, no SEED_SCRIPTS', () => {
    has(header(text('tools', 'ensure-ops.mjs')), ['distribution-files/scripts.mjs'], ['SEED_SCRIPTS']);
    const vocab = text('tools', 'ensure-vocabulary.mjs');
    has(vocab.slice(vocab.indexOf('// Tokens that assert a WRITE'), vocab.indexOf('export const WRITE_TOKENS')), ['absent kit script placed']);
    has(vocab, [], ['SEED_SCRIPTS']);
  });
  it('ensure-configs.mjs: its header row and --help name the one rule and the write-free survey of the other owning op', () => {
    const rows = header(text('tools', 'ensure-configs.mjs')).split('\n'), at = rows.findIndex((l) => /^\/\/ {3}scripts /.test(l));
    has(at === -1 ? '' : rows.slice(at, at + 2).join('\n'), ['one rule']);
    const help = main(['--help']).stdout, from = help.indexOf('\n  --only <op>');
    has(help.slice(from, help.indexOf('\n  --replace-custom', from)), ['write-free survey of the other owning op']);
    has(help, [], ['an edited member keeps all three']);
  });
});
