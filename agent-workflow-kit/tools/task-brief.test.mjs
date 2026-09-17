import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hermeticGitEnv } from './git-env.mjs';
import { parseLedger } from './plan-shape.mjs';
import { DELEGATION_STORE_BASENAME } from './dispatch-store.mjs';
import { appendFileSync } from 'node:fs';
import { main as dispatchMain } from './dispatch.mjs';

const ABSENT = 'absent ./task-brief.mjs';
const CHECKPOINT_ABSENT = 'absent ./checkpoint.mjs';
const loaded = await import('./task-brief.mjs').catch(() => ({}));
const checkpoint = await import('./checkpoint.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error(ABSENT); });
const checkpointMain = checkpoint.main ?? (() => { throw new Error(CHECKPOINT_ABSENT); });
const CLI = fileURLToPath(new URL('./task-brief.mjs', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'aw-task-brief-test-'));
const ENV = hermeticGitEnv(process.env, TMP);
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const BUDGET = 100;
const STEM = 'story-gamma';
const PLAN = `docs/plans/${STEM}.md`;
const OTHER_PLAN = 'docs/plans/story-delta.md';
const BRIEF = `docs/plans/TASK-${STEM}-T1.md`;
const OTHER_BRIEF = `docs/plans/TASK-${STEM}-T2.md`;
const DISPATCH = `docs/plans/TASK-${STEM}-T1-a0.md`;
const STORY = 'Story: S23 of SYNTHETIC-WIDGETS';
const MODULE = 'src/widget.mjs';
const TEST = 'src/widget.test.mjs';
const NESTED_TEST = 'src/widget.test/basic.test.mjs';
const ANCHOR = 'src/anchor.mjs';
const PIN = 'agent-workflow-kit/test/package-content.test.mjs';
const OTHER = 'src/other.mjs';
const OTHER_TEST = 'src/other.test.mjs';
const ESCAPED_TEST = 'src/widget.test/../../other.mjs';
const ROOT_OTHER = 'other.mjs';
const SWEEP = 'src/sweep/*.mjs';
const SWEEP_FILE = 'src/sweep/one.mjs';
const SWEEP_OTHER = 'src/sweep/two.mjs';
const [SWEEP_TEST, SWEEP_OTHER_TEST] = ['src/sweep/one.test.mjs', 'src/sweep/two.test.mjs'];
const READ = 'docs/ai/contract.md';
const READ_EXTRA = 'docs/ai/notes.md';
const READ_ADDED = 'docs/ai/extra.md';
const BAD_READ = 'docs/ai/bad.md';
const OUTSIDE = '../x';
const READS = [READ, READ_EXTRA];
const INITIAL = 'export const value = 1;\n';
const CHANGED = 'export const value = 2;\n';
const READ_BYTES = '# Synthetic contract\n';
const CHANGED_READ = '# Revised contract\n';
const FILES = [[TEST, 'test'], [MODULE, 'impl']];
const TAGS = ['test', 'impl', 'pin'];
const SECTIONS = ['title', 'slice', 'reads', 'acceptance', 'negative', 'budget'];
const INFO = 'aw-task-binding';
const BINDING_RE = /^`{3,}[ \t]*aw-task-binding[ \t]*\r?\n([\s\S]*?)^`{3,}[ \t]*(?:\r?\n|$)/gm;
const EXPORTS = ['main', 'parseBrief', 'stampBrief', 'checkBrief'];
const PREFIX = 'refs/agent-workflow/checkpoints/';
const LEDGER = [
  `M1 | modify | ${MODULE} | Revise the widget | ${BUDGET} | ${ANCHOR}:1`,
  `T1 | modify | ${TEST} | Cover the widget | ${BUDGET} | ${TEST}:1`,
  `T2 | modify | ${NESTED_TEST} | Cover nested cases | ${BUDGET} | ${NESTED_TEST}:1`,
  `P1 | modify | ${PIN} | Pin package contents | ${BUDGET} | ${PIN}:1`,
  `W1 | modify | ${SWEEP} | Revise sweep members | ${BUDGET} | ${ANCHOR}:1`,
];
const SHAPE_CELLS = [
  ['missing Reads section', { omit: 'reads' }],
  ['doubled Reads section', { duplicate: 'reads' }],
  ['Acceptance before Reads', { order: ['title', 'slice', 'acceptance', 'reads', 'negative', 'budget'] }],
  ['Files line without separator', { fileLines: [`- ${TEST} test`, `- ${MODULE} :: impl`] }],
  ['empty Files list', { files: [], grouping: 'test, impl' }],
  ['Budget paths differ from Files', { budget: [`- ${OTHER} :: ${BUDGET}`] }],
  ['empty Negative cases section', { negative: [] }],
  ['empty Acceptance section', { acceptance: [] }],
];
const GROUPING_CELLS = [
  ['second pin line', { row: 'P1', files: [[PIN, 'pin'], [OTHER, 'pin']] }],
  ['pin on a module row', { files: [...FILES, [PIN, 'pin']] }],
  ['pin row without a pin', { row: 'P1', files: [[PIN, 'test']] }],
  ['unknown tag', { files: [...FILES, [OTHER, 'unknown']] }],
  ['tag order reversed', { grouping: 'impl, test' }],
  ['tag omitted from Grouping', { grouping: 'impl' }],
];
const CONTRACT = { schema: 1, nonce: 'brief-attempt', stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'revise the widget', acceptance: 'the requested checks pass', returnShape: 'a diff and report',
  producerContract: 'record the returned artifacts', deadlineS: 900, retry: { cap: 2, index: 0 } };
const USAGE_CELLS = [[], ['unknown'], ['stamp'], ['check'], ['stamp', BRIEF, 'extra'], ['check', BRIEF, 'extra'],
  ['check', BRIEF, '--dispatch'], ['stamp', BRIEF, '--dispatch', DISPATCH]];
const renderPlan = (story = STORY) => [
  '# Plan: Synthetic widget revision', '## Goal and boundary', story,
  'Outcome: revise the widget. Governing spec: not adopted. Non-goals: unrelated files.',
  '## Module ledger', ...LEDGER, 'total: 6 → 600 lines',
  '## Verification', `- node --check ${MODULE} exits 0.`, '## Phase: Cleanup',
  '- Preserve the results and remove the temporary plan.', '## Next steps', '- None.',
].join('\n\n') + '\n';
const renderBrief = (overrides = {}) => {
  const data = { story: STORY, plan: PLAN, row: 'M1', files: FILES, reads: READS,
    acceptance: [`node --check ${MODULE} :: exits 0`], negative: ['wrong row :: refuses row'], ...overrides };
  const sections = {
    title: ['# Task: Revise the synthetic widget', ...(data.story ? [data.story] : [])],
    slice: ['## Slice', `Plan: ${data.plan}`, `Row: ${data.row}`,
      `Grouping: ${data.grouping ?? TAGS.filter((tag) => data.files.some(([, value]) => value === tag)).join(', ')}`, 'Files:',
      ...(data.fileLines ?? data.files.map(([path, tag]) => `- ${path} :: ${tag}`))],
    reads: ['## Reads', ...data.reads.map((path) => `- ${path}`)],
    acceptance: ['## Acceptance', ...data.acceptance.map((line) => `- ${line}`)],
    negative: ['## Negative cases', ...data.negative.map((line) => `- ${line}`)],
    budget: ['## Budget', ...(data.budget ?? data.files.map(([path]) => `- ${path} :: ${BUDGET}`))],
  };
  return (data.order ?? SECTIONS).filter((key) => key !== data.omit)
    .flatMap((key) => Array.from({ length: data.duplicate === key ? 2 : 1 }, () => sections[key].join('\n'))).join('\n\n') + '\n';
};
after(() => rmSync(TMP, { recursive: true, force: true }));
const runGit = (args, cwd, env = ENV) => spawnSync('git', args, { cwd, env });
const sh = (ws, args) => {
  const result = runGit(args, ws.cwd, ws.env);
  assert.equal(result.status, ACCEPT, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.toString('utf8').trimEnd();
};
const put = (ws, path, bytes = INITIAL) => {
  mkdirSync(dirname(join(ws.cwd, path)), { recursive: true }); writeFileSync(join(ws.cwd, path), bytes);
};
const makeRepo = ({ brief = renderBrief(), plan = renderPlan(), unborn = false } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  const ws = { cwd, env: { ...ENV, AW_DELEGATION_STORE: join(cwd, '.git', DELEGATION_STORE_BASENAME) } };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'coder-tools@proton.me'], ['config', 'user.name', 'coder-tool']]) sh(ws, args);
  for (const path of [MODULE, TEST, NESTED_TEST, ANCHOR, PIN, OTHER, OTHER_TEST, SWEEP_FILE, SWEEP_OTHER]) put(ws, path);
  if (!unborn) { sh(ws, ['add', '-A']); sh(ws, ['commit', '-q', '-m', 'initial tree']); }
  put(ws, '.git/info/exclude', '/docs/ai/\n/AGENTS.md\n');
  for (const path of [...READS, READ_ADDED]) put(ws, path, READ_BYTES);
  put(ws, PLAN, plan); put(ws, BRIEF, brief);
  assert.equal(parseLedger(plan).rows.length, LEDGER.length); assert.ok(parseLedger(plan).rows.every((row) => row.valid));
  return ws;
};
const mint = (ws, n = 0) => {
  const result = accept(checkpointMain(['mint', '--plan', PLAN], ws));
  const oid = sh(ws, ['rev-parse', `${PREFIX}${STEM}/${n}`]);
  assert.equal(result.stdout, `checkpoint ${STEM}/${n} ${oid}\n`);
  return oid;
};
const run = (ws, argv) => {
  const result = main(argv, { cwd: ws.cwd, env: ws.env });
  assert.equal(typeof result.stdout, 'string'); assert.equal(typeof result.stderr, 'string');
  return result;
};
const accept = (result) => { assert.equal(result.code, ACCEPT, result.stderr); return result; };
const read = (ws, path = BRIEF) => readFileSync(join(ws.cwd, path));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readProtected = (ws) => ({ files: [PLAN, ...READS, READ_ADDED, MODULE, TEST, NESTED_TEST, ANCHOR, PIN, OTHER,
  OTHER_TEST, SWEEP_FILE, SWEEP_OTHER, '.git/info/exclude'].map((path) => [path, read(ws, path)]),
  index: sh(ws, ['ls-files', '-s']), refs: sh(ws, ['for-each-ref', PREFIX]) });
const assertDigest = (ws, verb, flags = []) => {
  const before = read(ws); const protectedFiles = readProtected(ws); const result = accept(run(ws, [verb, BRIEF, ...flags]));
  assert.equal(result.stdout, `task-brief digest sha256:${digest(read(ws))}\n`);
  assert.deepEqual(readProtected(ws), protectedFiles);
  if (verb === 'check') assert.deepEqual(read(ws), before);
  return result.stdout;
};
const refuse = (ws, verb, name, flags = []) => {
  const before = read(ws); const result = run(ws, [verb, BRIEF, ...flags]);
  assert.equal(result.code, REFUSE, result.stderr); assert.match(result.stderr, new RegExp('\\b' + name + '\\b'));
  assert.deepEqual(read(ws), before); return result;
};
const renderBinding = (binding) => `\n\`\`\`${INFO}\n${JSON.stringify(binding)}\n\`\`\`\n`;
const readBinding = (ws) => {
  const text = read(ws).toString('utf8'); const blocks = [...text.matchAll(BINDING_RE)];
  assert.equal([...text.matchAll(/^`{3,}.*$/gm)].length, 2);
  assert.equal(blocks.length, 1); return JSON.parse(blocks[0][1]);
};
const assertBinding = (ws, oid) => {
  const actual = readBinding(ws);
  assert.deepEqual(Object.keys(actual).sort(), ['schema', 'plan', 'reads', 'checkpoint', 'head'].sort());
  assert.deepEqual(actual, { schema: 1, plan: { path: PLAN, sha256: digest(read(ws, PLAN)) },
    reads: READS.map((path) => ({ path, sha256: digest(read(ws, path)) })), checkpoint: oid, head: sh(ws, ['rev-parse', 'HEAD']) });
};
const editBinding = (ws, edit) => put(ws, BRIEF, read(ws).toString('utf8').replace(BINDING_RE, () => renderBinding(edit(readBinding(ws)))));
const editBrief = (ws, before, after) => put(ws, BRIEF, read(ws).toString('utf8').replace(before, after));
const prepareStamped = () => {
  const ws = makeRepo(); mint(ws); assertDigest(ws, 'stamp'); return ws;
};
const writeDispatch = (ws, path = BRIEF, hash = digest(read(ws))) =>
  put(ws, DISPATCH, `\`\`\`aw-dispatch-contract\n${JSON.stringify({ ...CONTRACT, inputs: `Read ${path} at sha256:${hash}` })}\n\`\`\`\n`);

describe('brief grammar — spec:checkpoint/S7', () => {
  it('refuses a test path that escapes the co-located directory through a parent segment', () => {
    const ws = makeRepo();
    put(ws, ROOT_OTHER);
    mint(ws); assertDigest(ws, 'stamp');
    const binding = readBinding(ws);
    put(ws, BRIEF, renderBrief({ files: [[ESCAPED_TEST, 'test'], [MODULE, 'impl']] }) + renderBinding(binding));
    for (const verb of ['check', 'stamp']) refuse(ws, verb, 'row');
  });
  it('exports the four functions and binding info string', () => {
    const ws = makeRepo(); assert.equal(run(ws, []).code, USAGE);
    for (const name of EXPORTS) assert.equal(typeof loaded[name], 'function', name);
    assert.equal(loaded.BRIEF_BINDING_INFO_STRING, INFO);
  });
  it('accepts a module slice and judges its absent binding separately from grammar', () => {
    const ws = makeRepo(); mint(ws); refuse(ws, 'check', 'binding');
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  it('accepts co-located directory tests and groups repeated tags as a distinct set', () => {
    const ws = makeRepo({ brief: renderBrief({ files: [[TEST, 'test'], [NESTED_TEST, 'test'], [MODULE, 'impl']] }) }); mint(ws);
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  it('refuses a test path unrelated to the impl path in the slice', () => {
    const ws = makeRepo({ brief: renderBrief({ files: [[OTHER_TEST, 'test'], [MODULE, 'impl']] }) }); refuse(ws, 'check', 'row');
  });
  for (const [row, path] of [['T1', TEST], ['T2', NESTED_TEST]]) it(`accepts the test-only row ${row}`, () => {
    const ws = makeRepo({ brief: renderBrief({ row, files: [[path, 'test']] }) }); mint(ws);
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  it('accepts exactly one pin on the package-content row', () => {
    const ws = makeRepo({ brief: renderBrief({ row: 'P1', files: [[PIN, 'pin']] }) }); mint(ws);
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  for (const [name, overrides] of GROUPING_CELLS) it(`refuses grouping: ${name}`, () => {
    const ws = makeRepo({ brief: renderBrief(overrides) }); refuse(ws, 'check', 'grouping');
  });
  it('refuses an anchor path as the impl set of a module row', () => {
    const ws = makeRepo({ brief: renderBrief({ files: [[ANCHOR, 'impl']] }) }); refuse(ws, 'check', 'row');
  });
  it('accepts an impl path from the sweep expansion', () => {
    const ws = makeRepo({ brief: renderBrief({ row: 'W1', files: [[SWEEP_FILE, 'impl']] }) }); mint(ws);
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  it('refuses an impl path outside the sweep expansion', () => {
    const ws = makeRepo({ brief: renderBrief({ row: 'W1', files: [[OTHER, 'impl']] }) }); refuse(ws, 'check', 'row');
  });
  it('refuses an unknown ledger row', () => {
    const ws = makeRepo({ brief: renderBrief({ row: 'absent-row' }) }); refuse(ws, 'check', 'row');
  });
  for (const [name, story, planStory] of [['absent', '', STORY], ['unequal', STORY.replace('S23', 'S24'), STORY], ['absent in plan', STORY, '']]) it(`refuses story ${name}`, () => {
    const ws = makeRepo({ brief: renderBrief({ story }), plan: renderPlan(planStory) }); refuse(ws, 'check', 'story');
  });
  for (const [name, overrides] of SHAPE_CELLS) it(`refuses shape: ${name}`, () => {
    const ws = makeRepo({ brief: renderBrief(overrides) }); refuse(ws, 'check', 'shape');
  });
});

describe('lone suites on module and sweep rows — spec:checkpoint/S11', () => {
  for (const [row, path] of [['M1', TEST], ['M1', NESTED_TEST], ['W1', SWEEP_TEST]]) it(`accepts lone suite ${path} on ${row}`, () => {
    const ws = makeRepo({ brief: renderBrief({ row, files: [[path, 'test']] }) }); mint(ws);
    assertDigest(ws, 'stamp'); assertDigest(ws, 'check');
  });
  for (const [row, files] of [['M1', [[OTHER_TEST, 'test']]], ['T1', [[OTHER_TEST, 'test']]], ['W1', [[SWEEP_OTHER_TEST, 'test'], [SWEEP_FILE, 'impl']]]]) it(`refuses unrelated test on ${row}`, () => {
    const ws = makeRepo({ brief: renderBrief({ row, files }) }); refuse(ws, 'check', 'row');
  });
});

describe('brief binding and dispatch freshness — spec:checkpoint/S8', () => {
  it('stamps zero blocks into one closed binding with every digest and current oid', () => {
    const ws = makeRepo(); const oid = mint(ws);
    assert.equal([...read(ws).toString('utf8').matchAll(BINDING_RE)].length, 0);
    assertDigest(ws, 'stamp'); assertBinding(ws, oid);
  });
  it('replaces one block with current plan, reads, newest checkpoint and HEAD values', () => {
    const ws = prepareStamped(); const before = readBinding(ws);
    put(ws, PLAN, renderPlan() + '\n'); put(ws, READ, CHANGED_READ); sh(ws, ['commit', '--allow-empty', '-q', '-m', 'advance head']);
    const oid = mint(ws, 1); assertDigest(ws, 'stamp'); assertBinding(ws, oid);
    assert.notDeepEqual(readBinding(ws), before); assertDigest(ws, 'check');
  });
  it('refuses two binding blocks on stamp and check without writing', () => {
    const ws = prepareStamped(); put(ws, BRIEF, read(ws).toString('utf8') + renderBinding(readBinding(ws)));
    for (const verb of ['stamp', 'check']) refuse(ws, verb, 'binding');
  });
  it('refuses stamp on a malformed brief without writing', () => {
    const ws = makeRepo({ brief: renderBrief({ omit: 'reads' }) }); refuse(ws, 'stamp', 'shape');
  });
  for (const kind of ['absent', 'directory', 'symlink', 'outside']) it(`refuses reads on a ${kind} Reads path`, () => {
    const ws = prepareStamped(); const path = kind === 'outside' ? OUTSIDE : BAD_READ;
    if (kind === 'directory') mkdirSync(join(ws.cwd, path));
    if (kind === 'symlink') symlinkSync(join(ws.cwd, READ), join(ws.cwd, path));
    if (kind === 'outside') put(ws, path, READ_BYTES);
    editBrief(ws, `- ${READ}\n`, `- ${path}\n`);
    for (const verb of ['stamp', 'check']) refuse(ws, verb, 'reads');
  });
  for (const kind of ['absent', 'directory', 'symlink']) it(`refuses reads on a ${kind} Plan path`, () => {
    const ws = prepareStamped(); put(ws, OTHER_PLAN, read(ws, PLAN)); rmSync(join(ws.cwd, PLAN));
    if (kind === 'directory') mkdirSync(join(ws.cwd, PLAN));
    if (kind === 'symlink') symlinkSync(join(ws.cwd, OTHER_PLAN), join(ws.cwd, PLAN));
    for (const verb of ['stamp', 'check']) refuse(ws, verb, 'reads');
  });
  it('refuses stamp before checkpoint zero exists', () => {
    const ws = makeRepo(); refuse(ws, 'stamp', 'no-checkpoint');
  });
  it('refuses check after the sequence has been pruned', () => {
    const ws = prepareStamped(); accept(checkpointMain(['prune', '--plan', PLAN], ws)); refuse(ws, 'check', 'no-checkpoint');
  });
  it('refuses stamp on an unborn HEAD even after a mint', () => {
    const ws = makeRepo({ unborn: true }); mint(ws); refuse(ws, 'stamp', 'head');
  });
  it('check repeats the digest of every byte of the stamped file without writing', () => {
    const ws = makeRepo(); mint(ws); const stamped = assertDigest(ws, 'stamp');
    assert.equal(assertDigest(ws, 'check'), stamped);
    editBrief(ws, 'exits 0', 'exits 0 with valid syntax');
    assert.notEqual(assertDigest(ws, 'check'), stamped);
  });
  it('refuses binding-plan after one plan byte changes', () => {
    const ws = prepareStamped(); put(ws, PLAN, read(ws, PLAN).toString('utf8') + '\n'); refuse(ws, 'check', 'binding-plan');
  });
  it('refuses binding-plan when the block names another Plan path', () => {
    const ws = prepareStamped(); put(ws, OTHER_PLAN, read(ws, PLAN));
    editBinding(ws, (binding) => ({ ...binding, plan: { ...binding.plan, path: OTHER_PLAN } })); refuse(ws, 'check', 'binding-plan');
  });
  it('refuses binding-read after read bytes change', () => {
    const ws = prepareStamped(); put(ws, READ, CHANGED_READ); refuse(ws, 'check', 'binding-read');
  });
  for (const added of [true, false]) it(`refuses binding-read when a Reads path is ${added ? 'added' : 'removed'}`, () => {
    const ws = prepareStamped(); editBrief(ws, `- ${READ_EXTRA}\n`, added ? `- ${READ_EXTRA}\n- ${READ_ADDED}\n` : '');
    refuse(ws, 'check', 'binding-read');
  });
  it('refuses binding-checkpoint after a scope change and fresh mint', () => {
    const ws = prepareStamped(); put(ws, MODULE, CHANGED); mint(ws, 1); refuse(ws, 'check', 'binding-checkpoint');
  });
  it('refuses checkpoint-stale after a scope change without a fresh mint', () => {
    const ws = prepareStamped(); put(ws, MODULE, CHANGED); refuse(ws, 'check', 'checkpoint-stale');
  });
  it('refuses binding-head after an empty commit changes HEAD alone', () => {
    const ws = prepareStamped(); sh(ws, ['commit', '--allow-empty', '-q', '-m', 'advance head']); refuse(ws, 'check', 'binding-head');
  });
  for (const kind of ['stray key', 'absent block']) it(`refuses binding for a ${kind}`, () => {
    const ws = prepareStamped();
    if (kind === 'stray key') editBinding(ws, (binding) => ({ ...binding, stray: true }));
    else put(ws, BRIEF, read(ws).toString('utf8').replace(BINDING_RE, ''));
    refuse(ws, 'check', 'binding');
  });
  it('accepts dispatch inputs carrying the current brief path and whole-file digest', () => {
    const ws = prepareStamped(); writeDispatch(ws); assertDigest(ws, 'check', ['--dispatch', DISPATCH]);
  });
  for (const kind of ['digest', 'brief path', 'absent', 'directory', 'symlink']) it(`refuses dispatch-inputs for another ${kind}`, () => {
    const ws = prepareStamped();
    if (kind === 'digest') writeDispatch(ws, BRIEF, digest(Buffer.from(CHANGED)));
    if (kind === 'brief path') writeDispatch(ws, OTHER_BRIEF);
    if (kind === 'directory') mkdirSync(join(ws.cwd, DISPATCH));
    if (kind === 'symlink') { writeDispatch(ws); put(ws, OTHER_BRIEF, read(ws, DISPATCH)); rmSync(join(ws.cwd, DISPATCH)); symlinkSync(join(ws.cwd, OTHER_BRIEF), join(ws.cwd, DISPATCH)); }
    refuse(ws, 'check', 'dispatch-inputs', ['--dispatch', DISPATCH]);
  });
  for (const argv of USAGE_CELLS) it(`returns usage without writing for ${JSON.stringify(argv)}`, () => {
    const ws = makeRepo(); const before = read(ws); assert.equal(run(ws, argv).code, USAGE); assert.deepEqual(read(ws), before);
  });
  it('writes the digest line, the exit code and nothing on stderr when run as a process', () => {
    const ws = makeRepo(); mint(ws);
    const result = spawnSync(process.execPath, [CLI, 'stamp', BRIEF], { cwd: ws.cwd, env: ws.env, encoding: 'utf8' });
    assert.deepEqual([result.status, result.stdout, result.stderr], [ACCEPT, `task-brief digest sha256:${digest(read(ws))}\n`, '']);
    const usage = spawnSync(process.execPath, [CLI], { cwd: ws.cwd, env: ws.env, encoding: 'utf8' });
    assert.deepEqual([usage.status, usage.stdout], [USAGE, '']); assert.match(usage.stderr, /\busage\b/);
  });
});

const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const SIBLING_NONCE = 'sibling-task';
const prepareSibling = (path = OTHER) => {
  const ws = makeRepo(); put(ws, OTHER_BRIEF, renderBrief({ files: [[path, 'impl']] }));
  const oid = mint(ws); assertDigest(ws, 'stamp');
  const clock = { ms: Date.now() + HOUR_MS };
  const deps = { cwd: ws.cwd, env: ws.env, now: () => { clock.ms += SECOND_MS; return new Date(clock.ms).toISOString(); } };
  accept(dispatchMain(['register', '--wave', 'wave-a', '--step-classes', 'code,triage', '--pairing-key', 'stepClass',
    '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1'], deps));
  const contract = { ...CONTRACT, nonce: SIBLING_NONCE, scope: 'write the requested file',
    inputs: 'the current tree', acceptance: 'the file matches the brief' };
  const contractPath = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(contractPath, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  accept(dispatchMain(['open', '--contract', contractPath, '--wave', 'wave-a', '--backend', 'codex', '--rationale', 'x',
    '--wrapper-cap-s', '600', '--kill-grace-s', '15', '--checkpoint', oid, '--task', OTHER_BRIEF], deps));
  return { ws, oid, deps };
};

describe("brief check over a wave's claimed dirt — spec:task-thread/S9", () => {
  it("accepts a sibling's claimed dirt", () => {
    const { ws } = prepareSibling(); put(ws, OTHER, CHANGED); assertDigest(ws, 'check');
  });
  it('refuses dirt in its own Files even when a sibling claims that path', () => {
    const { ws } = prepareSibling(MODULE); put(ws, MODULE, CHANGED); refuse(ws, 'check', 'checkpoint-stale');
  });
  it('refuses unclaimed dirt', () => {
    const { ws } = prepareSibling(); put(ws, ANCHOR, CHANGED); refuse(ws, 'check', 'checkpoint-stale');
  });
  it('a degraded sibling claims nothing', () => {
    const { ws, deps } = prepareSibling();
    accept(dispatchMain(['degrade', '--wave', 'wave-a', '--nonce', SIBLING_NONCE, '--step-class', 'code', '--rationale', 'withdraw'], deps));
    put(ws, OTHER, CHANGED); refuse(ws, 'check', 'checkpoint-stale');
  });
  it('a claim on another checkpoint never counts', () => {
    const { ws, oid } = prepareSibling(); put(ws, ANCHOR, CHANGED);
    assert.notEqual(mint(ws, 1), oid); assertDigest(ws, 'stamp');
    put(ws, OTHER, CHANGED); refuse(ws, 'check', 'checkpoint-stale');
  });
  it('an unreadable ledger names its reason', () => {
    const { ws } = prepareSibling(); put(ws, OTHER, CHANGED);
    appendFileSync(ws.env.AW_DELEGATION_STORE, 'malformed\n');
    assert.match(refuse(ws, 'check', 'checkpoint-stale').stderr, /malformed|JSON|line/iu);
  });
});
