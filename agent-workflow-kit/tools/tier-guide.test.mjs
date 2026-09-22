import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures, skipWithoutGit } from './hostile-git-harness.test.mjs';
import { hashGitDir } from './now-facts.test.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { COMMANDS, READ_ONLY, commandFor } from './commands.mjs';
import { CELL_NAMES, listActions, makeStageRepo } from './tier-guide-harness.test.mjs';
import { EPIC_KEYS, LF, TASK_KEYS } from '../test/tier-walk-harness.test.mjs';

const loaded = await import('./tier-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CLI = join(TOOLS, 'tier-guide.mjs');
const TODAY = '2026-09-22';
const ENVELOPE_KEYS = ['schema', 'command', 'dir', 'tier', 'states', 'entries', 'skipped'];
const STATE_KEYS = ['reader', 'file', 'cause', 'next'];
const ENTRY_KEYS = ['stage', 'id', 'path', 'cause', 'fact', 'residual', 'actions', 'stories'];
const STORY_KEYS = ['id', 'plan', 'stage', 'residual', 'actions'];
const ACTION_KEYS = ['kind', 'text', 'command'];
const KINDS = ['run', 'write', 'fact'];
const ROUTER_LINE = 'read-only — read `${CLAUDE_SKILL_DIR}/references/modes/tier.md` before acting.';
const RUN_LINE = 'node ${CLAUDE_SKILL_DIR}/tools/tier-guide.mjs --dir <project> --json';
const USAGE = [['--bogus'], ['--dir'], ['--dir', '--json'], ['--format=json'], ['--json', 'extra'],
  ['--help', '--json'], ['-h', '--dir', '.'], ['--help', '--help']];
const cells = {};

const runMain = (argv, env) => {
  const out = [];
  const err = [];
  const code = main(argv, { log: (text) => out.push(text), error: (text) => err.push(text), env, today: TODAY });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const render = (cell, argv = []) => runMain(['--dir', cells[cell].dir, ...argv], cells[cell].env);
const envelopeOf = (cell) => JSON.parse(render(cell, ['--json']).stdout);
const spawnCli = (args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
};
const snapshotWorkTree = (root, relative = '') => readdirSync(join(root, relative)).sort()
  .filter((name) => relative || name !== '.git').flatMap((name) => {
    const path = join(relative, name);
    const stat = lstatSync(join(root, path));
    const signature = `${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    if (stat.isDirectory()) return [[path, signature], ...snapshotWorkTree(root, path)];
    const bytes = (() => { try { return stat.isFile() ? readFileSync(join(root, path)) : ''; } catch { return 'unreadable'; } })();
    return [[path, `${signature}:${createHash('sha256').update(bytes).digest('hex')}`]];
  });

before(() => {
  for (const cell of CELL_NAMES) cells[cell] = makeStageRepo(cell);
});
after(() => {
  for (const repo of Object.values(cells)) repo.cleanup();
});

describe('spec:tier-guide/S1 the tier text in every rendered state', { skip: skipWithoutGit }, () => {
  it('names the tier, the sessions, both templates, every key and the Recommendations pointer', () => {
    const { tier } = envelopeOf('E1-absent');
    for (const pattern of [/^An epic is /, /^A story is /, /^A task is /, /spec, plan, tests, code, diff review \+ release \+ record/]) {
      assert.equal(tier.filter((line) => pattern.test(line)).length, 1, String(pattern));
    }
    for (const name of ['EPIC_TEMPLATE.md', 'TASK_TEMPLATE.md']) {
      assert.equal(tier.filter((line) => line.endsWith(` ${resolve(TOOLS, '../references/authoring', name)}`)).length, 1, name);
    }
    for (const key of new Set([...EPIC_KEYS, ...TASK_KEYS])) {
      const expected = [EPIC_KEYS, TASK_KEYS].filter((keys) => keys.includes(key)).length;
      assert.equal(tier.filter((line) => new RegExp(`^\\s*${key}: \\S`).test(line)).length, expected, key);
    }
    assert.match(tier.find((line) => /^\s*EPIC_ID: /.test(line)), /stem.*Queue|Queue.*stem/);
    const pointer = `node ${shellQuoteArg(`${TOOLS}/recommendations.mjs`)} --cwd ${shellQuoteArg(cells['E1-absent'].dir)}`;
    assert.equal(tier.filter((line) => line === pointer).length, 1);
  });

  it('prints the same fixed text first in every cell of the ladder', () => {
    const [head] = envelopeOf('E1-absent').tier.slice(-1);
    const fixed = envelopeOf('E1-absent').tier.slice(0, -1);
    for (const cell of CELL_NAMES) {
      const { tier } = envelopeOf(cell);
      assert.deepEqual(tier.slice(0, -1), fixed, cell);
      assert.equal(tier.at(-1), head.replace(shellQuoteArg(cells['E1-absent'].dir), shellQuoteArg(cells[cell].dir)), cell);
      assert.deepEqual(render(cell).stdout.split(LF).slice(1, tier.length + 1), tier, cell);
    }
  });
});

describe('spec:tier-guide/S7 read-only in every rendered state', { skip: skipWithoutGit }, () => {
  it('leaves .git and the work tree byte-equal and renders an unchanged tree alike', () => {
    for (const cell of CELL_NAMES) {
      const { dir } = cells[cell];
      const before = { git: hashGitDir(join(dir, '.git')), tree: snapshotWorkTree(dir) };
      const plain = [render(cell), render(cell)];
      const json = [render(cell, ['--json']), render(cell, ['--json'])];
      assert.deepEqual({ git: hashGitDir(join(dir, '.git')), tree: snapshotWorkTree(dir) }, before, cell);
      assert.equal(plain[1].stdout, plain[0].stdout, cell);
      assert.equal(json[1].stdout, json[0].stdout, cell);
    }
  });
});

describe('spec:tier-guide/S8 the exit table and usage', { skip: skipWithoutGit }, () => {
  it('exits 0 in every cell, 1 outside a work tree and 2 on every usage refusal, never exiting', () => {
    const exitCode = process.exitCode;
    for (const cell of CELL_NAMES) assert.equal(render(cell).code, 0, cell);
    const outside = fixtures.notARepository();
    try {
      const result = runMain(['--dir', outside.cwd], outside.env);
      assert.deepEqual([result.code, result.stdout], [1, '']);
      assert.match(result.stderr, /is not a git work tree \(not-a-repository/);
    } finally {
      outside.cleanup();
    }
    for (const argv of USAGE) {
      const result = runMain(argv, process.env);
      assert.deepEqual([result.code, result.stdout], [2, ''], argv.join(' '));
      assert.notEqual(result.stderr, '', argv.join(' '));
    }
    for (const flag of ['--help', '-h']) assert.match(runMain([flag], process.env).stdout, /Usage/);
    assert.equal(process.exitCode, exitCode);
  });

  it('answers the repository file as a command: --help exits 0 and a usage error exits 2', () => {
    const help = spawnCli(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage/);
    const usage = spawnCli(['--bogus']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument/);
  });
});

describe('spec:tier-guide/S9 the three surfaces of the mode', () => {
  it('carries the catalog entry, the SKILL header and the mode doc run line', () => {
    const command = commandFor('tier');
    assert.ok(command, 'the tier catalog entry exists');
    assert.deepEqual([command.group, command.kind], ['Inspect', READ_ONLY]);
    assert.match(command.oneLine, /epic.*story.*task/i);
    assert.match(command.oneLine, /guide/i);
    const keys = COMMANDS.map(({ key }) => key);
    assert.equal(keys.indexOf('tier'), keys.indexOf('now') + 1);
    const skill = readFileSync(join(TOOLS, '../SKILL.md'), 'utf8');
    assert.ok(skill.includes(`### Mode: tier${LF}${LF}${ROUTER_LINE}${LF}`));
    assert.ok(skill.indexOf('### Mode: tier') > skill.indexOf('### Mode: now'));
    assert.ok(readFileSync(join(TOOLS, '../references/modes/tier.md'), 'utf8').includes(RUN_LINE));
  });
});

describe('spec:tier-guide/S11 the JSON envelope carries the facts of the render', { skip: skipWithoutGit }, () => {
  it('keeps the key order and three fields per action, and prints every run or fact command as a whole line', () => {
    for (const cell of CELL_NAMES) {
      const envelope = envelopeOf(cell);
      const lines = render(cell).stdout.split(LF);
      assert.deepEqual(Object.keys(envelope), ENVELOPE_KEYS, cell);
      assert.deepEqual([envelope.schema, envelope.command, envelope.dir], [1, 'tier', cells[cell].dir], cell);
      assert.equal(typeof envelope.skipped, 'number');
      for (const item of envelope.states) {
        assert.deepEqual(Object.keys(item), STATE_KEYS, cell);
        assert.ok(lines.some((line) => line.includes(item.cause)), `${cell}: ${item.cause}`);
      }
      for (const entry of envelope.entries) {
        assert.deepEqual(Object.keys(entry), ENTRY_KEYS, cell);
        for (const story of entry.stories) assert.deepEqual(Object.keys(story), STORY_KEYS, cell);
        if (entry.fact) assert.equal(entry.fact.kind, 'fact');
      }
      for (const action of listActions(envelope)) {
        assert.deepEqual(Object.keys(action), ACTION_KEYS, cell);
        assert.ok(KINDS.includes(action.kind), `${cell}: ${action.kind}`);
        assert.ok(action.command === null || typeof action.command === 'string', cell);
        assert.ok(lines.some((line) => line.includes(action.text)), `${cell}: ${action.text}`);
        if (action.command !== null) assert.ok(lines.includes(action.command), `${cell}: ${action.command}`);
      }
    }
  });

  it('prints an E3 epic\'s leftover Cleanup after its stories in hand, so the next step is the story\'s', () => {
    const lines = render('E3-cleanup').stdout.split(LF);
    const story = lines.indexOf('  story S2 - stage S1');
    const cleanup = lines.findIndex((line) => /^ {2}1\. prune the checkpoints of the plan/.test(line));
    assert.ok(story > 0 && cleanup > story, `story ${story}, cleanup ${cleanup}`);
  });
});
