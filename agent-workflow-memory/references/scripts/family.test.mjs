// family.test.mjs — the script family's tree, its manifest and the manifest's one reader. Every path derives from
// this file's own directory, so the same file judges the canon and, copied, the kit mirror alike.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'family.json';
const TREE = {
  '': ['family.json', 'family.mjs', 'family.test.mjs'],
  'docs-size': ['check-docs-size.mjs', 'index.mjs', 'check-docs-size.test.mjs', 'check-docs-size-cli.test.mjs', 'check-docs-size-ensure.test.mjs'],
  'spec-schema': ['spec-schema.mjs', 'index.mjs', 'spec-schema.test.mjs'],
  archives: ['archive-changelog.mjs', 'archive-issues.mjs', 'archive-decisions.mjs', 'archive-caps.mjs', 'index.mjs', 'archive-changelog.test.mjs',
    'archive-issues.test.mjs', 'archive-decisions.test.mjs', 'archive-caps.test.mjs', 'archive-conservation.test.mjs', 'archiver-structure.test.mjs'],
  'git-hooks': ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs'],
  gates: ['migrate-gates.mjs', 'migrate-gates.test.mjs', 'migrate-gates-branches.test.mjs'],
  shared: ['markdown-blocks.mjs', 'project-root.mjs', 'index.mjs', 'markdown-blocks.test.mjs', 'project-root.test.mjs'],
  'test-support': ['_expect-shim.mjs', 'index.mjs'],
};
const MODULES = Object.keys(TREE).filter(Boolean);
const FILES = Object.entries(TREE).flatMap(([module, names]) => names.map((name) => (module ? `${module}/${name}` : name))).sort();
const INDEXED = ['archives', 'docs-size', 'shared', 'spec-schema', 'test-support'];
const SUPPORT = ['archives/index.mjs', 'test-support/_expect-shim.mjs', 'test-support/index.mjs'];
const SKILL_HOME = ['docs-size/index.mjs', 'family.mjs', 'gates/migrate-gates.mjs'];
const roleOf = (path) => (path.endsWith('.test.mjs') ? 'suite' : SUPPORT.includes(path) ? 'support' : SKILL_HOME.includes(path) ? 'skill-home' : 'deployed');
const moduleOf = (path) => (path.includes('/') ? path.split('/')[0] : null);
const readFamily = async (dir) => (await import('./family.mjs')).readFamily(dir);

// Every node under a directory as a POSIX path, a directory with a trailing / and any other node marked.
const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return [`${child}/`, ...walk(dir, child)];
    return [entry.isFile() ? child : `${child} (not a regular file)`];
  }).sort();

// The suite's own bijection judge: a tree file with other than one entry, an entry naming no file, or one for the manifest.
const bijectionProblems = (files, paths) => [
  ...files.filter((file) => file !== MANIFEST && paths.filter((path) => path === file).length !== 1)
    .map((file) => `${file}: ${paths.filter((path) => path === file).length} manifest entries`),
  ...paths.filter((path) => path === MANIFEST || !files.includes(path)).map((path) => `${path}: an entry naming no family file`),
];

describe('spec:script-family/S1 the canon tree and the manifest are one bijection', () => {
  it('the tree holds exactly the 35 files of the seven modules, each file but family.json one manifest entry', async () => {
    assert.deepEqual(walk(HERE), [...FILES, ...MODULES.map((module) => `${module}/`)].sort());
    assert.equal(FILES.length, 35);
    const files = walk(HERE).filter((node) => !node.endsWith('/'));
    const paths = (await readFamily(HERE)).map((entry) => entry.path);
    assert.deepEqual(bijectionProblems(files, paths), []);
    assert.deepEqual(bijectionProblems([...files, 'shared/stray.mjs'], paths), ['shared/stray.mjs: 0 manifest entries']);
    assert.deepEqual(bijectionProblems(files, [...paths, 'shared/ghost.mjs']), ['shared/ghost.mjs: an entry naming no family file']);
  });
});

// A child node that imports one file and exits: 0 exactly when the file and everything it imports load.
const imports = (file) => spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(file).href)});`], { encoding: 'utf8' });
const seedDeployment = (paths) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'family-seed-')));
  for (const path of paths) {
    mkdirSync(dirname(join(root, 'scripts', 'agent-workflow', path)), { recursive: true });
    copyFileSync(join(HERE, path), join(root, 'scripts', 'agent-workflow', path));
  }
  return { root, at: (path) => join(root, 'scripts', 'agent-workflow', path) };
};

describe('spec:script-family/S2 the manifest roles and the seed set', () => {
  it('suites, support, skill-home and deployed entries are exactly the roles the contract names', async () => {
    const family = await readFamily(HERE);
    assert.deepEqual(family.filter((entry) => entry.role !== roleOf(entry.path)).map((entry) => `${entry.path}: ${entry.role}`), []);
    const deployed = FILES.filter((path) => roleOf(path) === 'deployed' && path !== MANIFEST);
    const named = FILES.filter((path) => ['docs-size', 'spec-schema', 'archives', 'git-hooks', 'shared'].includes(moduleOf(path)) && !path.endsWith('.test.mjs')
      && (!path.endsWith('/index.mjs') || ['spec-schema', 'shared'].includes(moduleOf(path))));
    assert.deepEqual(deployed, named);
    assert.deepEqual(family.filter((entry) => entry.role === 'deployed').map((entry) => entry.path).sort(), deployed);
  });

  it('a deployment of exactly the seed files loads each, and losing any seed but the rotator breaks a load', async () => {
    const seeds = (await readFamily(HERE)).filter((entry) => entry.seed).map((entry) => entry.path);
    assert.ok(seeds.includes('archives/archive-decisions.mjs'), `the rotator is a seed: ${seeds.join(' ')}`);
    const whole = seedDeployment(seeds);
    try {
      for (const path of seeds) assert.equal(imports(whole.at(path)).status, 0, `${path}: ${imports(whole.at(path)).stderr}`);
    } finally {
      rmSync(whole.root, { recursive: true, force: true });
    }
    for (const lost of seeds.filter((path) => path !== 'archives/archive-decisions.mjs')) {
      const kept = seeds.filter((path) => path !== lost);
      const part = seedDeployment(kept);
      try {
        assert.ok(kept.some((path) => imports(part.at(path)).status !== 0), `without ${lost} every remaining seed still loads — it is no seed`);
      } finally {
        rmSync(part.root, { recursive: true, force: true });
      }
    }
  });
});

describe('spec:script-family/S3 readFamily reads the manifest and refuses by name', () => {
  it('over the canon: a frozen array of frozen { path, module, role, seed } in manifest order', async () => {
    const { readFamily: read, FAMILY_FILE, FAMILY_ROLES } = await import('./family.mjs');
    assert.equal(FAMILY_FILE, MANIFEST);
    assert.ok(Object.isFrozen(FAMILY_ROLES));
    assert.deepEqual([...FAMILY_ROLES].sort(), ['deployed', 'skill-home', 'suite', 'support']);
    const raw = JSON.parse(readFileSync(join(HERE, MANIFEST), 'utf8'));
    const family = read(HERE);
    assert.ok(Object.isFrozen(family));
    assert.deepEqual(family.map((entry) => entry.path), raw.entries.map((entry) => entry.path));
    for (const entry of family) {
      assert.ok(Object.isFrozen(entry), entry.path);
      assert.deepEqual(Object.keys(entry).sort(), ['module', 'path', 'role', 'seed']);
      assert.equal(entry.module, moduleOf(entry.path));
      assert.equal(typeof entry.seed, 'boolean');
      if (entry.role !== 'deployed') assert.equal(entry.seed, false, entry.path);
    }
    assert.deepEqual(read(), family, 'with no directory it reads its own');
  });

  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'family-refusal-')));
  after(() => rmSync(temp, { recursive: true, force: true }));
  const manifestPath = join(temp, MANIFEST);
  const BASE = { schema: 1, entries: [{ path: 'family.mjs', role: 'skill-home' }, { path: 'shared/markdown-blocks.mjs', role: 'deployed', seed: true }] };
  const entry = (at, patch) => ({ ...BASE, entries: BASE.entries.map((one, index) => (index === at ? patch({ ...one }) : one)) });
  const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

  it('over a temp folder: a hand-written manifest reads with module and seed derived', async () => {
    writeFileSync(manifestPath, JSON.stringify(BASE));
    assert.deepEqual(await readFamily(temp), [
      { path: 'family.mjs', module: null, role: 'skill-home', seed: false },
      { path: 'shared/markdown-blocks.mjs', module: 'shared', role: 'deployed', seed: true },
    ]);
  });

  // [the refusal, the manifest (null: none on disk; a string: its text), the field it names, its cause]
  const REFUSALS = [
    ['a manifest it cannot read', null, null, /cannot read|ENOENT|no such file|not found|absent|missing/i],
    ['text that is not JSON', '{ "schema": 1, ', null, /JSON/],
    ['a top level that is not an object', '[]', null, /object/i],
    ['a top-level key other than the two', { ...BASE, extra: true }, 'extra', /unknown|unexpected|extra|not allowed/i],
    ['a top-level key missing', without(BASE, 'entries'), 'entries', /missing|required|absent/i],
    ['a schema other than 1', { ...BASE, schema: 2 }, 'schema', /\b1\b/],
    ['entries that is not an array', { ...BASE, entries: {} }, 'entries', /array/i],
    ['an entry that is not an object', { ...BASE, entries: [...BASE.entries, 'shared/index.mjs'] }, 'entries', /object/i],
    ['an entry with an unknown key', entry(0, (one) => ({ ...one, extra: 1 })), 'extra', /unknown|unexpected|extra|not allowed/i],
    ['an entry missing a field', entry(0, (one) => without(one, 'role')), 'role', /missing|required|absent/i],
    ['a path that is not a string', entry(0, (one) => ({ ...one, path: 7 })), 'path', /string/i],
    ['a role that is not a string', entry(0, (one) => ({ ...one, role: ['suite'] })), 'role', /string/i],
    ['a duplicate path', { ...BASE, entries: [...BASE.entries, BASE.entries[1]] }, 'path', /duplicate/i],
    ['a role outside the four', entry(0, (one) => ({ ...one, role: 'packed' })), 'role', /packed|one of|unknown|outside|must/i],
    ['a seed that is not a boolean', entry(1, (one) => ({ ...one, seed: 'yes' })), 'seed', /boolean/i],
    ['a seed on an entry that is not deployed', entry(0, (one) => ({ ...one, seed: false })), 'seed', /deployed/i],
    ['no seed on a deployed entry', entry(1, (one) => without(one, 'seed')), 'seed', /deployed|missing|required/i],
    ['no deployed entry', { ...BASE, entries: [BASE.entries[0]] }, null, /deployed/i],
    ['an empty family', { ...BASE, entries: [] }, null, /deployed/i],
  ];
  const BAD_PATHS = ['../x.mjs', '/abs.mjs', 'other.mjs', 'family.json', 'nope/x.mjs', 'shared/deep/x.mjs', 'shared\\x.mjs', 'shared/', './family.mjs'];
  const refusals = [...REFUSALS, ...BAD_PATHS.map((path) => [`a path outside the grammar: ${path}`, entry(0, (one) => ({ ...one, path })), 'path', /./])];

  for (const [what, manifest, field, cause] of refusals) {
    it(`refuses ${what}, naming the manifest path, the field and the cause`, async () => {
      rmSync(manifestPath, { force: true });
      if (manifest !== null) writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      const { readFamily: read } = await import('./family.mjs');
      let returned;
      assert.throws(() => { returned = read(temp); }, (err) => {
        assert.ok(err.message.includes(manifestPath), `the manifest path is named: ${err.message}`);
        const rest = err.message.split(manifestPath).join('');
        if (field) assert.ok(rest.includes(field), `the field ${field} is named: ${err.message}`);
        assert.match(rest, cause);
        return true;
      });
      assert.equal(returned, undefined);
    });
  }
});

// Import specifiers with the names they take: static clauses, side-effect imports, literal dynamic imports, and a
// destructured `await import(<expr>)` by the last literal in it. `*` stands for names this scan cannot see.
const namesIn = (clause) => {
  const braces = clause.match(/\{([^}]*)\}/);
  const named = braces ? braces[1].split(',').map((part) => part.trim().split(/\s+as\s+|\s*[:=]\s*/)[0].trim()).filter(Boolean) : [];
  const head = clause.replace(/\{[^}]*\}/, '');
  return /\*/.test(head) ? ['*', ...named] : /[\w$]/.test(head) ? ['default', ...named] : named;
};
const importsOf = (text) => {
  const destructured = [...text.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(([^;]*?)\)\s*;/g)];
  const taken = new Set(destructured.map((m) => m.index + m[0].indexOf('import(')));
  return [
    ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^'"`;]*?)\s*from\s*(['"])([^'"\n]+)\2/g)].map((m) => ({ spec: m[3], names: namesIn(m[1]) })),
    ...[...text.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"\n]+)\1/g)].map((m) => ({ spec: m[2], names: [] })),
    ...destructured.flatMap((m) => {
      const literals = [...m[2].matchAll(/(['"])([^'"\n]+)\1/g)];
      return literals.length ? [{ spec: literals.at(-1)[2], names: namesIn(`{${m[1]}}`) }] : [];
    }),
    ...[...text.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)].filter((m) => !taken.has(m.index)).map((m) => ({ spec: m[2], names: ['*'] })),
  ].filter((one) => one.spec.startsWith('.'));
};

// The repository holding this tree (the nearest .git above it), walked for .mjs files; a nested checkout is its own.
const repoRoot = (dir = HERE) => (existsSync(join(dir, '.git')) ? dir : dirname(dir) === dir ? dirname(dirname(HERE)) : repoRoot(dirname(dir)));
const SKIP = new Set(['node_modules', '.git', '.claude', 'docs']);
const mjsUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return SKIP.has(entry.name) || existsSync(join(full, '.git')) ? [] : mjsUnder(full);
  return entry.isFile() && entry.name.endsWith('.mjs') ? [full] : [];
});

// A target inside this tree or a byte-equal twin (the mirror): its tree and its POSIX path there, else null.
const twins = new Map();
const isTwin = (tree) => {
  if (!twins.has(tree)) twins.set(tree, existsSync(join(tree, MANIFEST)) && readFileSync(join(tree, MANIFEST)).equals(readFileSync(join(HERE, MANIFEST))));
  return twins.get(tree);
};
const placeOf = (target) => {
  for (const tree of [dirname(target), dirname(dirname(target))]) {
    if (isTwin(tree)) return { tree, path: relative(tree, target).split(sep).join('/') };
  }
  return null;
};

describe('spec:script-family/S4 the index is the one door, and every non-suite file is loaded by its own suites', () => {
  it('indexes stand in exactly the five modules, each the exact door code outside its module imports', async () => {
    assert.deepEqual(MODULES.filter((module) => existsSync(join(HERE, module, 'index.mjs'))), [...INDEXED].sort((a, b) => MODULES.indexOf(a) - MODULES.indexOf(b)));
    const names = new Map(INDEXED.map((module) => [module, new Set()]));
    const reached = new Set();
    for (const file of mjsUnder(repoRoot())) {
      const from = placeOf(file);
      for (const { spec, names: taken } of importsOf(readFileSync(file, 'utf8'))) {
        const to = placeOf(resolve(dirname(file), spec));
        if (!to || !moduleOf(to.path) || (from && from.tree === to.tree && moduleOf(from.path) === moduleOf(to.path))) continue;
        reached.add(moduleOf(to.path));
        if (to.path.endsWith('/index.mjs')) for (const name of taken) names.get(moduleOf(to.path))?.add(name);
      }
    }
    assert.deepEqual([...reached].sort(), [...INDEXED].sort(), 'an index stands exactly where code outside the module imports it');
    for (const module of INDEXED) {
      const door = await import(pathToFileURL(join(HERE, module, 'index.mjs')).href);
      const taken = names.get(module);
      const exported = Object.keys(door).sort();
      if (taken.has('*')) for (const name of taken) assert.ok(name === '*' || exported.includes(name), `${module}/index.mjs lacks ${name}`);
      else assert.deepEqual(exported, [...taken].sort(), `${module}/index.mjs re-exports exactly the names imported from outside`);
      const files = TREE[module].filter((name) => name !== 'index.mjs' && !name.endsWith('.test.mjs'));
      const sources = await Promise.all(files.map((name) => import(pathToFileURL(join(HERE, module, name)).href)));
      for (const name of exported) assert.ok(sources.some((source) => name in source && source[name] === door[name]), `${module}/index.mjs: ${name} is no export of a ${module} file`);
    }
  });

  it('crossing imports name an index, inside a module ./, no runtime file reaches test-support/, every non-suite file is loaded by its suites', async () => {
    const family = await readFamily(HERE);
    const roles = new Map(family.map((entry) => [entry.path, entry.role]));
    const edges = new Map();
    const offenders = [];
    for (const path of FILES.filter((name) => name.endsWith('.mjs'))) {
      const targets = [];
      for (const { spec } of importsOf(readFileSync(join(HERE, path), 'utf8'))) {
        const to = placeOf(resolve(HERE, dirname(path), spec));
        if (!to || to.tree !== HERE) continue;
        targets.push(to.path);
        const same = moduleOf(to.path) === moduleOf(path);
        if (same && !spec.startsWith('./')) offenders.push(`${path} -> ${spec}: an import inside a module is ./`);
        if (!same && moduleOf(to.path) && !to.path.endsWith('/index.mjs')) offenders.push(`${path} -> ${spec}: a crossing import names the module's index.mjs`);
        if (moduleOf(to.path) === 'test-support' && ['deployed', 'skill-home'].includes(roles.get(path))) offenders.push(`${path} -> ${spec}: a runtime file imports test-support/`);
      }
      edges.set(path, targets);
    }
    assert.deepEqual(offenders, []);
    const closure = (start, seen = new Set()) => { for (const next of edges.get(start) ?? []) if (!seen.has(next)) { seen.add(next); closure(next, seen); } return seen; };
    const suites = FILES.filter((path) => path.endsWith('.test.mjs'));
    const unloaded = FILES.filter((path) => path.endsWith('.mjs') && !path.endsWith('.test.mjs')).filter((path) => {
      const loaders = path === 'family.mjs' ? ['family.test.mjs']
        : moduleOf(path) === 'test-support' ? suites : suites.filter((suite) => moduleOf(suite) === moduleOf(path));
      return !loaders.some((suite) => closure(suite).has(path));
    });
    assert.deepEqual(unloaded, [], 'each non-suite file is loaded by a suite of its own module (the shim by a suite that uses it)');
  });
});
