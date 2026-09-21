import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main, parseBrief } from '../task-brief.mjs';
import { main as checkpointMain } from '../checkpoint.mjs';
import { hermeticGitEnv } from '../git-env.mjs';

const loaded = await import('../task-brief.mjs').catch(() => ({}));
const NAMES = loaded.NAMES ?? null;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const FENCE = String.fromCharCode(96).repeat(3);
const ACCEPT = 0;
const REFUSE = 1;
const GIT_FAILURE = 128;
const ROOT_UID = 0;
const READ_ONLY = 0o444;
const READ_WRITE = 0o644;
const BUDGET = 100;
const SHA_LENGTH = 64;
const NON_STRING = 42;
const TMP = mkdtempSync(join(tmpdir(), 'aw-refusal-form-'));
const ENV = hermeticGitEnv(process.env, TMP);
const STEM = 'story-gamma';
const PLAN = `docs/plans/${STEM}.md`;
const BRIEF = `docs/plans/TASK-${STEM}-T1.md`;
const DISPATCH = `docs/plans/TASK-${STEM}-T1-a0.md`;
const SCRATCH_PLAN = 'docs/plans/TASK-stem.md';
const STORY = 'Story: S23 of SYNTHETIC-WIDGETS';
const TITLE = '# Task: Revise the widget';
const MODULE = 'src/widget.mjs';
const TEST = 'src/widget.test.mjs';
const OTHER = 'src/other.mjs';
const READ = 'docs/ai/contract.md';
const BAD_READ = 'docs/ai/missing.md';
const INITIAL = 'export const value = 1;' + LF;
const CHANGED = 'export const value = 2;' + LF;
const FILES = [[TEST, 'test'], [MODULE, 'impl']];
const BUDGET_LINES = FILES.map(([path]) => `- ${path} :: ${BUDGET}`);
const SECTIONS = ['title', 'slice', 'reads', 'acceptance', 'negative', 'budget'];
const SHAPE_COUNT = 14;
const TREE_FAILURE = 'fatal: injected tree failure';
const STEM_DETAIL = 'expected a readable regular plan directly under docs/plans';
const CONTRACT = {
  schema: 1, nonce: 'brief-attempt', stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'revise the widget', acceptance: 'the requested checks pass',
  returnShape: 'a diff and report', producerContract: 'record the returned artifacts',
  deadlineS: 900, retry: { cap: 2, index: 0 },
};

after(() => rmSync(TMP, { recursive: true, force: true }));

const renderPlan = () => [
  '# Plan: Synthetic widget revision', '## Goal and boundary', STORY,
  'Outcome: revise the widget. Governing spec: not adopted. Non-goals: unrelated files.',
  '## Module ledger',
  `M1 | modify | ${MODULE} | Revise the widget | ${BUDGET} | ${MODULE}:1`,
  'total: 1 → 100 lines', '## Verification', `- node --check ${MODULE} exits 0.`,
  '## Phase: Cleanup', '- Remove the temporary plan.', '## Next steps', '- None.',
].join(LF + LF) + LF;

const renderBrief = (overrides = {}) => {
  const data = {
    title: TITLE, story: STORY, plan: PLAN, row: 'M1', grouping: 'test, impl', files: FILES,
    reads: [`- ${READ}`], acceptance: [`- node --check ${MODULE} :: exits 0`],
    negative: ['- wrong row :: refuses row'], ...overrides,
  };
  const sections = {
    title: [data.title, data.story],
    slice: ['## Slice', `Plan: ${data.plan}`, `Row: ${data.row}`, `Grouping: ${data.grouping}`, 'Files:',
      ...data.files.map(([path, tag]) => `- ${path} :: ${tag}`)],
    reads: ['## Reads', ...data.reads],
    acceptance: ['## Acceptance', ...data.acceptance],
    negative: ['## Negative cases', ...data.negative],
    budget: ['## Budget', ...(data.budget ?? BUDGET_LINES)],
  };
  return SECTIONS.filter((key) => key !== data.omit)
    .map((key) => sections[key].join(LF)).join(LF + LF) + LF;
};
const put = (ws, path, bytes) => {
  mkdirSync(dirname(join(ws.cwd, path)), { recursive: true });
  writeFileSync(join(ws.cwd, path), bytes);
};
const read = (ws, path = BRIEF) => readFileSync(join(ws.cwd, path));
const runGit = (ws, args) => {
  const result = spawnSync('git', args, { cwd: ws.cwd, env: ws.env });
  assert.equal(result.status, ACCEPT, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.toString('utf8').trimEnd();
};
const makeRepo = ({ brief = renderBrief(), unborn = false } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  const ws = { cwd, env: { ...ENV, AW_DELEGATION_STORE: join(cwd, '.git', 'refusal-ledger.jsonl') } };
  runGit(ws, ['init', '-q', '-b', 'main']);
  runGit(ws, ['config', 'user.email', 'coder-tools@proton.me']);
  runGit(ws, ['config', 'user.name', 'coder-tool']);
  for (const path of [MODULE, TEST]) put(ws, path, INITIAL);
  if (!unborn) {
    runGit(ws, ['add', '-A']);
    runGit(ws, ['commit', '-q', '-m', 'initial tree']);
  }
  put(ws, '.git/info/exclude', '/docs/ai/' + LF + '/AGENTS.md' + LF);
  put(ws, READ, '# Synthetic contract' + LF);
  put(ws, PLAN, renderPlan());
  put(ws, BRIEF, brief);
  return ws;
};
const accept = (result) => {
  assert.equal(result.code, ACCEPT, result.stderr);
  assert.equal(result.stderr, '');
  return result;
};
const mint = (ws) => accept(checkpointMain(['mint', '--plan', PLAN], ws));
const run = (ws, argv, deps = {}) => main(argv, { cwd: ws.cwd, env: ws.env, ...deps });
const prepareStamped = () => {
  const ws = makeRepo();
  mint(ws);
  accept(run(ws, ['stamp', BRIEF]));
  return ws;
};
const refuse = (ws, verb, flags = [], deps = {}) => {
  const before = read(ws);
  const result = run(ws, [verb, BRIEF, ...flags], deps);
  assert.equal(result.code, REFUSE, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(read(ws), before);
  return result;
};
const assertForm = (result, name) => {
  assert.equal(result.code, REFUSE, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.endsWith(LF), result.stderr);
  const line = result.stderr.slice(0, -LF.length);
  assert.ok(!line.includes(LF) && !line.includes(CR), result.stderr);
  assert.match(name, /^[a-z]+(?:-[a-z]+)*$/u);
  assert.ok(line.startsWith(`${name}: `), result.stderr);
  const detail = line.slice(name.length + ': '.length);
  assert.ok(detail.trim().length > 0, result.stderr);
  assert.ok(!detail.includes('undefined'), result.stderr);
  return detail;
};
const stampMalformed = (overrides) => refuse(makeRepo({ brief: renderBrief(overrides) }), 'stamp');
const checkChanged = (change, flags = []) => {
  const ws = prepareStamped();
  change(ws);
  return refuse(ws, 'check', flags);
};
const writeDispatch = (ws) => {
  const contract = { ...CONTRACT, inputs: `Read ${BRIEF} at sha256:${'0'.repeat(SHA_LENGTH)}` };
  put(ws, DISPATCH, [FENCE + 'aw-dispatch-contract', JSON.stringify(contract), FENCE, ''].join(LF));
};
const runOutside = () => {
  const cwd = mkdtempSync(join(TMP, 'outside-'));
  return main(['stamp', BRIEF], { cwd, env: ENV });
};

const RECIPES = {
  shape: () => stampMalformed({ omit: 'reads' }),
  grouping: () => stampMalformed({ grouping: 'impl' }),
  row: () => stampMalformed({ row: 'Z9' }),
  story: () => stampMalformed({ story: 'Story: S24 of SYNTHETIC-WIDGETS' }),
  reads: () => stampMalformed({ reads: [`- ${BAD_READ}`] }),
  binding: () => {
    const ws = makeRepo();
    mint(ws);
    return refuse(ws, 'check');
  },
  'binding-plan': () => checkChanged((ws) => appendFileSync(join(ws.cwd, PLAN), LF)),
  'binding-read': () => checkChanged((ws) => put(ws, READ, '# Revised contract' + LF)),
  'binding-checkpoint': () => checkChanged((ws) => {
    put(ws, MODULE, CHANGED);
    mint(ws);
  }),
  'checkpoint-stale': () => checkChanged((ws) => put(ws, MODULE, CHANGED)),
  head: () => {
    const ws = makeRepo({ unborn: true });
    mint(ws);
    return refuse(ws, 'stamp');
  },
  'binding-head': () => checkChanged((ws) => runGit(ws, ['commit', '--allow-empty', '-q', '-m', 'advance head'])),
  'dispatch-inputs': () => checkChanged(writeDispatch, ['--dispatch', DISPATCH]),
  environment: runOutside,
};

it('covers every refusal name with one-line detail — spec:checkpoint/S12', async (t) => {
  await t.test('exported names match the recipe table', () => {
    if (NAMES === null) throw new Error('NAMES is absent');
    assert.deepEqual(Object.values(NAMES).sort(), Object.keys(RECIPES).sort());
  });
  const names = NAMES === null ? Object.keys(RECIPES) : Object.values(NAMES);
  for (const name of names) {
    await t.test(name, () => assertForm(RECIPES[name](), name));
  }
});

const SHAPE_CELLS = [
  ['title', () => renderBrief({ title: '# Tusk: Revise the widget' }), ['# Tusk: Revise the widget', 'the title is not']],
  ['stray line', () => renderBrief().replace('## Slice', 'Note: stray line' + LF + '## Slice'), ['Note: stray line', 'not a Story line']],
  ['foreign heading', () => renderBrief() + '## Extra' + LF + '- extra' + LF, ['## Extra', 'foreign']],
  ['absent Reads', () => renderBrief({ omit: 'reads' }), ['## Reads', 'absent']],
  ['absent Grouping', () => renderBrief().replace('Grouping: test, impl' + LF, ''), ['Grouping', 'absent']],
  ['Reads line grammar', () => renderBrief({ reads: ['not a bullet'] }), ['not a bullet', '## Reads line']],
  ['Negative cases line grammar', () => renderBrief({ negative: ['not a bullet'] }), ['not a bullet', '## Negative cases line']],
  ['empty Files', () => renderBrief({ files: [], budget: [] }), ['Files:']],
  ['repeated Budget path', () => renderBrief({ budget: [...BUDGET_LINES, BUDGET_LINES[0]] }), [TEST, 'repeated']],
  ['absent Budget path', () => renderBrief({ budget: [BUDGET_LINES[0]] }), [MODULE, 'absent']],
  ['foreign Budget path', () => renderBrief({ budget: [...BUDGET_LINES, `- ${OTHER} :: ${BUDGET}`] }), [OTHER, 'foreign']],
  ['Budget count', () => renderBrief({ budget: [BUDGET_LINES[0], `- ${MODULE} :: many`] }), [`- ${MODULE} :: many`, 'positive integer']],
  ['empty Acceptance', () => renderBrief({ acceptance: [] }), ['## Acceptance']],
  ['empty Negative cases', () => renderBrief({ negative: [] }), ['## Negative cases']],
];

it('identifies each malformed brief with a distinct shape detail', async (t) => {
  const lines = [];
  for (const [name, render, expected] of SHAPE_CELLS) {
    await t.test(name, () => {
      const result = refuse(makeRepo({ brief: render() }), 'stamp');
      lines.push(result.stderr);
      const detail = assertForm(result, 'shape');
      for (const text of expected) assert.ok(detail.includes(text), result.stderr);
    });
  }
  await t.test('every stderr line differs', () => {
    assert.equal(lines.length, SHAPE_COUNT);
    assert.equal(new Set(lines).size, SHAPE_COUNT);
  });
});

it('gives a colonless shape member the failed rule detail', () => {
  assert.equal(loaded.parseBrief, parseBrief);
  const result = loaded.parseBrief(NON_STRING);
  assert.equal(result.ok, false);
  assert.match(result.reason, /^shape: \S/u);
});

it('includes mint and stamp in the checkpoint-stale remedy', () => {
  const detail = assertForm(RECIPES['checkpoint-stale'](), 'checkpoint-stale');
  assert.match(detail, /mint/iu);
  assert.match(detail, /stamp/iu);
});

it('keeps the handed-up no-checkpoint name and detail', () => {
  const result = refuse(makeRepo(), 'stamp');
  assertForm(result, 'no-checkpoint');
  assert.equal(result.stderr, `no-checkpoint: ${STEM}${LF}`);
});

it('keeps the handed-up stem name and detail', () => {
  const ws = makeRepo({ brief: renderBrief({ plan: SCRATCH_PLAN }) });
  put(ws, SCRATCH_PLAN, renderPlan());
  const result = refuse(ws, 'stamp');
  assertForm(result, 'stem');
  assert.equal(result.stderr, `stem: ${STEM_DETAIL}${LF}`);
});

it('wraps the whole non-repository sentence as environment', () => {
  const result = runOutside();
  assertForm(result, 'environment');
  assert.match(result.stderr, /^environment: fatal: not a git repository/u);
});

it('wraps a nameless tree-object failure as environment', () => {
  const ws = prepareStamped();
  const runGit = (args, cwd, input, env) => args[0] === 'cat-file' && args[1] === '-t'
    ? { status: GIT_FAILURE, stdout: Buffer.alloc(0), stderr: Buffer.from(TREE_FAILURE) }
    : spawnSync('git', args, { cwd, input, env });
  const result = refuse(ws, 'check', [], { runGit });
  assertForm(result, 'environment');
  assert.match(result.stderr, /^environment: .*injected tree failure/u);
});

it('wraps a refused brief write and preserves its bytes', (t) => {
  if (process.getuid?.() === ROOT_UID) {
    t.skip('root bypasses read-only file permissions');
    return;
  }
  const ws = makeRepo();
  mint(ws);
  chmodSync(join(ws.cwd, BRIEF), READ_ONLY);
  try {
    const result = refuse(ws, 'stamp');
    assertForm(result, 'environment');
    assert.match(result.stderr, /^environment: EACCES/u);
  } finally {
    chmodSync(join(ws.cwd, BRIEF), READ_WRITE);
  }
});

it('prints a path containing a line feed as one reads line', () => {
  const ws = makeRepo();
  const result = run(ws, ['stamp', 'docs/plans/a' + LF + 'b.md']);
  const detail = assertForm(result, 'reads');
  assert.ok(detail.includes('b.md'), result.stderr);
  assert.equal(result.stderr.split(LF).length, 2);
});
