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
// The D-schema values come from the ONE reader (references/scripts/spec-schema.mjs): no second
// source of the prefix, the navigator filename or the slug pattern. Pure strings in, ops out — the
// filesystem belongs to spec-check.mjs. Dependency-free, Node >= 22.

import { SPEC_SCHEMA } from '../references/scripts/spec-schema.mjs';

const STORE = SPEC_SCHEMA.storePrefix;
const NAV = SPEC_SCHEMA.navigatorFile;
const SUFFIX = '.md';
const SEPARATOR = ':';

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
const targetDefect = (target) => {
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
  if (target === SPEC_OPS_GRAMMAR.storeRoot) {
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
export const parseSpecOps = (specs) => {
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
    const defect = sides.map(targetDefect).find(Boolean);
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
  if (errors.length === 0 && ops.length === 0) {
    errors.push({ code: 'op-empty', message: 'no op to judge — name at least one --op or --ops-file entry, or run --all' });
  }
  return { ops: errors.length > 0 ? [] : ops, errors };
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
