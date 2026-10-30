// scripts-adr-store.test.mjs — the scripts op's store run: the project's rotator brought in after the writes
// (`--ensure-current`), its spawn and when it runs, the store moved by real runs, and the runs that fail the op.
// The op's leaf is imported dynamically, so a tree without it fails each cell, never the load.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../ensure-configs.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { SCRIPT_PRIORS } from '../script-priors.mjs';

const { ensureScripts } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);

const SHIPPED = 'matches a body an earlier release shipped';
const HOOK = 'the commit hook runs the files written above, so they may stop the next commit';
const DRY_HOOK = 'the commit hook runs the files named above, so writing them may stop the next commit';
const S = 'ADR store: ';
const SKIP = '[archive-decisions] SKIP — no ADR substrate (neither docs/ai/decisions.md nor docs/ai/adr); nothing to bring current.';
const [MIGRATED, NAVIGATOR] = [`${S}brought-current: migrated, navigator written`, `${S}brought-current: navigator written`];

// A temp project (package.json unless node is false, docs/ai). `lay` lays `bodies` down; `bodies` null leaves the tree to `setup`.
const withTree = (bodies, fn, { node = true, setup = () => {}, lay = () => {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-adr-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (bodies) lay(dir, bodies);
    setup(dir);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const doc = (rel) => (dir, body) => { mkdirSync(dirname(join(dir, 'docs', 'ai', rel)), { recursive: true }); writeFileSync(join(dir, 'docs', 'ai', rel), body); };
const decisions = (dir) => doc('decisions.md')(dir, '---\ntype: decisions\nmaxLines: 200\n---\n\n# Decisions\n\n## AD-002 — second\n\nbody two\n');
const monolith = (dir) => doc('history/decisions-archive.md')(dir, '---\ntype: archive\n---\n\n# Decisions archive\n\n## AD-001 — first\n\nbody one\n');
const both = (dir) => { decisions(dir); monolith(dir); };
// A recording writer: each atomic publish (rename) and create-only publish (link) records its target path under
// `base`, the `refuseAt`-th one throws EACCES before it touches the tree.
const recorder = (dir, { refuseAt = 0, base = 'scripts' } = {}, order = []) => {
  const record = (real) => (from, to) => {
    if (order.push(relative(join(dir, base), to).split(sep).join('/')) === refuseAt) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
    return real(from, to);
  };
  return { order, deps: { rename: record(renameSync), link: record(linkSync) } };
};

// ── the kit folder: the family read from the KIT mirror's manifest inside each cell, never counted by hand ──
const KF = 'scripts/agent-workflow';
const [INSTALLER, ROTK, ISSUES] = ['git-hooks/install-git-hooks.mjs', 'archives/archive-decisions.mjs', 'archives/archive-issues.mjs'];
const kb = (p) => readFileSync(join(BUNDLE, ...p.split('/')));
const IMPORT = /(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g;
const importsOf = (p, within) => [...kb(p).toString('utf8').matchAll(IMPORT)].map(([, spec]) => posix.join(posix.dirname(p), spec)).filter((dep) => within.includes(dep));
// `roots` and every file of `within` they reach through bundled relative imports, transitively.
const closureOf = (within, roots) => { const reached = new Set(roots); for (const p of reached) for (const dep of importsOf(p, within)) reached.add(dep); return [...reached]; };
// Dependencies before importers, code-unit order of the manifest path otherwise.
const writeOrder = (paths) => { const left = new Set(paths), out = []; while (left.size) { const next = [...left].sort().find((p) => importsOf(p, paths).every((d) => !left.has(d))); assert.ok(next, `an import cycle among ${[...left]}`); out.push(next); left.delete(next); } return out; };
const kitFamily = async () => {
  const { readFamily } = await import('../../references/scripts/family.mjs');
  const deployed = readFamily(BUNDLE).filter((e) => e.role === 'deployed');
  const own = deployed.filter((e) => e.module !== 'spec-schema' && e.module !== 'docs-size' && e.path !== 'run.mjs');
  const F = { family: own.map((e) => e.path), seeds: own.filter((e) => e.seed).map((e) => e.path), pairs: deployed.filter((e) => ['spec-schema', 'docs-size'].includes(e.module)).map((e) => e.path), shared: own.filter((e) => e.module === 'shared').map((e) => e.path) };
  assert.deepEqual([INSTALLER, ROTK, ISSUES].filter((p) => !F.family.includes(p)), [], 'the named files are family files');
  return F;
};
const putK = (dir, bodies) => { for (const [p, body] of Object.entries(bodies)) if (body !== null) { mkdirSync(dirname(join(dir, KF, p)), { recursive: true }); writeFileSync(join(dir, KF, p), body); } };
// A temp project whose kit folder holds every family file on its bundled body but as `bodies` says (null: absent).
const withKit = (F, bodies, fn, opts = {}) => withTree(bodies, fn, { ...opts, lay: (dir, b) => putK(dir, Object.fromEntries(F.family.map((p) => [p, p in b ? b[p] : kb(p)]))) });
const gitKit = (F, bodies, store, fn) => withKit(F, bodies, fn, { setup: (dir) => { const g = sh(dir, 'git', 'init', '-q'); assert.equal(g.status, 0, `${g.stdout}${g.stderr}`); store(dir); } });
const holdsK = (dir, want) => { for (const [p, body] of Object.entries(want)) { const at = join(dir, KF, p); assert.equal(existsSync(at) && sha(readFileSync(at)), sha(body), `${p} holds the expected body`); } };
// The catalog seam: OLD(path) catalogued under its manifest path as a body a release shipped.
const priorsK = (...paths) => [...SCRIPT_PRIORS, ...paths.map((file) => ({ file, digest: sha(OLD(file)) }))];
const relK = (p) => `${KF}/${p}`;
const LK = {
  refreshed: (p) => `${relK(p)}: ${SHIPPED} — refreshed to the bundled one`,
  replaced: (p) => `${relK(p)}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in a script or suite of your own under its own name in scripts/, or a config the script reads`,
  placed: (p) => `${relK(p)}: absent — placed from the bundled scripts`,
  count: (k) => `${KF}/: ${k} other kit scripts are already the bundled body — nothing written`,
};
const NOT_ACCEPTED_K = `${KF}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`;
const WOULD_K = `${S}${KF}/${ROTK} --ensure-current would run after the writes, bringing the store current or writing nothing when it already is`;
const FAIL_K = (how) => `adr-store-not-current — ${KF}/${ROTK} --ensure-current ${how} — the ADR store was not confirmed current`;
const [NOTE_CMD, NOTE_K] = ['node scripts/agent-workflow/docs-size/check-docs-size.mjs --write-index', '<the index note naming the deployed docs checker>'];
// A recording spawnSync: each call's cmd, args and opts, and `<spawn>` in `log`; it answers an already-current exit 0 under `answer`.
const fakeSpawn = (answer = {}, log = []) => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); log.push('<spawn>'); return { status: 0, signal: null, stdout: 'already-current\n', stderr: '', ...answer }; };
  return { calls, spawn };
};
const run = (dir, opts = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, ...opts, deps: { git: () => ({ status: 128, stdout: '', stderr: '' }), ...opts.deps } });
const tokensOf = (out) => [...out.matchAll(/^ {2}([a-z-]+): ([a-z-]+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);

// The real rotator: a migration snapshots into the tree's own git dir, so every such tree is git-initialised, and
// every spawn drops each inherited GIT_ variable (the commit hook sets GIT_DIR) and NODE_TEST_CONTEXT.
const home = mkdtempSync(join(tmpdir(), 'scripts-adr-home-'));
after(() => rmSync(home, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home)).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const seam = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env });
const sh = (dir, cmd, ...args) => spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' });
const SNAP = '<the snapshot line>';
// The lines with the one snapshot line under the tree's own .git read as SNAP, and the rotator's index note that
// names the docs checker at its deployed path read as NOTE_K.
const linesOfK = (dir, r) => r.lines.map((l) => (l.startsWith(`${S}snapshot: ${join(realpathSync(dir), '.git', 'agent-workflow-adr-migration-snapshot-')}`) ? SNAP
  : l.startsWith(S) && l.includes('docs/ai/index.md') && l.includes(NOTE_CMD) ? NOTE_K : l));
const spawned = (calls) => calls.map(({ cmd, args, opts }) => [cmd, args, opts?.cwd, 'timeout' in (opts ?? {}), 'env' in (opts ?? {})]);

describe("spec:distribution-files/S17 the store run's spawn and when it runs", () => {
  it('one spawn of node with the project rotator in the kit folder and --ensure-current, cwd the project, no timeout or env key, after the last write', async () => {
    const F = await kitFamily();
    withKit(F, { [INSTALLER]: OLD(INSTALLER), [ISSUES]: null }, (dir) => {
      const { order, deps } = recorder(dir, { base: KF });
      const { calls, spawn } = fakeSpawn({}, order);
      run(dir, { deps: { ...deps, spawnSync: spawn, priors: priorsK(INSTALLER) } });
      assert.deepEqual(spawned(calls), [[process.execPath, [join(dir, KF, ...ROTK.split('/')), '--ensure-current'], dir, false, false]]);
      assert.deepEqual(order, [INSTALLER, ISSUES, '<spawn>'], 'the spawn is the last entry, after every publish');
    });
  });
  it('an accepted component and a declined one whose judged seed files hold the rotator: one spawn each, on a current store and an old one', async () => {
    const F = await kitFamily();
    const declined = (body) => (dir) => putK(dir, { ...Object.fromEntries(F.pairs.map((p) => [p, kb(p)])), [ROTK]: body });
    const components = [['an accepted component', {}, () => {}], ['a declined one, the rotator alone', null, declined(kb(ROTK))], ['a declined one, the rotator edited', null, declined(EDIT(ROTK))]];
    const got = components.flatMap(([c, bodies, lay]) => [['a current store', () => {}], ['an old one', both]].map(([s, store]) => [`${c} on ${s}`, withKit(F, bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      run(dir, { deps: { spawnSync: spawn } });
      return spawned(calls);
    }, { setup: (dir) => { lay(dir); store(dir); } })]));
    assert.deepEqual(got.map(([label, calls]) => [label, calls.length, calls[0]?.[1]?.[0]?.endsWith(join(KF, ...ROTK.split('/')))]), got.map(([label]) => [label, 1, true]));
  });
  it('an already-current exit 0 relays no stdout line, the SKIP line included; each stderr line relayed prefixed, last; the token as the file lines make it', async () => {
    const F = await kitFamily();
    const N = F.family.length;
    const rows = [[{}, 'already-present', [LK.count(N)]], [{ [INSTALLER]: OLD(INSTALLER) }, 'refreshed', [LK.refreshed(INSTALLER), LK.count(N - 1), HOOK]]];
    for (const [bodies, token, lines] of rows) for (const [stderr, tail] of [['', []], ['note one\nnote two\n', [`${S}note one`, `${S}note two`]]]) withKit(F, bodies, (dir) => {
      const { calls, spawn } = fakeSpawn({ stdout: `${SKIP}\nalready-current\n`, stderr });
      const r = run(dir, { deps: { spawnSync: spawn, priors: priorsK(INSTALLER) } });
      assert.deepEqual([calls.length, r.token, r.lines], [1, token, [...lines, ...tail]], `stderr ${JSON.stringify(stderr)}`);
    });
    withKit(F, {}, (dir) => {
      const { calls, spawn } = fakeSpawn({ stdout: 'brought-current: migrated, navigator written\nalready-current\n' });
      const r = run(dir, { deps: { spawnSync: spawn } });
      assert.deepEqual([calls.length, r.token, r.lines], [1, 'already-present', [LK.count(N)]], 'the summary is the last stdout line alone');
    });
  });
  it('a create-only placement whose temp cleanup fails: the temp note after the hook-run line, the store lines after the note, seeded', async () => {
    const F = await kitFamily();
    withKit(F, { [ISSUES]: null }, (dir) => {
      let calls = 0;
      const rm = (p) => { if (calls++ === 0) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }); rmSync(p, { force: true }); };
      const r = run(dir, { deps: { rm, spawnSync: fakeSpawn({ stdout: 'brought-current: navigator written\n' }).spawn } });
      const note = `${relK(ISSUES)}: the write stands, but its temp file could not be removed — delete it by hand: `;
      assert.deepEqual([r.token, r.lines.map((l) => (l.startsWith(note) ? note : l))], ['seeded', [LK.placed(ISSUES), LK.count(F.family.length - 1), HOOK, note, NAVIGATOR]], r.lines.join('\n'));
    });
  });
  it('not-placed, skipped-no-node-evidence, wrong-node-kind, bundle-unreadable, write-refused, race-unresolved and a declined tree with no rotator spawn nothing', async () => {
    const F = await kitFamily();
    const unreadable = (p, ...rest) => { if (String(p) === join(BUNDLE, ...ISSUES.split('/'))) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); return readFileSync(p, ...rest); };
    const raced = (dir) => (from, to) => { if (to === join(dir, KF, ...ISSUES.split('/'))) writeFileSync(to, OLD(ISSUES)); return linkSync(from, to); };
    // The tree the specs op seeds: the pairs and the shared files they import, no rotator.
    const seeded = { setup: (dir) => putK(dir, Object.fromEntries([...F.pairs, ...F.shared].map((p) => [p, kb(p)]))) };
    const rows = [
      ['not-placed', null, {}, () => ({})],
      ['skipped-no-node-evidence', null, { node: false }, () => ({})],
      ['wrong-node-kind', { [ISSUES]: null }, { setup: (dir) => symlinkSync(join(dir, 'package.json'), join(dir, KF, ...ISSUES.split('/'))) }, () => ({})],
      ['bundle-unreadable', {}, {}, () => ({ readFile: unreadable })],
      ['write-refused', { [INSTALLER]: OLD(INSTALLER) }, {}, (dir) => ({ ...recorder(dir, { refuseAt: 1, base: KF }).deps, priors: priorsK(INSTALLER) })],
      ['race-unresolved', { [ISSUES]: null }, {}, (dir) => ({ link: raced(dir) })],
      ['already-present', null, seeded, () => ({})],
    ];
    const got = rows.map(([cause, bodies, tree, deps]) => withKit(F, bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      const r = run(dir, { deps: { ...deps(dir), spawnSync: spawn } });
      return [r.token === 'failed' ? r.lines[0].split(' — ')[0] : r.token, calls.length];
    }, tree));
    assert.deepEqual(got, rows.map(([cause]) => [cause, 0]));
    withKit(F, null, (dir) => {
      const { calls, spawn } = fakeSpawn();
      assert.deepEqual([run(dir, { dryRun: true, deps: { spawnSync: spawn } }).lines, calls.length], [[LK.count(F.shared.length), NOT_ACCEPTED_K], 0], 'a declined tree with no rotator prints no would line dry');
    }, seeded);
  });
  it('a dry run spawns nothing and ends with the would line exactly when the rotator is judged, the token unchanged by it', async () => {
    const F = await kitFamily();
    const N = F.family.length;
    const would = (l) => l.replace(/— (refreshed|replaced|placed) /, '— would be $1 ');
    // A declined component whose judged seed closure holds the rotator: an edited rotator, every seed file it imports absent.
    const declined = { setup: (dir) => putK(dir, { ...Object.fromEntries(F.pairs.map((p) => [p, kb(p)])), [ROTK]: EDIT(ROTK) }) };
    const closure = writeOrder(closureOf(F.seeds, [ROTK]));
    assert.ok(closure.length > 1, 'the rotator imports seed files');
    const rows = [[{ [INSTALLER]: OLD(INSTALLER) }, 'would-refresh', [would(LK.refreshed(INSTALLER)), LK.count(N - 1), DRY_HOOK, WOULD_K]], [{}, 'already-present', [LK.count(N), WOULD_K]],
      [null, 'would-seed', [...closure.map((p) => would(p === ROTK ? LK.replaced(p) : LK.placed(p))), NOT_ACCEPTED_K, 'if a commit hook runs the files named above, writing them may stop the next commit', WOULD_K], declined]];
    for (const [bodies, token, lines, tree] of rows) withKit(F, bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      const r = run(dir, { dryRun: true, deps: { spawnSync: spawn, priors: priorsK(INSTALLER) } });
      assert.deepEqual([calls.length, r.token, r.lines], [0, token, lines]);
    }, tree);
  });
});

describe('spec:distribution-files/S27 the store moved by real rotator runs', () => {
  it('a monolith beside decisions.md and no adr/, the rotator edited and no docs-size module: written, migrated, the index note naming the deployed checker, the monolith gone, --check green', { timeout: 120_000 }, async () => {
    const F = await kitFamily();
    gitKit(F, { [ROTK]: EDIT(ROTK) }, both, (dir) => {
      const r = run(dir, { deps: { spawnSync: seam } });
      assert.deepEqual([r.token, linesOfK(dir, r)], ['refreshed', [LK.replaced(ROTK), LK.count(F.family.length - 1), HOOK, SNAP, MIGRATED, NOTE_K]], r.lines.join('\n'));
      holdsK(dir, { [ROTK]: kb(ROTK) });
      const check = sh(dir, process.execPath, `${KF}/${ROTK}`, '--check');
      assert.deepEqual([existsSync(join(dir, KF, 'docs-size')), existsSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md')), check.status], [false, false, 0], `${check.stdout}${check.stderr}`);
    });
  });
  it('decisions.md and no adr/ beside an edited rotator and no docs-size module: the file line, the count, the hook-run line, navigator written, the index note', { timeout: 120_000 }, async () => {
    const F = await kitFamily();
    gitKit(F, { [ROTK]: EDIT(ROTK) }, decisions, (dir) => {
      const r = run(dir, { deps: { spawnSync: seam } });
      assert.deepEqual([r.token, linesOfK(dir, r)], ['refreshed', [LK.replaced(ROTK), LK.count(F.family.length - 1), HOOK, NAVIGATOR, NOTE_K]], r.lines.join('\n'));
      holdsK(dir, { [ROTK]: kb(ROTK) });
    });
  });
  it('a current family over either move: refreshed with no file line; seeded beside one placed file', { timeout: 240_000 }, async () => {
    const F = await kitFamily();
    const N = F.family.length;
    for (const [store, tail] of [[both, [SNAP, MIGRATED, NOTE_K]], [decisions, [NAVIGATOR, NOTE_K]]]) {
      for (const [bodies, token, lines] of [[{}, 'refreshed', [LK.count(N)]], [{ [ISSUES]: null }, 'seeded', [LK.placed(ISSUES), LK.count(N - 1), HOOK]]]) gitKit(F, bodies, store, (dir) => {
        const r = run(dir, { deps: { spawnSync: seam } });
        assert.deepEqual([r.token, linesOfK(dir, r)], [token, [...lines, ...tail]], r.lines.join('\n'));
      });
    }
  });
});

describe('spec:distribution-files/S28 a rotator that does not bring the store current fails the op', () => {
  // A prior installer, built through the deps.priors seam (the catalog names no file in the kit folder), refreshed before the store run.
  const failed = (F, how, tail) => ({ op: 'scripts', token: 'failed', failed: true, lines: [FAIL_K(how), LK.refreshed(INSTALLER), LK.count(F.family.length - 1), HOOK, ...tail] });
  it('a real monolith with no decisions.md: failed, exited with code 1, the op lines, the rotator stderr line prefixed, the prior written stays', { timeout: 120_000 }, async () => {
    const F = await kitFamily();
    gitKit(F, { [INSTALLER]: OLD(INSTALLER) }, monolith, (dir) => {
      const r = run(dir, { deps: { spawnSync: seam, priors: priorsK(INSTALLER) } });
      assert.deepEqual(r, failed(F, 'exited with code 1', [`${S}[archive-decisions] docs/ai/decisions.md not found but a legacy monolith is present — a broken tree; restore docs/ai/decisions.md before migrating.`]));
      holdsK(dir, { [INSTALLER]: kb(INSTALLER) });
    });
  });
  it('through deps.spawnSync: exit 3, a signal, an error, an error with a signal, an error on exit 0: failed, stderr then stdout lines prefixed, nothing put back', async () => {
    const F = await kitFamily();
    const boom = new Error('spawnSync node EAGAIN');
    const rows = [[{ status: 3 }, 'exited with code 3'], [{ status: null, signal: 'SIGTERM' }, 'was killed by signal SIGTERM'], [{ status: null, error: boom }, `ended with an error (${boom.message})`], [{ status: null, signal: 'SIGTERM', error: boom }, `ended with an error (${boom.message})`],
      [{ error: new Error('spawnSync node EPIPE'), status: 0, signal: null, stdout: 'already-current\n', stderr: '' }, 'ended with an error (spawnSync node EPIPE)', [`${S}already-current`]]];
    for (const [answer, how, tail = [`${S}err one`, `${S}out one`, `${S}out two`]] of rows) withKit(F, { [INSTALLER]: OLD(INSTALLER) }, (dir) => {
      const r = run(dir, { deps: { spawnSync: fakeSpawn({ stdout: 'out one\nout two\n', stderr: 'err one\n', ...answer }).spawn, priors: priorsK(INSTALLER) } });
      assert.deepEqual(r, failed(F, how, tail), how);
      holdsK(dir, { [INSTALLER]: kb(INSTALLER) });
    });
  });
  it('through deps.spawnSync: a runner that throws and one that returns nothing end with an error, no store line, nothing put back', async () => {
    const F = await kitFamily();
    const rows = [[() => { throw new Error('spawnSync node ENOMEM'); }, 'ended with an error (spawnSync node ENOMEM)'], [() => undefined, 'ended with an error (the spawn returned no result)']];
    for (const [spawn, how] of rows) withKit(F, { [INSTALLER]: OLD(INSTALLER) }, (dir) => {
      assert.deepEqual(run(dir, { deps: { spawnSync: spawn, priors: priorsK(INSTALLER) } }), failed(F, how, []), how);
      holdsK(dir, { [INSTALLER]: kb(INSTALLER) });
    });
  });
  it('through main: exit code 1, scripts: failed, and rules and index still print their token lines', async () => withKit(await kitFamily(), { [INSTALLER]: EDIT(INSTALLER) }, (dir) => {
    const rotator = { status: 3, signal: null, stdout: '', stderr: 'err one\n' };
    const spawn = (cmd, args, opts) => (String(args?.[0] ?? '').endsWith(join(KF, ...ROTK.split('/'))) ? rotator : spawnSync(cmd, args, opts));
    const { code, stdout } = main(['--reconcile', '--cwd', dir], { deps: { spawnSync: spawn, git: () => ({ status: 128, stdout: '', stderr: '' }) } });
    const ops = tokensOf(stdout).map((t) => t.split(':')[0]);
    assert.deepEqual([code, tokensOf(stdout).filter((t) => t.startsWith('scripts:')), ops.slice(ops.indexOf('scripts') + 1)], [1, ['scripts: failed'], ['rules', 'index']], stdout);
  }));
});
