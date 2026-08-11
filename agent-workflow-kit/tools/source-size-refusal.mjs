// source-size-refusal.mjs — how the source-size practice STOPS, and what every stop must name. The
// leaf every other half reads, so a refusal raised deep in the scope walk carries the same contract
// as one raised by the config reader:
//   • exit 2 — the INPUTS are unusable (usage, a malformed config, a failed enumeration); the
//     practice could not judge anything, and no step it could name would change that.
//   • exit 1 — the practice REFUSED: a violation, a stale record, a file it cannot verify, or a
//     declared state the reader must move on (an absent or unminted config). Every one of these
//     carries a step the reader can perform.
//   • every refusal names the config of the project it ACTUALLY judged, absolute: under a foreign or
//     relative --cwd a repo-relative name points at whatever directory the reader happens to be in.
//
// Dependency-free, Node >= 22. No side effects on import.

import { resolve } from 'node:path';

export const SOURCE_SIZE_CONFIG_REL = 'docs/ai/source-size.json';

export const configPathFor = (cwd) => resolve(cwd, 'docs', 'ai', 'source-size.json');

export const SOURCE_SIZE_STOP = 'SOURCE_SIZE_STOP';

const stopWith = (exitCode) => (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { code: SOURCE_SIZE_STOP, exitCode });

export const configFail = stopWith(2);
export const scopeFail = stopWith(1);
