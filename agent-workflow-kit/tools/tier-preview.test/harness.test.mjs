// harness.test.mjs — the shared fixture of the tier-offer suites (docs/ai/specs/kit/tier/tier-offer/).
// Declares no test and imports nothing under test statically: a temp deployed project, injected
// readiness, a captured run of the offer CLI, one injected fs failure.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_TEMPLATE = resolve(HERE, '..', '..', 'references', 'templates', 'agent_rules.md');
const RULES_REL = 'docs/ai/agent_rules.md';
const LF = String.fromCharCode(10);
const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const ABSENT = 'tier-preview.mjs main is absent';
const WRITE_PRIMITIVES = ['writeFile', 'rename', 'link', 'rm', 'mkdir'];
const bases = [];

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
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

// One entry of `files`: undefined or null places nothing; a string or a Buffer is a regular file;
// { kind: 'symlink', text } links to a regular file outside the project; { kind: 'directory',
// entries } is a directory holding the named empty files.
const place = (base, root, rel, spec) => {
  if (spec === undefined || spec === null) return;
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (typeof spec === 'string' || Buffer.isBuffer(spec)) {
    writeFileSync(path, spec);
    return;
  }
  if (spec.kind === 'symlink') {
    const outside = join(base, `outside-${bases.length}-${rel.replaceAll('/', '-')}`);
    writeFileSync(outside, spec.text ?? '');
    symlinkSync(outside, path);
    return;
  }
  assert.equal(spec.kind, 'directory', `unknown fixture kind for ${rel}`);
  mkdirSync(path);
  for (const name of spec.entries ?? []) writeFileSync(join(path, name), '');
};

// makeProject({ files, docsAi, link, name }) → { root, base }; name is the project directory's name. docsAi: 'directory' (default), 'absent',
// 'symlink' or 'file'; link: 'root' or 'docs' returns a root, or places a docs component, that is a
// symlink to a real deployment. The rules file defaults to the bundled template (story sessions
// present); pass files[RULES_REL] = null to leave it out.
export const makeProject = ({ files = {}, docsAi = 'directory', link, name = 'project' } = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'tier-offer-'));
  bases.push(base);
  const real = join(base, link ? 'real' : name);
  mkdirSync(real);
  const docs = join(real, 'docs');
  if (docsAi === 'directory') mkdirSync(join(docs, 'ai'), { recursive: true });
  if (docsAi === 'file') place(base, real, 'docs/ai', 'not a directory');
  if (docsAi === 'symlink') {
    mkdirSync(join(base, 'elsewhere'));
    mkdirSync(docs);
    symlinkSync(join(base, 'elsewhere'), join(docs, 'ai'));
  }
  const withRules = { [RULES_REL]: readFileSync(RULES_TEMPLATE), ...files };
  if (docsAi === 'directory') {
    for (const [rel, spec] of Object.entries(withRules)) place(base, real, rel, spec);
  }
  if (link === 'root') {
    const root = join(base, name);
    symlinkSync(real, root);
    return { root, base };
  }
  if (link === 'docs') {
    const root = join(base, name);
    mkdirSync(root);
    symlinkSync(docs, join(root, 'docs'));
    return { root, base };
  }
  return { root: real, base };
};

// readinessOf({ codex, agy, executor, detectError }) → the deps a run composes its readiness
// from: the two bridges at the given readiness tokens (a thrown detector when detectError names a
// cause) and the executor vehicle survey at the given state.
export const readinessOf = ({ codex = 'needs-cli', agy = 'needs-cli', executor = 'missing', detectError } = {}) => ({
  detect: () => {
    if (detectError) throw new Error(detectError);
    return [{ name: CODEX, readiness: codex }, { name: AGY, readiness: agy }];
  },
  surveyVehicle: () => ({ state: executor }),
});

// A tree snapshot: every path under root with its kind and, for a regular file, its bytes.
const snapshot = (path) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(path) };
  if (stat.isFile()) return { kind: 'file', bytes: readFileSync(path).toString('hex') };
  if (!stat.isDirectory()) return { kind: 'other' };
  return { kind: 'directory', entries: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) };
};

// runOffer(root, args, deps) → { code, stdout, stderr, lines, writes, before, after }: main runs
// once on `--cwd root` plus args, synchronously; every write primitive call is recorded as
// [name, ...args] (then runs as given in deps, or for real), and the project tree is captured
// around the run.
export const runOffer = async (root, args = [], deps = {}) => {
  const loaded = await import('../tier-preview.mjs').catch(() => ({}));
  const main = loaded.main ?? (() => { throw new Error(ABSENT); });
  const writes = [];
  const recorded = Object.fromEntries(WRITE_PRIMITIVES.map((name) => [name, (...call) => {
    writes.push([name, ...call]);
    return (deps[name] ?? REAL[name])(...call);
  }]));
  const before = snapshot(root);
  const outcome = main(['--cwd', root, ...args], { ...deps, ...recorded });
  assert.ok(!(outcome instanceof Promise), 'main returns synchronously');
  assert.deepEqual(Object.keys(outcome).sort(), ['code', 'stderr', 'stdout']);
  const lines = outcome.stdout === '' ? [] : outcome.stdout.split(LF);
  return { ...outcome, lines, writes, before, after: snapshot(root) };
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
