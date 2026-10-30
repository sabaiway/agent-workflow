// The op's leaf is imported dynamically, so a tree without it fails each cell, never the load.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../ensure-configs.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { SCRIPT_PRIORS, PRIOR_FILES } from '../script-priors.mjs';

const { ensureScripts, SCRIPT_CHANNEL, LOCAL_HOOK_CHANNEL } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
// A name is a path under scripts/; a kit-folder name maps to its manifest path, the installer's to the local hook channel.
const [SRC, INSTALLERS] = [new Map(), new Set()];
const bundled = (n) => readFileSync(join(BUNDLE, SRC.get(n) ?? n));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// File bytes are compared by digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
const shaOf = (bytes) => (bytes === null ? null : sha(bytes));
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);
// The catalog seam: OLD(name) catalogued as a body a release shipped, for names with no row of their own.
const priorsWith = (...names) => [...SCRIPT_PRIORS, ...names.map((n) => ({ file: SRC.get(n) ?? n, digest: sha(OLD(n)) }))];
const rel = (n) => `scripts/${n}`;
const channelOf = (n) => (INSTALLERS.has(n) ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL);
// The kit folder, read inside each cell from the kit mirror's manifest and node-evidence: the family (the deployed entries less the
// spec layer's) in write order — the installer, then each file after every family file its bundled relative imports name, else by path.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
let layout;
const kitLayout = () => (layout ??= (async () => {
  const [{ readFamily }, { KIT_SCRIPTS_DIR, INSTALLER_REL }] = await Promise.all([import('../../references/scripts/family.mjs'), import('../node-evidence.mjs')]);
  const deployed = readFamily(BUNDLE).filter((e) => e.role === 'deployed'), spec = (e) => ['spec-schema', 'docs-size'].includes(e.module);
  const kit = posix.relative('scripts', KIT_SCRIPTS_DIR), installer = posix.relative(KIT_SCRIPTS_DIR, INSTALLER_REL);
  const at = (path) => { assert.ok(deployed.some((e) => e.path === path), `${path} is a deployed entry of the manifest`); SRC.set(`${kit}/${path}`, path); return `${kit}/${path}`; };
  const importsOf = (path) => [...readFileSync(join(BUNDLE, path), 'utf8').matchAll(IMPORT)].map((m) => posix.join(posix.dirname(path), m[1]));
  const [order, rest] = [[installer], deployed.filter((e) => !spec(e) && e.path !== 'run.mjs' && e.path !== installer).map((e) => e.path)];
  for (let next; (next = rest.filter((p) => importsOf(p).every((d) => !rest.includes(d))).sort()[0]);) order.push(...rest.splice(rest.indexOf(next), 1));
  assert.deepEqual(rest, [], "the family's imports close no cycle");
  INSTALLERS.add(at(installer));
  return { dir: KIT_SCRIPTS_DIR, kit, at, order: order.map(at), last: at(order.at(-1)), installer: at(installer), pairs: deployed.filter(spec).map((e) => at(e.path)),
    would: `ADR store: ${rel(at('archives/archive-decisions.mjs'))} --ensure-current would run after the writes, bringing the store current or writing nothing when it already is` };
})());

const SHIPPED = 'matches a body an earlier release shipped';
const DIFFERS = 'differs from every body this kit knows it shipped';
const HOOK = 'the commit hook runs the files written above, so they may stop the next commit';
const DRY_HOOK = 'the commit hook runs the files named above, so writing them may stop the next commit';
const L = {
  refreshed: (n) => `${rel(n)}: ${SHIPPED} — refreshed to the bundled one`,
  replaced: (n) => `${rel(n)}: ${DIFFERS} — replaced by the bundled body; an edit meant to last goes in ${channelOf(n)}`,
  placed: (n) => `${rel(n)}: absent — placed from the bundled scripts`,
  count: (k, at) => `${at}/: ${k} other kit scripts are already the bundled body — nothing written`,
  partway: (k) => `the writes stopped PARTWAY — the ${k} file(s) named above were already written and are NOT rolled back`,
};
const FORBIDDEN = /withheld|customized|preserved|kept aside|the user's yes|the block below|you edited|user edited|edited it/i;

const put = (dir, bodies) => { for (const [n, body] of Object.entries(bodies)) if (body !== null) { mkdirSync(dirname(join(dir, 'scripts', n)), { recursive: true }); writeFileSync(join(dir, 'scripts', n), body); } mkdirSync(join(dir, 'scripts'), { recursive: true }); };
// A temp project (package.json unless node is false, docs/ai). `bodies` maps a name of `family` to its bytes or
// null (absent), every other name on its bundled body; `bodies` null leaves scripts/ to `setup`.
const withTree = (bodies, fn, { node = true, setup = () => {}, family = [] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-op-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (bodies) put(dir, Object.fromEntries(family.map((n) => [n, n in bodies ? bodies[n] : bundled(n)])));
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
const holds = (dir, want) => { for (const [n, body] of Object.entries(want)) assert.equal(shaOf(bytesOf(dir, n)), shaOf(body), `${n} holds the expected body`); };
const isFileLine = (l) => /^scripts\/[^:]/.test(l);
// The S16 invariant, asserted on every run below: a run that completed a publish (an atomic rename or a
// create-only link), failed or not, prints the hook-run line once after its file lines, one that
// completed none prints none; a dry run prints the would-be form once exactly when a file line would write,
// and, every tree here judging the rotator, ends with the store's would line.
const assertHookRun = (r, wrote, dryRun, would) => {
  const hooks = r.lines.flatMap((l, i) => (/commit hook runs the files/.test(l) ? [i] : []));
  const due = dryRun ? r.lines.some((l) => isFileLine(l) && l.includes(' — would be ')) : wrote > 0;
  const [last, word] = [r.lines.findLastIndex(isFileLine), dryRun ? 'files named above' : 'files written above'];
  assert.deepEqual([hooks.length, hooks.every((i) => i > last && r.lines[i].includes(word)), dryRun ? r.lines.at(-1) : would], [due ? 1 : 0, true, would], `the hook-run line, then the would line:\n${r.lines.join('\n')}`);
};
// `would` is the store's would line of the layout the tree is laid out in.
const run = (dir, { would, ...opts } = {}) => {
  const [deps, done] = [opts.deps ?? {}, []];
  const counted = (real) => (from, to) => {
    const out = real(from, to);
    done.push(to);
    return out;
  };
  const r = ensureScripts({ cwd: dir, kitRoot: KIT, ...opts, deps: { git: () => ({ status: 128, stdout: '', stderr: '' }), ...deps, rename: counted(deps.rename ?? renameSync), link: counted(deps.link ?? linkSync) } });
  assertHookRun(r, done.length, opts.dryRun, would);
  return r;
};
// A recording writer: each atomic publish (rename) and create-only publish (link) records its target name,
// the `refuseAt`-th one throws EACCES before it touches the tree.
const recorder = (dir, { refuseAt = 0 } = {}, order = []) => {
  const record = (real) => (from, to) => {
    if (order.push(relative(join(dir, 'scripts'), to)) === refuseAt) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
    return real(from, to);
  };
  return { order, deps: { rename: record(renameSync), link: record(linkSync) } };
};

const cli = (dir, flags = [], ctx = {}) => main(['--reconcile', ...flags, '--cwd', dir], { ...ctx, deps: { git: () => ({ status: 128, stdout: '', stderr: '' }), ...ctx.deps } });
const tokensOf = (out) => [...out.matchAll(/^ {2}([a-z-]+): ([a-z-]+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
const opsOf = (out) => tokensOf(out).map((t) => t.split(':')[0]);
// The detail lines one op printed under its token line.
const detailsOf = (out, op) => {
  const rest = (out.split(`\n  ${op}: `)[1] ?? '').split('\n').slice(1);
  const end = rest.findIndex((l) => !l.startsWith('      '));
  return rest.slice(0, end === -1 ? rest.length : end).map((l) => l.slice(6));
};
// What the retired replace step printed: its block and its command.
const REPLACE_STEP = /user's yes|--replace-custom/;

describe('spec:distribution-files/S14 the rule by its cells over an accepted component', () => {
  const check = (dir, r, token, lines) => {
    assert.deepEqual({ token: r.token, lines: r.lines, entries: 'entries' in r }, { token, lines, entries: false });
    assert.deepEqual(r.lines.filter((l) => FORBIDDEN.test(l)), [], 'no line says withheld, customized, preserved, kept aside, the yes, the block or an edit by the user');
    assert.equal(existsSync(join(dir, '.agent-workflow')), false, 'nothing written under .agent-workflow');
  };
  it('one plain run in the kit folder: a prior (through deps.priors) refreshed, each edit replaced naming its channel, an absent file placed create-only, a current one counted, the hook-run line, no store line', async () => {
    const K = await kitLayout();
    const [caps, issues, root] = ['archives/archive-caps.mjs', 'archives/archive-issues.mjs', 'shared/project-root.mjs'].map(K.at);
    const [bodies, want] = [{ [K.installer]: EDIT(K.installer), [caps]: OLD(caps), [issues]: EDIT(issues), [root]: null }, { [K.installer]: L.replaced, [caps]: L.refreshed, [issues]: L.replaced, [root]: L.placed }];
    withTree(bodies, (dir) => {
      const links = [], link = (from, to) => { links.push(relative(join(dir, 'scripts'), to)); return linkSync(from, to); };
      check(dir, run(dir, { would: K.would, deps: { link, priors: priorsWith(caps) } }), 'seeded', [...K.order.filter((n) => n in bodies).map((n) => want[n](n)), L.count(K.order.length - 4, K.dir), HOOK]);
      assert.deepEqual(links, [root]);
      holds(dir, Object.fromEntries(Object.keys(bodies).map((n) => [n, bundled(n)])));
      assert.deepEqual(readdirSync(join(dir, 'scripts')), [K.kit], 'every file at its deployed path under the kit folder, none flat in scripts/');
    }, { family: K.order });
    assert.deepEqual([LOCAL_HOOK_CHANNEL, SCRIPT_CHANNEL], ['the local hook file scripts/pre-commit.local, which the commit hook runs first', 'a script or suite of your own under its own name in scripts/, or a config the script reads']);
  });
  it('each family file edited alone, in turn: replaced in place by the bundled bytes, its line naming LOCAL_HOOK_CHANNEL for the installer and SCRIPT_CHANNEL for every other file', async () => {
    const K = await kitLayout();
    for (const n of K.order) withTree({ [n]: EDIT(n) }, (dir) => { check(dir, run(dir, { would: K.would }), 'refreshed', [L.replaced(n), L.count(K.order.length - 1, K.dir), HOOK]); holds(dir, { [n]: bundled(n) }); }, { family: K.order });
  });
});

describe('spec:distribution-files/S15 the dry run and the quiet cells', () => {
  const wouldBe = (l) => (l === HOOK ? DRY_HOOK : l.replace(/— (refreshed|replaced|placed) /, '— would be $1 '));
  it("a dry run gives a plain run's lines in their would-be forms and the store's would line, writes nothing, would-seed beside an absent file, else would-refresh", async () => {
    const K = await kitLayout(), [caps, issues] = ['archives/archive-caps.mjs', 'archives/archive-issues.mjs'].map(K.at), deps = { priors: priorsWith(K.installer) };
    const rows = [[{ [K.installer]: OLD(K.installer), [caps]: EDIT(caps) }, 'would-refresh', 'refreshed'], [{ [K.installer]: EDIT(K.installer), [issues]: null }, 'would-seed', 'seeded']];
    for (const [bodies, dryToken, token] of rows) {
      const real = withTree(bodies, (dir) => run(dir, { would: K.would, deps }), { family: K.order });
      withTree(bodies, (dir) => {
        const [before, dry] = [snapshot(dir), run(dir, { would: K.would, dryRun: true, deps })];
        assert.deepEqual([dry.token, real.token, 'entries' in dry, dry.lines], [dryToken, token, false, [...real.lines.map(wouldBe), K.would]]);
        assert.deepEqual(snapshot(dir), before);
      }, { family: K.order });
    }
  });
  it('a fully current family over a current store: already-present, the one count line, no hook-run line, no store line, nothing written', async () => {
    const K = await kitLayout();
    withTree({}, (dir) => {
      const before = snapshot(dir);
      assert.deepEqual(run(dir, { would: K.would }), { op: 'scripts', token: 'already-present', failed: false, lines: [L.count(K.order.length, K.dir)] });
      assert.deepEqual(snapshot(dir), before);
    }, { family: K.order });
  });
});

describe('spec:distribution-files/S16 the failure cells and the hook-run line', () => {
  const linkAway = (dir, at) => { renameSync(join(dir, at), join(dir, 'elsewhere')); symlinkSync(join(dir, 'elsewhere'), join(dir, at)); }; // the target holds what the folder held
  const rows = [
    ['a symlinked kit folder', 'wrong-node-kind', (K) => K.dir, 'exists but is a symlink', (K, dir) => linkAway(dir, K.dir)],
    ['a symlinked module folder', 'wrong-node-kind', (K) => posix.dirname(rel(K.last)), 'exists but is a symlink', (K, dir) => linkAway(dir, posix.dirname(rel(K.last)))],
    ['a symlink at the last family path', 'wrong-node-kind', (K) => rel(K.last), 'exists but is a symlink', (K, dir) => { writeFileSync(join(dir, 'elsewhere.txt'), 'the link target\n'); symlinkSync(join(dir, 'elsewhere.txt'), join(dir, rel(K.last))); }],
    ['a directory at the last family path', 'wrong-node-kind', (K) => rel(K.last), 'exists but is a directory', (K, dir) => mkdirSync(join(dir, rel(K.last)))],
    ['an unreadable bundled body at the last family path', 'bundle-unreadable', (K) => rel(K.last), 'the bundled script could not be read, so nothing was written — reinstall the kit.', (K, dir) => { writeFileSync(join(dir, rel(K.last)), bundled(K.last)); cpSync(BUNDLE, join(dir, 'kit', 'references', 'scripts'), { recursive: true }); rmSync(join(dir, 'kit', 'references', 'scripts', SRC.get(K.last))); }],
  ];
  // A folder is named with or without its trailing slash; a file by its deployed path.
  for (const [kind, cause, at, says, setup] of rows) it(`${kind}: ${cause} naming it, no entries field, nothing written, a link target untouched`, async () => {
    const K = await kitLayout();
    withTree({ [K.installer]: EDIT(K.installer), [K.last]: null }, (dir) => {
      const before = snapshot(dir), r = run(dir, { would: K.would, kitRoot: existsSync(join(dir, 'kit')) ? join(dir, 'kit') : KIT });
      const named = [`${at(K)}:`, `${at(K)}/:`].some((head) => r.lines[0].startsWith(`${cause} — ${head} ${says}`));
      assert.deepEqual([r.token, 'entries' in r, named, snapshot(dir)], ['failed', false, true, before], r.lines.join('\n'));
    }, { family: K.order, setup: (dir) => setup(K, dir) });
  });
  it('a write refused at the second write: write-refused, the installer written and not rolled back, the later files not refreshed, replaced or placed, PARTWAY counting 1', async () => {
    const K = await kitLayout();
    const [blocks, index, caps, issues] = ['shared/markdown-blocks.mjs', 'shared/index.mjs', 'archives/archive-caps.mjs', 'archives/archive-issues.mjs'].map(K.at);
    const bodies = { [K.installer]: OLD(K.installer), [blocks]: OLD(blocks), [index]: OLD(index), [caps]: EDIT(caps), [issues]: null };
    withTree(bodies, (dir) => {
      const r = run(dir, { would: K.would, deps: { ...recorder(dir, { refuseAt: 2 }).deps, priors: priorsWith(K.installer, blocks, index) } });
      assert.deepEqual({ token: r.token, entries: 'entries' in r, lines: r.lines }, { token: 'failed', entries: false, lines: [`write-refused — ${rel(blocks)}: EACCES: refused`, L.refreshed(K.installer),
        `${rel(blocks)}: ${SHIPPED} — not refreshed; its write was refused (above)`, `${rel(index)}: ${SHIPPED} — not refreshed; the run stopped before it`, `${rel(caps)}: ${DIFFERS} — not replaced; the run stopped before it; an edit meant to last goes in ${SCRIPT_CHANNEL}`,
        `${rel(issues)}: absent — not placed; the run stopped before it`, L.count(K.order.length - 5, K.dir), HOOK, L.partway(1)] });
      holds(dir, { ...bodies, [K.installer]: bundled(K.installer) });
      assert.deepEqual(Object.keys(snapshot(dir)).filter((p) => p.endsWith('.tmp')), [], 'no temp file left');
    }, { family: K.order });
  });
  it('the hook-run line: once on a run that wrote, failed or not; none on one that wrote none; once on a dry run that would write', async () => {
    const K = await kitLayout();
    const [one, two] = [{ [K.installer]: EDIT(K.installer) }, { [K.installer]: EDIT(K.installer), [K.order[1]]: EDIT(K.order[1]) }];
    const rows = [['a plain run that wrote', one, () => ({}), 1], ['a plain run that wrote none', {}, () => ({}), 0],
      ['a failed run after one write', two, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), 1], ['a failed run before any write', two, (dir) => ({ deps: recorder(dir, { refuseAt: 1 }).deps }), 0],
      ['a dry run that would write', one, () => ({ dryRun: true }), 1], ['a dry run that would write none', {}, () => ({ dryRun: true }), 0]];
    const got = rows.map(([label, bodies, opts]) => [label, withTree(bodies, (dir) => run(dir, { would: K.would, ...opts(dir) }).lines.filter((l) => l === HOOK || l === DRY_HOOK).length, { family: K.order })]);
    assert.deepEqual(got, rows.map(([label, , , want]) => [label, want]));
  });
});

describe('spec:distribution-files/S18 one token precedence over the plain and dry runs', () => {
  it('adjacent cells, one table: failed, seeded, refreshed, already-present; would-seed and would-refresh on a dry run; never pending or customized-preserved', async () => {
    const K = await kitLayout(), [c, i] = ['archives/archive-caps.mjs', 'archives/archive-issues.mjs'].map(K.at), priors = priorsWith(K.installer);
    const [plain, dry, caps, installer, absent] = [() => ({ deps: { priors } }), () => ({ dryRun: true, deps: { priors } }), { [c]: EDIT(c) }, { [K.installer]: OLD(K.installer) }, { [i]: null }];
    const rows = [
      ['failed over seeded: the placement refused after the installer was refreshed', { ...installer, ...absent }, (dir) => ({ deps: { ...recorder(dir, { refuseAt: 2 }).deps, priors } }), 'failed'],
      ['seeded over refreshed: an absent file placed beside a replaced edit', { ...caps, ...absent }, plain, 'seeded'],
      ['refreshed by a replaced edit alone', caps, plain, 'refreshed'],
      ['refreshed over already-present', installer, plain, 'refreshed'],
      ['already-present', {}, plain, 'already-present'],
      ['would-seed in the place of seeded on a dry run', { ...caps, ...absent }, dry, 'would-seed'],
      ['would-refresh in the place of refreshed on a dry run', caps, dry, 'would-refresh'],
    ];
    const got = rows.map(([label, bodies, opts]) => [label, withTree(bodies, (dir) => run(dir, { would: K.would, ...opts(dir) }).token, { family: K.order })]);
    assert.deepEqual(got, rows.map(([label, , , token]) => [label, token]));
  });
});

describe('spec:distribution-files/S19 write order through a recording writer', () => {
  // Every family file but the last due, by turns edited, on a catalogued earlier body and absent; the last stays current.
  const tree = (K, bodies = Object.fromEntries(K.order.slice(0, -1).map((n, i) => [n, [EDIT(n), OLD(n), null][i % 3]]))) => ({ bodies, priors: priorsWith(...K.order), due: K.order.filter((n) => n in bodies) });
  it("one plain run's refreshes, replacements and placements: the installer, then each family file after every family file it imports, in code-unit order of its manifest path otherwise", async () => {
    const K = await kitLayout(), { bodies, priors, due } = tree(K);
    assert.deepEqual(K.order.slice(0, 4).map((n) => SRC.get(n)), [SRC.get(K.installer), 'shared/markdown-blocks.mjs', 'shared/project-root.mjs', 'shared/index.mjs']);
    assert.deepEqual(K.order.slice(4).filter((n) => !SRC.get(n).startsWith('archives/')), [], 'then the archives');
    const order = withTree(bodies, (dir) => { const { order: written, deps } = recorder(dir); run(dir, { would: K.would, deps: { ...deps, priors } }); return written; }, { family: K.order });
    assert.deepEqual(order, due);
  });
  it('a write refused partway leaves every later file unwritten', async () => {
    const K = await kitLayout(), { bodies, priors, due } = tree(K);
    withTree(bodies, (dir) => {
      const [before, { order, deps }] = [snapshot(dir), recorder(dir, { refuseAt: 2 })], now = (run(dir, { would: K.would, deps: { ...deps, priors } }), snapshot(dir));
      assert.deepEqual([order, due.slice(1).filter((n) => now[join('scripts', n)] !== before[join('scripts', n)])], [due.slice(0, 2), []]);
    }, { family: K.order });
  });
});

describe('spec:distribution-files/S20 the race of an absent file on a plain run', () => {
  // The create-only link finds the file `body` put there between the survey and the write: the family file
  // before the last in write order, so the installer is written before it and the last file after it.
  const appear = (K, bodies, body, deps = {}) => withTree(bodies, (dir) => {
    const target = join(dir, rel(K.order.at(-2)));
    const link = (from, to) => {
      if (to === target) writeFileSync(to, body);
      return linkSync(from, to);
    };
    return [run(dir, { would: K.would, deps: { ...deps, link } }), ...[K.installer, K.order.at(-2), K.last].map((n) => shaOf(bytesOf(dir, n)))];
  }, { family: K.order });
  it('one that appears with the bundled body stands, its line saying so, already-present when every other file is current', async () => {
    const K = await kitLayout(), raced = K.order.at(-2);
    const [r, , placed] = appear(K, { [raced]: null }, bundled(raced));
    assert.deepEqual([r.token, r.lines, placed], ['already-present', [`${rel(raced)}: appeared while this run was placing it — the bundled body stands, nothing written`, L.count(K.order.length - 1, K.dir)], sha(bundled(raced))]);
  });
  it('one with other bytes: race-unresolved, the earlier write kept and named, nothing further written', async () => {
    const K = await kitLayout(), raced = K.order.at(-2);
    const [r, installer, after, later] = appear(K, { [K.installer]: OLD(K.installer), [raced]: null, [K.last]: OLD(K.last) }, OLD(raced), { priors: priorsWith(K.installer, K.last) });
    assert.deepEqual([r.token, r.lines], ['failed', [`race-unresolved — ${rel(raced)}: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled`,
      L.refreshed(K.installer), `${rel(raced)}: absent — not placed; its write was refused (above)`, `${rel(K.last)}: ${SHIPPED} — not refreshed; the run stopped before it`, L.count(K.order.length - 3, K.dir), HOOK, L.partway(1)]]);
    assert.deepEqual([installer, after, later], [bundled(K.installer), OLD(raced), OLD(K.last)].map(sha));
  });
});

describe('spec:distribution-files/S21 the rule through real commits', () => {
  const home = mkdtempSync(join(tmpdir(), 'scripts-op-home-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  // Every spawn drops each inherited GIT_ variable and NODE_TEST_CONTEXT, the op's spawn of the rotator included.
  const env = Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home)).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_V8_COVERAGE'));
  const sh = (dir, cmd, ...args) => {
    const r = spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' }), out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(!r.error && r.signal === null, `${cmd} ${args.join(' ')} did not run to an exit (${r.error?.code ?? r.signal}): ${out}`);
    return { status: r.status, out };
  };
  const ok = (dir, ...cmd) => { const { status, out } = sh(dir, ...cmd); assert.equal(status, 0, out); };
  const commit = (dir, message, ...flags) => { ok(dir, 'git', 'add', '-A'); return sh(dir, 'git', 'commit', '-q', ...flags, '-m', message); };
  const passes = ({ status, out }) => assert.equal(status, 0, out);
  const plainRun = (dir) => {
    const { code, stdout } = cli(dir, ['--only', 'scripts'], { deps: { spawnSync: (command, args, options) => spawnSync(command, args, { ...options, env }) } });
    assert.deepEqual([code, REPLACE_STEP.test(stdout), existsSync(join(dir, '.agent-workflow'))], [0, false, false], stdout);
    return { tokens: tokensOf(stdout), details: detailsOf(stdout, 'scripts') };
  };
  it('the hook its installer writes runs the docs checker and archive lines through the stable kit command and no suite, a commit passes; an edited installer is made the bundled bytes by one plain run; an absent family file placed with no command', { timeout: 120_000 }, async () => {
    const K = await kitLayout();
    withTree({}, (dir) => {
      for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'fixture']]) ok(dir, 'git', ...args);
      for (const [doc, type, title] of [['changelog.md', 'log', 'Changelog'], ['known_issues.md', 'issues', 'Known issues']]) writeFileSync(join(dir, 'docs', 'ai', doc), `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${title}\n`);
      const checker = rel(K.at('docs-size/check-docs-size.mjs')), hook = () => readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8').split('\n');
      for (const args of [[checker, '--write-index'], [rel(K.installer)]]) ok(dir, process.execPath, ...args);
      const command = `node ${rel(K.at('run.mjs'))}`;
      const lines = [`${command} docs-size`, `${command} docs-size --check-index`, ...['changelog', 'issues', 'decisions'].map((name) => `${command} archive-${name} --check`)];
      assert.deepEqual([lines.filter((l) => !hook().includes(l)), hook().filter((l) => /--test\b|\.test\.mjs/.test(l))], [[], []], hook().join('\n'));
      passes(commit(dir, 'one'));
      put(dir, { [K.installer]: EDIT(K.installer) });
      const edited = plainRun(dir);
      assert.deepEqual([edited.tokens, edited.details[0].includes('scripts/pre-commit.local')], [['scripts: refreshed'], true], edited.details.join('\n'));
      assert.deepEqual(edited.details, [L.replaced(K.installer), L.count(K.order.length - 1, K.dir), HOOK]);
      holds(dir, { [K.installer]: bundled(K.installer) });
      // The tree is commit one's again, so the hook's run is proved on an empty commit.
      passes(commit(dir, 'two', '--allow-empty'));
      rmSync(join(dir, rel(K.last)));
      assert.deepEqual(plainRun(dir), { tokens: ['scripts: seeded'], details: [L.placed(K.last), L.count(K.order.length - 1, K.dir), HOOK] });
      holds(dir, { [K.last]: bundled(K.last) });
    }, { family: K.order, setup: (dir) => put(dir, Object.fromEntries([...K.pairs, K.at('run.mjs')].map((n) => [n, bundled(n)]))) });
  });
});

describe('spec:distribution-files/S22 --only specs and --only scripts each write their own files', () => {
  it('--only specs replaces the edited spec-layer file alone, no scripts line; --only scripts replaces the kit script alone, no specs line; neither prints a replace block or command', async () => {
    const K = await kitLayout(), [caps, checker] = ['archives/archive-caps.mjs', 'docs-size/check-docs-size.mjs'].map(K.at);
    const tree = (fn) => withTree({ [caps]: EDIT(caps) }, fn, { family: K.order, setup: (dir) => put(dir, { ...Object.fromEntries(K.pairs.map((n) => [n, bundled(n)])), [checker]: EDIT(checker) }) });
    tree((dir) => {
      const specs = cli(dir, ['--only', 'specs']).stdout;
      assert.deepEqual([opsOf(specs), detailsOf(specs, 'specs').includes(`${rel(checker)}: ${DIFFERS} — replaced by the bundled body; an edit meant to last goes in ${SCRIPT_CHANNEL}`), REPLACE_STEP.test(specs), shaOf(bytesOf(dir, checker)), shaOf(bytesOf(dir, caps))],
        [['specs'], true, false, sha(bundled(checker)), sha(EDIT(caps))], specs);
    });
    tree((dir) => {
      const scripts = cli(dir, ['--only', 'scripts']).stdout;
      assert.deepEqual([opsOf(scripts), detailsOf(scripts, 'scripts'), REPLACE_STEP.test(scripts), shaOf(bytesOf(dir, checker))], [['scripts'], [L.replaced(caps), L.count(K.order.length - 1, K.dir), HOOK], false, sha(EDIT(checker))], scripts);
    });
  });
});

describe('spec:distribution-files/S24 shipped text of the one rule and the store run', () => {
  const [text, header] = [(...p) => readFileSync(join(KIT, ...p), 'utf8'), (src) => src.slice(0, src.indexOf('\nimport '))];
  const has = (body, yes, no = []) => assert.deepEqual([yes.filter((p) => !body.includes(p)), no.filter((p) => body.includes(p))], [[], []], 'missing phrases, then claimed ones');
  const [RETIRED, STORE_RUN] = [['old-adr-layout-migration-instructed', 'adr-layout-unverifiable'], 'archive-decisions.mjs --ensure-current'];
  it('upgrade.md: the scripts token arm, the enforcement-script paragraph and the owns sentence state the one rule and the store run', () => {
    const doc = text('references', 'modes', 'upgrade.md'), at = doc.indexOf('**What the enforcement-script ensure does.**'), paragraph = at === -1 ? '' : doc.slice(at, doc.indexOf('\n', at));
    has(doc.slice(doc.indexOf('scripts → ')).split(';')[0], ['`seeded`', '`refreshed`', '`already-present`', '`not-placed`', '`skipped-no-node-evidence`'], ['`pending`', 'customized-preserved']);
    has(paragraph, ['a kit script outside the seed names', 'no question and no copy kept', 'where a lasting edit goes', 'the commit hook runs the files written',
      'keeps the standing seed files current with the modules they import', 'places no other kit script', 'hook-run line as a condition', '--ensure-current', 'after the writes', 'its refusal stops the upgrade', '`--write-baseline`',
      'the `enforcement` check line and apply, by the consent route'], ['withheld', 'customized', 'preserved', 'kept aside', 'held back', 'one yes', 'replace block', 'migrate-adr-store']);
    assert.deepEqual(PRIOR_FILES.filter((name) => paragraph.includes(`scripts/${name}`)), [], 'the enforcement-script paragraph names no flat kit file');
    has(doc, ["rewrites only what it owns, and the scripts op's store run moves ADR entries, rewrites their inbound links"], [...RETIRED, 'never auto-migrated', 'legacy-ADR', 'cannot READ', 'the layout it read']);
    has(text('tools', 'upgrade-runlist.mjs'), [], RETIRED);
  });
  it('the ensure-ops.mjs header and the ensure-vocabulary.mjs comments name the leaf, the rule, the store run and no replace run for a kit script', () => {
    has(header(text('tools', 'ensure-ops.mjs')), ['distribution-files/scripts.mjs', 'no question and no copy'], ['SEED_SCRIPTS']);
    has(text('tools', 'ensure-vocabulary.mjs'), ["runs the project's rotator (`--ensure-current`)"], ['SEED_SCRIPTS', 'over the kit scripts', 'held back', ...RETIRED]);
  });
  it('ensure-configs.mjs: its header row and --help name the rule and the store run, no survey of another op and no yes for a kit script', () => {
    const rows = header(text('tools', 'ensure-configs.mjs')).split('\n'), at = rows.findIndex((l) => /^\/\/ {3}scripts /.test(l));
    has(at === -1 ? '' : rows.slice(at, at + 4).join('\n'), ['with no question and no copy kept', 'brings the ADR store current (--ensure-current)'], ['held back']);
    const help = main(['--help']).stdout, from = help.indexOf('\n  --only <op>'), fifth = help.indexOf('A fifth');
    has(help.slice(from, help.indexOf('\n  --cwd', from)), [], ['survey']);
    has(fifth === -1 ? '' : help.slice(fifth, help.indexOf('\n\n', fifth)), ['with no question and no copy kept', `scripts/agent-workflow/archives/${STORE_RUN} brings the ADR store current`], ['yes', 'held back']);
  });
  it('no shipped file but a test names migrate-adr-store; renderers.mjs and status.md name the upgrade for an older layout', () => {
    const isTest = (path) => path.split(/[\\/]/).some((segment) => /\.test(\.mjs)?$/.test(segment));
    const shipped = ['tools', 'references'].flatMap((root) => readdirSync(join(KIT, root), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => relative(KIT, join(entry.parentPath, entry.name))).filter((path) => !isTest(path)));
    assert.deepEqual([...shipped, 'SKILL.md', 'README.md'].filter((path) => text(path).includes('migrate-adr-store')), []);
    const LINE = "/agent-workflow-kit upgrade moves it where scripts/ holds the kit's decisions rotator, or prints the rotator's refusal";
    has(text('tools', 'renderers.mjs'), [`old layout — ${LINE}`]);
    const status = text('references', 'modes', 'status.md'), at = status.indexOf('When `project.adrLayout`');
    const note = at === -1 ? '' : status.slice(at, status.indexOf('need no note', at));
    has(note, [`${LINE}.`]);
    assert.deepEqual([...new Set([...note.matchAll(/\/agent-workflow-kit ([a-z-]+)/g)].map((match) => match[1]))], ['upgrade'], note);
  });
});

describe('spec:distribution-files/S5 one directory, one door', () => {
  const HERE = join(KIT, 'tools', 'distribution-files'), DIR = HERE + sep;
  const specifiers = (source) => [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  const kitModules = (at) => readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (join(at, e.name) + sep === DIR ? [] : kitModules(join(at, e.name))) : e.isFile() && e.name.endsWith('.mjs') ? [join(at, e.name)] : []));
  it('the index exports exactly ensureScripts, SCRIPT_CHANNEL, fileLine and hookLine, each the very export of scripts.mjs, nothing of retired.mjs; replace-set.mjs and kept-aside.mjs are absent', async () => {
    const [door, leaf] = await Promise.all(['./index.mjs', './scripts.mjs'].map((path) => import(path).catch(() => ({}))));
    assert.deepEqual(Object.keys(door).sort(), ['SCRIPT_CHANNEL', 'ensureScripts', 'fileLine', 'hookLine']);
    assert.deepEqual(Object.keys(door).filter((name) => door[name] !== leaf[name]), []);
    assert.deepEqual(['replace-set.mjs', 'kept-aside.mjs'].filter((name) => existsSync(join(HERE, name))), []);
  });
  it('scripts.mjs alone imports retired.mjs; no kit module outside the directory imports past the index; no non-test file of it imports ensure-specs.mjs, ensure-configs.mjs or family-registry.mjs', () => {
    const consumers = ['ensure-configs.mjs', 'ensure-specs.mjs', 'family-registry.mjs'].map((name) => join(KIT, 'tools', name));
    const offenders = kitModules(KIT).flatMap((file) => specifiers(readFileSync(file, 'utf8')).filter((spec) => spec.startsWith('.')).map((spec) => resolve(dirname(file), spec))
      .filter((target) => target.startsWith(DIR) && target !== join(HERE, 'index.mjs')).map((target) => `${relative(KIT, file)} → ${relative(KIT, target)}`));
    const inward = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).flatMap((name) => specifiers(readFileSync(join(HERE, name), 'utf8')).filter((spec) => consumers.includes(resolve(HERE, spec))).map((spec) => `${name} → ${spec}`));
    const importers = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).filter((name) => specifiers(readFileSync(join(HERE, name), 'utf8')).some((spec) => resolve(HERE, spec) === join(HERE, 'retired.mjs')));
    assert.deepEqual([offenders, inward, existsSync(join(HERE, 'retired.mjs')), importers], [[], [], true, ['scripts.mjs']]);
  });
});
