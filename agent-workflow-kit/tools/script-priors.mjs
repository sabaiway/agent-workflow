// script-priors.mjs — the APPEND-ONLY catalog of every enforcement-script body this family has shipped
// into a project's `scripts/`, as sha256 digests, and the ONE classifier a refresh asks before it
// replaces a deployed script — the spec-layer ensure for its pairs, the `hook-checks` writer for the
// hook installer: `current` (byte-equal to the bundled copy) · `prior` (a body a release shipped, never
// edited since) · `custom` (anything else — preserved verbatim, replaced only by the replace run the
// user's yes starts). The lens-region idiom (AD-041) over whole script bodies.
//
// Append discipline: when a release changes one of PRIOR_FILES, append the OUTGOING body's row here
// in the same release and copy its bytes to test/fixtures/script-priors/<firstShipped>/<file>.txt —
// script-priors.test.mjs holds the two sides equal both ways and pins the row count. Rows are never
// edited or removed: a deployment on any shipped body must keep classifying `prior`.
//
// Pure leaf: node:crypto only. No side effects on import.

import { createHash } from 'node:crypto';

// The deployed scripts a refresh may REPLACE — the FULL refreshable catalog: the checker pair that
// imports the reader and (since 2a) the reader pair itself, which the spec-layer ensure refreshes, and
// the hook installer, which the `hook-checks` writer refreshes. Every other deployed script is outside
// the refresh lane by design.
export const PRIOR_FILES = Object.freeze([
  'check-docs-size.mjs', 'check-docs-size.test.mjs', 'spec-schema.mjs', 'spec-schema.test.mjs', 'install-git-hooks.mjs',
]);

const prior = (file, firstShipped, lastShipped, digest) => Object.freeze({ file, firstShipped, lastShipped, digest });

// One row per DISTINCT shipped body (memory package versions; the body is the memory canon the kit
// mirrors). `firstShipped`..`lastShipped` is the inclusive release range that carried the body.
export const SCRIPT_PRIORS = Object.freeze([
  prior('check-docs-size.mjs', '4.0.0', '4.3.0', '84fb3673b034d4b2ba5bedf4a3e47899f98da3971c17902d1f2a548d07dc53bf'),
  prior('check-docs-size.mjs', '4.4.0', '4.5.0', '7a5cd7f98571c3248d0378623172e9c60073b8d8761bce7a95c263f99bfb3a42'),
  prior('check-docs-size.mjs', '4.5.1', '4.5.4', 'fef3555b14a5ade46071bac18bd6dfc87daec39dd63ce1f7965864c3e51558d9'),
  prior('check-docs-size.test.mjs', '4.0.0', '4.5.4', '88fbb3d7f097d74771b7c5d9ad99fcd58b274ae33f391e1ff01f4b138b9236cd'),
  prior('spec-schema.mjs', '4.6.0', '4.6.1', 'f8ee23d81e90fd4225ca4ece288cba41982c4430290bc6d033f5ca18d2d283f4'),
  prior('spec-schema.test.mjs', '4.6.0', '4.6.1', 'a12d6d3f5d32c6dabdee7e15af7d2ab15a0ced37515d1844fe0951f60cddbc99'),
  prior('spec-schema.mjs', '4.7.0', '4.7.0', '40b5b038d5ec5ed53c327c6d269d22fe5fa2bed99ae711fbf84306ad047be452'),
  prior('spec-schema.test.mjs', '4.7.0', '4.7.0', 'fde896419924223e54cfcabfdb1ef5807df5386fac700ed7c1463b6e7f81501b'),
  prior('check-docs-size.mjs', '4.6.0', '6.0.0', '22d020c3668cdbfb4cbc1f67a8a85b2baa2d0c4956808a50626d37409e81ab38'),
  prior('spec-schema.mjs', '5.0.0', '7.2.1', '6a7d1e836c158baab5a412a1ad76d34891934dc28c88486c264a4b5d46f5892a'),
  prior('spec-schema.test.mjs', '5.0.0', '7.2.1', '698564d7283281be1826019d214df475bb876687915de086818d8f5ece0e0336'),
  prior('check-docs-size.mjs', '7.0.0', '8.1.5', '0cf90ae2cbfc809847574a8c71a6b1322c783359740b08e0ff179f0d9d04dffc'),
  prior('install-git-hooks.mjs', '4.0.0', '8.2.1', '4c4010153cd3a9ca556f34d567d9985cff5c6e1b5ec3087ed7805e5c98f6f918'),
]);

export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

// classifyDeployedScript(deployedBytes, file, bundleBytes, priors?) → 'current' | 'prior' | 'custom'.
// The bundled body is compared FIRST, so a bundle that happens to equal a catalogued body still
// reads as current; the catalog is consulted by file name, so a body shipped under another name is
// never a prior for this one.
export const classifyDeployedScript = (deployedBytes, file, bundleBytes, priors = SCRIPT_PRIORS) => {
  const digest = digestOf(deployedBytes);
  if (digest === digestOf(bundleBytes)) return 'current';
  return priors.some((row) => row.file === file && row.digest === digest) ? 'prior' : 'custom';
};
