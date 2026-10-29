// node-evidence.mjs — does Node PROVABLY run in this project tree? Contract: docs/ai/specs/kit/node-evidence.md.
// Pure over an injectable lstat; no writes, no side effects on import. Dependency-free, Node >= 22.

import { lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_FOLDER_ROOT } from './source-size-config.mjs';

export const NODE_EVIDENCE = Object.freeze({
  PACKAGE_JSON: 'package-json',
  DEPLOYED_SCRIPTS: 'deployed-node-scripts',
  NONE: 'none',
  UNREADABLE: 'unreadable',
});

export const PACKAGE_JSON_REL = 'package.json';
export const SCRIPTS_DIR = 'scripts';
export const KIT_SCRIPTS_DIR = KIT_FOLDER_ROOT;

// The kit's one door to the script family: the mirrored manifest's deployed entries, each with its
// manifest path, module and seed flag, its deployed path in the kit folder and its bundled path in this
// kit. A manifest the reader refuses fails this module's import with the reader's message.
export const DEPLOYED_SCRIPTS = Object.freeze(readFamily().filter(({ role }) => role === 'deployed').map(({ path, module, seed }) =>
  Object.freeze({ path, module, seed, deployed: `${KIT_SCRIPTS_DIR}/${path}`, bundled: `references/scripts/${path}` })));
export const INSTALLER_REL = DEPLOYED_SCRIPTS.find(({ module }) => module === 'git-hooks').deployed;

// The nine flat runnable names probed before the kit folder (frozen, so a flat deployment keeps its
// evidence), then the deployed manifest paths, sorted — each relative to scripts/.
const FLAT_SCRIPTS = [
  'archive-caps.mjs',
  'archive-changelog.mjs',
  'archive-decisions.mjs',
  'archive-issues.mjs',
  'check-docs-size.mjs',
  'install-git-hooks.mjs',
  'markdown-blocks.mjs',
  'migrate-gates.mjs',
  'spec-schema.mjs',
];
const KIT_UNDER_SCRIPTS = posix.relative(SCRIPTS_DIR, KIT_SCRIPTS_DIR);
export const NODE_EVIDENCE_SCRIPTS = Object.freeze([
  ...FLAT_SCRIPTS,
  ...DEPLOYED_SCRIPTS.map(({ path }) => path).sort().map((path) => `${KIT_UNDER_SCRIPTS}/${path}`),
]);

export const NODE_EVIDENCE_PROBES = Object.freeze([PACKAGE_JSON_REL, ...NODE_EVIDENCE_SCRIPTS.map((name) => `${SCRIPTS_DIR}/${name}`)]);

const ENOENT = 'ENOENT';
const kindOf = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : st.isFile() ? 'a regular file' : 'not a regular file');

const answer = (state, evidence, wrongKind, extra = {}) =>
  Object.freeze({ state, evidence, probed: NODE_EVIDENCE_PROBES, wrongKind: Object.freeze(wrongKind), ...extra });

// probeNodeEvidence(cwd, lstat) -> { state, evidence, probed, wrongKind, error? }: the first regular file
// among the probes answers; a probe failing with anything but ENOENT answers unreadable at once; a path of
// the wrong node kind is not evidence — it is recorded in `wrongKind` and the walk continues. lstat does
// not follow the LEAF but walks THROUGH a symlinked folder, whose files are not this tree's — so scripts/,
// the kit folder and each module folder are proven plain, once each, before any script beneath counts.
export const probeNodeEvidence = (cwd, lstat = lstatSync) => {
  const wrongKind = [];
  const folders = new Map();
  const plainFolder = (rel) => {
    if (!folders.has(rel)) folders.set(rel, probeKind(rel, 'dir') === 'dir');
    return folders.get(rel);
  };
  const foldersOf = (rel) => rel.split('/').slice(1, -1).map((_, at, parts) => [SCRIPTS_DIR, ...parts.slice(0, at + 1)].join('/'));
  const probeKind = (rel, wanted) => {
    let st;
    try {
      st = lstat(join(cwd, rel));
    } catch (err) {
      if (err && err.code === ENOENT) return 'absent';
      throw Object.assign(err, { probedRel: rel });
    }
    if (wanted === 'dir' ? st.isDirectory() && !st.isSymbolicLink() : st.isFile()) return wanted;
    wrongKind.push(`${rel} is ${kindOf(st)}`);
    return 'wrong-kind';
  };
  try {
    if (probeKind(PACKAGE_JSON_REL, 'file') === 'file') return answer(NODE_EVIDENCE.PACKAGE_JSON, PACKAGE_JSON_REL, wrongKind);
    if (plainFolder(SCRIPTS_DIR)) {
      for (const rel of NODE_EVIDENCE_PROBES.slice(1)) {
        if (foldersOf(rel).every(plainFolder) && probeKind(rel, 'file') === 'file') return answer(NODE_EVIDENCE.DEPLOYED_SCRIPTS, rel, wrongKind);
      }
    }
  } catch (err) {
    return answer(NODE_EVIDENCE.UNREADABLE, null, wrongKind, { error: `${err.code || err.message || 'lstat failed'} on ${err.probedRel}` });
  }
  return answer(NODE_EVIDENCE.NONE, null, wrongKind);
};

export const hasNodeEvidence = (probe) => probe.state === NODE_EVIDENCE.PACKAGE_JSON || probe.state === NODE_EVIDENCE.DEPLOYED_SCRIPTS;

// The sentence a skip line carries: every probe checked, and what of the wrong kind sat at any of them.
export const describeNodeProbes = (probe = null) => {
  const probes = `${PACKAGE_JSON_REL} and the kit-seeded ${SCRIPTS_DIR}/ files (${NODE_EVIDENCE_SCRIPTS.join(', ')})`;
  const wrong = probe?.wrongKind?.length ? ` — not evidence: ${probe.wrongKind.join('; ')}` : '';
  return `${probes}${wrong}`;
};
