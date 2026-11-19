import { composeCheckerBlock } from '../checker-block/index.mjs';

export const CHECKER_NAME = 'release-scan';
export const UNEXPECTED_REMEDY = 'fix the cause the stack below names, then re-run';
const TARGET_REMEDY = 'fix or drop each mis-aimed target above as its finding says, then re-run';
const SCAN_REMEDY = 'remove each attribution, reviewer identity, and hardcoded version claim above, then re-run';

export const composeScanBlock = ({ cwd, misaimed, findings, after }) => {
  const classes = [];
  const remedies = [];
  if (misaimed.length) {
    classes.push(`${misaimed.length} mis-aimed target(s)`);
    remedies.push(TARGET_REMEDY);
  }
  if (findings.length) {
    classes.push(`${findings.length} finding(s)`);
    remedies.push(SCAN_REMEDY);
  }
  return composeCheckerBlock({
    name: CHECKER_NAME,
    root: cwd,
    failed: classes.join('; '),
    findings: [
      ...misaimed.map(({ path, status, remedy }) => ({ path, text: `${status} — ${remedy}` })),
      ...findings.map(({ file, line, kind, detail }) => ({ path: file, line, text: `${kind} — ${detail}` })),
    ],
    remedies,
    after,
  });
};
