// bridge-state-dirs.mjs — the one leaf that turns the bundled bridges' declared writable state dirs
// (`writableDirs`) into `sandbox.filesystem.allowWrite` entries (contract: bridges/velocity-profile).
// The bridge tier writes them, the advisor counts them, the danger check admits them, the autonomy
// preview names them: one resolution, one home-relative spelling, one merge, so the four cannot drift.
//
// A LEAF: imports declared-paths.mjs and node:path only. No side effects on import. Dependency-free,
// Node >= 22.

import { dirname, relative, resolve } from 'node:path';
import { dirCovers, isResolvableDeclaredEntry, resolveDeclaredDir } from './declared-paths.mjs';

// D6 resolution, mirroring the wrappers' byte-semantics (`${VAR:-default}` + the exact case-arms:
// `~` / `~/…` / `/…` ride as-given; EVERY other form — including `~user/…`, which the wrappers
// never resolve as a home path — anchors like a relative path). Anchored to the TARGET PROJECT ROOT,
// matching what a wrapper invoked from the project root resolves.
export const resolveWritableDir = (entry, { env, root }) => {
  const value = entry.env == null ? '' : (env[entry.env] ?? '');
  if (value === '') return entry.default;
  if (value === '~' || value.startsWith('~/') || value.startsWith('/')) return value;
  return resolve(root, value);
};

// The HOME-SYMBOLIC spelling: tilde forms stay symbolic, an absolute dir under the home (by path
// segment, never a string prefix) folds back to `~/…`, anything outside the home stays absolute.
export const homeRelative = (dir, home) => {
  if (dir === '~') return '~';
  if (dir.startsWith('~/')) return `~/${dir.slice(2)}`;
  const homeAbs = resolve(home);
  const abs = resolve(dir);
  if (abs === homeAbs) return '~';
  return dirCovers(homeAbs, abs) ? `~/${relative(homeAbs, abs)}` : abs;
};

const ancestorsOf = (dir) => {
  const out = [];
  for (let at = dirname(dir); at !== dir; dir = at, at = dirname(at)) out.push(at);
  return out;
};

// A grant on `/`, on the home, or on an ancestor of the home or of the root would hand every
// sandboxed command the user's whole tree — never a bridge's state dir. The override that produced
// it is named, so the user knows which variable to fix.
const dangerOf = (abs, { home, root }) => {
  const homeAbs = resolve(home);
  if (abs === '/') return 'the filesystem root';
  if (abs === homeAbs) return 'the home directory';
  if (ancestorsOf(homeAbs).includes(abs)) return 'an ancestor of the home directory';
  if (ancestorsOf(resolve(root)).includes(abs)) return 'an ancestor of the project root';
  return null;
};

export const stateDirsOf = (dirEntries, { env, root, home }) => {
  const dirs = [];
  for (const entry of dirEntries) {
    const raw = resolveWritableDir(entry, { env, root });
    const danger = dangerOf(resolveDeclaredDir(raw, { home, root }), { home, root });
    if (danger !== null) {
      const source = entry.env == null ? 'its declared default' : entry.env;
      throw new Error(`writable state dir "${raw}" from ${source} resolves to ${danger} — refusing to grant it; point ${source} at the bridge's own state dir`);
    }
    const rendered = homeRelative(raw, home);
    if (!dirs.includes(rendered)) dirs.push(rendered);
  }
  return dirs;
};

// The dirs no existing allowWrite entry covers (resolved both sides, containment by path segment).
export const missingStateDirs = (dirs, allowWrite, { home, root }) => {
  const existing = (Array.isArray(allowWrite) ? allowWrite : [])
    .filter(isResolvableDeclaredEntry)
    .map((entry) => resolveDeclaredDir(entry, { home, root }));
  return dirs.filter((dir) => {
    const abs = resolveDeclaredDir(dir, { home, root });
    return !existing.some((container) => dirCovers(container, abs));
  });
};

// The ONE writer of `sandbox.filesystem.allowWrite`: the other sandbox and filesystem sub-keys stay
// where they are, each dir not already present appends once. Pure: returns a new object, and with
// nothing to add returns the input unchanged (no sandbox key is created for nothing).
export const mergeAllowWrite = (settings, dirs) => {
  const base = settings ?? {};
  const existing = Array.isArray(base.sandbox?.filesystem?.allowWrite) ? base.sandbox.filesystem.allowWrite : [];
  const toAppend = [];
  for (const dir of dirs) if (!existing.includes(dir) && !toAppend.includes(dir)) toAppend.push(dir);
  if (toAppend.length === 0) return base;
  return {
    ...base,
    sandbox: {
      ...base.sandbox,
      filesystem: { ...base.sandbox?.filesystem, allowWrite: [...existing, ...toAppend] },
    },
  };
};
