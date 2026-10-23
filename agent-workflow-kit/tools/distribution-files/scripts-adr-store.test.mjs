// scripts-adr-store.test.mjs — the scripts op's store run: the project's rotator brought in after the writes
// (`--ensure-current`), its spawn and when it runs, the store moved by real runs, and the runs that fail the op.
// The op's leaf is imported dynamically, so a tree without it fails each cell, never the load.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../ensure-configs.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { NODE_EVIDENCE_SCRIPTS } from '../node-evidence.mjs';
import { CHECKER_PAIR, INSTALLER_SET, READER_PAIR, SCRIPT_PRIORS } from '../script-priors.mjs';

const { ensureScripts } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
// The family in write order: the installer set, then every other family name in code-unit order.
const ORDER = ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs', '_expect-shim.mjs', 'archive-caps.mjs',
  'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs', 'archive-conservation.test.mjs', 'archive-decisions.mjs',
  'archive-decisions.test.mjs', 'archive-issues.mjs', 'archive-issues.test.mjs', 'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs',
  'check-docs-size-ensure.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs', 'migrate-gates-branches.test.mjs', 'migrate-gates.mjs', 'migrate-gates.test.mjs'];
const [SET, LAST] = [[...INSTALLER_SET], ORDER.at(-1)];
// The three files that read the store, in write order.
const ROT = ['archive-decisions.mjs', 'archive-decisions.test.mjs', 'archiver-structure.test.mjs'];
const bundled = (n) => readFileSync(join(BUNDLE, n));
const PRIOR = readFileSync(join(KIT, 'test', 'fixtures', 'script-priors', '7.2.0', `${SET[1]}.txt`));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);
// The catalog seam: OLD(name) catalogued as a body a release shipped, for names with no row of their own.
const priorsWith = (...names) => [...SCRIPT_PRIORS, ...names.map((file) => ({ file, digest: sha(OLD(file)) }))];
const PAIR_BODIES = Object.fromEntries([...READER_PAIR, ...CHECKER_PAIR].map((n) => [n, bundled(n)]));
const rel = (n) => `scripts/${n}`;

const SHIPPED = 'matches a body an earlier release shipped';
const HOOK = 'the commit hook runs the files written above, so they may stop the next commit';
const DRY_HOOK = 'the commit hook runs the files named above, so writing them may stop the next commit';
const NOT_ACCEPTED = 'scripts/: the enforcement scripts were not accepted in this project, so no other kit script is placed';
const L = {
  refreshed: (n) => `${rel(n)}: ${SHIPPED} — refreshed to the bundled one`,
  replaced: (n) => `${rel(n)}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in a script or suite of your own under its own name in scripts/, or a config the script reads`,
  placed: (n) => `${rel(n)}: absent — placed from the bundled scripts`,
  count: (k) => `scripts/: ${k} other kit scripts are already the bundled body — nothing written`,
};
const S = 'ADR store: ';
const WOULD = `${S}scripts/archive-decisions.mjs --ensure-current would run after the writes, bringing the store current or writing nothing when it already is`;
const FAIL = (how) => `adr-store-not-current — scripts/archive-decisions.mjs --ensure-current ${how} — the ADR store is not current`;
const SKIP = '[archive-decisions] SKIP — no ADR substrate (neither docs/ai/decisions.md nor docs/ai/adr); nothing to bring current.';
const NOTE = `${S}[archive-decisions] docs/ai/index.md NOT regenerated — the index generator is not beside this script — run ` + '`node scripts/check-docs-size.mjs --write-index`' + ' to refresh docs/ai/index.md';
const [MIGRATED, NAVIGATOR] = [`${S}brought-current: migrated, navigator written`, `${S}brought-current: navigator written`];

const put = (dir, bodies) => { mkdirSync(join(dir, 'scripts'), { recursive: true }); for (const [n, body] of Object.entries(bodies)) if (body !== null) writeFileSync(join(dir, 'scripts', n), body); };
// A temp project (package.json unless node is false, docs/ai). `bodies` maps a family name to its bytes or
// null (absent), every other family name on its bundled body; `bodies` null leaves scripts/ to `setup`.
const withTree = (bodies, fn, { node = true, setup = () => {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-adr-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (bodies) put(dir, Object.fromEntries(ORDER.map((n) => [n, n in bodies ? bodies[n] : bundled(n)])));
    setup(dir);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const bytesOf = (dir, n) => (existsSync(join(dir, 'scripts', n)) ? readFileSync(join(dir, 'scripts', n)) : null);
// File bytes are compared by digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
const holds = (dir, want) => { for (const [n, body] of Object.entries(want)) assert.equal(bytesOf(dir, n) && sha(bytesOf(dir, n)), sha(body), `${n} holds the expected body`); };
const doc = (rel) => (dir, body) => { mkdirSync(dirname(join(dir, 'docs', 'ai', rel)), { recursive: true }); writeFileSync(join(dir, 'docs', 'ai', rel), body); };
const decisions = (dir) => doc('decisions.md')(dir, '---\ntype: decisions\nmaxLines: 200\n---\n\n# Decisions\n\n## AD-002 — second\n\nbody two\n');
const monolith = (dir) => doc('history/decisions-archive.md')(dir, '---\ntype: archive\n---\n\n# Decisions archive\n\n## AD-001 — first\n\nbody one\n');
const both = (dir) => { decisions(dir); monolith(dir); };
// A recording writer: each atomic publish (rename) and create-only publish (link) records its target name,
// the `refuseAt`-th one throws EACCES before it touches the tree.
const recorder = (dir, { refuseAt = 0 } = {}, order = []) => {
  const record = (real) => (from, to) => {
    if (order.push(relative(join(dir, 'scripts'), to)) === refuseAt) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
    return real(from, to);
  };
  return { order, deps: { rename: record(renameSync), link: record(linkSync) } };
};
// A recording spawnSync: each call's cmd, args and opts, and `<spawn>` in `log`; it answers an already-current exit 0 under `answer`.
const fakeSpawn = (answer = {}, log = []) => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); log.push('<spawn>'); return { status: 0, signal: null, stdout: 'already-current\n', stderr: '', ...answer }; };
  return { calls, spawn };
};
const run = (dir, opts = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, ...opts });
const tokensOf = (out) => [...out.matchAll(/^ {2}([a-z-]+): ([a-z-]+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);

// The real rotator: a migration snapshots into the tree's own git dir, so every such tree is git-initialised, and
// every spawn drops each inherited GIT_ variable (the commit hook sets GIT_DIR) and NODE_TEST_CONTEXT.
const home = mkdtempSync(join(tmpdir(), 'scripts-adr-home-'));
after(() => rmSync(home, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home)).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const seam = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env });
const sh = (dir, cmd, ...args) => spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' });
const gitTree = (bodies, store, fn) => withTree(bodies, fn, { setup: (dir) => { const g = sh(dir, 'git', 'init', '-q'); assert.equal(g.status, 0, `${g.stdout}${g.stderr}`); store(dir); } });
const SNAP = '<the snapshot line>';
// The lines with the one snapshot line under the tree's own .git read as SNAP.
const linesOf = (dir, r) => r.lines.map((l) => (l.startsWith(`${S}snapshot: ${join(realpathSync(dir), '.git', 'agent-workflow-adr-migration-snapshot-')}`) ? SNAP : l));

describe("spec:distribution-files/S17 the store run's spawn and when it runs", () => {
  it('one spawn of node with the project rotator and --ensure-current, cwd the project, no timeout or env key, after the last write', () => withTree({ [SET[1]]: PRIOR, 'migrate-gates.mjs': null }, (dir) => {
    const { order, deps } = recorder(dir);
    const { calls, spawn } = fakeSpawn({}, order);
    run(dir, { deps: { ...deps, spawnSync: spawn } });
    assert.deepEqual(calls.map(({ cmd, args, opts }) => [cmd, args, opts?.cwd, 'timeout' in (opts ?? {}), 'env' in (opts ?? {})]), [[process.execPath, [join(dir, 'scripts', 'archive-decisions.mjs'), '--ensure-current'], dir, false, false]]);
    assert.deepEqual(order, [SET[1], 'migrate-gates.mjs', '<spawn>'], 'the spawn is the last entry, after every publish');
  }));
  it('an accepted component and a declined one whose seed files hold the rotator: one spawn each, on a current store and an old one', () => {
    const declined = (n) => (dir) => put(dir, { ...PAIR_BODIES, [n]: bundled(n) });
    const components = [['an accepted component', {}, () => {}], ['a declined one, the rotator alone', null, declined(ROT[0])], ['a declined one, its suite alone', null, declined(ROT[1])]];
    const got = components.flatMap(([c, bodies, lay]) => [['a current store', () => {}], ['an old one', both]].map(([s, store]) => [`${c} on ${s}`, withTree(bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      run(dir, { deps: { spawnSync: spawn } });
      return calls.length;
    }, { setup: (dir) => { lay(dir); store(dir); } })]));
    assert.deepEqual(got, got.map(([label]) => [label, 1]));
  });
  it('an already-current exit 0 relays no stdout line, the SKIP line included; each stderr line relayed prefixed, last; the token as the file lines make it', () => {
    const rows = [[{}, 'already-present', [L.count(21)]], [{ [SET[1]]: PRIOR }, 'refreshed', [L.refreshed(SET[1]), L.count(20), HOOK]]];
    for (const [bodies, token, lines] of rows) for (const [stderr, tail] of [['', []], ['note one\nnote two\n', [`${S}note one`, `${S}note two`]]]) withTree(bodies, (dir) => {
      const { calls, spawn } = fakeSpawn({ stdout: `${SKIP}\nalready-current\n`, stderr });
      const r = run(dir, { deps: { spawnSync: spawn } });
      assert.deepEqual([calls.length, r.token, r.lines], [1, token, [...lines, ...tail]], `stderr ${JSON.stringify(stderr)}`);
    });
    withTree({}, (dir) => {
      const { calls, spawn } = fakeSpawn({ stdout: 'brought-current: migrated, navigator written\nalready-current\n' });
      const r = run(dir, { deps: { spawnSync: spawn } });
      assert.deepEqual([calls.length, r.token, r.lines], [1, 'already-present', [L.count(21)]], 'the summary is the last stdout line alone');
    });
  });
  it('a create-only placement whose temp cleanup fails: the temp note after the hook-run line, the store lines after the note, seeded', () => withTree({ 'migrate-gates.mjs': null }, (dir) => {
    let calls = 0;
    const rm = (p) => { if (calls++ === 0) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }); rmSync(p, { force: true }); };
    const r = run(dir, { deps: { rm, spawnSync: fakeSpawn({ stdout: 'brought-current: navigator written\n' }).spawn } });
    const note = 'scripts/migrate-gates.mjs: the write stands, but its temp file could not be removed — delete it by hand: ';
    assert.deepEqual([r.token, r.lines.map((l) => (l.startsWith(note) ? note : l))], ['seeded', [L.placed('migrate-gates.mjs'), L.count(20), HOOK, note, NAVIGATOR]], r.lines.join('\n'));
  }));
  it('not-placed, skipped-no-node-evidence, wrong-node-kind, bundle-unreadable, write-refused, race-unresolved and a declined tree with no rotator spawn nothing', () => {
    const unreadable = (p, ...rest) => { if (String(p) === join(BUNDLE, LAST)) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); return readFileSync(p, ...rest); };
    const raced = (dir) => (from, to) => { if (to === join(dir, 'scripts', 'migrate-gates.mjs')) writeFileSync(to, OLD('migrate-gates.mjs')); return linkSync(from, to); };
    const blocks = { setup: (dir) => put(dir, { ...PAIR_BODIES, 'markdown-blocks.mjs': bundled('markdown-blocks.mjs') }) };
    const rows = [
      ['not-placed', null, {}, () => ({})],
      ['skipped-no-node-evidence', Object.fromEntries(NODE_EVIDENCE_SCRIPTS.map((n) => [n, null])), { node: false }, () => ({})],
      ['wrong-node-kind', { [LAST]: null }, { setup: (dir) => symlinkSync(join(dir, 'package.json'), join(dir, 'scripts', LAST)) }, () => ({})],
      ['bundle-unreadable', {}, {}, () => ({ readFile: unreadable })],
      ['write-refused', { [SET[1]]: PRIOR }, {}, (dir) => recorder(dir, { refuseAt: 1 }).deps],
      ['race-unresolved', { 'migrate-gates.mjs': null }, {}, (dir) => ({ link: raced(dir) })],
      ['already-present', null, blocks, () => ({})],
    ];
    const got = rows.map(([cause, bodies, tree, deps]) => withTree(bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      const r = run(dir, { deps: { ...deps(dir), spawnSync: spawn } });
      return [r.token === 'failed' ? r.lines[0].split(' — ')[0] : r.token, calls.length];
    }, tree));
    assert.deepEqual(got, rows.map(([cause]) => [cause, 0]));
    withTree(null, (dir) => {
      const { calls, spawn } = fakeSpawn();
      assert.deepEqual([run(dir, { dryRun: true, deps: { spawnSync: spawn } }).lines, calls.length], [[L.count(1), NOT_ACCEPTED], 0], 'a declined tree with no rotator prints no would line dry');
    }, blocks);
  });
  it('a dry run spawns nothing and ends with the would line exactly when the rotator is judged, the token unchanged by it', () => {
    const would = (l) => l.replace(/— (refreshed|replaced|placed) /, '— would be $1 ');
    // A declined component whose judged seed closure holds the rotator: an edited rotator, its import absent.
    const declined = { setup: (dir) => put(dir, { ...PAIR_BODIES, [ROT[0]]: EDIT(ROT[0]) }) };
    const rows = [[{ [SET[1]]: PRIOR }, 'would-refresh', [would(L.refreshed(SET[1])), L.count(20), DRY_HOOK, WOULD]], [{}, 'already-present', [L.count(21), WOULD]],
      [null, 'would-seed', [would(L.replaced(ROT[0])), would(L.placed('markdown-blocks.mjs')), NOT_ACCEPTED, 'if a commit hook runs the files named above, writing them may stop the next commit', WOULD], declined]];
    for (const [bodies, token, lines, tree] of rows) withTree(bodies, (dir) => {
      const { calls, spawn } = fakeSpawn();
      const r = run(dir, { dryRun: true, deps: { spawnSync: spawn } });
      assert.deepEqual([calls.length, r.token, r.lines], [0, token, lines]);
    }, tree);
  });
});

describe('spec:distribution-files/S27 the store moved by real rotator runs', () => {
  const group = (body) => Object.fromEntries(ROT.map((n) => [n, body(n)]));
  for (const [kind, body, line] of [['earlier', OLD, L.refreshed], ['edited', EDIT, L.replaced]]) it(`a monolith beside decisions.md, the three on ${kind} bodies, no checker: written, migrated, the monolith gone, --check green`, { timeout: 120_000 }, () => gitTree(group(body), both, (dir) => {
    const r = run(dir, { deps: { spawnSync: seam, priors: priorsWith(...ROT) } });
    assert.deepEqual([r.token, linesOf(dir, r)], ['refreshed', [...ROT.map(line), L.count(18), HOOK, SNAP, MIGRATED, NOTE]], r.lines.join('\n'));
    holds(dir, group(bundled));
    const check = sh(dir, process.execPath, 'scripts/archive-decisions.mjs', '--check');
    assert.deepEqual([existsSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md')), check.status], [false, 0], `${check.stdout}${check.stderr}`);
  }));
  it('decisions.md and no adr/ beside an earlier rotator body, no checker: the file line, the count, the hook-run line, navigator written, the index note', { timeout: 120_000 }, () => gitTree({ [ROT[0]]: OLD(ROT[0]) }, decisions, (dir) => {
    const r = run(dir, { deps: { spawnSync: seam, priors: priorsWith(ROT[0]) } });
    assert.deepEqual([r.token, r.lines], ['refreshed', [L.refreshed(ROT[0]), L.count(20), HOOK, NAVIGATOR, NOTE]]);
    holds(dir, { [ROT[0]]: bundled(ROT[0]) });
  }));
  it('a current family over either move: refreshed with no file line; seeded beside one placed file', { timeout: 240_000 }, () => {
    for (const [store, tail] of [[both, [SNAP, MIGRATED, NOTE]], [decisions, [NAVIGATOR, NOTE]]]) {
      for (const [bodies, token, lines] of [[{}, 'refreshed', [L.count(21)]], [{ 'migrate-gates.mjs': null }, 'seeded', [L.placed('migrate-gates.mjs'), L.count(20), HOOK]]]) gitTree(bodies, store, (dir) => {
        const r = run(dir, { deps: { spawnSync: seam } });
        assert.deepEqual([r.token, linesOf(dir, r)], [token, [...lines, ...tail]], r.lines.join('\n'));
      });
    }
  });
});

describe('spec:distribution-files/S28 a rotator that does not bring the store current fails the op', () => {
  const failed = (how, tail) => ({ op: 'scripts', token: 'failed', failed: true, lines: [FAIL(how), L.refreshed(SET[1]), L.count(20), HOOK, ...tail] });
  it('a real monolith with no decisions.md: failed, exited with code 1, the op lines, the rotator stderr line prefixed, the prior written stays', { timeout: 120_000 }, () => gitTree({ [SET[1]]: PRIOR }, monolith, (dir) => {
    const r = run(dir, { deps: { spawnSync: seam } });
    assert.deepEqual(r, failed('exited with code 1', [`${S}[archive-decisions] docs/ai/decisions.md not found but a legacy monolith is present — a broken tree; restore docs/ai/decisions.md before migrating.`]));
    holds(dir, { [SET[1]]: bundled(SET[1]) });
  }));
  it('through deps.spawnSync: exit 3, a signal, an error, an error with a signal, an error on exit 0: failed, stderr then stdout lines prefixed, nothing put back', () => {
    const boom = new Error('spawnSync node EAGAIN');
    const rows = [[{ status: 3 }, 'exited with code 3'], [{ status: null, signal: 'SIGTERM' }, 'was killed by signal SIGTERM'], [{ status: null, error: boom }, `ended with an error (${boom.message})`], [{ status: null, signal: 'SIGTERM', error: boom }, `ended with an error (${boom.message})`],
      [{ error: new Error('spawnSync node EPIPE'), status: 0, signal: null, stdout: 'already-current\n', stderr: '' }, 'ended with an error (spawnSync node EPIPE)', [`${S}already-current`]]];
    for (const [answer, how, tail = [`${S}err one`, `${S}out one`, `${S}out two`]] of rows) withTree({ [SET[1]]: PRIOR }, (dir) => {
      const r = run(dir, { deps: { spawnSync: fakeSpawn({ stdout: 'out one\nout two\n', stderr: 'err one\n', ...answer }).spawn } });
      assert.deepEqual(r, failed(how, tail), how);
      holds(dir, { [SET[1]]: bundled(SET[1]) });
    });
  });
  it('through main: exit code 1, scripts: failed, and specs, rules and index still print their token lines', () => withTree({ [SET[1]]: PRIOR }, (dir) => {
    const rotator = { status: 3, signal: null, stdout: '', stderr: 'err one\n' };
    const spawn = (cmd, args, opts) => (String(args?.[0] ?? '').endsWith('scripts/archive-decisions.mjs') ? rotator : spawnSync(cmd, args, opts));
    const { code, stdout } = main(['--reconcile', '--cwd', dir], { deps: { spawnSync: spawn } });
    const ops = tokensOf(stdout).map((t) => t.split(':')[0]);
    assert.deepEqual([code, tokensOf(stdout).filter((t) => t.startsWith('scripts:')), ops.slice(ops.indexOf('scripts') + 1)], [1, ['scripts: failed'], ['specs', 'rules', 'index']], stdout);
  }));
});
