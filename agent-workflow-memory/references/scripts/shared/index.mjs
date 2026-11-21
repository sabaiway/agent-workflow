// The shared module's one door (spec script-family).
export { ADR_LOG, ADR_STORE, AGENTS_FILE, AGENTS_SKILLS, CHANGELOG, CHANGELOG_CARRY, CHANGELOG_LEGACY, CLAUDE_FILE, CONDENSED_INDEX, DECISIONS, DECISIONS_ARCHIVE, DECISIONS_ARCHIVE_EARLY, DOCS, DOCS_TREE, GATES, HISTORY, INDEX, ISSUES_RESOLVED, KNOWN_ISSUES, LOCAL_HOOK, MEMORY_STAMP, PACKAGE_JSON, PRE_COMMIT, RECENT, SCRIPTS, WORKFLOW_STAMP } from './locations.mjs';
export { tokenizeMarkdown, findParagraphBreak, fail } from './markdown-blocks.mjs';
export { findProjectRoot } from './project-root.mjs';
export { composeRedBlock, composeUsageRefusal, guardChecker } from './verdict-block.mjs';
