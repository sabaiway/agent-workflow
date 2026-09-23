// The shared ground of the tier-walk suite — the throwaway home and project, the built environment,
// the state substrate, and the two template texts the suite pins with the values that render them.
// It declares NO test of its own; it sits in test/, outside files[], so it never ships; the `.test.mjs`
// name keeps it out of the changed-line coverage domain. It reads nothing from this repo's own references/: every template
// byte the suite compares comes from the INSTALLED copy, and the pinned texts are literals.

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cutRegion } from './doc-region-harness.test.mjs';

export const LF = String.fromCharCode(10);
export const DATE = '2026-09-21';
export const PLAN = 'docs/plans/greet.md';
export const MODULE = 'src/greet.mjs';
export const TEST = 'src/greet.test.mjs';
export const CONFIG = 'docs/ai/orchestration.json';
export const QUEUE = 'docs/plans/queue.md';
export const MODULE_ROW = 'M1 | modify | src/greet.mjs | Greet the reader by name | n/a | src/greet.mjs:1';
const QUEUE_TEXT = ['# Queue', '', '## Now', ''].join(LF);

export const renderLines = (lines) => lines.join(LF) + LF;
export const writeFixture = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
export const snapshotTree = (root, relative = '') => Object.fromEntries(
  readdirSync(join(root, relative)).sort().filter((name) => relative || name !== '.git').flatMap((name) => {
    const path = join(relative, name);
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return [[path, { kind: 'link', target: readlinkSync(absolute) }]];
    if (stat.isFile()) return [[path, { kind: 'file', bytes: readFileSync(absolute) }]];
    if (stat.isDirectory()) return [[path, { kind: 'directory' }], ...Object.entries(snapshotTree(root, path))];
    throw new Error(`Unexpected fixture entry: ${absolute}`);
  }),
);
export const renderPlan = ({ story = 'Story: S1 of WALK-EPIC', row = MODULE_ROW, next = '- None.' } = {}) => renderLines([
  '# Plan: Greet the reader', '', '## Goal and boundary', story,
  'Outcome: greet the reader by name. Governing spec: not adopted. Non-goals: unrelated files.', '',
  '## Module ledger', row, 'total: 0 → 0 lines', '', '## Verification',
  `- node --check ${MODULE} exits 0.`, '', '## Phase: Cleanup',
  '- Preserve the results and remove the temporary plan.', '', '## Next steps', next,
]);
export const removeSection = (text, heading) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (start < 0 || end < 0) throw new Error(`${heading} is not a closed section`);
  return [...lines.slice(0, start), ...lines.slice(end)].join(LF);
};
export const landStory = (epic) => epic.replace('state: planned', `state: landed ${DATE}`);
export const addResultLine = (epic) => epic.replace('## Acceptance' + LF, '## Acceptance' + LF + `Result line: ${DATE}` + LF);
export const listFiles = (tree) => Object.keys(tree).filter((path) => tree[path].kind === 'file').sort();
export const removeStorySpan = (text) => {
  const lines = text.split(LF);
  const start = lines.findIndex((line) => /^### 2[.][0-9]+[.] Story sessions/.test(line));
  if (start < 0) throw new Error('Story sessions template heading is absent');
  const end = lines.findIndex((line, index) => index > start && /^(---$|## |### )/.test(line));
  return [...lines.slice(0, start), ...lines.slice(end < 0 ? lines.length : end)].join(LF);
};

export const createGround = (roots) => {
  const root = mkdtempSync(join(tmpdir(), 'tier-walk-'));
  roots.push(root);
  const [home, project, bin, temporary] = ['home', 'project', 'bin', 'tmp'].map((name) => join(root, name));
  for (const path of [home, project, bin, temporary]) mkdirSync(path);
  const gitPath = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(gitPath, join(bin, 'git'));
  const kit = join(home, '.claude/skills/agent-workflow-kit');
  const env = { HOME: home, PATH: bin, TMPDIR: temporary };
  const records = [];
  const toolLabels = new Set();
  const run = (label, command, args, cwd = project) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    const record = { label, code: result.status, stdout: result.stdout ?? '',
      stderr: (result.stderr ?? '') + (result.error ? result.error.message : '') };
    records.push(record);
    return record;
  };
  const tool = (label, name, args) => {
    toolLabels.add(label);
    return run(label, join(bin, 'node'), [join(kit, 'tools', name), ...args]);
  };
  const git = (label, args) => run(label, join(bin, 'git'), args);
  const toolsPrefix = `${join(kit, 'tools')}/`;
  const shell = (label, line) => {
    const [command, path = ''] = line.split(' ');
    if (command === 'node' && path.replaceAll("'", '').startsWith(toolsPrefix)) toolLabels.add(label);
    return run(label, '/bin/sh', ['-c', line]);
  };
  const guide = (stage) => {
    const json = tool(`guide-${stage}`, 'tier-guide.mjs', ['--dir', project, '--json']);
    const plain = tool(`guide-${stage}-plain`, 'tier-guide.mjs', ['--dir', project]);
    if (json.code !== 0 || plain.code !== 0) throw new Error(`the guide at ${stage}: ${json.stderr}${plain.stderr}`);
    return { envelope: JSON.parse(json.stdout), lines: plain.stdout.split(LF) };
  };
  return { root, home, project, bin, kit, env, records, toolLabels, run, tool, git, shell, guide };
};
export const probeEnvironment = (ground) => {
  const fakeBin = join(ground.root, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'codex'), renderLines(['#!/bin/sh', 'exit 0']), { mode: 0o755 });
  const pollution = { AGENT_WORKFLOW_ENGINE_DIR: fakeBin, CODEX_CLI_BRIDGE_DIR: fakeBin,
    TIER_WALK_UNRELATED: 'must not reach the child', PATH: fakeBin + ':' + (process.env.PATH ?? '') };
  const saved = Object.fromEntries(Object.keys(pollution).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, pollution);
    ground.run('environment', join(ground.bin, 'node'), ['-e', 'process.stdout.write(JSON.stringify(process.env))']);
    for (const name of ['codex', 'node', 'git']) ground.run(`find-${name}`, '/bin/sh', ['-c', `command -v ${name}`]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
export const prepareSubstrate = (ground, state) => {
  const { project, kit, git } = ground;
  git('init', ['init', '-q', '-b', 'main']);
  git('email', ['config', 'user.email', 'coder-tools@proton.me']);
  git('name', ['config', 'user.name', 'coder-tool']);
  writeFixture(join(project, MODULE), renderLines(["export const greet = () => 'Hello';"]));
  writeFixture(join(project, 'package.json'), renderLines(['{"name":"walk-project","private":true,"type":"module"}']));
  for (const name of ['orchestration.json', 'gates.json', 'agent_rules.md']) {
    const bytes = readFileSync(join(kit, 'references/templates', name));
    writeFixture(join(project, 'docs/ai', name), name === 'agent_rules.md' ? removeStorySpan(bytes.toString('utf8')) : bytes);
  }
  if (state === 'seeded') {
    const config = readFileSync(join(project, CONFIG), 'utf8');
    const seed = ', "epic": { "author": "solo", "review": "solo" }, "task": { "author": "solo", "execute": "solo" }';
    const closing = config.lastIndexOf('}');
    writeFixture(join(project, CONFIG), config.slice(0, closing) + seed + config.slice(closing));
    mkdirSync(join(project, 'docs/ai/epics'));
    writeFixture(join(project, QUEUE), QUEUE_TEXT);
  }
  git('stage-substrate', ['add', '-A']);
  git('commit-substrate', ['commit', '-q', '-m', 'Create greeting substrate']);
};

// The two pinned template texts, one template line per source line (tier-templates S2).
export const EPIC_TEMPLATE_TEXT = renderLines([
  '---',
  'type: epic',
  'lastUpdated: {{DATE}}',
  'scope: permanent',
  'staleAfter: 90d',
  'owner: none',
  'maxLines: 60',
  'state: open',
  '---',
  '',
  '# Epic: {{EPIC_TITLE}}',
  '',
  '## Intent',
  '{{INTENT}}',
  '',
  '## Value',
  '{{VALUE}}',
  '',
  '## Non-goals',
  '{{NON_GOALS}}',
  '',
  '## Acceptance',
  '{{ACCEPTANCE}}',
  '',
  '## Specs',
  '{{SPECS}}',
  '',
  '## Stories ledger',
  '- S1 | {{STORY_NAME}} | depends-on: none | owns: {{OWNED_PATHS}} | shared: none | state: planned',
  '',
  '## Queue',
  'Row {{EPIC_ID}} in {{QUEUE_BUCKET}}',
]);
export const TASK_TEMPLATE_TEXT = renderLines([
  '# Task: {{TASK_NAME}}',
  'Story: {{STORY_ID}} of {{EPIC_ID}}',
  '',
  '## Slice',
  'Plan: {{PLAN_PATH}}',
  'Row: {{ROW_ID}}',
  'Grouping: test, impl',
  'Files:',
  '- {{TEST_PATH}} :: test',
  '- {{MODULE_PATH}} :: impl',
  '',
  '## Reads',
  '- {{PLAN_PATH}}',
  '',
  '## Acceptance',
  '- {{ACCEPTANCE_COMMAND}} :: {{EXPECTED_OUTCOME}}',
  '',
  '## Negative cases',
  '- {{NEGATIVE_CASE}} :: {{NEGATIVE_OUTCOME}}',
  '',
  '## Budget',
  '- {{TEST_PATH}} :: {{TEST_MAX_LINES}}',
  '- {{MODULE_PATH}} :: {{MODULE_MAX_LINES}}',
]);
// The closed key lists, typed from the contract — never derived from the texts above.
export const EPIC_KEYS = ['DATE', 'EPIC_TITLE', 'INTENT', 'VALUE', 'NON_GOALS', 'ACCEPTANCE', 'SPECS',
  'STORY_NAME', 'OWNED_PATHS', 'EPIC_ID', 'QUEUE_BUCKET'];
export const TASK_KEYS = ['TASK_NAME', 'STORY_ID', 'EPIC_ID', 'PLAN_PATH', 'ROW_ID', 'TEST_PATH', 'MODULE_PATH',
  'ACCEPTANCE_COMMAND', 'EXPECTED_OUTCOME', 'NEGATIVE_CASE', 'NEGATIVE_OUTCOME', 'TEST_MAX_LINES', 'MODULE_MAX_LINES'];
export const EPIC_VALUES = { DATE, EPIC_TITLE: 'Greet the reader', INTENT: 'Greet the reader by name.',
  VALUE: 'The reader receives a personal greeting.', NON_GOALS: 'No other messages.',
  ACCEPTANCE: 'The reader receives the greeting.', SPECS: 'none', STORY_NAME: 'Greet the reader',
  OWNED_PATHS: MODULE, EPIC_ID: 'WALK-EPIC', QUEUE_BUCKET: 'Now' };
export const TASK_VALUES = { TASK_NAME: 'Greet the reader', STORY_ID: 'S1', EPIC_ID: 'WALK-EPIC', PLAN_PATH: PLAN,
  ROW_ID: 'M1', TEST_PATH: TEST, MODULE_PATH: MODULE, ACCEPTANCE_COMMAND: `node --test ${TEST}`,
  EXPECTED_OUTCOME: 'exits 0', NEGATIVE_CASE: 'empty name', NEGATIVE_OUTCOME: 'remains a string',
  TEST_MAX_LINES: '100', MODULE_MAX_LINES: '100' };
export const renderTemplate = (text, values) => text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g,
  (span, key) => (Object.hasOwn(values, key) ? values[key] : span));
export const findSpans = (text) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(([, inner]) => inner);

// The tier's two literal tokens and the closed first-contact surface list (tier-discovery): where each
// region is read, the two asserted anchors that cut it, and which of the region's lines may carry the pair.
export const TIER_PHRASE = 'epic, story and task';
export const TIER_COMMAND = '/agent-workflow-kit tier';
const anyLine = (lines) => lines;
const nextLine = (lines) => lines.slice(1, 2);
export const SURFACES = [
  { name: 'install Next block', source: 'install stdout', from: 'Next —', to: LF + LF, pick: anyLine },
  { name: 'skill description', source: 'installed kit file', path: 'SKILL.md', from: 'description: ', to: LF,
    pick: anyLine },
  { name: 'kit README Use row', source: 'installed kit file', path: 'README.md',
    from: '| `/agent-workflow-kit now` |', to: LF + LF, pick: nextLine },
  { name: 'root README front door', source: 'repository file', path: 'README.md',
    from: '3. **Every session afterwards**', to: LF + '---' + LF, pick: anyLine },
  { name: 'welcome mat', source: 'installed kit file', path: 'references/shared/report-footer.md',
    from: '**Welcome mat', to: '### Version disclosure', pick: anyLine },
  { name: 'bootstrap block', source: 'installed kit file', path: 'references/modes/bootstrap.md',
    from: 'present ONE compact optional-accelerators block', to: 'Then **ask before committing**', pick: anyLine },
  { name: 'help tier line', source: 'help render', from: TIER_COMMAND, to: LF, pick: anyLine },
];
// Every surface's source text: the install's recorded stdout, the installed kit files, the repository files,
// and the help rendered by importing the installed commands.mjs (never spawned, so no walk step is added).
export const readSurfaces = async ({ kit, installStdout, repository }) => {
  const { formatHelp } = await import(pathToFileURL(join(kit, 'tools/commands.mjs')).href);
  const read = { 'install stdout': () => installStdout, 'help render': formatHelp,
    'installed kit file': (path) => readFileSync(join(kit, path), 'utf8'),
    'repository file': (path) => readFileSync(join(repository, path), 'utf8') };
  return Object.fromEntries(SURFACES.map(({ name, source, path }) => [name, read[source](path)]));
};
export const surfaceNamed = (name) => SURFACES.find((surface) => surface.name === name);
export const cutSurface = (surface, text) => cutRegion(text, surface.from, surface.to, surface.name);
// The one check: the names of the given surfaces whose picked lines carry no line with BOTH tokens, byte
// for byte (case kept, no whitespace collapsed). `regions` maps a surface name to its cut region.
export const surfacesLackingPair = (regions) => Object.entries(regions)
  .filter(([name, region]) => !surfaceNamed(name).pick(region.split(LF))
    .some((line) => line.includes(TIER_PHRASE) && line.includes(TIER_COMMAND)))
  .map(([name]) => name);
