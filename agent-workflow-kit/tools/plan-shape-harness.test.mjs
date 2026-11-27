// The shared harness of the plan-shape suites — the plan builder, the finding-code reader and the
// temp-tree writers all three lanes need. It declares NO test of its own; the `.test.mjs` name is
// what keeps it out of the tarball (files[] excludes tools/**/*.test.mjs) and out of the changed-line
// coverage domain. It imports nothing under test, so a suite that reaches for it still LOADS when
// the modules under test are absent — the red proof stays observable.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const makeTree = (prefix) => mkdtempSync(join(tmpdir(), `${prefix}-`));
export const write = (root, path, content = '') => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
export const writeJson = (root, path, value) => write(root, path, `${JSON.stringify(value, null, 2)}\n`);
export const DEFAULT_ROW = 'R1 | modify | docs/readme.md | keep the document current | docs/readme.md:1';
export const LEGACY_ROW = 'R1 | modify | docs/readme.md | keep the document current | n/a | docs/readme.md:1';
export const ledgerOf = (rows) => rows;
export const planWith = ({
  title = '# Plan: example',
  goal = '- Spec: docs/ai/specs/example.md',
  ledger = DEFAULT_ROW,
  verification = '- `node --test` exits 0',
  phases = '',
} = {}) => `${title}

## Goal and boundary
${goal}

## Module ledger
${ledger}

## Verification
${verification}
${phases}
## Phase: Cleanup
- Record it.

## Next steps
- Continue.
`;

export const codes = (result) => result.findings.map((finding) => finding.code);
export const UNREADABLE_PLAN_BYTES = Buffer.from([0xff]);
export const makeOtherPlan = (overrides = {}) => ({
  identity: 'docs/plans/other.md', digest: 'a'.repeat(64), held: true, story: null, paths: [], ...overrides,
});

export const buildStoryEpic = (claim, field = 'owns') => ['---', 'type: epic', 'lastUpdated: 2026-09-10', 'scope: permanent', 'staleAfter: 90d', 'owner: none',
  'maxLines: 60', 'state: open', '---', '# Epic: Ownership', '## Intent', 'Keep ownership visible.',
  '## Value', 'Keep work separate.', '## Non-goals', 'No implementation choices.', '## Acceptance', 'Result line: 2026-09-10',
  '## Specs', 'docs/ai/specs/kit/example.md', '## Stories ledger',
  `- S1 | Boundary | depends-on: none | owns: ${field === 'owns' ? claim : 'none'} | shared: ${field === 'shared' ? claim : 'none'} | state: planned`,
  '## Queue', 'Row ALPHA in Now'].join('\n');
