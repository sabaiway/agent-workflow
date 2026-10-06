// bridge-sandbox-recipe.mjs — the one reader of the bundled bridges' declared sandbox surfaces
// (contract: bridges/velocity-profile). The bridge tier seeds the hosts it returns and the
// Recommendations sandbox-lane recipe renders hosts and dirs from it, so the two cannot drift.
//
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';

// The manifest-declared session-sandbox recipe surfaces of every BUNDLED bridge whose review
// wrapper is in the wired set — networkHosts ∪ writableDirs, derived from the manifests (the
// single documentation source), never hardcoded here.
export const bundledSandboxRecipe = (placedWrappers, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  const readDir = deps.readdir ?? readdirSync;
  const bundleRoot = deps.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
  const hosts = [];
  const dirEntries = [];
  for (const dir of readDir(bundleRoot)) {
    // An unreadable/unparsable bundled manifest must NOT thin the recipe silently — a partial
    // recipe rendered as complete is worse than none. The throw reaches the caller: a stated skip
    // in the advisor, a STOP with zero writes in the bridge tier.
    let manifest;
    try {
      manifest = JSON.parse(readFile(join(bundleRoot, dir, 'capability.json'), 'utf8'));
    } catch (err) {
      // ENOTDIR = the entry is a stray regular file (.DS_Store, a README), not a bridge bundle.
      if (err?.code === 'ENOTDIR') continue;
      throw new Error(`bundled manifest unreadable: ${join(dir, 'capability.json')} — ${err?.message ?? err}`);
    }
    const reviewCmd = manifest?.roles?.review?.cmd;
    if (!reviewCmd || !placedWrappers.includes(reviewCmd)) continue;
    if (Array.isArray(manifest.networkHosts)) {
      for (const h of manifest.networkHosts) if (!hosts.includes(h)) hosts.push(h);
    }
    if (Array.isArray(manifest.writableDirs)) dirEntries.push(...manifest.writableDirs);
  }
  return { hosts, dirEntries };
};
