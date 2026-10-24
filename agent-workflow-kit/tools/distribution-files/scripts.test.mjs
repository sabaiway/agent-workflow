// scripts.test.mjs — the upgrade's `scripts` op by its cells, from the plain-run rule to the shipped text.
// The op's leaf is imported dynamically, so a tree without it fails each cell, never the load.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../ensure-configs.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { BUNDLED_SCRIPT_NAMES } from '../node-evidence.mjs';
import { INSTALLER_SET, SCRIPT_PRIORS } from '../script-priors.mjs';

const { ensureScripts, SCRIPT_CHANNEL, LOCAL_HOOK_CHANNEL } = await import('./scripts.mjs').catch(() => ({}));

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
// The family in write order: the installer set, then every other family name in code-unit order.
const ORDER = ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs', '_expect-shim.mjs', 'archive-caps.mjs',
  'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs', 'archive-conservation.test.mjs', 'archive-decisions.mjs',
  'archive-decisions.test.mjs', 'archive-issues.mjs', 'archive-issues.test.mjs', 'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs',
  'check-docs-size-ensure.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs', 'migrate-gates-branches.test.mjs', 'migrate-gates.mjs', 'migrate-gates.test.mjs'];
const PAIRS = ['spec-schema.mjs', 'spec-schema.test.mjs', 'check-docs-size.mjs', 'check-docs-size.test.mjs'];
const [SET, LAST] = [[...INSTALLER_SET], ORDER.at(-1)];
const PRIOR_AT = { 'install-git-hooks.mjs': '4.0.0', 'install-git-hooks.test.mjs': '7.2.0', 'install-git-hooks-repo-exec.test.mjs': '4.0.0' };
const bundled = (n) => readFileSync(join(BUNDLE, n));
const prior = (n) => readFileSync(join(KIT, 'test', 'fixtures', 'script-priors', PRIOR_AT[n], `${n}.txt`));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// File bytes are compared by digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
const shaOf = (bytes) => (bytes === null ? null : sha(bytes));
const EDIT = (n) => Buffer.from(`// mine: ${n}\n`);
const OLD = (n) => Buffer.from(`// an earlier ${n}\n`);
// The catalog seam: OLD(name) catalogued as a body a release shipped, for names with no row of their own.
const priorsWith = (...names) => [...SCRIPT_PRIORS, ...names.map((file) => ({ file, digest: sha(OLD(file)) }))];
const PRIORS = Object.fromEntries(SET.map((n) => [n, prior(n)]));
const PAIR_BODIES = Object.fromEntries(PAIRS.map((n) => [n, bundled(n)]));
const rel = (n) => `scripts/${n}`;
const channelOf = (n) => (n === SET[0] ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL);

const SHIPPED = 'matches a body an earlier release shipped';
const DIFFERS = 'differs from every body this kit knows it shipped';
const HOOK = 'the commit hook runs the files written above, so they may stop the next commit';
const DRY_HOOK = 'the commit hook runs the files named above, so writing them may stop the next commit';
const WOULD = 'ADR store: scripts/archive-decisions.mjs --ensure-current would run after the writes, bringing the store current or writing nothing when it already is';
const L = {
  refreshed: (n) => `${rel(n)}: ${SHIPPED} — refreshed to the bundled one`,
  replaced: (n) => `${rel(n)}: ${DIFFERS} — replaced by the bundled body; an edit meant to last goes in ${channelOf(n)}`,
  placed: (n) => `${rel(n)}: absent — placed from the bundled scripts`,
  count: (k) => `scripts/: ${k} other kit scripts are already the bundled body — nothing written`,
  partway: (k) => `the writes stopped PARTWAY — the ${k} file(s) named above were already written and are NOT rolled back`,
};
const FORBIDDEN = /withheld|customized|preserved|kept aside|the user's yes|the block below|you edited|user edited|edited it/i;

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
const holds = (dir, want) => { for (const [n, body] of Object.entries(want)) assert.equal(shaOf(bytesOf(dir, n)), shaOf(body), `${n} holds the expected body`); };
const isFileLine = (l) => /^scripts\/[^:]/.test(l);
// The S16 invariant, asserted on every run below: a run that completed a publish (an atomic rename or a
// create-only link), failed or not, prints the hook-run line once after its file lines, one that
// completed none prints none; a dry run prints the would-be form once exactly when a file line would write,
// and, every tree here judging the rotator, ends with the store's would line.
const assertHookRun = (r, wrote, dryRun) => {
  const hooks = r.lines.flatMap((l, i) => (/commit hook runs the files/.test(l) ? [i] : []));
  const due = dryRun ? r.lines.some((l) => isFileLine(l) && l.includes(' — would be ')) : wrote > 0;
  const [last, word] = [r.lines.findLastIndex(isFileLine), dryRun ? 'files named above' : 'files written above'];
  assert.deepEqual([hooks.length, hooks.every((i) => i > last && r.lines[i].includes(word)), dryRun ? r.lines.at(-1) : WOULD], [due ? 1 : 0, true, WOULD], `the hook-run line, then the would line:\n${r.lines.join('\n')}`);
};
const run = (dir, opts = {}) => {
  const [deps, done] = [opts.deps ?? {}, []];
  const counted = (real) => (from, to) => {
    const out = real(from, to);
    done.push(to);
    return out;
  };
  const r = ensureScripts({ cwd: dir, kitRoot: KIT, ...opts, deps: { ...deps, rename: counted(deps.rename ?? renameSync), link: counted(deps.link ?? linkSync) } });
  assertHookRun(r, done.length, opts.dryRun);
  return r;
};
const spy = (paths) => (p, ...rest) => { paths.push(String(p)); return readFileSync(p, ...rest); };
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
  it('one plain run: a prior refreshed, each edit replaced naming its channel, an absent file placed create-only, a current one counted, the hook-run line', () => {
    const bodies = { [SET[0]]: EDIT(SET[0]), [SET[1]]: prior(SET[1]), 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'migrate-gates.mjs': null };
    withTree(bodies, (dir) => {
      const links = [];
      const link = (from, to) => {
        links.push(relative(join(dir, 'scripts'), to));
        return linkSync(from, to);
      };
      check(dir, run(dir, { deps: { link } }), 'seeded', [L.replaced(SET[0]), L.refreshed(SET[1]), L.replaced('archive-caps.mjs'), L.placed('migrate-gates.mjs'), L.count(17), HOOK]);
      assert.deepEqual(links, ['migrate-gates.mjs']);
      holds(dir, Object.fromEntries(Object.keys(bodies).map((n) => [n, bundled(n)])));
    });
    assert.deepEqual([LOCAL_HOOK_CHANNEL, SCRIPT_CHANNEL], ['the local hook file scripts/pre-commit.local, which the commit hook runs first', 'a script or suite of your own under its own name in scripts/, or a config the script reads']);
  });
  it('each installer-set member edited in turn beside the other two on prior bodies: all three the bundled bytes', () => {
    for (const edited of SET) withTree({ ...PRIORS, [edited]: EDIT(edited) }, (dir) => {
      check(dir, run(dir), 'refreshed', [...SET.map((n) => (n === edited ? L.replaced(n) : L.refreshed(n))), L.count(18), HOOK]);
      holds(dir, Object.fromEntries(SET.map((n) => [n, bundled(n)])));
    });
  });
});

describe('spec:distribution-files/S15 the dry run and the quiet cells', () => {
  const wouldBe = (l) => (l === HOOK ? DRY_HOOK : l.replace(/— (refreshed|replaced|placed) /, '— would be $1 '));
  it("a dry run gives a plain run's lines in their would-be forms and the store's would line, writes nothing, would-seed beside an absent file, else would-refresh", () => {
    const rows = [[{ ...PRIORS, 'archive-caps.mjs': EDIT('archive-caps.mjs') }, 'would-refresh', 'refreshed'], [{ ...PRIORS, [SET[0]]: EDIT(SET[0]), 'migrate-gates.mjs': null }, 'would-seed', 'seeded']];
    for (const [bodies, dryToken, token] of rows) {
      const real = withTree(bodies, (dir) => run(dir));
      withTree(bodies, (dir) => {
        const [before, dry] = [snapshot(dir), run(dir, { dryRun: true })];
        assert.deepEqual([dry.token, real.token, 'entries' in dry, dry.lines], [dryToken, token, false, [...real.lines.map(wouldBe), WOULD]]);
        assert.deepEqual(snapshot(dir), before);
      });
    }
  });
  it('a fully current family over a current store: already-present, the one count line, no hook-run line, no store line, nothing written', () => withTree({}, (dir) => {
    const before = snapshot(dir);
    assert.deepEqual(run(dir), { op: 'scripts', token: 'already-present', failed: false, lines: [L.count(21)] });
    assert.deepEqual(snapshot(dir), before);
  }));
});

describe('spec:distribution-files/S16 the failure cells and the hook-run line', () => {
  const rows = [
    ['a symlink', 'wrong-node-kind', 'exists but is a symlink', (dir) => { writeFileSync(join(dir, 'elsewhere.txt'), 'the link target\n'); symlinkSync(join(dir, 'elsewhere.txt'), join(dir, 'scripts', LAST)); }],
    ['a directory', 'wrong-node-kind', 'exists but is a directory', (dir) => mkdirSync(join(dir, 'scripts', LAST))],
    ['an unreadable bundled body', 'bundle-unreadable', 'the bundled script could not be read, so nothing was written — reinstall the kit.',
      (dir) => { writeFileSync(join(dir, 'scripts', LAST), bundled(LAST)); cpSync(BUNDLE, join(dir, 'kit', 'references', 'scripts'), { recursive: true }); rmSync(join(dir, 'kit', 'references', 'scripts', LAST)); }],
  ];
  for (const [kind, cause, says, setup] of rows) it(`${kind} at the last family path: ${cause} naming it, no entries field, nothing written`, () => withTree({ ...PRIORS, [LAST]: null }, (dir) => {
    const before = snapshot(dir), r = run(dir, { kitRoot: existsSync(join(dir, 'kit')) ? join(dir, 'kit') : KIT });
    assert.deepEqual([r.token, 'entries' in r, r.lines[0].startsWith(`${cause} — ${rel(LAST)}: ${says}`)], ['failed', false, true], r.lines.join('\n'));
    assert.deepEqual(snapshot(dir), before);
  }, { setup }));
  it('a rename refused at the second write: write-refused, the installer written, the later files not refreshed, replaced or placed, PARTWAY counting 1', () => {
    withTree({ ...PRIORS, 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'migrate-gates.mjs': null }, (dir) => {
      const r = run(dir, { deps: recorder(dir, { refuseAt: 2 }).deps });
      assert.deepEqual({ token: r.token, entries: 'entries' in r, lines: r.lines }, { token: 'failed', entries: false, lines: [`write-refused — ${rel(SET[1])}: EACCES: refused`, L.refreshed(SET[0]),
        `${rel(SET[1])}: ${SHIPPED} — not refreshed; its write was refused (above)`, `${rel(SET[2])}: ${SHIPPED} — not refreshed; the run stopped before it`,
        `scripts/archive-caps.mjs: ${DIFFERS} — not replaced; the run stopped before it; an edit meant to last goes in ${SCRIPT_CHANNEL}`,
        'scripts/migrate-gates.mjs: absent — not placed; the run stopped before it', L.count(16), HOOK, L.partway(1)] });
      holds(dir, { [SET[0]]: bundled(SET[0]), [SET[1]]: prior(SET[1]), [SET[2]]: prior(SET[2]), 'archive-caps.mjs': EDIT('archive-caps.mjs'), 'migrate-gates.mjs': null });
      assert.deepEqual(readdirSync(join(dir, 'scripts')).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
    });
  });
  it('the hook-run line: once on a run that wrote, failed or not; none on one that wrote none; once on a dry run that would write', () => {
    const rows = [
      ['a plain run that wrote', PRIORS, () => ({}), 1],
      ['a plain run that wrote none', {}, () => ({}), 0],
      ['a failed run after one write', PRIORS, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), 1],
      ['a failed run before any write', PRIORS, (dir) => ({ deps: recorder(dir, { refuseAt: 1 }).deps }), 0],
      ['a dry run that would write', PRIORS, () => ({ dryRun: true }), 1],
      ['a dry run that would write none', {}, () => ({ dryRun: true }), 0],
    ];
    const got = rows.map(([label, bodies, opts]) => [label, withTree(bodies, (dir) => run(dir, opts(dir)).lines.filter((l) => l === HOOK || l === DRY_HOOK).length)]);
    assert.deepEqual(got, rows.map(([label, , , want]) => [label, want]));
  });
});

describe('spec:distribution-files/S18 one token precedence over the plain and dry runs', () => {
  it('adjacent cells, one table: failed, seeded, refreshed, already-present; would-seed and would-refresh on a dry run; never pending or customized-preserved', () => {
    const [plain, dry, caps, installer, absent] = [() => ({}), () => ({ dryRun: true }), { 'archive-caps.mjs': EDIT('archive-caps.mjs') }, { [SET[0]]: prior(SET[0]) }, { 'migrate-gates.mjs': null }];
    const rows = [
      ['failed over seeded: the placement refused after the installer was refreshed', { ...installer, ...absent }, undefined, (dir) => ({ deps: recorder(dir, { refuseAt: 2 }).deps }), 'failed'],
      ['seeded over refreshed: an absent file placed beside a replaced edit', { ...caps, ...absent }, undefined, plain, 'seeded'],
      ['refreshed by a replaced edit alone', caps, undefined, plain, 'refreshed'],
      ['refreshed over already-present', installer, undefined, plain, 'refreshed'],
      ['already-present', {}, undefined, plain, 'already-present'],
      ['would-seed in the place of seeded on a dry run', { ...caps, ...absent }, undefined, dry, 'would-seed'],
      ['would-refresh in the place of refreshed on a dry run', caps, undefined, dry, 'would-refresh'],
    ];
    const got = rows.map(([label, bodies, setup, opts]) => [label, withTree(bodies, (dir) => run(dir, opts(dir)).token, { setup })]);
    assert.deepEqual(got, rows.map(([label, , , , token]) => [label, token]));
  });
});

describe('spec:distribution-files/S19 write order through a recording writer', () => {
  const BODIES = { [SET[0]]: EDIT(SET[0]), [SET[1]]: prior(SET[1]), [SET[2]]: null, '_expect-shim.mjs': EDIT('_expect-shim.mjs'), 'archive-caps.mjs': null, 'markdown-blocks.mjs': OLD('markdown-blocks.mjs'), [LAST]: OLD(LAST) };
  const priors = priorsWith('markdown-blocks.mjs', LAST);
  const due = ORDER.filter((n) => n in BODIES);
  it("one plain run's refreshes, replacements and placements: the installer, its two suites, then every other family file in code-unit name order", () => withTree(BODIES, (dir) => {
    const { order, deps } = recorder(dir);
    run(dir, { deps: { ...deps, priors } });
    assert.deepEqual([order, [...ORDER].sort()], [due, BUNDLED_SCRIPT_NAMES.filter((n) => !PAIRS.includes(n)).sort()]);
  }));
  it('a write refused partway leaves every later file unwritten', () => withTree(BODIES, (dir) => {
    const [before, { order, deps }] = [snapshot(dir), recorder(dir, { refuseAt: 2 })];
    run(dir, { deps: { ...deps, priors } });
    const now = snapshot(dir);
    assert.deepEqual([order, due.slice(1).filter((n) => now[join('scripts', n)] !== before[join('scripts', n)])], [due.slice(0, 2), []]);
  }));
});

describe('spec:distribution-files/S20 the race of an absent file on a plain run', () => {
  // The create-only link finds the file `body` put there between the survey and the write.
  const appear = (bodies, body, deps = {}) => withTree(bodies, (dir) => {
    const target = join(dir, 'scripts', 'migrate-gates.mjs');
    const link = (from, to) => {
      if (to === target) writeFileSync(to, body);
      return linkSync(from, to);
    };
    return [run(dir, { deps: { ...deps, link } }), shaOf(bytesOf(dir, SET[1])), shaOf(bytesOf(dir, 'migrate-gates.mjs')), shaOf(bytesOf(dir, LAST))];
  });
  it('one that appears with the bundled body stands, its line saying so, already-present when every other file is current', () => {
    const [r, , placed] = appear({ 'migrate-gates.mjs': null }, bundled('migrate-gates.mjs'));
    assert.deepEqual([r.token, r.lines, placed], ['already-present', ['scripts/migrate-gates.mjs: appeared while this run was placing it — the bundled body stands, nothing written', L.count(20)], sha(bundled('migrate-gates.mjs'))]);
  });
  it('one with other bytes: race-unresolved, the earlier write kept and named, nothing further written', () => {
    const [r, installer, raced, later] = appear({ [SET[1]]: prior(SET[1]), 'migrate-gates.mjs': null, [LAST]: OLD(LAST) }, OLD('migrate-gates.mjs'), { priors: priorsWith(LAST) });
    assert.deepEqual([r.token, r.lines], ['failed', ['race-unresolved — scripts/migrate-gates.mjs: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled',
      L.refreshed(SET[1]), 'scripts/migrate-gates.mjs: absent — not placed; its write was refused (above)', `${rel(LAST)}: ${SHIPPED} — not refreshed; the run stopped before it`, L.count(18), HOOK, L.partway(1)]]);
    assert.deepEqual([installer, raced, later], [bundled(SET[1]), OLD('migrate-gates.mjs'), OLD(LAST)].map(sha));
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
  const commit = (dir, message, ...flags) => { ok(dir, 'git', 'add', '-A'); return sh(dir, 'git', 'commit', '-q', ...flags, '-m', message); };
  const passes = ({ status, out }) => {
    assert.deepEqual([status, /skipping running files/i.test(out)], [0, false], out);
    for (const re of [/(?:✔|(?<!not )ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/, /(?:✔|(?<!not )ok \d+ -) install-git-hooks — the in-place installer under a GIT_DIR-pinned fixture/, /(?:\u2139|#) fail 0(?!\d)/]) assert.match(out, re, out);
  };
  const plainRun = (dir) => {
    const { code, stdout } = cli(dir, ['--only', 'scripts']);
    assert.deepEqual([code, REPLACE_STEP.test(stdout), existsSync(join(dir, '.agent-workflow'))], [0, false, false], stdout);
    return { tokens: tokensOf(stdout), details: detailsOf(stdout, 'scripts') };
  };
  it('a prior set stops a commit until one plain run; an edited installer is replaced by the next; an absent suite placed with no command', { timeout: 240_000 }, () => withTree(PRIORS, (dir) => {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'fixture']]) ok(dir, 'git', ...args);
    for (const [doc, type, title] of [['changelog.md', 'log', 'Changelog'], ['known_issues.md', 'issues', 'Known issues']]) writeFileSync(join(dir, 'docs', 'ai', doc), `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${title}\n`);
    for (const args of [['scripts/check-docs-size.mjs', '--write-index'], ['scripts/install-git-hooks.mjs']]) ok(dir, process.execPath, ...args);
    const one = commit(dir, 'one');
    assert.ok(one.status !== 0 && /(?:✖|not ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/.test(one.out), one.out);
    assert.deepEqual(plainRun(dir), { tokens: ['scripts: refreshed'], details: [...SET.map(L.refreshed), L.count(18), HOOK] });
    passes(commit(dir, 'two'));
    put(dir, { ...PRIORS, [SET[0]]: EDIT(SET[0]) });
    const edited = plainRun(dir);
    assert.deepEqual([edited.tokens, edited.details[0].includes('scripts/pre-commit.local')], [['scripts: refreshed'], true], edited.details.join('\n'));
    assert.deepEqual(edited.details, [L.replaced(SET[0]), L.refreshed(SET[1]), L.refreshed(SET[2]), L.count(18), HOOK]);
    holds(dir, Object.fromEntries(SET.map((n) => [n, bundled(n)])));
    // The tree is commit two's again, so the hook's run is proved on an empty commit.
    passes(commit(dir, 'three', '--allow-empty'));
    rmSync(join(dir, 'scripts', SET[2]));
    assert.deepEqual(plainRun(dir), { tokens: ['scripts: seeded'], details: [L.placed(SET[2]), L.count(20), HOOK] });
    holds(dir, { [SET[2]]: bundled(SET[2]) });
  }, { setup: (dir) => put(dir, PAIR_BODIES) }));
});

describe('spec:distribution-files/S22 --only specs and --only scripts each write their own files', () => {
  const tree = (fn) => withTree({ 'archive-caps.mjs': EDIT('archive-caps.mjs') }, fn, { setup: (dir) => put(dir, { ...PAIR_BODIES, 'check-docs-size.mjs': EDIT('check-docs-size.mjs') }) });
  it('--only specs replaces the edited spec-layer file alone, no scripts line; --only scripts replaces the kit script alone, no specs line; neither prints a replace block or command', () => {
    tree((dir) => {
      const specs = cli(dir, ['--only', 'specs']).stdout;
      assert.deepEqual([opsOf(specs), detailsOf(specs, 'specs').includes(`scripts/check-docs-size.mjs: ${DIFFERS} — replaced by the bundled body; an edit meant to last goes in ${SCRIPT_CHANNEL}`), REPLACE_STEP.test(specs), shaOf(bytesOf(dir, 'check-docs-size.mjs')), shaOf(bytesOf(dir, 'archive-caps.mjs'))],
        [['specs'], true, false, sha(bundled('check-docs-size.mjs')), sha(EDIT('archive-caps.mjs'))], specs);
    });
    tree((dir) => {
      const scripts = cli(dir, ['--only', 'scripts']).stdout;
      assert.deepEqual([opsOf(scripts), detailsOf(scripts, 'scripts'), REPLACE_STEP.test(scripts), shaOf(bytesOf(dir, 'check-docs-size.mjs'))], [['scripts'], [L.replaced('archive-caps.mjs'), L.count(20), HOOK], false, sha(EDIT('check-docs-size.mjs'))], scripts);
    });
  });
});

describe('spec:distribution-files/S24 shipped text of the one rule and the store run', () => {
  const [text, header] = [(...p) => readFileSync(join(KIT, ...p), 'utf8'), (src) => src.slice(0, src.indexOf('\nimport '))];
  const has = (body, yes, no = []) => assert.deepEqual([yes.filter((p) => !body.includes(p)), no.filter((p) => body.includes(p))], [[], []], 'missing phrases, then claimed ones');
  const [RETIRED, STORE_RUN] = [['old-adr-layout-migration-instructed', 'adr-layout-unverifiable'], 'archive-decisions.mjs --ensure-current'];
  it('upgrade.md: the scripts token arm, the enforcement-script paragraph and the owns sentence state the one rule and the store run', () => {
    const doc = text('references', 'modes', 'upgrade.md'), at = doc.indexOf('**What the enforcement-script ensure does.**');
    has(doc.slice(doc.indexOf('scripts → ')).split(';')[0], ['`seeded`', '`refreshed`', '`already-present`', '`not-placed`', '`skipped-no-node-evidence`'], ['`pending`', 'customized-preserved']);
    has(at === -1 ? '' : doc.slice(at, doc.indexOf('\n', at)), ['a kit script outside the seed names', 'no question and no copy kept', 'where a lasting edit goes', 'the commit hook runs the files written',
      'keeps the standing seed files current with the modules they import', 'places no other kit script', 'hook-run line as a condition', `\`scripts/${STORE_RUN}\``, 'after the writes', 'its refusal stops the upgrade', '`--write-baseline`',
      'the `enforcement` check line and apply, by the consent route'], ['withheld', 'customized', 'preserved', 'kept aside', 'held back', 'one yes', 'replace block', 'migrate-adr-store']);
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
    has(fifth === -1 ? '' : help.slice(fifth, help.indexOf('\n\n', fifth)), ['with no question and no copy kept', `scripts/${STORE_RUN} brings the ADR store current`], ['yes', 'held back']);
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
  it('the index exports exactly ensureScripts, SCRIPT_CHANNEL, fileLine and hookLine, each the very export of scripts.mjs; replace-set.mjs and kept-aside.mjs are absent', async () => {
    const [door, leaf] = await Promise.all(['./index.mjs', './scripts.mjs'].map((path) => import(path).catch(() => ({}))));
    assert.deepEqual(Object.keys(door).sort(), ['SCRIPT_CHANNEL', 'ensureScripts', 'fileLine', 'hookLine']);
    assert.deepEqual(Object.keys(door).filter((name) => door[name] !== leaf[name]), []);
    assert.deepEqual(['replace-set.mjs', 'kept-aside.mjs'].filter((name) => existsSync(join(HERE, name))), []);
  });
  it('no kit module outside the directory imports a file of it but the index; no file of it imports ensure-specs.mjs or ensure-configs.mjs', () => {
    const consumers = ['ensure-configs.mjs', 'ensure-specs.mjs'].map((name) => join(KIT, 'tools', name));
    const offenders = kitModules(KIT).flatMap((file) => specifiers(readFileSync(file, 'utf8')).filter((spec) => spec.startsWith('.')).map((spec) => resolve(dirname(file), spec))
      .filter((target) => target.startsWith(DIR) && target !== join(HERE, 'index.mjs')).map((target) => `${relative(KIT, file)} → ${relative(KIT, target)}`));
    const inward = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).flatMap((name) => specifiers(readFileSync(join(HERE, name), 'utf8')).filter((spec) => consumers.includes(resolve(HERE, spec))).map((spec) => `${name} → ${spec}`));
    assert.deepEqual([offenders, inward], [[], []]);
  });
});
