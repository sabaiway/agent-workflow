import { composeCheckerBlock } from '../checker-block/index.mjs';
import { resolveKitDoc } from '../advisor-matrix.mjs';

export const CHECKER_NAME = 'doc-parity';
const DRIFT_REMEDY = 'update each doc above in the same edit as the code it binds, then re-run';

const structureLine = (structure) =>
  `  ${structure.ok ? '✓' : '✗'} ${structure.constant} → ${structure.files[0].rel}${structure.ok ? '' : ` — ${structure.files[0].reason}`}`;

export const formatHuman = (results, structure) => {
  const lines = ['doc-parity — code constants ⟷ references/modes/*.md contract (read-only, BUGFREE-3)'];
  for (const r of results) {
    for (const f of r.files) {
      lines.push(`  ${f.ok ? '✓' : '✗'} ${r.constant} → ${f.rel}${f.ok ? '' : ` — ${f.reason}`}`);
    }
  }
  lines.push(structureLine(structure));
  const failed = results.flatMap((r) => r.files.filter((f) => !f.ok).map((f) => `${r.constant} @ ${f.rel}`));
  // The summary verdict derives from BOTH halves. A PASS token computed from the bindings alone read
  // as a green report while the structure check below it said FAIL — the one surface that lied.
  const green = failed.length === 0 && structure.ok;
  lines.push(`  check: ${green ? 'PASS' : 'FAIL'} — ${failed.length === 0 ? `${results.length} binding(s) consistent` : `${failed.length} drifted binding(s): ${failed.join('; ')}`}, structure ${structure.ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
};

export const formatCheckPass = (results) =>
  `doc-parity check: PASS — ${results.length} binding(s) consistent; the advisor matrix structure corresponds`;

const driftFinding = (constant, { rel, reason }) => ({
  path: resolveKitDoc(rel), text: `${constant} — ${reason}`,
});

export const composeDriftBlock = ({ results, structure, cwd }) => {
  const drifted = results.filter(({ ok }) => !ok);
  const classes = [];
  if (drifted.length) classes.push(`${drifted.length} drifted binding(s)`);
  const findings = drifted.flatMap(({ constant, files }) =>
    files.filter(({ ok }) => !ok).map((file) => driftFinding(constant, file)));
  if (!structure.ok) {
    classes.push('the advisor matrix structure drifted');
    findings.push(driftFinding(structure.constant, structure.files[0]));
  }
  return composeCheckerBlock({
    name: CHECKER_NAME, root: cwd, failed: classes.join('; '), findings, remedies: [DRIFT_REMEDY],
  });
};
