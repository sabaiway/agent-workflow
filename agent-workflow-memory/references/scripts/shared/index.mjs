// The shared module's one door (spec script-family).
export { tokenizeMarkdown, findParagraphBreak, fail } from './markdown-blocks.mjs';
export { findProjectRoot } from './project-root.mjs';
export { composeRedBlock, composeUsageRefusal, guardChecker } from './verdict-block.mjs';
