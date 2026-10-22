// index.mjs — the one door into distribution-files/: what ensure-configs.mjs and ensure-specs.mjs
// import, each the very export of the leaf that owns it. No kit module outside this directory
// imports a leaf directly.

export { keptAsidePath, replaceBlock, runReplace } from './replace-set.mjs';
export { SCRIPT_CHANNEL, ensureScripts } from './scripts.mjs';
