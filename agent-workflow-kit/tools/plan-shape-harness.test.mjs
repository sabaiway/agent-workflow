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

export const DEFAULT_ROW = 'R1 | modify | docs/readme.md | keep the document current | n/a | docs/readme.md:1';
export const ledgerOf = (row, total = 'total: 0 → 0 lines') => `${row}\n${total}`;
export const planWith = ({
  title = '# Plan: example',
  goal = '- Spec: docs/ai/specs/example.md',
  ledger = ledgerOf(DEFAULT_ROW),
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
