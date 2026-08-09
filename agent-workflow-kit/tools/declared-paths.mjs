// declared-paths.mjs — the shared resolution + containment leaf for a DECLARED settings path
// (`sandbox.filesystem.allowWrite`). Two consumers must never disagree about what such an entry
// MEANS: the advisor's worktrees-dir convergence lane asks "does a declared entry cover this dir?",
// and the autonomy render's allowWrite degrade asks "does this entry resolve outside the repo?" —
// the same resolution and the same containment rule, read from opposite ends. A second resolver
// would let those two answers drift, so the rule lives here once.
//
// A LEAF: imports node:path only (never the advisor, never the render — the advisor already imports
// the render). No side effects on import. Dependency-free, Node >= 22.

import { resolve, sep } from 'node:path';

// What counts as a RESOLVABLE declared entry, shared by both consumers so they cannot disagree about
// which entries are readable at all. A blank entry is rejected deliberately: it means nothing to a
// host, but it would resolve to the project root and thereby read as a grant on the whole repo.
export const isResolvableDeclaredEntry = (entry) => typeof entry === 'string' && entry.trim() !== '';

// Resolve a declared entry the way a host that honors the key resolves it: `~` and `~/…` against the
// resolved home, every other form (relative or absolute) against the project root.
export const resolveDeclaredDir = (entry, { home, root }) => {
  if (entry === '~') return resolve(home);
  if (entry.startsWith('~/')) return resolve(home, entry.slice(2));
  return resolve(root, entry);
};

// Ancestor-or-equal containment on PATH SEGMENTS, never a raw string prefix — a grant on `<p>/farm`
// must never read as a grant on the sibling `<p>/farmhouse`. A grant on a DESCENDANT never covers
// its parent: the parent dir is the one a provision writes into.
export const dirCovers = (containerDir, candidateDir) => {
  const base = containerDir.endsWith(sep) ? containerDir.slice(0, -sep.length) : containerDir;
  return candidateDir === base || candidateDir.startsWith(`${base}${sep}`);
};
