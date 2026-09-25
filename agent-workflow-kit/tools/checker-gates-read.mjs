// checker-gates-read.mjs — the READ-ONLY leaf of the kit-owned checker gates: the frozen candidate
// table, the precondition probes, the declaration read and the one derivation the declare verb and
// the profile-gap detector both call. Governing contract: docs/ai/specs/kit/tier/checker-gates/
// (part checker-gates-read). No CLI (refuseDirectRun); nothing here writes.
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CHECKER_CLAIM, classifyCheckerClaim, dqUnsafePath } from './checker-claim.mjs';
import { refuseDirectRun } from './direct-run.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { GATES_REL, KIT_CHECKER_CLAIMS, coverageDeclarationDefects, validateDeclaration } from './gates-declaration.mjs';
import { escapeForLine, isLineUnsafe } from './source-size-core.mjs';

const DEPLOYMENT_CHAIN = ['.', 'docs', 'docs/ai'];
const NOT_APPLICABLE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const OK = 'ok';
const ABSENT = 'absent';
const FOREIGN = 'foreign';
const SYMLINK_CLASS = 'symlink';
const GIT_DIR = Object.freeze({ rel: '.git', kinds: ['directory', 'file'], what: 'a directory or a regular gitfile' });
const STORE_ROOT = Object.freeze({ rel: 'docs/ai/specs/index.md', kinds: ['file'], what: 'a regular file' });
const COVERAGE_SCOPE = Object.freeze({ rel: 'docs/ai/spec-coverage.json', kinds: ['file'], what: 'a regular file' });

export const CANDIDATE_STATES = Object.freeze({
  declared: 'declared',
  idTaken: 'id-taken',
  probeUnreadable: 'probe-unreadable',
  notApplicable: 'not-applicable',
  offered: 'offered',
  withheld: 'withheld',
});

const lstatOf = (deps) => deps.lstatSync ?? lstatSync;

export const isDeployed = (root, deps) => {
  try {
    return DEPLOYMENT_CHAIN.every((path, index) => {
      const stat = lstatOf(deps)(resolve(root, path));
      if (stat.isSymbolicLink()) return false;
      return index < DEPLOYMENT_CHAIN.length - 1 || stat.isDirectory();
    });
  } catch {
    return false;
  }
};

const kindAt = (path, lstat) => {
  try {
    const stat = lstat(path);
    if (stat.isSymbolicLink()) return { kind: SYMLINK_CLASS };
    if (stat.isDirectory()) return { kind: 'directory' };
    return { kind: stat.isFile() ? 'file' : 'other' };
  } catch (error) {
    if (NOT_APPLICABLE_CODES.has(error?.code)) return { kind: ABSENT };
    return { unreadable: String(error?.code ?? error?.message ?? error) };
  }
};

// A probe answers {} when its checker runs by design over the tree, else the state and its detail.
const requiring = (...requirements) => (root, deps) => {
  const judged = requirements.map((requirement) => ({ requirement, ...kindAt(resolve(root, requirement.rel), lstatOf(deps)) }));
  const unreadable = judged.find((item) => item.unreadable !== undefined);
  if (unreadable) {
    return { state: CANDIDATE_STATES.probeUnreadable, detail: `${unreadable.requirement.rel}: ${unreadable.unreadable}` };
  }
  const missing = judged.find(({ requirement, kind }) => !requirement.kinds.includes(kind));
  if (missing) return { state: CANDIDATE_STATES.notApplicable, detail: `${missing.requirement.rel} is not ${missing.requirement.what}` };
  return {};
};

const candidate = (id, title, probe) => Object.freeze({ id, title, probe });

export const CHECKER_GATE_CANDIDATES = Object.freeze([
  candidate('control-bytes', 'No raw control byte in the work tree', requiring(GIT_DIR)),
  candidate('plan-shape', 'Plans in flight keep the structural planning shape', requiring()),
  candidate('spec-check', 'Feature-spec store structure — the whole store', requiring(STORE_ROOT)),
  candidate(
    'spec-coverage',
    'No work without a specification — every in-scope tool is governed by a contract, or named in the shrink-only debt',
    requiring(COVERAGE_SCOPE, STORE_ROOT),
  ),
]);

const claimOf = (id) => KIT_CHECKER_CLAIMS.find((claim) => claim.id === id);

const refusal = (name, detail) => (detail === undefined ? { refusal: name } : { refusal: name, detail: String(detail) });

const attempt = (read) => {
  try {
    return { value: read() };
  } catch (error) {
    return { error };
  }
};

const readDeclaration = (root, deps) => {
  const read = readRegularFileNoFollow(resolve(root, GATES_REL), deps);
  if (read.outcome === ABSENT) return refusal('declaration-absent');
  if (read.outcome === FOREIGN) {
    return read.className === SYMLINK_CLASS ? refusal('declaration-symlink') : refusal('declaration-not-regular', read.className);
  }
  if (read.outcome !== OK) return refusal('declaration-unreadable', read.code);
  const parsed = attempt(() => JSON.parse(read.content));
  if (parsed.error) return refusal('declaration-malformed', parsed.error.message);
  const validated = attempt(() => validateDeclaration(parsed.value));
  if (validated.error) return refusal('declaration-invalid', validated.error.message);
  const gates = validated.value;
  const defects = coverageDeclarationDefects(gates, root);
  if (defects.length > 0) return refusal('declaration-coverage-defect', defects[0].message);
  return { declaration: Object.hasOwn(parsed.value, '_README') ? { readme: parsed.value._README, gates } : { gates } };
};

const claimState = ({ id, screen }, gates, root) => {
  const claimed = gates.some((gate) => {
    const claim = classifyCheckerClaim(screen, gate.cmd, root);
    return claim === CHECKER_CLAIM.CANONICAL || claim === CHECKER_CLAIM.ELSEWHERE;
  });
  if (claimed) return { state: CANDIDATE_STATES.declared };
  const taken = gates.find((gate) => gate.id === id);
  return taken ? { state: CANDIDATE_STATES.idTaken, detail: taken.cmd } : {};
};

const toolPathOf = ({ basename, screen }, deps) => join(deps.kitToolsDir ?? dirname(screen.canonical), basename);
const isUnrenderable = (path) => dqUnsafePath(path) || isLineUnsafe(path);

const judgeCandidate = ({ id, title, probe }, rendered, gates, root, deps) => {
  const claimed = claimState(claimOf(id), gates, root);
  if (claimed.state) return claimed;
  const probed = probe(root, deps);
  if (probed.state) return probed;
  if (rendered.unrenderable) return { state: CANDIDATE_STATES.withheld };
  return { state: CANDIDATE_STATES.offered, entry: JSON.stringify({ id, title, cmd: rendered.cmd }) };
};

const shapeOf = (id, { state, entry = null, detail }) => (detail === undefined ? { id, state, entry } : { id, state, entry, detail });

export const judgeCheckerGates = (root, deps = {}) => {
  if (!isDeployed(root, deps)) return refusal('no-deployment');
  const loaded = readDeclaration(root, deps);
  if (loaded.refusal) return loaded;
  const rendered = CHECKER_GATE_CANDIDATES.map(({ id }) => {
    const claim = claimOf(id);
    const path = toolPathOf(claim, deps);
    return isUnrenderable(path) ? { unrenderable: path } : { cmd: `node "${path}" ${claim.tail}` };
  });
  const judged = CHECKER_GATE_CANDIDATES.map((entry, index) => judgeCandidate(entry, rendered[index], loaded.declaration.gates, root, deps));
  const firstWithheld = judged.findIndex(({ state }) => state === CANDIDATE_STATES.withheld);
  const named = (item, index) => (index === firstWithheld
    ? { ...item, detail: `the kit path cannot be rendered into a command: ${escapeForLine(rendered[index].unrenderable)}` }
    : item);
  return {
    declaration: loaded.declaration,
    candidates: CHECKER_GATE_CANDIDATES.map(({ id }, index) => shapeOf(id, named(judged[index], index))),
  };
};

refuseDirectRun(import.meta.url);
