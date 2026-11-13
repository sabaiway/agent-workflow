import { composeCheckerBlock } from '../checker-block/index.mjs';
import { COVERAGE_DECLARED_REL } from '../coverage-declared/index.mjs';

export const CHECKER_NAME = 'coverage-check';
const ZERO = 0;
const CLASS_SEPARATOR = '; ';
const WITHHELD_PREFIX = `${CHECKER_NAME}: NO VERDICT — `;
const RED_NO_CONTEXT = `${WITHHELD_PREFIX}no final-run attestation context — a verdict is issued only inside the run that owns the lcov (run-gates.mjs --final); findings above are informational`;
const CLASS_TEXTS = [
  {
    verdict: () => 'the declared list is unusable',
    remedy: `fix what each finding above names in ${COVERAGE_DECLARED_REL}, then re-run`,
  },
  {
    verdict: () => 'the lcov file is unusable',
    remedy: 'let the declared unit-tests gate write the lcov file as a regular file this run can read, then re-run',
  },
  {
    verdict: (count) => `${count} changed Node line(s) or file(s) uncovered`,
    remedy: 'cover each changed line and file above with a test that executes it, then re-run',
  },
  {
    verdict: (count) => `${count} red-proof obligation(s) unmet`,
    remedy: 're-observe each red proof above on its pre-fix tree, or restore its bound test until it runs green N/N',
  },
  {
    verdict: () => 'the evidence store is unusable',
    remedy: 'repair or move aside the evidence store above, then re-run',
  },
  {
    verdict: () => 'the attestation context was refused',
    remedy: 're-run run-gates.mjs --final on a tree no gate changes',
  },
];

export const buildDeclaredFindings = ({ configFailure, failures }) => configFailure
  ? [{ path: COVERAGE_DECLARED_REL, text: configFailure }] : failures;

export const buildLcovFindings = (failure) => failure ? [{
  path: failure.path,
  text: failure.error
    ? `status could not be read (${failure.error.code ?? failure.error.message})`
    : 'not a regular file (a symlink/device is never read — fail closed)',
}] : [];

export const buildUncoveredFindings = (failures) => failures.map(({ path, line }) => ({
  path,
  ...(line === undefined ? {} : { line }),
  text: line === undefined ? 'absent from coverage — the suite never executed this changed file'
    : 'changed line not executed by the suite',
}));

export const buildRedProofFindings = (failures) => failures.map(({ file, testId, reason }) => ({
  path: file, text: `${testId}: ${reason}`,
}));

export const buildEvidenceFindings = (path, failure) => failure ? [{ path, text: failure }] : [];

export const buildAttestationFindings = (root, refusal) => refusal ? [{ path: root, text: refusal }] : [];

export const isRed = (classes) => classes.some((findings) => findings.length > ZERO);

export const composeCoverageBlock = ({ root, classes, after, withoutContext = false }) => {
  if (!isRed(classes)) return after;
  const met = classes.map((findings, index) => ({ findings, ...CLASS_TEXTS[index] }))
    .filter(({ findings }) => findings.length > ZERO);
  return composeCheckerBlock({
    name: CHECKER_NAME,
    root,
    failed: met.map(({ findings, verdict }) => verdict(findings.length)).join(CLASS_SEPARATOR),
    findings: met.flatMap(({ findings }) => findings),
    remedies: met.map(({ remedy }) => remedy),
    after: after.map((line) => withoutContext && line.startsWith(WITHHELD_PREFIX) ? RED_NO_CONTEXT : line),
  });
};
