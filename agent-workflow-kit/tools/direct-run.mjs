// direct-run.mjs — the ONE direct-invocation predicate for kit modules, plus the EXPLICIT registry of
// library-only modules and the refusal they print when someone runs one as a command.
//
// Two facts this leaf owns:
//
//   1. WAS this module the process entry point? Compared by REAL path, not lexically. ESM resolves a
//      symlinked entry point to its target, so `import.meta.url === pathToFileURL(process.argv[1]).href`
//      is FALSE whenever a tool is invoked through a link — a CLI whose gate reads that way exits 0
//      having run nothing, which reads as PASS. The realpath compare was fixed once inside the
//      source-size writer; this module is that fix extracted, so every consumer shares it (the
//      THE-LEXICAL-DIRECT-RUN-GUARD class stays closed in one place instead of per file).
//
//   2. WHICH modules have no CLI at all. A library-only module invoked directly today runs its
//      top-level code, prints nothing, and exits 0 — indistinguishable from a tool that worked. The
//      registry below turns that silence into a one-line pointer at the command that DOES the thing,
//      and a non-zero exit.
//
// The registry is EXPLICIT, never a repo-wide heuristic (D6). Its membership rule — the one the
// completeness test enforces — is REACHABILITY BY NAME: a module a mode doc names is a module an
// agent or a user can try to run, and it is exactly those that need a pointer. A library module no
// document names is unreachable by name and stays out.
//
// A pure leaf: it imports NOTHING from tools/ (the read-graph purity walk depends on that) and has no
// side effect on import.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

// The usage exit code of the family's CLIs — invoking a library module is a usage error, not a
// precondition failure.
export const DIRECT_RUN_USAGE_EXIT = 2;

// Compared by REAL path (see (1) above). Exported as a test seam: the unresolvable arm cannot be
// reached through a real invocation, where an existing entry point is a precondition.
export const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

// isDirectRun(import.meta.url) → was THIS module the entry point of the current process?
export const isDirectRun = (moduleUrl, argv1 = process.argv[1]) =>
  Boolean(argv1) && sameFile(fileURLToPath(moduleUrl), argv1);

// The registry: library-only module → the command that does what someone reaching for it wants. The
// value is a user-facing command token of the kit's own catalog (commands.mjs), pinned by the test —
// never a raw node invocation, which would just move the confusion one file over.
export const LIBRARY_ONLY_MODULES = Object.freeze({
  // Named by references/modes/upgrade.md as the source of truth for the _README refresh decision; the
  // command that APPLIES that decision is the ensure CLI, and the one that edits the config by intent
  // is set-recipe.
  'orchestration-config.mjs': '/agent-workflow-kit set-recipe',
  // Named by references/modes/mcp.md as the read half the advisor and uninstall ask. It only ever
  // REPORTS; the command that acts on what it reports is the mode itself.
  'mcp-registration.mjs': '/agent-workflow-kit mcp',
  // Named by references/modes/set-recipe.md as the activity/slot registry; the command that shows
  // the recipes it defines, resolved for this environment, is the recipes advisor.
  'carriers.mjs': '/agent-workflow-kit recipes',
  // The READ core of the subagent-vehicle surface: it sits one name away from the writer
  // references/modes/agents.md DOES name, and reaching for it is reaching for the agents mode.
  'cheap-agents-read.mjs': '/agent-workflow-kit agents',
  'review-roster.mjs': '/agent-workflow-kit recipes',
  'review-roster-resolve.mjs': '/agent-workflow-kit recipes',
  'set-recipe-roster.mjs': '/agent-workflow-kit set-recipe',
});

// The frozen refusal line. One line, names the module, names the command.
export const libraryOnlyLine = (name) => {
  const command = LIBRARY_ONLY_MODULES[name];
  if (command === undefined) {
    throw new Error(`[agent-workflow-kit] ${name} is not in LIBRARY_ONLY_MODULES — register it before guarding it`);
  }
  return `${name}: library module — no CLI; use ${command}`;
};

// refuseDirectRun(import.meta.url) — the guard a library-only module ends with. A no-op when imported
// (the overwhelmingly common case); on a DIRECT run it prints the pointer and sets a non-zero exit
// code. `process.exitCode` rather than `process.exit`: nothing else is pending on a direct run, and a
// hard exit inside module evaluation would be a side effect of import if the predicate ever misfired.
export const refuseDirectRun = (moduleUrl, deps = {}) => {
  if (!isDirectRun(moduleUrl, deps.argv1 ?? process.argv[1])) return 0;
  (deps.errlog ?? console.error)(libraryOnlyLine(basename(fileURLToPath(moduleUrl))));
  (deps.setExitCode ?? ((code) => { process.exitCode = code; }))(DIRECT_RUN_USAGE_EXIT);
  return DIRECT_RUN_USAGE_EXIT;
};
