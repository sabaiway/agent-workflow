// harness.test.mjs — the shared fixture of the checker-gates suites (docs/ai/specs/kit/tier/checker-gates/).
// Declares no test and imports nothing under test statically: a temp deployed project per declaration
// and probe state, a captured run of the declare verb, one injected fs failure.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LF = String.fromCharCode(10);
const ABSENT = 'checker-gates.mjs main is absent';
const WRITE_PRIMITIVES = ['writeFile', 'rename', 'link', 'rm', 'mkdir'];
const README = 'The fixture declaration.';
const bases = [];

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

export const KIT_TOOLS = Object.freeze({
  'control-bytes': resolve(HERE, '..', 'control-bytes.mjs'),
  'plan-shape': resolve(HERE, '..', 'plan-shape-cli.mjs'),
  'spec-check': resolve(HERE, '..', 'spec-check-cli.mjs'),
  'spec-coverage': resolve(HERE, '..', 'spec-coverage-cli.mjs'),
});

const REAL = Object.freeze({
  lstatSync,
  lstat: lstatSync,
  readFileSync,
  open: openSync,
  writeFile: writeFileSync,
  rename: renameSync,
  link: linkSync,
  rm: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
});

// One placed path: undefined or null places nothing; a string or a Buffer is a regular file;
// { kind: 'symlink', text } links to a regular file outside the project; { kind: 'directory' } is an
// empty directory. The declaration also takes an array of gates, serialized with the fixture _README.
const place = (base, root, rel, spec) => {
  if (spec === undefined || spec === null) return;
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (Array.isArray(spec)) {
    writeFileSync(path, `${JSON.stringify({ _README: README, gates: spec }, null, 2)}${LF}`);
    return;
  }
  if (typeof spec === 'string' || Buffer.isBuffer(spec)) {
    writeFileSync(path, spec);
    return;
  }
  if (spec.kind === 'symlink') {
    const outside = join(base, `outside-${rel.replaceAll('/', '-')}`);
    writeFileSync(outside, spec.text ?? '');
    symlinkSync(outside, path);
    return;
  }
  assert.equal(spec.kind, 'directory', `unknown fixture kind for ${rel}`);
  mkdirSync(path);
};

// makeProject({ gates, storeRoot, scope, git, files, docsAi, name }) → { root, base }. docsAi:
// 'directory' (default), 'absent', 'symlink' or 'file'; gates, storeRoot, scope and git place
// docs/ai/gates.json, docs/ai/specs/index.md, docs/ai/spec-coverage.json and .git; files places any
// other project path. Every placement is absent unless given.
export const makeProject = ({ gates, storeRoot, scope, git, files = {}, docsAi = 'directory', name = 'project' } = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'checker-gates-'));
  bases.push(base);
  const root = join(base, name);
  mkdirSync(root);
  const docs = join(root, 'docs');
  if (docsAi === 'directory') mkdirSync(join(docs, 'ai'), { recursive: true });
  if (docsAi === 'file') place(base, root, 'docs/ai', 'not a directory');
  if (docsAi === 'symlink') {
    mkdirSync(join(base, 'elsewhere'));
    mkdirSync(docs);
    symlinkSync(join(base, 'elsewhere'), join(docs, 'ai'));
  }
  place(base, root, '.git', git);
  if (docsAi === 'directory') {
    const placed = { 'docs/ai/gates.json': gates, 'docs/ai/specs/index.md': storeRoot, 'docs/ai/spec-coverage.json': scope, ...files };
    for (const [rel, spec] of Object.entries(placed)) place(base, root, rel, spec);
  }
  return { root, base };
};

// runVerb(root, args, deps) → { code, stdout, stderr, lines, writes }: main runs once on `--cwd root`
// plus args (a null root passes args alone), synchronously; every write primitive call is recorded
// as [name, ...args], then runs as given in deps, or for real.
export const runVerb = async (root, args = [], deps = {}) => {
  const loaded = await import('../checker-gates.mjs').catch(() => ({}));
  const main = loaded.main ?? (() => { throw new Error(ABSENT); });
  const writes = [];
  const recorded = Object.fromEntries(WRITE_PRIMITIVES.map((name) => [name, (...call) => {
    writes.push([name, ...call]);
    return (deps[name] ?? REAL[name])(...call);
  }]));
  const argv = root === null ? args : ['--cwd', root, ...args];
  const outcome = main(argv, { ...deps, ...recorded });
  assert.ok(!(outcome instanceof Promise), 'main returns synchronously');
  assert.deepEqual(Object.keys(outcome).sort(), ['code', 'stderr', 'stdout']);
  const lines = outcome.stdout === '' ? [] : outcome.stdout.split(LF);
  return { ...outcome, lines, writes };
};

// failAt(root, primitive, rel, code) → a deps fragment whose `primitive` throws an fs-shaped error
// for any call whose first or second argument starts with root/rel, and runs the real primitive
// otherwise.
export const failAt = (root, primitive, rel, code = 'EACCES') => {
  const real = REAL[primitive];
  assert.equal(typeof real, 'function', `no real primitive named ${primitive}`);
  const target = resolve(root, rel);
  return {
    [primitive]: (...args) => {
      if (args.slice(0, 2).some((arg) => typeof arg === 'string' && arg.startsWith(target))) {
        throw Object.assign(new Error(`${code}: injected ${primitive} failure, ${String(args[0])}`), { code });
      }
      return real(...args);
    },
  };
};
