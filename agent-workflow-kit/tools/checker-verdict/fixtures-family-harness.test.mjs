import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BINDINGS } from '../doc-parity.mjs';
import { REPOSITORY_ROOT } from './run-harness.test.mjs';

const SCRIPT_FAMILY_PATH = 'agent-workflow-memory/references/scripts';
const SCRIPT_FAMILY_SOURCE = join(REPOSITORY_ROOT, SCRIPT_FAMILY_PATH);
const DOCS_SIZE_PATH = `${SCRIPT_FAMILY_PATH}/docs-size/check-docs-size.mjs`;
const KIT_PACKAGE_PATH = 'agent-workflow-kit';
const BOUND_DOCUMENT_PATH = 'references/modes/receipt-deadline.md';
const FIXTURE_DATE = '2000-01-01';
const READER_PATH = 'tools/path-inventory.mjs';
const READER_SUCCESS_LINE = 'export const EXIT_OK = 0;';
const READER_FAILURE_LINE = 'export const EXIT_OK = 1;';

export const copyPackageFolders = (root, project, packagePath, folders) => {
  for (const folder of folders) {
    cpSync(join(root, packagePath, folder), join(project, packagePath, folder), {
      recursive: true,
      filter: (source) => !basename(source).includes('.test.') || !statSync(source).isFile(),
    });
  }
};

const buildAbsentBoundToken = (project) => {
  copyPackageFolders(REPOSITORY_ROOT, project, KIT_PACKAGE_PATH, ['tools', 'references']);
  const bindings = BINDINGS.filter((binding) => binding.files.includes(BOUND_DOCUMENT_PATH));
  if (bindings.length !== 1) {
    throw new Error(`Expected one doc-parity binding for ${BOUND_DOCUMENT_PATH}; found ${bindings.length}`);
  }
  const [binding] = bindings;
  const destination = join(project, KIT_PACKAGE_PATH, BOUND_DOCUMENT_PATH);
  const text = readFileSync(destination, 'utf8');
  if (!text.includes(binding.token)) {
    throw new Error(`Missing doc-parity token in copied ${BOUND_DOCUMENT_PATH}`);
  }
  writeFileSync(destination, text.replaceAll(binding.token, ''));
};

const buildFailingReader = (project) => {
  copyPackageFolders(REPOSITORY_ROOT, project, KIT_PACKAGE_PATH, ['tools']);
  const destination = join(project, KIT_PACKAGE_PATH, READER_PATH);
  const text = readFileSync(destination, 'utf8');
  if (text.split(READER_SUCCESS_LINE).length !== 2) {
    throw new Error(`Expected one "${READER_SUCCESS_LINE}" in copied ${READER_PATH}`);
  }
  writeFileSync(destination, text.replace(READER_SUCCESS_LINE, READER_FAILURE_LINE));
  return { CLAUDE_PROJECT_DIR: project };
};

const createDocument = (body, maxLines = 80) => [
  '---',
  'type: reference',
  `lastUpdated: ${FIXTURE_DATE}`,
  'scope: permanent',
  'staleAfter: never',
  'owner: none',
  `maxLines: ${maxLines}`,
  '---',
  '',
  body,
  '',
].join('\n');

const buildFamilyProject = (project, documentPath, text) => {
  cpSync(SCRIPT_FAMILY_SOURCE, join(project, 'scripts/agent-workflow'), { recursive: true });
  const destination = join(project, documentPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
};

const buildOverCapDocument = (project) => buildFamilyProject(
  project,
  'docs/ai/oversized.md',
  createDocument('# Document over its cap', 1),
);

const buildStaleIndex = (project) => buildFamilyProject(
  project,
  'docs/ai/index.md',
  createDocument('# Outdated navigator'),
);

const buildOverdueChangelog = (project) => buildFamilyProject(
  project,
  'docs/ai/changelog.md',
  createDocument(`# Changelog\n\n## ${FIXTURE_DATE} \u2014 Unarchived entry\n\nCompleted work.`),
);

const buildOverdueIssue = (project) => buildFamilyProject(
  project,
  'docs/ai/known_issues.md',
  createDocument(`# Known issues\n\n### Issue-001 \u2014 Fixed issue\n\n- **Resolved:** ${FIXTURE_DATE}`),
);

const buildLegacyDecisions = (project) => buildFamilyProject(
  project,
  'docs/ai/history/decisions-archive.md',
  createDocument(`# Legacy decisions\n\n## AD-001 \u2014 Archived decision\n\n**Date:** ${FIXTURE_DATE}`),
);

export const FAMILY_FIXTURES = Object.freeze([
  {
    path: DOCS_SIZE_PATH,
    commandArguments: [],
    redCase: 'document-over-cap',
    build: buildOverCapDocument,
  },
  {
    path: DOCS_SIZE_PATH,
    commandArguments: ['--check-index'],
    redCase: 'docs-index-stale',
    build: buildStaleIndex,
  },
  {
    path: `${SCRIPT_FAMILY_PATH}/archives/archive-changelog.mjs`,
    commandArguments: ['--check'],
    redCase: 'changelog-entry-overdue',
    build: buildOverdueChangelog,
  },
  {
    path: `${SCRIPT_FAMILY_PATH}/archives/archive-issues.mjs`,
    commandArguments: ['--check'],
    redCase: 'resolved-issue-overdue',
    build: buildOverdueIssue,
  },
  {
    path: `${SCRIPT_FAMILY_PATH}/archives/archive-decisions.mjs`,
    commandArguments: ['--check'],
    redCase: 'legacy-decisions-monolith',
    build: buildLegacyDecisions,
  },
  {
    path: 'agent-workflow-kit/tools/doc-parity.mjs',
    commandArguments: ['--check'],
    redCase: 'bound-token-absent',
    ownPackage: KIT_PACKAGE_PATH,
    build: buildAbsentBoundToken,
  },
  {
    path: 'agent-workflow-kit/tools/mcp-server.mjs',
    commandArguments: ['--self-check'],
    redCase: 'reader-answers-an-error',
    ownPackage: KIT_PACKAGE_PATH,
    build: buildFailingReader,
  },
]);
