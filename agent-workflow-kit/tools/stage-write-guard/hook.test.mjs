import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hermeticGitEnv } from '../git-env.mjs';
import { fixtures, makeRepo, REAL_GIT, skipWithoutGit } from '../hostile-git-harness.test.mjs';
import { writeJson } from '../plan-shape-harness.test.mjs';
import { composeRenderLine } from '../stage-render/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const HOOK_PATH = join(HERE, '..', '..', 'references', 'hooks', 'stage-write-guard.mjs');
const RECORD_BASENAME = 'agent-workflow-stage.json';
const SLOT_FILE = 'docs/plans/next-session.json';
const RECORDED_STAGE = 'spec-and-plan';
const DECOY_STAGE = 'epic';
const AUTHORING = 'authoring';
const ANY = 'any';
const ORCHESTRATION_REL = 'docs/ai/orchestration.json';
const FLOW = { debtQueue: 'docs/debt.md', convergenceSummary: 'docs/convergence.md' };
const MEMORY_SEGMENT = '-work-project';
const DENY_KEYS = ['hookEventName', 'permissionDecision', 'permissionDecisionReason'];
const CODE = 'tools/x.mjs';
const PLAN = 'docs/plans/p.md';
const decisionsSeen = new Set();

const TOOL_INPUTS = {
  Write: (path) => ({ file_path: path, content: 'x' }),
  Edit: (path) => ({ file_path: path, old_string: 'a', new_string: 'b' }),
  MultiEdit: (path) => ({ file_path: path, edits: [{ old_string: 'a', new_string: 'b' }] }),
  NotebookEdit: (path) => ({ notebook_path: path, new_source: 'x' }),
  Bash: (path) => ({ command: `touch ${path}` }),
  Read: (path) => ({ file_path: path }),
};

const recordPathOf = (dir) => join(dir, '.git', RECORD_BASENAME);
const clearRecord = (dir) => rmSync(recordPathOf(dir), { recursive: true, force: true });
const writeRecord = (dir, { stage = RECORDED_STAGE, slotFile = SLOT_FILE, writes = AUTHORING, ...extra } = {}) => {
  clearRecord(dir);
  writeFileSync(recordPathOf(dir), JSON.stringify({ schema: 1, stage, slotFile, writes, ...extra }));
};

const makeWorld = (label) => {
  const repo = makeRepo(label);
  const decoy = makeRepo(`${label}-decoy`);
  writeRecord(decoy.dir, { stage: DECOY_STAGE });
  const outside = join(repo.home, 'outside');
  const config = join(repo.home, 'config');
  const memoryDir = join(config, 'projects', MEMORY_SEGMENT, 'memory');
  mkdirSync(outside);
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(config, 'plans'));
  writeJson(repo.dir, ORCHESTRATION_REL, { flow: FLOW });
  after(() => { repo.cleanup(); decoy.cleanup(); });
  return { repo, decoy, outside, config, memoryNote: join(memoryDir, 'note.md'), hostPlan: join(config, 'plans', 'plan.md'), at: (rel) => join(repo.dir, rel) };
};

const envOf = (world, over = {}) => Object.fromEntries(Object.entries({
  ...hermeticGitEnv(process.env, world.repo.home), CLAUDE_PROJECT_DIR: world.decoy.dir, CLAUDE_CONFIG_DIR: world.config, ...over,
}).filter(([, value]) => value !== undefined));

const noteDecision = (stdout) => {
  if (stdout.trim() === '') return;
  try {
    decisionsSeen.add(JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision ?? 'no decision field');
  } catch {
    decisionsSeen.add('unparsed output');
  }
};

const judge = (world, { tool = 'Write', target, cwd = world.repo.dir, env = envOf(world), toolInput, input } = {}) => {
  const payload = { session_id: 'session', transcript_path: join(world.outside, 'transcript.jsonl'), cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput ?? TOOL_INPUTS[tool](target) };
  const result = spawnSync(process.execPath, [HOOK_PATH], { input: input ?? JSON.stringify(payload), cwd: world.outside, env, encoding: 'utf8' });
  noteDecision(result.stdout);
  return result;
};

const assertNone = (result, label = '') => {
  assert.equal(result.status, 0, `${label} exit: ${result.stderr}`);
  assert.equal(result.stdout, '', `${label} prints no decision`);
};

const assertDeny = (result, fragments = [], label = '') => {
  assert.equal(result.status, 0, `${label} exit: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'], label);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), [...DENY_KEYS].sort(), label);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse', label);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', label);
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.equal(typeof reason, 'string', label);
  for (const fragment of fragments) assert.ok(reason.includes(fragment), `${label} the reason names ${fragment}: ${reason}`);
  return reason;
};

const writeFakeGit = (world, name, body, mode = 0o755) => {
  const dir = join(world.repo.home, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${body}\n`, { mode });
  return dir;
};

describe('spec:stage-write-guard/S1 the decision table', { skip: skipWithoutGit }, () => {
  const world = makeWorld('guard-s1');
  const stageDeny = [RECORDED_STAGE, SLOT_FILE, composeRenderLine(SLOT_FILE)];
  const OTHER_SLOT_FILE = 'docs/plans/other-session.json';

  it('a no-code record denies a code path and a test path under docs/plans, through each write tool', () => {
    writeRecord(world.repo.dir);
    for (const [tool, rel] of [['Write', CODE], ['Edit', 'docs/plans/x.test.mjs'], ['MultiEdit', 'tools/y.mjs'], ['NotebookEdit', 'notebooks/n.ipynb']]) {
      assertDeny(judge(world, { tool, target: world.at(rel) }), [world.at(rel), ...stageDeny], `${tool} ${rel}`);
    }
  });

  it('a no-code record passes every authoring document, the configured debt queue, a memory note and a host plan file', () => {
    writeRecord(world.repo.dir);
    const rels = [PLAN, 'docs/ai/specs/kit/x.md', 'docs/ai/epics/E.md', 'docs/plans/queue.md', SLOT_FILE, 'docs/plans/p-essence.txt', FLOW.debtQueue, FLOW.convergenceSummary];
    for (const rel of rels) assertNone(judge(world, { target: world.at(rel) }), rel);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assertNone(judge(world, { tool, target: world.memoryNote }), `${tool} memory note`);
    assertNone(judge(world, { target: world.hostPlan }), 'host plan file');
    assertDeny(judge(world, { target: join(dirname(world.memoryNote), 'x.mjs') }), [RECORDED_STAGE], 'code under the memory directory');
  });

  it('a no-code record denies a .json directly under docs/plans that is not the one slot file', () => {
    writeRecord(world.repo.dir);
    assertDeny(judge(world, { target: world.at(OTHER_SLOT_FILE) }), [world.at(OTHER_SLOT_FILE), RECORDED_STAGE], OTHER_SLOT_FILE);
  });

  it('the debt queue is the one the config names, and a configured .mjs path admits nothing', () => {
    writeRecord(world.repo.dir);
    writeJson(world.repo.dir, ORCHESTRATION_REL, { flow: { ...FLOW, debtQueue: 'docs/owed.md' } });
    assertNone(judge(world, { target: world.at('docs/owed.md') }), 'the configured debt queue');
    assertDeny(judge(world, { target: world.at(FLOW.debtQueue) }), [RECORDED_STAGE], 'a debt queue the config no longer names');
    writeJson(world.repo.dir, ORCHESTRATION_REL, { flow: { ...FLOW, debtQueue: 'docs/debt.mjs' } });
    assertDeny(judge(world, { target: world.at('docs/debt.mjs') }), [RECORDED_STAGE], 'a configured .mjs path');
    writeJson(world.repo.dir, ORCHESTRATION_REL, { flow: FLOW });
  });

  it('an any record passes every path, a code path included', () => {
    writeRecord(world.repo.dir, { stage: 'code', writes: ANY });
    for (const rel of [CODE, 'docs/plans/x.test.mjs', PLAN]) assertNone(judge(world, { target: world.at(rel) }), rel);
    assertNone(judge(world, { tool: 'NotebookEdit', target: world.at('notebooks/n.ipynb') }), 'notebook');
  });

  it('the call rows: an unreadable payload and no present record give none, a failing run denies', () => {
    writeRecord(world.repo.dir);
    assertNone(judge(world, { input: 'not json' }), 'unreadable payload');
    clearRecord(world.repo.dir);
    assertNone(judge(world, { target: world.at(CODE) }), 'no present record');
    const noGit = join(world.repo.home, 'no-git');
    mkdirSync(noGit);
    assertDeny(judge(world, { target: world.at(CODE), env: envOf(world, { PATH: noGit }) }), [world.at(CODE)], 'a failing run');
  });
});

describe('spec:stage-write-guard/S2 a record that cannot be read', { skip: skipWithoutGit }, () => {
  const world = makeWorld('guard-s2');
  const elsewhere = join(world.repo.home, 'elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify({ schema: 1, stage: 'code', slotFile: SLOT_FILE, writes: ANY }));
  const layRecord = {
    link: () => symlinkSync(elsewhere, recordPathOf(world.repo.dir)),
    directory: () => mkdirSync(recordPathOf(world.repo.dir)),
    'not JSON': () => writeFileSync(recordPathOf(world.repo.dir), '{ "schema": 1, '),
    'an extra key': () => writeRecord(world.repo.dir, { writes: ANY, extra: true }),
    'schema 2': () => writeFileSync(recordPathOf(world.repo.dir), JSON.stringify({ schema: 2, stage: 'code', slotFile: SLOT_FILE, writes: ANY })),
    'writes other': () => writeRecord(world.repo.dir, { writes: 'other' }),
    'holding a key twice': () => writeFileSync(recordPathOf(world.repo.dir), `{"schema":1,"stage":"code","slotFile":"${SLOT_FILE}","writes":"authoring","writes":"any"}`),
    'holding an escaped key twice': () => writeFileSync(recordPathOf(world.repo.dir), `{"schema":1,"stage":"code","slotFile":"${SLOT_FILE}","writes":"authoring","wri\\u0074es":"any"}`),
    'of an unknown stage': () => writeRecord(world.repo.dir, { stage: 'bogus', writes: ANY }),
    'naming another slot file': () => writeRecord(world.repo.dir, { stage: 'code', slotFile: 'docs/plans/other-session.json', writes: ANY }),
  };

  for (const [state, lay] of Object.entries(layRecord)) {
    it(`a record that is ${state} denies a code target naming the record and passes the authoring documents`, () => {
      clearRecord(world.repo.dir);
      lay();
      assertDeny(judge(world, { target: world.at(CODE) }), [world.at(CODE), RECORD_BASENAME], state);
      for (const target of [world.at(PLAN), world.at(SLOT_FILE), world.memoryNote]) assertNone(judge(world, { target }), `${state} ${target}`);
    });
  }

  it('an unreadable record denies a code target and passes a plan', { skip: process.getuid?.() === 0 ? 'root reads a mode-000 file' : false }, () => {
    writeRecord(world.repo.dir, { writes: ANY });
    chmodSync(recordPathOf(world.repo.dir), 0o000);
    assertDeny(judge(world, { target: world.at(CODE) }), [RECORD_BASENAME], 'unreadable');
    assertNone(judge(world, { target: world.at(PLAN) }), 'unreadable, a plan');
    chmodSync(recordPathOf(world.repo.dir), 0o644);
  });

  it('a record whose lstat fails other than by no entry denies a code target naming the record and passes a plan', () => {
    const fileGitDir = world.at(ORCHESTRATION_REL);
    const env = envOf(world, { PATH: writeFakeGit(world, 'file-git-dir', `printf '%s\\n%s\\n' '${world.repo.dir}' '${fileGitDir}'`) });
    assertDeny(judge(world, { target: world.at(CODE), env }), [join(fileGitDir, RECORD_BASENAME), 'ENOTDIR'], 'lstat ENOTDIR');
    assertNone(judge(world, { target: world.at(PLAN), env }), 'lstat ENOTDIR, a plan');
  });

  it('a record of that shape in any spacing, key order or key escaping decides by its writes', () => {
    const spaced = `{\n\t"writes" : "any",\r\n  "slotFile":"${SLOT_FILE}", "stage": "code",  "\\u0073chema": 1 }\n`;
    writeFileSync(recordPathOf(world.repo.dir), spaced);
    assertNone(judge(world, { target: world.at(CODE) }), 'spaced any record');
    writeFileSync(recordPathOf(world.repo.dir), spaced.replace('"any"', '"authoring"'));
    assertDeny(judge(world, { target: world.at(CODE) }), ['code', SLOT_FILE], 'spaced authoring record');
  });

  it('the record the renderer composes is read for every stage of the table and for null', async () => {
    const { composeStageRecord, loadStages } = await import('../stage-render/index.mjs');
    const table = loadStages(readFileSync(join(HERE, '..', 'stage-render', 'stages.json'), 'utf8'));
    for (const stage of [null, ...Object.keys(table.stages)]) {
      writeFileSync(recordPathOf(world.repo.dir), composeStageRecord({ stage, writes: ANY }));
      assertNone(judge(world, { target: world.at(CODE) }), `${stage} any`);
      writeFileSync(recordPathOf(world.repo.dir), composeStageRecord({ stage, writes: AUTHORING }));
      assertDeny(judge(world, { target: world.at(CODE) }), [SLOT_FILE], `${stage} authoring`);
    }
  });

  it('a null-stage record denies a code target naming the slot file alone', () => {
    writeRecord(world.repo.dir, { stage: null });
    const reason = assertDeny(judge(world, { target: world.at(CODE) }), [SLOT_FILE, composeRenderLine(SLOT_FILE)], 'null stage');
    assert.equal(reason.includes('null'), false, reason);
  });
});

describe('spec:stage-write-guard/S3 the path judged at its real place', { skip: skipWithoutGit }, () => {
  const world = makeWorld('guard-s3');
  world.repo.write(CODE, 'export {};\n');
  world.repo.write('docs/ai/specs/kit/x.md', '# x\n');
  mkdirSync(world.at('docs/plans'), { recursive: true });
  symlinkSync(world.at(CODE), world.at('docs/plans/alias.md'));
  symlinkSync(world.at('docs/ai/specs/kit/x.md'), world.at('docs/plans/spec-alias.md'));
  symlinkSync(world.at('tools'), world.at('docs/plans/code-dir'));

  it('a relative target resolves against the payload cwd, never the process cwd', () => {
    writeRecord(world.repo.dir);
    assertNone(judge(world, { target: 'p.md', cwd: world.at('docs/plans') }), 'relative plan');
    assertDeny(judge(world, { target: 'x.mjs', cwd: world.at('docs/plans') }), [RECORDED_STAGE], 'relative code');
  });

  it('a link into code is denied and a link between two authoring documents passes', () => {
    writeRecord(world.repo.dir);
    assertDeny(judge(world, { target: world.at('docs/plans/alias.md') }), [RECORDED_STAGE], 'leaf link into code');
    assertDeny(judge(world, { target: world.at('docs/plans/code-dir/y.md') }), [RECORDED_STAGE], 'directory link into code');
    assertNone(judge(world, { target: world.at('docs/plans/spec-alias.md') }), 'link between authoring documents');
  });

  it('a link to a file not yet written is judged where it points', () => {
    writeRecord(world.repo.dir);
    symlinkSync(world.at('tools/new.mjs'), world.at('docs/plans/new-alias.md'));
    symlinkSync(world.at('docs/plans/new.md'), world.at('tools/new-alias.mjs'));
    assertDeny(judge(world, { target: world.at('docs/plans/new-alias.md') }), [RECORDED_STAGE], 'dangling link into code');
    assertNone(judge(world, { target: world.at('tools/new-alias.mjs') }), 'dangling link into a plan');
  });

  it('a tool_input path holding a .. segment is never an authoring document', () => {
    writeRecord(world.repo.dir);
    assertDeny(judge(world, { target: `${world.repo.dir}/docs/plans/../plans/p.md` }), [RECORDED_STAGE], 'dot-dot');
  });

  it('a memory note under a linked configuration directory passes', () => {
    writeRecord(world.repo.dir);
    const linkedConfig = join(world.repo.home, 'config-link');
    symlinkSync(world.config, linkedConfig);
    assertNone(judge(world, { target: world.memoryNote, env: envOf(world, { CLAUDE_CONFIG_DIR: linkedConfig }) }), 'CLAUDE_CONFIG_DIR a link');
    symlinkSync(world.config, join(world.repo.home, '.claude'));
    const throughHome = join(world.repo.home, '.claude', 'projects', MEMORY_SEGMENT, 'memory', 'note.md');
    assertNone(judge(world, { target: throughHome, env: envOf(world, { CLAUDE_CONFIG_DIR: undefined }) }), 'HOME/.claude a link');
  });
});

describe('spec:stage-write-guard/S5 the call rows come first', { skip: skipWithoutGit }, () => {
  const world = makeWorld('guard-s5');
  const failing = (env, label, fragments = []) => {
    assertDeny(judge(world, { target: world.at(CODE), env }), [world.at(CODE), ...fragments], `${label} code`);
    assertDeny(judge(world, { target: world.at(PLAN), env }), [world.at(PLAN), ...fragments], `${label} plan`);
    assertNone(judge(world, { target: world.memoryNote, env }), `${label} memory note`);
  };

  it('a git absent from PATH denies a code target and a plan naming the failure and passes a memory note, with no record present', (t) => {
    const absent = fixtures.absentGit();
    t.after(absent.cleanup);
    clearRecord(world.repo.dir);
    failing(envOf(world, { PATH: absent.env.PATH }), 'ENOENT', ['ENOENT']);
  });

  it('a payload cwd that does not exist is a failed run', () => {
    clearRecord(world.repo.dir);
    const gone = join(world.repo.home, 'gone');
    assertDeny(judge(world, { target: world.at(CODE), cwd: gone }), [world.at(CODE)], 'absent cwd');
    assertNone(judge(world, { target: world.memoryNote, cwd: gone }), 'absent cwd, memory note');
  });

  it('a git that cannot execute, is killed, exits nonzero or answers garbage denies a code target', (t) => {
    clearRecord(world.repo.dir);
    const killed = fixtures.killedGit(['rev-parse']);
    t.after(killed.cleanup);
    failing(envOf(world, { PATH: killed.env.PATH }), 'signal', ['SIGKILL']);
    failing(envOf(world, { PATH: writeFakeGit(world, 'eacces', 'exit 0', 0o644) }), 'EACCES', ['EACCES']);
    const answers = {
      'exit 128 other wording': 'echo "fatal: something else entirely" >&2; exit 128',
      'exit 1': 'echo "fatal: broken" >&2; exit 1',
      'empty answer': 'exit 0',
      'garbage answer': 'echo garbage; exit 0',
      'paths without a real path': `printf '%s\\n%s\\n' '${join(world.repo.home, 'no-root')}' '${join(world.repo.home, 'no-git-dir')}'`,
    };
    for (const [label, body] of Object.entries(answers)) {
      const dir = writeFakeGit(world, label.replaceAll(' ', '-'), body);
      assertDeny(judge(world, { target: world.at(CODE), env: envOf(world, { PATH: dir }) }), [world.at(CODE)], label);
    }
  });

  it('an internal error on a recognized write denies a code target naming it and passes a memory note', () => {
    clearRecord(world.repo.dir);
    assertDeny(judge(world, { target: CODE, cwd: null }), [CODE, 'no absolute cwd'], 'no cwd, a relative target');
    assertDeny(judge(world, { target: world.at(CODE), cwd: 'relative' }), [world.at(CODE), 'no absolute cwd'], 'a relative cwd');
    assertNone(judge(world, { target: world.memoryNote, cwd: 'relative' }), 'a relative cwd, a memory note');
    const underFile = join(world.at(ORCHESTRATION_REL), 'x.mjs');
    assertDeny(judge(world, { target: underFile }), [underFile, 'could not judge', 'ENOTDIR'], 'a target under a regular file');
  });

  it('a cwd and a target in no work tree, and no present record file, give no decision', () => {
    clearRecord(world.repo.dir);
    assertNone(judge(world, { target: join(world.outside, 'x.mjs'), cwd: world.outside }), 'no work tree');
    assertNone(judge(world, { target: world.at(CODE) }), 'no present record');
  });

  it('under a no-code record a code target is denied from outside, in a linked work tree and outside every repository', () => {
    writeRecord(world.repo.dir);
    const linked = join(world.repo.home, 'linked');
    world.repo.must(['worktree', 'add', '--detach', linked]);
    assertDeny(judge(world, { target: world.at(CODE), cwd: world.outside }), [RECORDED_STAGE], 'cwd outside');
    assertDeny(judge(world, { target: join(linked, CODE) }), [RECORDED_STAGE], 'linked work tree');
    assertDeny(judge(world, { target: join(world.outside, 'x.mjs') }), [RECORDED_STAGE], 'target outside every repository');
    writeRecord(world.repo.dir, { stage: 'code', writes: ANY });
    assertNone(judge(world, { target: join(world.outside, 'x.mjs') }), 'any: target outside');
    assertNone(judge(world, { target: world.at(CODE), cwd: world.outside }), 'any: cwd outside');
    assertNone(judge(world, { target: join(linked, CODE) }), 'any: linked work tree');
  });

  it('a run under a translated locale is read through LC_ALL=C', () => {
    const translated = writeFakeGit(world, 'translated', `if [ "$LC_ALL" != C ]; then echo "fatal: [translated] no repository here" >&2; exit 128; fi\nexec "${REAL_GIT}" "$@"`);
    const env = envOf(world, { PATH: translated, LC_ALL: 'xx_XX.UTF-8', LANG: 'xx_XX.UTF-8' });
    clearRecord(world.repo.dir);
    assertNone(judge(world, { target: join(world.outside, 'x.mjs'), cwd: world.outside, env }), 'no work tree in C');
    writeRecord(world.repo.dir);
    assertDeny(judge(world, { target: world.at(CODE), env }), [RECORDED_STAGE, SLOT_FILE], 'the record read in C');
  });

  it('another tool, a missing or non-string path field and an unreadable payload give no decision', () => {
    writeRecord(world.repo.dir);
    for (const tool of ['Bash', 'Read']) assertNone(judge(world, { tool, target: world.at(CODE) }), tool);
    assertNone(judge(world, { toolInput: { content: 'x' } }), 'Write without file_path');
    assertNone(judge(world, { toolInput: { file_path: 42, content: 'x' } }), 'non-string file_path');
    assertNone(judge(world, { tool: 'NotebookEdit', toolInput: { file_path: world.at('n.ipynb'), new_source: 'x' } }), 'NotebookEdit without notebook_path');
    assertNone(judge(world, { input: 'not json' }), 'unreadable payload');
  });
});

describe('spec:stage-write-guard/S6 the hook is self-contained', () => {
  const STATIC_SPECIFIER = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gmu;
  const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)\)/gu;
  const NODE_LITERAL = /^['"]node:[^'"]+['"]$/u;

  it('every import specifier of its source is a node: module, and no dynamic import reaches anything else', () => {
    const source = readFileSync(HOOK_PATH, 'utf8');
    const specifiers = [...source.matchAll(STATIC_SPECIFIER)].map((match) => match[1] ?? match[2]);
    assert.ok(specifiers.length > 0, 'the hook imports its node: modules');
    for (const specifier of specifiers) assert.ok(specifier.startsWith('node:'), specifier);
    for (const match of source.matchAll(DYNAMIC_IMPORT)) assert.match(match[1].trim(), NODE_LITERAL);
  });

  it('sync-mirrors --check reports the family stage-guard-locations with no change', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-mirrors.mjs', '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const lines = result.stdout.split('\n');
    assert.ok(lines.includes('stage-guard-locations: 0 change(s), 1 identical'), result.stdout);
    assert.equal(lines.some((line) => line.includes('would') && line.includes('stage-write-guard.mjs')), false, result.stdout);
  });

  it('the generated region holds the record basename, the slot-file grammar, the hook location and the table\'s stage ids', async () => {
    const { STAGE_RECORD_BASENAME, SLOT_FILE_NAME, loadStages } = await import('../stage-render/index.mjs');
    const table = loadStages(readFileSync(join(HERE, '..', 'stage-render', 'stages.json'), 'utf8'));
    assert.ok(readFileSync(HOOK_PATH, 'utf8').includes(`const STAGE_IDS = ${JSON.stringify(Object.keys(table.stages))};`), 'the stage ids');
    const { STAGE_GUARD_HOOK } = await import('../../references/scripts/shared/index.mjs');
    assert.equal(STAGE_RECORD_BASENAME, RECORD_BASENAME);
    assert.equal(STAGE_GUARD_HOOK, '.claude/hooks/stage-write-guard.mjs');
    assert.ok(SLOT_FILE_NAME !== undefined, 'the door exports SLOT_FILE_NAME');
    const grammar = SLOT_FILE_NAME instanceof RegExp ? SLOT_FILE_NAME.source : String(SLOT_FILE_NAME);
    const source = readFileSync(HOOK_PATH, 'utf8');
    assert.ok(source.includes(STAGE_RECORD_BASENAME), 'the record basename');
    assert.ok(source.includes(grammar) || source.includes(JSON.stringify(grammar)), 'the slot-file grammar');
    assert.ok(source.includes(STAGE_GUARD_HOOK), 'the hook location');
  });
});

describe('spec:stage-write-guard/S4 the deny object', { skip: skipWithoutGit }, () => {
  const world = makeWorld('guard-s4');

  it('the deny prints exactly the PreToolUse deny object naming the target, the stage, its slot file and the render line, exit 0', () => {
    writeRecord(world.repo.dir, { stage: 'design-consult' });
    const result = judge(world, { target: world.at(CODE) });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason;
    assert.deepEqual(parsed, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    for (const fragment of [world.at(CODE), 'design-consult', SLOT_FILE, composeRenderLine(SLOT_FILE)]) assert.ok(reason.includes(fragment), `${fragment}: ${reason}`);
  });

  it('across every cell of the file the hook decided only deny, never allow or ask', () => {
    assert.deepEqual([...decisionsSeen], ['deny']);
  });
});
