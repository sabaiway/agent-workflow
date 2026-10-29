// project-root.mjs — the one project-root finder of the script family (spec script-family).
//
// A module file sits in <root>/scripts/agent-workflow/<module>/ in a deployment and in
// <pkg>/references/scripts/<module>/ in the canon, so the root is the directory three levels above the
// module file's own directory in both. Dependency-free, Node >= 22. No side effects on import.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `moduleUrl` is a module's import.meta.url (a URL or its href).
export const findProjectRoot = (moduleUrl) => resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
