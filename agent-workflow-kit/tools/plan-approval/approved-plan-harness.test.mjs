import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_SCHEMA } from '../../references/scripts/spec-schema/index.mjs';
import { stripGitLocationEnv } from '../git-env.mjs';
import { makeTree, planWith, write } from '../plan-shape-harness.test.mjs';
import { getRevisionHomePath } from '../spec-check-ops.mjs';

export const APPROVED_PLAN_BODY = planWith({ goal: 'Spec: not adopted. Keep the guide current.' });

export const SPEC = SPEC_SCHEMA.storePrefix + 'guide.md';
export const FRONTMATTER = `---
type: spec
lastUpdated: 2026-11-24
scope: permanent
staleAfter: 90d
owner: none
`;
export const CONTRACT = `${FRONTMATTER}maxLines: 150
kind: spec
status: draft
revision: 1
---
# Spec: guide

## Contract
- Keep the guide current.

## Scenarios
- S1 the guide is current :: unbound

## Out of scope
- Publishing.

## Module
- docs/readme.md
`;
const SPEC_ROW = `R2 | modify | ${SPEC} | revise the contract | ${SPEC}:1`;
export const contractPlan = (...rows) => planWith({
  goal: `Spec: ${SPEC}`,
  ledger: [SPEC_ROW, ...rows].join('\n'),
});

export const recordApproval = (root, planRel, { essence = 'Keep the guide current.' } = {}) => {
  const scratch = makeTree('plan-approval-essence');
  try {
    const file = join(scratch, 'essence.txt');
    write(scratch, 'essence.txt', essence);
    const env = stripGitLocationEnv(process.env);
    delete env.NODE_TEST_CONTEXT;
    const { status, stdout, stderr, error } = spawnSync(process.execPath,
      [join(import.meta.dirname, 'cli.mjs'), 'record', planRel, '--essence-file', file],
      { cwd: root, env, encoding: 'utf8' });
    if (status !== 0 || error) {
      throw Object.assign(new Error(`plan-approval record exited ${status}: ${stderr || error?.message}`), { status, stderr });
    }
    return { stdout, stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const writeApprovedPlan = (root, planRel, { body = APPROVED_PLAN_BODY, essence } = {}) => {
  write(root, planRel, body);
  return recordApproval(root, planRel, { essence });
};

export const writeApprovedContractPlan = (root, planRel) => {
  write(root, SPEC, CONTRACT.replace('status: draft', 'status: live'));
  write(root, getRevisionHomePath(planRel, SPEC), CONTRACT.replace('Keep the guide current.', 'Improve the guide.').replace('revision: 1', 'revision: 2'));
  return writeApprovedPlan(root, planRel, { body: contractPlan() });
};
