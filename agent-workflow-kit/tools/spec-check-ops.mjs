// spec-check-ops.mjs — the frozen CHANGE-OP grammar of the structural checker (spec layer 2b).
//
// The change source is EXPLICIT and never git: a session states what it did to the spec store, and
// this module decides whether that statement is even sayable. Four verbs, one separator, one
// spelling per path:
//
//   add=<p> | modify=<p> | remove=<p> | rename=<old>:<new>
//
// A target is a POSIX repo-relative `.md` path inside docs/ai/specs/ whose every segment is
// D-schema-shaped (kebab dirs; a `<slug>.md` or `index.md` leaf). Because no accepted target can
// carry a `:`, the rename separator is unambiguous — which is why the grammar can stay one line.
//
// NOTHING is normalized away: `./x.md`, `a//b.md` and `a/../b.md` REFUSE rather than resolving to
// some other path, so one document has exactly ONE accepted spelling and a dedup can be an equality.
// The store root is never an op target — it is the navigator, not a contract.
//
// The D-schema values come from the ONE reader (references/scripts/spec-schema/index.mjs): no second
// source of the prefix, the navigator filename or the slug pattern. Pure strings in, ops out — the
// filesystem belongs to spec-check.mjs. Dependency-free, Node >= 22.

import { sep } from 'node:path';
import { SPEC_SCHEMA } from '../references/scripts/spec-schema/index.mjs';

const STORE = SPEC_SCHEMA.storePrefix;
const NAV = SPEC_SCHEMA.navigatorFile;
const SUFFIX = '.md';
const SEPARATOR = ':';
const HOME_SUFFIX = '.specs';
const PLAN_OP_VERBS = Object.freeze({ create: 'add', modify: 'modify', delete: 'remove' });

export const SPEC_OPS_GRAMMAR = Object.freeze({
  verbs: Object.freeze(['add', 'modify', 'remove', 'rename']),
  separator: SEPARATOR,
  storePrefix: STORE,
  navigator: NAV,
  suffix: SUFFIX,
  slugPattern: SPEC_SCHEMA.slugPattern,
  storeRoot: `${STORE}${NAV}`,
  roles: Object.freeze(['add', 'modify', 'remove', 'rename-from', 'rename-to', 'listing-parent']),
});

const SLUG_RE = new RegExp(SPEC_SCHEMA.slugPattern);
const DRIVE_RE = /^[A-Za-z]:/;
const VERBS = SPEC_OPS_GRAMMAR.verbs;

// The ONE target judgement, ordered from the most literal defect to the most structural. The store
// PREFIX is asked before the dot segments on purpose: `./docs/ai/specs/x.md` is not a store path
// that needs normalizing, it is a path outside the store, and saying so is the honest refusal.
const targetDefect = (target, allowStoreRoot = false) => {
  if (target.includes('\\')) return { code: 'op-target', reason: 'a backslash is not a path separator here' };
  if (DRIVE_RE.test(target)) return { code: 'op-target', reason: 'a drive letter is not a repo-relative path' };
  if (target.startsWith('/')) return { code: 'op-target', reason: 'an absolute path is not repo-relative' };
  if (target.includes('//')) return { code: 'op-target', reason: 'a doubled slash is not a path segment' };
  if (target.endsWith('/')) return { code: 'op-target', reason: 'a directory is never an op target — name the document' };
  if (!target.startsWith(STORE)) return { code: 'op-target', reason: `the target is outside the store ${STORE}` };
  if (target.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { code: 'op-target', reason: 'a dot segment is never resolved away — write the path as it is' };
  }
  if (!target.endsWith(SUFFIX)) return { code: 'op-target', reason: `a spec document is a ${SUFFIX} file` };
  if (target === SPEC_OPS_GRAMMAR.storeRoot && !allowStoreRoot) {
    return { code: 'op-root', reason: 'the store root is the navigator, never an op target' };
  }
  const segments = target.slice(STORE.length).split('/');
  const leaf = segments[segments.length - 1];
  const badDir = segments.slice(0, -1).find((segment) => !SLUG_RE.test(segment));
  if (badDir !== undefined) return { code: 'op-segment', reason: `"${badDir}" is not a slug (${SPEC_SCHEMA.slugPattern})` };
  const stem = leaf.slice(0, -SUFFIX.length);
  if (leaf !== NAV && !SLUG_RE.test(stem)) return { code: 'op-segment', reason: `"${stem}" is not a slug (${SPEC_SCHEMA.slugPattern})` };
  return null;
};

// The slug a document owns — the folder name for an index.md, the file stem otherwise. The same
// rule the reader applies to `rel`, kept here because the checker asks it of WHOLE PATHS.
export const slugOf = (path) => {
  const segments = path.slice(STORE.length).split('/');
  const leaf = segments[segments.length - 1];
  return leaf === NAV ? segments[segments.length - 2] ?? null : leaf.slice(0, -SUFFIX.length);
};

// The document that LISTS this one: `<dir>/index.md` for a leaf, ONE level up for an index.md
// (a promoted root is listed by its parent, never by itself). The store root is listed by nothing.
export const listingParentOf = (path) => {
  const segments = path.slice(STORE.length).split('/');
  const dirs = segments.slice(0, -1);
  if (segments[segments.length - 1] === NAV) {
    return dirs.length === 0 ? null : `${STORE}${[...dirs.slice(0, -1), NAV].join('/')}`;
  }
  return `${STORE}${[...dirs, NAV].join('/')}`;
};

// The shape a path plays. A path in TWO roles is refused rather than reconciled: "added and then
// removed" states two different post-states for one probe, and guessing which one the session meant
// is exactly the unresolved reference this module exists to refuse.
const SHAPES = Object.freeze({ 'rename-from,rename-from': 'fan-out', 'rename-to,rename-to': 'fan-in', 'rename-from,rename-to': 'chain' });
const roleConflict = (roles) => SHAPES[[...roles].sort().join(',')] ?? 'two roles';

// parseSpecOps(specs) -> { ops, errors }. Every op is judged, so one call names EVERY defect; any
// error at all empties `ops` — a partially-understood change set would attest a post-state nobody
// declared.
const parseOps = (specs, fromPlan) => {
  const errors = [];
  const ops = [];
  const seen = new Set();
  const roles = new Map();
  const claim = (path, role, spec) => {
    const held = roles.get(path);
    if (held === undefined) roles.set(path, { role, spec });
    else errors.push({ code: 'op-role', message: `"${spec}" and "${held.spec}" put ${path} in two roles (${roleConflict([held.role, role])})` });
  };
  for (const raw of specs ?? []) {
    const spec = String(raw);
    // Surrounding whitespace is REFUSED rather than trimmed: trimming would give one document a
    // second accepted spelling, and the whole grammar rests on there being exactly one.
    if (spec !== spec.trim()) {
      errors.push({ code: 'op-grammar', message: `"${spec}" — leading or trailing whitespace is never trimmed away; write the op without it` });
      continue;
    }
    const eq = spec.indexOf('=');
    const verb = eq === -1 ? spec : spec.slice(0, eq);
    const payload = eq === -1 ? '' : spec.slice(eq + 1);
    if (!VERBS.includes(verb)) {
      errors.push({ code: 'op-grammar', message: `"${spec}" — an op is verb=<target>, the verb one of ${VERBS.join('|')}` });
      continue;
    }
    if (payload === '') {
      errors.push({ code: 'op-grammar', message: `"${spec}" — an op is verb=<target>, and the target is never empty` });
      continue;
    }
    if (seen.has(spec)) continue;
    seen.add(spec);
    const sides = verb === 'rename' ? payload.split(SEPARATOR) : [payload];
    if (verb === 'rename' && sides.length !== 2) {
      errors.push({ code: 'op-grammar', message: `"${spec}" — rename takes <old>${SEPARATOR}<new>: exactly one separator "${SEPARATOR}"` });
      continue;
    }
    const defect = sides.map((side) => targetDefect(side, fromPlan && verb === 'modify')).find(Boolean);
    if (defect) {
      errors.push({ code: defect.code, message: `"${spec}" — ${defect.reason}` });
      continue;
    }
    if (verb === 'rename' && sides[0] === sides[1]) {
      errors.push({ code: 'op-role', message: `"${spec}" — a rename to itself (self) declares no change` });
      continue;
    }
    if (verb === 'rename') {
      claim(sides[0], 'rename-from', spec);
      claim(sides[1], 'rename-to', spec);
      ops.push({ verb, from: sides[0], to: sides[1] });
    } else {
      claim(payload, verb, spec);
      ops.push({ verb, target: payload });
    }
  }
  if (!fromPlan && errors.length === 0 && ops.length === 0) {
    errors.push({ code: 'op-empty', message: 'no op to judge — name at least one --op or --ops-file entry, or run --all' });
  }
  return { ops: errors.length > 0 ? [] : ops, errors };
};

export const parseSpecOps = (specs) => parseOps(specs, false);

const reachesStore = (path, isSweep, expand) => {
  const segments = path.split('/');
  const lead = segments.slice(0, segments.findIndex(isSweep)).join('/');
  if (`${lead}/`.startsWith(STORE)) return true;
  return (lead === '' || STORE.startsWith(`${lead}/`)) && expand(path).some((match) => match.startsWith(STORE));
};

export const parsePlanSpecOps = (rows, isSweep, expand) => {
  const sweep = rows.find(({ path }) => isSweep(path) && reachesStore(path, isSweep, expand));
  if (sweep) {
    const message = `${sweep.id} ${sweep.path}: --plan judges one store document per row; name each store document in its own row`;
    return { ops: [], errors: [{ code: 'op-sweep', message }] };
  }
  return parseOps(rows
    .filter(({ path }) => path.startsWith(STORE) && path.endsWith(SUFFIX))
    .map(({ verb, path }) => `${PLAN_OP_VERBS[verb]}=${path}`), true);
};

// buildClosure(ops) -> [{ path, roles }] sorted: every op path PLUS the document that lists it.
// A listing parent that is itself an op target keeps its op role; two ops under one parent name it
// once; ops under different parents name both.
export const buildClosure = (ops) => {
  const entries = new Map();
  const put = (path, role) => entries.set(path, [...new Set([...(entries.get(path) ?? []), role])]);
  const targets = [];
  for (const op of ops) {
    if (op.verb === 'rename') {
      put(op.from, 'rename-from');
      put(op.to, 'rename-to');
      targets.push(op.from, op.to);
    } else {
      put(op.target, op.verb);
      targets.push(op.target);
    }
  }
  for (const target of targets) {
    const parent = listingParentOf(target);
    if (parent !== null && !entries.has(parent)) put(parent, 'listing-parent');
  }
  return [...entries]
    .map(([path, roles]) => ({ path, roles }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

export const parsePendingModulePath = (claimed) => {
  const kind = claimed.endsWith('/') ? 'dir' : 'file';
  const path = kind === 'dir' ? claimed.slice(0, -1) : claimed;
  const valid = path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return valid ? { path, kind } : null;
};

const pendingModulePlan = ({ identity, rows }) => ({
  identity,
  creates: rows.filter(({ verb }) => verb === 'create').map(({ path }) => path),
});

export const selectPendingModulePlans = (plans = [], { path, status, home }) => {
  const revision = home?.paths.includes(path);
  if (!revision && status !== 'draft') return { plan: null, refusedPlans: [] };
  const documentVerb = revision ? 'modify' : 'create';
  const candidates = plans.filter(({ identity, rows }) => (!revision || identity === home.plan) &&
    rows.some((row) => row.verb === documentVerb && row.path === path));
  const accepted = candidates.filter(({ accepted }) => accepted === true);
  return {
    plan: accepted.length === 1 ? pendingModulePlan(accepted[0]) : null,
    refusedPlans: candidates.filter(({ accepted }) => accepted === false).map(pendingModulePlan),
  };
};

const isStrictDescendant = (path, directory) => path !== directory &&
  path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);

export const hasPendingModuleCover = (canonicalPath, kind, canonicalCreates) => {
  const cover = canonicalCreates.filter((path) => kind === 'dir' ? isStrictDescendant(path, canonicalPath) : path === canonicalPath);
  return cover.length > 0 && !cover.some((file) => canonicalCreates.some((path) => isStrictDescendant(file, path)));
};

export const getRevisionHomePath = (plan, storePath) => {
  const home = `${plan.slice(0, -SUFFIX.length)}${HOME_SUFFIX}`;
  if (storePath === undefined) return home;
  return targetDefect(storePath, true) === null ? `${home}/${storePath.slice(STORE.length)}` : null;
};

export const getRevisionStorePath = (home, homePath) => {
  const prefix = `${home}/`;
  if (!homePath.startsWith(prefix)) return null;
  const target = `${STORE}${homePath.slice(prefix.length)}`;
  return targetDefect(target, true) === null ? target : null;
};
