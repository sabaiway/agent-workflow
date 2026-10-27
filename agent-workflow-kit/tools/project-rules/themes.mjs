// The theme registry: pure data and pure derivation. Every surface that names a theme or its files
// reads this list, never a second copy. Contract: docs/ai/specs/kit/project-rules/themes.md.

export const THEMES = Object.freeze([
  Object.freeze({
    name: 'project-layout',
    template: 'references/rules/project-layout.md',
    readWhen: '**Start of every session**',
  }),
]);

export const RECORD_PATH = 'docs/ai/rules/effective/sources.json';

export const themePaths = (name) => Object.freeze({
  kit: `docs/ai/rules/${name}.md`,
  local: `docs/ai/rules/local/${name}.md`,
  effective: `docs/ai/rules/effective/${name}.md`,
  record: RECORD_PATH,
});
