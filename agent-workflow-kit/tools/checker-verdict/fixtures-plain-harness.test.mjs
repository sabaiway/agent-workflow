import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PLAN_PATH = 'docs/plans/fixture.md';
const QUEUE_PATH = 'docs/plans/queue.md';
const SPEC_PATH = 'docs/ai/specs/broken.md';
const SPEC_OPERATION = `modify=${SPEC_PATH}`;
const OPS_PATH = 'docs/plans/spec-ops.list';
const RECEIPTS_PATH = 'receipts.jsonl';
const TOOL_PATH = 'src/tool.mjs';
const ANCHOR_PATH = 'docs/readme.md';
const STRUCTURAL_RED_CASE = 'plan-sections-absent';
const SPEC_RED_CASE = 'spec-contract-absent';
const joinLines = (lines) => lines.join('\n');
const ANCHOR_TEXT = joinLines(['Anchor.']);
const TOOL_TEXT = joinLines(['export const value = 1;']);

const writeFiles = (project, files) => {
  for (const [relativePath, text] of Object.entries(files)) {
    const path = join(project, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
};

const createPlanText = (row) => joinLines([
  '# Plan: Fixture',
  '## Goal and boundary',
  '- Spec: docs/ai/specs/example.md',
  '## Module ledger',
  row,
  'total: 0 \u2192 0 lines',
  '## Verification',
  '- `node --test` exits 0',
  '## Phase: Cleanup',
  '- Record the result.',
  '## Next steps',
  '- Continue.',
]);

const createSpecText = (kind, body) => joinLines([
  '---',
  'type: spec',
  'lastUpdated: 2026-01-01',
  'scope: permanent',
  'staleAfter: 90d',
  'owner: none',
  `maxLines: ${kind === 'index' ? 80 : 150}`,
  `kind: ${kind}`,
  ...(kind === 'spec' ? ['status: draft', 'revision: 1'] : []),
  '---',
  ...body,
]);

const buildStructuralPlan = (project) => writeFiles(project, {
  [PLAN_PATH]: joinLines(['# Plan: Fixture']),
});

const buildUnlandedPlan = (project) => writeFiles(project, {
  [PLAN_PATH]: createPlanText(`R1 | create | docs/new.md | create the document | n/a | ${ANCHOR_PATH}:1`),
  [ANCHOR_PATH]: ANCHOR_TEXT,
});

const buildBrokenSpec = (project) => writeFiles(project, {
  'docs/ai/specs/index.md': createSpecText('index', [
    '# Specs',
    '> Up: [technical_specification.md](../technical_specification.md)',
    '## Children',
    '- [broken](./broken.md)',
  ]),
  [SPEC_PATH]: createSpecText('spec', [
    '# Spec: broken',
    '## Scenarios',
    '- S1 the tool returns :: unbound',
    '## Out of scope',
    '- Other tools.',
    '## Module',
    `- ${TOOL_PATH}`,
  ]),
  [TOOL_PATH]: TOOL_TEXT,
});

const buildSpecRegister = (project) => {
  buildBrokenSpec(project);
  writeFiles(project, { [OPS_PATH]: joinLines([SPEC_OPERATION]) });
};

const buildUncoveredTool = (project) => {
  mkdirSync(join(project, 'docs/ai/specs'), { recursive: true });
  writeFiles(project, {
    'docs/ai/spec-coverage.json': joinLines([
      '{"schema":1,"roots":["src"],"extensions":[".mjs"],"adopted":[]}',
    ]),
    [TOOL_PATH]: TOOL_TEXT,
  });
};

const buildUnrecordedRule = (project) => writeFiles(project, {
  'docs/ai/rules/project-layout.md': joinLines(['# Project layout']),
});

const buildTerminalQueue = (project) => writeFiles(project, {
  [QUEUE_PATH]: joinLines(['## Pending', '- **DONE 2026-01-01 \u2014 FIXTURE-ROW.** Finished.']),
});

const buildDamagedArchive = (project) => writeFiles(project, {
  [QUEUE_PATH]: joinLines(['## Pending']),
  'archive.txt': joinLines(['queue-purge: 1', '']),
});

const buildMissingCloseSection = (project) => writeFiles(project, {
  'docs/ai/handover.md': joinLines(['# Handover']),
});

const buildInvalidManifest = (project) => writeFiles(project, {
  'skill/capability.json': joinLines(['null']),
});

const buildUnprobedVersion = (project) => writeFiles(project, {
  'tools/pin.mjs': joinLines(['const version = "claude 1.2.3";']),
});

const buildMalformedEpic = (project) => writeFiles(project, {
  'docs/ai/epics/FIXTURE.md': joinLines(['# Epic: Fixture']),
});

const buildUnmatchedClaim = (project) => writeFiles(project, {
  [PLAN_PATH]: joinLines(['# Plan: Fixture', '## Verification', '- Existing criterion.']),
  [QUEUE_PATH]: joinLines(['# Queue']),
});

const buildUncoveredRobustness = (project) => writeFiles(project, {
  [PLAN_PATH]: createPlanText(`R1 | modify | ${TOOL_PATH} | preserve the result | 1 | ${ANCHOR_PATH}:1`),
  [ANCHOR_PATH]: ANCHOR_TEXT,
  [TOOL_PATH]: joinLines(['export const outcome = "EEXIST";']),
});

const buildAbsentContract = (project) => writeFiles(project, {
  'dispatch.md': joinLines(['# Dispatch']),
});

const buildAutonomyDrift = (project) => {
  const home = join(project, 'home');
  mkdirSync(home, { recursive: true });
  writeFiles(project, {
    'docs/ai/autonomy.json': joinLines(['{}']),
    '.claude/settings.json': joinLines(['{"sandbox":{"enabled":false}}']),
  });
  return { HOME: home };
};

const buildShrunkenReceipts = (project) => {
  writeFiles(project, { [RECEIPTS_PATH]: joinLines(['{}', '']) });
  return { AW_REVIEW_RECEIPTS: join(project, RECEIPTS_PATH) };
};

export const PLAIN_FIXTURES = Object.freeze([
  {
    path: 'agent-workflow-kit/tools/plan-shape-cli.mjs',
    commandArguments: ['--check', PLAN_PATH],
    redCase: STRUCTURAL_RED_CASE,
    build: buildStructuralPlan,
  },
  {
    path: 'agent-workflow-kit/tools/plan-shape-cli.mjs',
    commandArguments: ['--check', '--in-flight'],
    redCase: STRUCTURAL_RED_CASE,
    build: buildStructuralPlan,
  },
  {
    path: 'agent-workflow-kit/tools/plan-shape-cli.mjs',
    commandArguments: ['--verify', PLAN_PATH],
    redCase: 'plan-create-not-landed',
    build: buildUnlandedPlan,
  },
  {
    path: 'agent-workflow-kit/tools/plan-shape-cli.mjs',
    commandArguments: ['--verify', '--in-flight'],
    redCase: STRUCTURAL_RED_CASE,
    build: buildStructuralPlan,
  },
  {
    path: 'agent-workflow-kit/tools/spec-check-cli.mjs',
    commandArguments: ['--all'],
    redCase: SPEC_RED_CASE,
    build: buildBrokenSpec,
  },
  {
    path: 'agent-workflow-kit/tools/spec-check-cli.mjs',
    commandArguments: ['--op', SPEC_OPERATION],
    redCase: SPEC_RED_CASE,
    build: buildBrokenSpec,
  },
  {
    path: 'agent-workflow-kit/tools/spec-check-cli.mjs',
    commandArguments: ['--ops-file', OPS_PATH],
    redCase: SPEC_RED_CASE,
    build: buildSpecRegister,
  },
  {
    path: 'agent-workflow-kit/tools/spec-coverage-cli.mjs',
    commandArguments: ['--check'],
    redCase: 'tool-without-contract',
    build: buildUncoveredTool,
  },
  {
    path: 'agent-workflow-kit/tools/project-rules/rules-cli.mjs',
    commandArguments: ['--check'],
    redCase: 'rule-without-record',
    build: buildUnrecordedRule,
  },
  {
    path: 'agent-workflow-kit/tools/queue-audit-cli.mjs',
    commandArguments: ['--check', QUEUE_PATH, '--section', '## Pending'],
    redCase: 'terminal-row-still-listed',
    build: buildTerminalQueue,
  },
  {
    path: 'agent-workflow-kit/tools/queue-purge-cli.mjs',
    commandArguments: ['--check', QUEUE_PATH, '--section', '## Pending', '--archive', 'archive.txt'],
    redCase: 'archive-not-intact',
    build: buildDamagedArchive,
  },
  {
    path: 'agent-workflow-kit/tools/session-close-check.mjs',
    commandArguments: ['--check'],
    redCase: 'handover-section-absent',
    build: buildMissingCloseSection,
  },
  {
    path: 'agent-workflow-kit/tools/manifest/validate.mjs',
    commandArguments: ['--strict', 'skill'],
    redCase: 'manifest-root-not-object',
    build: buildInvalidManifest,
  },
  {
    path: 'agent-workflow-kit/tools/release-scan.mjs',
    commandArguments: ['tools'],
    redCase: 'version-pin-without-probe',
    build: buildUnprobedVersion,
  },
  {
    path: 'agent-workflow-kit/tools/epic-shape-cli.mjs',
    commandArguments: ['--check', 'docs/ai/epics/FIXTURE.md'],
    redCase: 'epic-frontmatter-absent',
    build: buildMalformedEpic,
  },
  {
    path: 'agent-workflow-kit/tools/fold-scope-cli.mjs',
    commandArguments: ['--class', 'in-scope', '--claim', 'missing criterion', '--plan', PLAN_PATH, '--queue', QUEUE_PATH],
    redCase: 'claim-not-in-acceptance',
    build: buildUnmatchedClaim,
  },
  {
    path: 'agent-workflow-kit/tools/robustness-brief.mjs',
    commandArguments: ['--plan', PLAN_PATH, '--coverage'],
    redCase: 'robustness-class-untagged',
    build: buildUncoveredRobustness,
  },
  {
    path: 'agent-workflow-kit/tools/dispatch.mjs',
    commandArguments: ['check', 'dispatch.md'],
    redCase: 'dispatch-contract-absent',
    build: buildAbsentContract,
  },
  {
    path: 'agent-workflow-kit/tools/velocity-profile.mjs',
    commandArguments: ['--autonomy', '--check'],
    redCase: 'autonomy-settings-drift',
    build: buildAutonomyDrift,
  },
  {
    path: 'agent-workflow-kit/tools/receipt-deadline.mjs',
    commandArguments: ['--backend', 'codex', '--watermark', '4', '--timeout', '1'],
    redCase: 'receipts-shorter-than-watermark',
    build: buildShrunkenReceipts,
  },
  {
    path: 'agent-workflow-kit/tools/apply-danger-check.mjs',
    commandArguments: ['--variant', 'gate-hook.not-current', '--cwd', '.'],
    redCase: 'hook-change-beyond-scope',
    build: () => ({}),
  },
  {
    path: 'agent-workflow-kit/tools/autonomy-doctor.mjs',
    commandArguments: ['--verify'],
    redCase: 'deployment-absent',
    build: () => ({}),
  },
]);
