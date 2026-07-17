// semver-lite.mjs — the dependency-free semver LEAF shared by the npx installer (the never-downgrade
// gate, bin/install.mjs) and the family registry (the bridge freshness probe).
//
// Parses the leading `x.y.z` only (prerelease/build ignored — family versions are plain).
// compareSemver returns -1 | 0 | 1, or null when EITHER side is unparseable. The null contract is
// load-bearing at both call sites: a legacy install predates any version stamp (→ no gate), and a
// freshness probe that cannot parse a version must degrade to "unknown" — never to a false ordering
// claim in either direction (INV-B). No `let`: a small functional comparison (AGENTS.md §2.3).
//
// Pure, no imports, no side effects, Node >= 22.

export const parseSemver = (str) => {
  const m = typeof str === 'string' ? str.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const compareSemver = (a, b) => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const firstDiff = [0, 1, 2].map((i) => (pa[i] === pb[i] ? 0 : pa[i] < pb[i] ? -1 : 1)).find((c) => c !== 0);
  return firstDiff ?? 0;
};
