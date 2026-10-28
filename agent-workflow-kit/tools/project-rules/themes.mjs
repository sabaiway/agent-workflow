// The theme registry: pure data and pure derivation. Every surface that names a theme or its files
// reads this list, never a second copy. Contract: docs/ai/specs/kit/project-rules/themes.md.

const START = '**Start of every session**';
const BEFORE = '**Before any code change**';

const theme = (name, home, readWhen) => Object.freeze({ name, home, template: `references/rules/${name}.md`, readWhen });

// home: 'kit' → the template is the kit's own file; 'engine' → it is the installed engine's.
export const THEMES = Object.freeze([
  theme('project-layout', 'kit', START),
  theme('communication', 'kit', BEFORE),
  theme('story-sessions', 'kit', BEFORE),
  theme('lens', 'engine', BEFORE),
]);

// The line that opens every theme template's body and the kit block's body; a suite pins every copy.
export const PRECEDENCE_LINE = "The kit block of AGENTS.md is the kit's and is rewritten on every upgrade; it and docs/ai/rules/effective/ govern over any copy of kit text elsewhere in this project's files; text of your own goes outside the block, and a change to a kit rule goes in its theme's file under docs/ai/rules/local/.";

export const RECORD_PATH = 'docs/ai/rules/effective/sources.json';

export const themePaths = (name) => Object.freeze({
  kit: `docs/ai/rules/${name}.md`,
  local: `docs/ai/rules/local/${name}.md`,
  effective: `docs/ai/rules/effective/${name}.md`,
  record: RECORD_PATH,
});
