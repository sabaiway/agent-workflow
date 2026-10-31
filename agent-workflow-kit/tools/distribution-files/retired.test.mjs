import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv } from '../git-env.mjs';
import { PRIOR_FILES, SCRIPT_PRIORS, classifyDeployedScript, digestOf } from '../script-priors.mjs';

const { ensureScripts } = await import('./scripts.mjs').catch(() => ({}));
const { main } = await import('../ensure-configs.mjs').catch(() => ({}));
const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT, 'references', 'scripts');
const FIXTURES = join(KIT, 'test', 'fixtures', 'script-priors');
const KD = 'scripts/agent-workflow';
const bundled = (path) => readFileSync(join(BUNDLE, path));
const flat = (name) => `scripts/${name}`;
const versionsOf = (name) => readdirSync(FIXTURES).filter((version) => existsSync(join(FIXTURES, version, `${name}.txt`))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const flatBody = (name, K) => ['spec-schema.mjs', 'markdown-blocks.mjs'].includes(name) ? bundled(K.byName.get(name)) : readFileSync(join(FIXTURES, versionsOf(name).at(-1), `${name}.txt`));
const kitLayout = async () => {
  const { readFamily } = await import('../../references/scripts/family.mjs');
  const deployed = readFamily(BUNDLE).filter((entry) => entry.role === 'deployed');
  return { deployed, byName: new Map(deployed.map((entry) => [basename(entry.path), entry.path])),
    family: deployed.filter((entry) => !['spec-schema', 'docs-size'].includes(entry.module) && entry.path !== 'run.mjs').map((entry) => entry.path),
    seeds: deployed.filter((entry) => entry.seed && !['spec-schema', 'docs-size'].includes(entry.module) && entry.path !== 'run.mjs').map((entry) => entry.path) };
};
const WOULD_STORE = `ADR store: ${KD}/archives/archive-decisions.mjs --ensure-current would run after the writes, bringing the store current or writing nothing when it already is`;
const L = {
  removed: (name) => `${flat(name)}: removed — the kit's scripts live in scripts/agent-workflow/`,
  kept: (name, path) => `${flat(name)}: kept — ${KD}/${path} is not placed yet`,
  refused: (name, code) => `${flat(name)}: not removed (${code}) — left for the next run`,
  foreign: (name) => `${flat(name)}: differs from every body this kit knows it shipped — not the kit's, left as it stands; the kit's checks now run from scripts/agent-workflow/`,
  suite: (name) => `${flat(name)}: a suite of your own — the kit's hook runs no suite; add node --test ${flat(name)} to scripts/pre-commit.local to keep it on every commit`,
  placed: (path) => `${KD}/${path}: absent — placed from the bundled scripts`,
  notAccepted: `${KD}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`,
  grep: `other files naming an old path: git grep -n -F --untracked ${PRIOR_FILES.map((name) => `-e ${name}`).join(' ')} -- . ':!scripts/agent-workflow'`,
  boundary: 'git grep lists tracked and untracked files git does not ignore; the hooks dir and ignored files are yours to check',
};
const put = (dir, bodies, base = 'scripts') => {
  for (const [name, body] of Object.entries(bodies)) { const path = join(dir, base, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
};
const snapshot = (dir, at = dir, out = {}) => {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) snapshot(dir, path, out);
    else out[relative(dir, path)] = entry.isFile() ? digestOf(readFileSync(path)) : '<link>';
  }
  return out;
};
const withTree = (K, fn, { family = false, command = true, node = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'retired-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    if (family) put(dir, Object.fromEntries(K.deployed.filter((entry) => entry.path !== 'run.mjs').map((entry) => [entry.path, bundled(entry.path)])), KD);
    if (command) put(dir, { 'run.mjs': bundled('run.mjs') }, KD);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const outsideGit = () => ({ status: 128, stdout: '', stderr: '' });
const currentStore = () => ({ status: 0, stdout: 'already-current\n', stderr: '' });
const run = (dir, { deps = {}, ...options } = {}) => {
  const index = join(dir, '.git', 'index'), before = existsSync(index) ? digestOf(readFileSync(index)) : null;
  const guard = (write, targetAt) => (...args) => {
    assert.ok(relative(dir, String(args[targetAt])).startsWith(`${KD}/`), `no flat write: ${args[targetAt]}`);
    return write(...args);
  };
  const result = ensureScripts({ cwd: dir, kitRoot: KIT, ...options, deps: { git: outsideGit, spawnSync: currentStore, ...deps,
    rename: guard(deps.rename ?? renameSync, 1), link: guard(deps.link ?? linkSync, 1), writeFile: guard(deps.writeFile ?? writeFileSync, 0) } });
  assert.equal(existsSync(index) ? digestOf(readFileSync(index)) : null, before, 'the index is byte-identical');
  assert.equal(result.failed, result.token === 'failed');
  assert.deepEqual(result.lines.filter((line) => /\b\d+ (?:flat files|files removed|files kept)\b/.test(line)), [], 'no removal count line');
  return result;
};
const hasLine = (result, line) => assert.ok(result.lines.includes(line), `missing line: ${line}\n${result.lines.join('\n')}`);
const assertWouldRemove = (result, name) => assert.ok(result.lines.some((line) => line.startsWith(`${flat(name)}:`) && line.includes('would be removed')), flat(name));
// The store's would line stands, and every line of the part flat-move comes after it.
const assertWouldFirst = (result) => {
  const at = result.lines.indexOf(WOULD_STORE), flat = result.lines.flatMap((line, index) => (/^scripts\/(?!agent-workflow\/)/.test(line) || [L.grep, L.boundary].includes(line) ? [index] : []));
  assert.ok(at !== -1 && flat.length > 0 && flat.every((index) => index > at), `the would line before every flat line:\n${result.lines.join('\n')}`);
};
const assertNoAfterLines = (result) => assert.deepEqual(result.lines.filter((line) => /a suite of your own|git grep|(?:not|outside|no) (?:a )?(?:git )?work tree/i.test(line)), []);
const initGit = (dir) => {
  const home = join(dir, 'git-home'); mkdirSync(home);
  const env = Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home)).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  const result = spawnSync('git', ['init', '-q'], { cwd: dir, env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4);
  writeFileSync(join(dir, '.git', 'index'), Buffer.concat([header, createHash('sha1').update(header).digest()]));
  const calls = [], git = (command, args, options) => {
    calls.push({ command, args, placed: existsSync(join(dir, KD, 'archives', 'archive-caps.mjs')) });
    assert.equal(options.cwd, dir); assert.equal(command, 'git');
    assert.deepEqual(Object.keys(options.env).filter((key) => /^git_/i.test(key) || key === 'NODE_TEST_CONTEXT'), []);
    return spawnSync(command, args, { ...options, env });
  };
  return { calls, git };
};

describe('spec:distribution-files/S29 the flat component and the command prerequisite', () => {
  it('the flat installer, shipped or edited, accepts the family and removes only replaceable kit files', async () => {
    const K = await kitLayout();
    for (const edited of [false, true]) withTree(K, (dir) => {
      put(dir, Object.fromEntries(PRIOR_FILES.map((name) => [name, flatBody(name, K)])));
      if (edited) put(dir, { 'install-git-hooks.mjs': '// my installer\n' });
      const links = [], result = run(dir, { deps: { link: (from, to) => { links.push(relative(join(dir, KD), to)); return linkSync(from, to); } } });
      assert.equal(result.token, 'seeded');
      assert.deepEqual(links.sort(), [...K.family].sort(), 'every absent family file placed create-only');
      for (const path of K.family) assert.equal(digestOf(readFileSync(join(dir, KD, path))), digestOf(bundled(path)));
      for (const name of PRIOR_FILES) {
        const path = K.byName.get(name), kept = path && !K.family.includes(path);
        if (edited && name === 'install-git-hooks.mjs') { hasLine(result, L.foreign(name)); continue; }
        hasLine(result, kept ? L.kept(name, path) : L.removed(name));
        assert.equal(existsSync(join(dir, flat(name))), Boolean(kept), name);
      }
    });
  });
  it('a flat seed alone accepts nothing: every seed entry placed with the not-accepted line, that flat file removed; index and project-root are never read or named', async () => {
    const K = await kitLayout();
    for (const name of ['archive-decisions.mjs', 'markdown-blocks.mjs']) withTree(K, (dir) => {
      put(dir, { [name]: flatBody(name, K), 'index.mjs': '// not a seed\n', 'project-root.mjs': '// not a seed\n' });
      const reads = [], result = run(dir, { deps: { readFile: (path, ...args) => { reads.push(String(path)); return readFileSync(path, ...args); } } });
      assert.equal(result.token, 'seeded'); hasLine(result, L.notAccepted); hasLine(result, L.removed(name));
      for (const path of K.seeds) hasLine(result, L.placed(path));
      assert.deepEqual(Object.keys(snapshot(join(dir, KD))).sort(), [...K.seeds, 'run.mjs'].sort());
      for (const path of K.seeds) assert.equal(digestOf(readFileSync(join(dir, KD, path))), digestOf(bundled(path)));
      for (const ignored of ['index.mjs', 'project-root.mjs']) { assert.ok(!reads.includes(join(dir, flat(ignored)))); assert.ok(!result.lines.some((line) => line.includes(flat(ignored)))); }
      assert.equal(existsSync(join(dir, flat(name))), false);
    });
  });
  it('flat pairs supply Node evidence but no acceptance, every seed entry placed; suites alone skip, an archiver waits, and no cell answers not-placed', async () => {
    const K = await kitLayout(), suites = PRIOR_FILES.filter((name) => name.endsWith('.test.mjs'));
    const rows = [
      { names: ['check-docs-size.mjs', 'spec-schema.mjs', ...suites, '_expect-shim.mjs'], token: 'seeded' },
      { names: [...suites, '_expect-shim.mjs'], token: 'skipped-no-node-evidence', command: false },
      { names: ['archive-caps.mjs'], token: 'seeded' }, { names: [], token: 'seeded' },
    ];
    for (const row of rows) withTree(K, (dir) => {
      put(dir, Object.fromEntries(row.names.map((name) => [name, flatBody(name, K)])));
      const before = snapshot(dir), reads = [], result = run(dir, { deps: { readFile: (path, ...args) => { reads.push(path); return readFileSync(path, ...args); } } });
      assert.equal(result.token, row.token);
      if (row.command === false) { assert.deepEqual([reads, snapshot(dir)], [[], before]); assertNoAfterLines(result); return; }
      hasLine(result, L.notAccepted);
      for (const path of K.seeds) hasLine(result, L.placed(path));
      for (const name of row.names) {
        const path = K.byName.get(name);
        hasLine(result, path ? L.kept(name, path) : L.removed(name));
        assert.equal(existsSync(join(dir, flat(name))), Boolean(path));
      }
      assert.deepEqual(Object.keys(snapshot(join(dir, KD))).sort(), [...K.seeds, 'run.mjs'].sort());
      if (row.names.every((name) => K.byName.get(name))) {
        for (const name of row.names) assert.equal(snapshot(dir)[flat(name)], before[flat(name)], `${name} left as it stood`);
        assertNoAfterLines(result);
        assert.ok(!result.lines.some((line) => /^scripts\/(?!agent-workflow\/)/.test(line) && !row.names.some((name) => line.startsWith(`${flat(name)}:`))), 'no flat line for a file the tree does not hold');
      }
    }, { command: row.command !== false, node: row.names.length === 0 });
  });
  it('without run.mjs the installer witness places the family but keeps every kit flat file naming run.mjs', async () => {
    const K = await kitLayout();
    withTree(K, (dir) => {
      put(dir, Object.fromEntries(PRIOR_FILES.map((name) => [name, flatBody(name, K)])));
      const result = run(dir); assert.equal(result.token, 'seeded');
      assert.equal(existsSync(join(dir, KD, 'run.mjs')), false);
      for (const name of PRIOR_FILES) { hasLine(result, L.kept(name, 'run.mjs')); assert.equal(digestOf(readFileSync(join(dir, flat(name)))), digestOf(flatBody(name, K))); }
      assertNoAfterLines(result);
    }, { command: false });
  });
});

describe('spec:distribution-files/S30 body classification and files left in place', () => {
  it('catalog bodies by flat name and bundled deployed bodies, LF and CRLF, are removed without changing classifyDeployedScript', async () => {
    const K = await kitLayout();
    for (const name of PRIOR_FILES) {
      const path = K.byName.get(name), bodies = [...versionsOf(name).map((version) => readFileSync(join(FIXTURES, version, `${name}.txt`))), ...(path ? [bundled(path)] : [])];
      for (const body of bodies) for (const crlf of [false, true]) withTree(K, (dir) => {
        const bytes = crlf ? Buffer.from(body.toString().replace(/\r?\n/g, '\r\n')) : body;
        put(dir, { [name]: bytes });
        const result = run(dir); hasLine(result, L.removed(name)); assert.equal(result.token, 'refreshed'); assert.equal(existsSync(join(dir, flat(name))), false);
        const bundle = path ? bundled(path) : Buffer.from('// no deployed entry\n');
        const expected = digestOf(bytes) === digestOf(bundle) ? 'current' : SCRIPT_PRIORS.some((row) => row.file === name && row.digest === digestOf(bytes)) ? 'prior' : 'custom';
        assert.equal(classifyDeployedScript(bytes, name, bundle), expected);
        if (path && path !== name) assert.equal(classifyDeployedScript(flatBody(name, K), path, bundle), digestOf(flatBody(name, K)) === digestOf(bundle) ? 'current' : 'custom');
      }, { family: true });
    }
  });
  it('other bytes, including a catalog body under the wrong flat name, are named on every plain and dry run and never touched', async () => {
    const K = await kitLayout();
    for (const dryRun of [false, true]) withTree(K, (dir) => {
      put(dir, Object.fromEntries(PRIOR_FILES.map((name) => [name, name === 'archive-caps.mjs' ? flatBody('install-git-hooks.mjs', K) : `// my ${name}\n`])));
      const before = snapshot(dir);
      for (const repeat of [1, 2]) {
        const result = run(dir, { dryRun });
        for (const name of PRIOR_FILES) hasLine(result, L.foreign(name));
        assert.deepEqual(snapshot(dir), before, `run ${repeat}`); assert.equal(result.token, 'already-present'); assertNoAfterLines(result);
      }
    }, { family: true });
  });
  it('unreadable files, failed unlinks, ENOENT, links and directories are left without failing or reporting a kit suite as the user\'s', async () => {
    const K = await kitLayout(), name = 'archive-caps.test.mjs', later = 'archive-changelog.test.mjs';
    for (const kind of ['unreadable', 'EACCES', 'ENOENT', 'link', 'directory']) withTree(K, (dir) => {
      put(dir, { '_expect-shim.mjs': flatBody('_expect-shim.mjs', K), [name]: flatBody(name, K), [later]: flatBody(later, K) });
      const target = join(dir, flat(name)), reads = [], error = (code) => Object.assign(new Error(`${code}: fixture`), { code });
      if (kind === 'link') { renameSync(target, join(dir, 'link-target')); symlinkSync(join(dir, 'link-target'), target); }
      if (kind === 'directory') { unlinkSync(target); mkdirSync(target); }
      const before = snapshot(dir), result = run(dir, { deps: {
        readFile: (path, ...args) => { reads.push(path); if (path === target && kind === 'unreadable') throw error('EACCES'); return readFileSync(path, ...args); },
        unlink: (path) => { if (path === target && ['EACCES', 'ENOENT'].includes(kind)) throw error(kind); return unlinkSync(path); },
      } });
      assert.equal(result.token, 'refreshed'); hasLine(result, L.removed('_expect-shim.mjs')); hasLine(result, L.removed(later));
      assert.ok(lstatSync(target)); assert.equal(snapshot(dir)[flat(name)], before[flat(name)]);
      assert.ok(!result.lines.includes(L.suite(name))); assert.ok(reads.filter((path) => path === target).length <= 1, 'reuse classification without a second read');
      if (kind === 'EACCES') hasLine(result, L.refused(name, kind));
      else if (kind === 'ENOENT') assert.ok(!result.lines.some((line) => line.startsWith(`${flat(name)}:`)));
      else assert.ok(result.lines.some((line) => line.includes(flat(name)) && (kind === 'unreadable' ? line.includes('EACCES') : /link|directory/.test(line))));
      if (kind === 'link') assert.equal(digestOf(readFileSync(join(dir, 'link-target'))), before['link-target']);
    }, { family: true });
  });
});

describe('spec:distribution-files/S34 removal order, tokens, previews and follow-up lines', () => {
  it('removal follows the last write and successful store run; a stopped removal converges and a failed run never removes', async () => {
    const K = await kitLayout();
    for (const failure of ['none', 'write', 'store', 'interrupted']) withTree(K, (dir) => {
      put(dir, { '_expect-shim.mjs': flatBody('_expect-shim.mjs', K), 'archive-caps.test.mjs': flatBody('archive-caps.test.mjs', K) });
      put(dir, { [K.family[0]]: '// refresh me\n' }, KD);
      const events = [], removed = [], result = run(dir, { deps: {
        rename: (from, to) => { events.push('write'); if (failure === 'write') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return renameSync(from, to); },
        spawnSync: () => { events.push('store'); return { status: failure === 'store' ? 1 : 0, stdout: 'already-current\n', stderr: '' }; },
        unlink: (path) => { if (failure === 'interrupted' && removed.length) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); events.push('unlink'); unlinkSync(path); removed.push(basename(path)); },
      } });
      if (['write', 'store'].includes(failure)) { assert.equal(result.token, 'failed'); assert.deepEqual(removed, []); assertNoAfterLines(result); }
      else {
        assert.equal(result.token, 'refreshed'); assert.ok(events.indexOf('unlink') > events.lastIndexOf('write')); assert.ok(events.indexOf('unlink') > events.indexOf('store'));
        for (const name of removed) hasLine(result, L.removed(name));
        if (failure === 'interrupted') { hasLine(result, L.refused('archive-caps.test.mjs', 'EACCES')); const next = run(dir); hasLine(next, L.removed('archive-caps.test.mjs')); assert.ok(!next.lines.includes(L.removed('_expect-shim.mjs'))); }
      }
      const final = run(dir); assert.equal(final.token, ['write', 'store'].includes(failure) ? 'refreshed' : 'already-present');
      if (!['write', 'store'].includes(failure)) assertNoAfterLines(final);
    }, { family: true });
  });
  it('a declined removal beside absent seeds seeds them; beside current seeds it refreshes with no placement line; a dry run previews standing replacements and keeps only absent ones, after the would line', async () => {
    const K = await kitLayout();
    for (const seedsStand of [false, true]) for (const dryRun of [false, true]) withTree(K, (dir) => {
      put(dir, { '_expect-shim.mjs': flatBody('_expect-shim.mjs', K), 'spec-schema.mjs': flatBody('spec-schema.mjs', K), 'archive-caps.mjs': flatBody('archive-caps.mjs', K) });
      put(dir, { [K.byName.get('spec-schema.mjs')]: bundled(K.byName.get('spec-schema.mjs')), ...(seedsStand ? Object.fromEntries(K.seeds.map((path) => [path, bundled(path)])) : {}) }, KD);
      const at = `seeds ${seedsStand ? 'current' : 'absent'}, ${dryRun ? 'dry' : 'plain'}`, before = snapshot(dir), result = run(dir, { dryRun });
      assert.equal(result.token, seedsStand ? (dryRun ? 'would-refresh' : 'refreshed') : (dryRun ? 'would-seed' : 'seeded'), at); hasLine(result, L.notAccepted);
      const placed = result.lines.filter((line) => line.startsWith(`${KD}/`) && /: absent — (?:would be )?placed from the bundled scripts$/.test(line)).map((line) => line.slice(KD.length + 1, line.indexOf(':')));
      assert.deepEqual(placed.sort(), seedsStand ? [] : [...K.seeds].sort(), at);
      for (const name of ['_expect-shim.mjs', 'spec-schema.mjs']) { if (dryRun) assertWouldRemove(result, name); else hasLine(result, L.removed(name)); }
      if (dryRun) { assert.deepEqual(snapshot(dir), before); assert.ok(result.lines.some((line) => line.startsWith('scripts/archive-caps.mjs:') && line.includes('would be kept') && line.includes(`${KD}/archives/archive-caps.mjs`))); assertWouldFirst(result); }
      else { hasLine(result, L.kept('archive-caps.mjs', 'archives/archive-caps.mjs')); const next = run(dir); assert.equal(next.token, 'already-present'); assertNoAfterLines(next); }
    });
  });
  it('a dry run counts its own due family placements without writing', async () => {
    const K = await kitLayout();
    withTree(K, (dir) => {
      put(dir, { 'install-git-hooks.mjs': flatBody('install-git-hooks.mjs', K), 'archive-caps.mjs': flatBody('archive-caps.mjs', K) });
      const before = snapshot(dir), result = run(dir, { dryRun: true });
      assert.equal(result.token, 'would-seed'); for (const name of ['install-git-hooks.mjs', 'archive-caps.mjs']) assertWouldRemove(result, name);
      assert.deepEqual(snapshot(dir), before);
    });
  });
  it('the CLI hands in the specs preview, but a failed specs op or --only scripts hands in none', async () => {
    const K = await kitLayout();
    for (const mode of ['specs', 'failed-specs', 'only-scripts']) withTree(K, (dir) => {
      put(dir, { 'check-docs-size.mjs': flatBody('check-docs-size.mjs', K), 'spec-schema.mjs': flatBody('spec-schema.mjs', K) });
      const before = snapshot(dir), result = main(['--reconcile', '--cwd', dir, '--dry-run', ...(mode === 'only-scripts' ? ['--only', 'scripts'] : [])], { kitRoot: KIT, deps: {
        git: outsideGit, readFile: (path, ...args) => { if (mode === 'failed-specs' && path === join(BUNDLE, 'docs-size', 'check-docs-size.mjs')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return readFileSync(path, ...args); },
      } });
      const details = { lines: result.stdout.split('\n').filter((line) => line.startsWith('      scripts/')).map((line) => line.slice(6)) };
      assert.equal(result.code, mode === 'failed-specs' ? 1 : 0, result.stderr);
      for (const name of ['check-docs-size.mjs', 'spec-schema.mjs']) {
        if (mode === 'specs') assertWouldRemove(details, name);
        else assert.ok(details.lines.some((line) => line.startsWith(`${flat(name)}:`) && line.includes('would be kept') && line.includes(`${KD}/${mode === 'failed-specs' ? K.byName.get(name) : 'run.mjs'}`)));
      }
      assert.deepEqual(snapshot(dir), before);
    }, { command: mode === 'failed-specs' });
  });
  it('without the command a plain or dry run keeps flat files, including ones with no replacement', async () => {
    const K = await kitLayout();
    for (const dryRun of [false, true]) withTree(K, (dir) => {
      put(dir, Object.fromEntries(PRIOR_FILES.map((name) => [name, flatBody(name, K)])));
      const before = snapshot(dir), result = run(dir, { dryRun }); assert.equal(result.token, 'already-present');
      for (const name of PRIOR_FILES) {
        if (dryRun) assert.ok(result.lines.some((line) => line.startsWith(`${flat(name)}:`) && line.includes('would be kept') && line.includes(`${KD}/run.mjs`)));
        else hasLine(result, L.kept(name, 'run.mjs'));
      }
      if (dryRun) assertWouldFirst(result);
      assert.deepEqual(snapshot(dir), before); assertNoAfterLines(result);
    }, { family: true, command: false });
  });
  it('only removal runs print user suite lines, then git grep and its boundary, or one outside-work-tree line', async () => {
    const K = await kitLayout();
    for (const realGit of [false, true]) for (const dryRun of [false, true]) withTree(K, (dir) => {
      const git = realGit ? initGit(dir) : { git: outsideGit, calls: [] };
      put(dir, { '_expect-shim.mjs': flatBody('_expect-shim.mjs', K), 'archive-caps.test.mjs': '// my suite\n', 'own.test.mjs': '// my suite\n', 'nested/own.test.mjs': '// nested\n' });
      const result = run(dir, { dryRun, deps: { git: git.git } });
      assert.equal(result.token, dryRun ? 'would-refresh' : 'refreshed');
      assert.deepEqual(result.lines.filter((line) => line.includes('a suite of your own')).sort(), ['archive-caps.test.mjs', 'own.test.mjs'].map(L.suite).sort());
      const lastRemoval = result.lines.findLastIndex((line) => line.includes(dryRun ? 'would be removed' : ': removed —'));
      assert.ok(result.lines.indexOf(L.suite('own.test.mjs')) > lastRemoval);
      if (realGit) {
        hasLine(result, L.grep); hasLine(result, L.boundary);
        assert.ok(result.lines.indexOf(L.grep) > result.lines.findLastIndex((line) => line.includes('a suite of your own')));
        assert.ok(result.lines.indexOf(L.boundary) > result.lines.indexOf(L.grep));
        assert.ok(git.calls.some(({ args }) => args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')));
        assert.ok(git.calls.every(({ args }) => ['rev-parse', 'check-ignore'].includes(args[0]) && !args.some((arg) => /HEAD/.test(arg))));
      } else { assert.ok(!result.lines.includes(L.grep)); assert.equal(result.lines.filter((line) => /(?:not|outside|no) (?:a )?(?:git )?work tree/i.test(line)).length, 1); }
      if (!dryRun) { const next = run(dir, { deps: { git: git.git } }); assert.equal(next.token, 'already-present'); assertNoAfterLines(next); }
    }, { family: true });
  });
});

describe('spec:distribution-files/S35 commit the move together in visible deployments', () => {
  it('placements or removals print one commit line after check-ignore; hidden, error and idle runs print none and never read HEAD', async () => {
    const K = await kitLayout();
    for (const action of ['place', 'remove', 'both', 'idle']) for (const visibility of ['visible', 'hidden', 'error']) withTree(K, (dir) => {
      const recorded = initGit(dir);
      if (visibility === 'hidden') writeFileSync(join(dir, '.git', 'info', 'exclude'), `${KD}/\n`);
      if (action === 'place' || action === 'both') put(dir, { 'install-git-hooks.mjs': '// my installer\n' });
      if (action === 'remove' || action === 'both') put(dir, { '_expect-shim.mjs': flatBody('_expect-shim.mjs', K) });
      const result = run(dir, { deps: { git: (command, args, options) => {
        const answer = recorded.git(command, args, options);
        return visibility === 'error' && args[0] === 'check-ignore' ? { status: 128, stdout: '', stderr: '' } : answer;
      } } });
      const lines = result.lines.filter((line) => line.includes('docs/ai/gates.json') && line.includes('package.json'));
      assert.equal(lines.length, visibility === 'visible' && action !== 'idle' ? 1 : 0, result.lines.join('\n'));
      if (lines.length) {
        assert.ok(lines[0].includes(`${KD}/`) && /one change/.test(lines[0]) && /every branch/.test(lines[0]) && /merge/.test(lines[0]) && /commit/.test(lines[0]) && /install/.test(lines[0]));
        if (action === 'remove' || action === 'both') assert.ok(lines[0].includes('scripts/_expect-shim.mjs'));
      }
      if (action !== 'idle') assert.ok(recorded.calls.some(({ args, placed }) => args.join(' ') === `check-ignore -q ${KD}` && placed), 'check-ignore after placement');
      assert.ok(recorded.calls.every(({ args }) => ['rev-parse', 'check-ignore'].includes(args[0]) && !args.some((arg) => /HEAD/.test(arg))));
    }, { family: action === 'remove' || action === 'idle' });
  });
});
