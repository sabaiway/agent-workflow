import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripGitLocationEnv } from '../git-env.mjs';
import { FAULT_POINTS } from './record.mjs';
import { faultEnvironment, readFaultMarks } from './fault-harness.test.mjs';
import { KIT_OVERRIDE, REPOSITORY_ROOT } from './run-harness.test.mjs';

const KIT_PACKAGE_PREFIX = 'agent-workflow-kit/';
const SUCCESS_CODE = 0;

export const runImportCensus = async ({ record, root = REPOSITORY_ROOT }) => {
  const problems = [];
  const environment = Object.fromEntries(Object.entries(stripGitLocationEnv(process.env))
    .filter(([key]) => !KIT_OVERRIDE.test(key) && key !== 'NODE_TEST_CONTEXT'));
  for (const { path, commandLines } of record.files) {
    if (!path.startsWith(KIT_PACKAGE_PREFIX) || !commandLines?.length) continue;
    for (const faultPoint of FAULT_POINTS) {
      const directory = mkdtempSync(join(tmpdir(), 'checker-import-'));
      try {
        const entry = join(directory, 'entry.mjs');
        const marks = join(directory, 'marks');
        const target = pathToFileURL(resolve(root, path)).href;
        writeFileSync(entry, `import ${JSON.stringify(target)};\n`);
        const result = spawnSync(process.execPath, [entry], {
          env: { ...environment, ...faultEnvironment({ point: faultPoint, entry, marks }) },
        });
        if (readFaultMarks(marks).includes(entry)) {
          problems.push({ problem: 'fault-at-import', path, faultPoint });
        } else if (result.error || result.status !== SUCCESS_CODE) {
          problems.push({ problem: 'import-failed', path, faultPoint });
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  return problems;
};
