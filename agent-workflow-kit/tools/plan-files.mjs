// plan-files.mjs — the in-flight-plan file convention (FLOW-READ-GRAPH-PURITY, flow Plan 4
// Phase 2). A LEAF: Node built-ins only, read-only fs (one injectable readdir), no CLI, no side
// effects on import — extracted so the procedures read surface lists plans without importing
// review-state (whose graph reaches the flow-store write API). review-state re-exports everything
// here except readPlanEntries, so every existing consumer keeps its import site. Dependency-free, Node >= 22.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PLANS_REL = 'docs/plans';

// The plans directory's entries as plan-shape-cli and the tier guide read them: absent is an empty
// list, any other read error is thrown with its code.
export const readPlanEntries = (cwd) => {
  try {
    return readdirSync(join(cwd, PLANS_REL), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`${PLANS_REL} could not be read (${error?.code ?? 'fs error'})`);
  }
};

// Scratch by the naming convention: EXECUTE-/FEEDBACK-/TASK- prefixes, or a name carrying PROMPT/prompt/
// handoff. queue.md is the series index, never a plan.
export const isScratchPlanName = (name) =>
  name === 'queue.md' ||
  name.startsWith('EXECUTE-') ||
  name.startsWith('FEEDBACK-') ||
  name.startsWith('TASK-') ||
  name.includes('PROMPT') ||
  name.includes('prompt') ||
  name.includes('handoff');

// The in-flight plan files: top-level docs/plans/*.md minus queue.md minus scratch. [] when the
// directory is absent (no plans → nothing in flight). STRING-typed for every consumer.
export const plansInFlight = (cwd, readdir = readdirSync) => {
  let entries;
  try {
    entries = readdir(join(cwd, PLANS_REL), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !isScratchPlanName(e.name))
    .map((e) => e.name)
    .sort();
};
