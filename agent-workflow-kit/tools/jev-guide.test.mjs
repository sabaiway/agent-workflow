import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, READ_ONLY, commandFor, routeInvocation } from './commands.mjs';

// The guide and the facts leaf are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const loaded = await import('./jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const connectLine = (await import('./jev-facts.mjs').catch(() => ({}))).connectLine ?? (() => { throw new Error('connectLine is absent'); });
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CLI = join(TOOLS, 'jev-guide.mjs');
const LF = '\n';
const KEY = 'TYPESAFE_API_KEY';
const HEADING = 'WHERE IT PAYS IN THIS WORKFLOW';
const ENVELOPE_KEYS = ['schema', 'command', 'dir', 'text', 'skill', 'key', 'connect', 'steps', 'prompts'];
const ROUTER_LINE = 'read-only — read `${CLAUDE_SKILL_DIR}/references/modes/jev.md` before acting.';
const RUN_LINE = 'node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json';
const NOT_A_REPLACEMENT = '"Jev is not a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot"';

const has = (...parts) => (text) => parts.every((part) => (part instanceof RegExp ? part.test(text) : text.includes(part)));
const edge = (part) => has('jev-1.13', part);
// One check per element of the fixed array, in the contract's order: each element is claimed by exactly one.
const ELEMENT_CHECKS = [
  ['WHAT', has(/^WHAT: /, 'decision model', 'a state and typed questions (choice, score, noul)', 'typed answers',
    'probabilities', 'a confidence', 'does not write text')],
  ['WHY HERE', has(/^WHY HERE: /, 'a typed decision with a confidence instead of prompt-and-parse',
    'the user\'s own code', 'the agent\'s scratch scripts')],
  ['price and latency', has('0.042 dollars per million input tokens', 'output free', 'sub-second', 'as the vendor states')],
  ['the quoted vendor sentence', has(/^NOT: /, NOT_A_REPLACEMENT)],
  ['literal reading', edge(/literal/)],
  ['no counting or arithmetic', edge('no counting or arithmetic')],
  ['dates read as text', edge(/dates (are )?read as text/)],
  ['a large irrelevant state distracts', edge('large irrelevant state distracts')],
  ['adversarial content', edge('adversarial content can move the answer')],
  ['indirection', edge('indirection lowers accuracy')],
  ['no structural invariants', edge('no structural invariants across questions')],
  ['no generation', edge('no generation')],
  ['the confidence caveat', has(/confidence is not a correctness/i, 'conservative thresholds', 'test with your own data')],
  ['retention', has('zero data retention for enterprise customers only', 'data processing agreement',
    'not to train on user data')],
  ['source docs.typesafe.ai', has(/^SOURCES: /, 'docs.typesafe.ai', 'every Jev claim', 'read 2026-09-29')],
  ['source skills CLI README', has('skills CLI README', 'skill paths', 'read 2026-09-29')],
  ['source code.claude.com', has('code.claude.com', 'claude plugin list', 'read 2026-09-29')],
];
const PROMPT_CHECKS = [
  has(/gate log/i, 'failing gate', /\bchoice\b/, 'first real error'),
  has(/finding/i, 'decided register', /register id/, /\bchoice\b/, /\bnone\b/),
  has(/paragraph/i, /\bnoul\b/, 'named rule'),
];
const STEP_HEADINGS = ['STEP 1 — the key', 'STEP 2 — the vendor skill'];
const ORDER_LINE = 'Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the two steps — the key with its connect line and its mark, the vendor skill with its install lines, its mark and its first prompt; then the three prompts where it pays.';
const INVARIANTS_LINE = "**Invariants:** the guide is read-only and opens no connection · the connect line is run by the user in a terminal of their own, never by the agent · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · process.exitCode, never process.exit().";
const USAGE = [['--bogus'], ['--dir'], ['--dir', '--json'], ['--json', 'extra'], ['--help', '--json'],
  ['-h', '--dir', '.'], ['--help', '--help'], ['-h', '-h']];

const made = [];
const cells = {};
const tmp = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `jev-${tag}-`));
  made.push(dir);
  return dir;
};
const withSkill = (root) => {
  const path = join(root, '.claude', 'skills', 'typesafe-ai', 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# the vendor skill\n');
  return path;
};
const runMain = (argv, io) => {
  const out = [];
  const err = [];
  const code = main(argv, { log: (text) => out.push(text), error: (text) => err.push(text), ...io });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const ioOf = (cell) => ({ cwd: cells[cell].dir, env: cells[cell].env, home: cells[cell].home });
const render = (cell, argv = []) => runMain(['--dir', cells[cell].dir, ...argv], ioOf(cell));
const envelopeOf = (cell) => JSON.parse(render(cell, ['--json']).stdout);
const linesOf = (cell) => render(cell).stdout.split(LF);
const spawnCli = (args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
};

before(() => {
  cells.bare = { dir: tmp('bare'), home: tmp('home'), env: {} };
  const found = tmp('found');
  cells.found = { dir: found, home: tmp('home'), env: { [KEY]: 'jev-canary-value', SHELL: '/bin/bash' }, skill: withSkill(found) };
});
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('spec:jev-guide/S1 the fixed text first, seventeen strings each claimed by one check', () => {
  it('exports JEV_TEXT frozen, seventeen strings, each claimed by exactly one element check in order', () => {
    const text = loaded.JEV_TEXT;
    assert.ok(Array.isArray(text) && Object.isFrozen(text), 'JEV_TEXT is a frozen array');
    assert.equal(text.length, ELEMENT_CHECKS.length);
    text.forEach((element, index) => {
      const claims = ELEMENT_CHECKS.flatMap(([name, check]) => (check(element) ? [name] : []));
      assert.deepEqual(claims, [ELEMENT_CHECKS[index][0]], element);
    });
  });

  it('prints the fixed array first in every plain render and carries it as text in JSON', () => {
    for (const cell of ['bare', 'found']) {
      assert.deepEqual(linesOf(cell).slice(0, loaded.JEV_TEXT.length), [...loaded.JEV_TEXT], cell);
      assert.deepEqual(envelopeOf(cell).text, [...loaded.JEV_TEXT], cell);
    }
  });
});

describe('spec:jev-guide/S6 three workflow prompts where Jev pays', () => {
  it('prints three prompts over candidate ids within the vendor limits, each a hint and never a gate', () => {
    for (const cell of ['bare', 'found']) {
      const { prompts } = envelopeOf(cell);
      assert.equal(prompts.length, PROMPT_CHECKS.length, cell);
      prompts.forEach((prompt, index) => {
        assert.ok(PROMPT_CHECKS[index](prompt), prompt);
        assert.ok(has(/\bids?\b/, '255 options', '64k tokens', '32k for the state plus the longest question')(prompt), prompt);
        assert.ok(has(/\bhint\b/, 'never a gate', 'every candidate text is sent to the vendor')(prompt), prompt);
      });
      const lines = linesOf(cell);
      assert.deepEqual(lines.slice(lines.indexOf(HEADING) + 1), prompts, cell);
    }
  });
});

describe('spec:jev-guide/S9 the exit table', () => {
  it('answers --help or -h alone with the usage text at exit 0, reading neither the dir, the home nor the key', () => {
    for (const flag of ['--help', '-h']) {
      const reads = [];
      const out = [];
      const io = new Proxy({ log: (text) => out.push(text), error: (text) => out.push(text), cwd: join(tmp('help'), 'absent'),
        env: {}, home: join(tmp('help'), 'absent') }, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
      assert.equal(main([flag], io), 0, flag);
      assert.deepEqual(reads.filter((prop) => !['log', 'error'].includes(prop)), [], flag);
      assert.match(out.join(LF), /Usage/, flag);
      assert.match(out.join(LF), /Reads only:[^\n]*key variable[^\n]*five skill paths/, `${flag}: the Reads only sentence names the key and the five paths`);
      assert.doesNotMatch(out.join(LF), /Reads only:[^\n]*\bSHELL\b/, `${flag}: SHELL is no longer read`);
      for (const element of loaded.JEV_TEXT) assert.ok(!out.join(LF).includes(element), `${flag}: ${element}`);
    }
  });

  it('exits 1 with nothing rendered when the --dir is absent, a regular file or a link to itself', () => {
    const root = tmp('exit');
    writeFileSync(join(root, 'file'), 'x');
    symlinkSync('self', join(root, 'self'));
    for (const name of ['absent', 'file', 'self']) {
      const result = runMain(['--dir', join(root, name)], { cwd: root, env: {}, home: tmp('home') });
      assert.deepEqual([result.code, result.stdout], [1, ''], name);
      assert.notEqual(result.stderr, '', name);
    }
  });

  it('exits 2 on every usage refusal and returns without exiting', () => {
    const exitCode = process.exitCode;
    for (const argv of USAGE) {
      const result = runMain(argv, ioOf('bare'));
      assert.deepEqual([result.code, result.stdout], [2, ''], argv.join(' '));
      assert.notEqual(result.stderr, '', argv.join(' '));
    }
    assert.equal(render('bare').code, 0);
    assert.equal(process.exitCode, exitCode);
  });

  it('answers the repository file as a command: a render exits 0 and a usage error exits 2', () => {
    const run = spawnCli(['--dir', cells.bare.dir, '--json']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).command, 'jev');
    const usage = spawnCli(['--bogus']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument/);
  });
});

describe('spec:jev-guide/S10 the JSON envelope and the plain render carry the same facts', () => {
  it('keeps the envelope keys and the plain composition in a bare cell and in a found-and-set cell', () => {
    for (const [cell, found, set] of [['bare', [], false], ['found', [join('.claude', 'skills', 'typesafe-ai', 'SKILL.md')], true]]) {
      const envelope = envelopeOf(cell);
      assert.deepEqual(Object.keys(envelope), ENVELOPE_KEYS, cell);
      assert.deepEqual([envelope.schema, envelope.command, envelope.dir], [1, 'jev', cells[cell].dir], cell);
      assert.deepEqual(envelope.text, [...loaded.JEV_TEXT], cell);
      assert.deepEqual(envelope.skill, { found: found.map((path) => join(cells[cell].dir, path)) }, cell);
      assert.deepEqual(envelope.key, { set }, cell);
      assert.equal(envelope.connect, connectLine(TOOLS), cell);
      assert.deepEqual(envelope.steps.map(([heading]) => heading), STEP_HEADINGS, cell);
      assert.ok(envelope.steps.every((step) => step.every((line) => typeof line === 'string')), cell);
      assert.ok(envelope.prompts.length === 3 && envelope.prompts.every((prompt) => typeof prompt === 'string'), cell);
      const composed = [...envelope.text, ...envelope.steps.flat(), HEADING, ...envelope.prompts].join(LF);
      assert.equal(render(cell).stdout, composed, cell);
    }
  });
});

describe('spec:jev-guide/S11 registration: the catalog entry, the SKILL header and the mode doc', () => {
  it('places the jev catalog entry directly after tier, in Inspect, read-only, and routes the token', () => {
    const command = commandFor('jev');
    assert.ok(command, 'the jev catalog entry exists');
    assert.deepEqual([command.group, command.kind], ['Inspect', READ_ONLY]);
    assert.ok(has(/\bJev\b/, 'TypeSafe', /\bguide\b/i)(command.oneLine), command.oneLine);
    const keys = COMMANDS.map(({ key }) => key);
    assert.equal(keys.indexOf('jev'), keys.indexOf('tier') + 1);
    assert.equal(routeInvocation('jev'), 'jev');
    assert.equal(routeInvocation('/agent-workflow-kit jev'), 'jev');
  });

  it('puts the Mode: jev header with the tier-form router line directly after the tier section', () => {
    const skill = readFileSync(join(TOOLS, '../SKILL.md'), 'utf8');
    const tier = skill.indexOf('### Mode: tier');
    assert.ok(tier >= 0);
    assert.equal(skill.indexOf('### Mode: ', tier + 1), skill.indexOf('### Mode: jev'));
    assert.ok(skill.includes(`### Mode: jev${LF}${LF}${ROUTER_LINE}${LF}`));
  });

  it('gives the mode doc its run line, the jev-connect declaration on line 3, the render sentences, the order and the invariants', () => {
    const doc = readFileSync(join(TOOLS, '../references/modes/jev.md'), 'utf8');
    assert.ok(doc.includes(RUN_LINE));
    assert.equal(doc.split(LF)[2], '<!-- opt-in-capability: jev-connect -->');
    assert.ok(has(/the user's (conversational )?language/, /never paste the JSON/i, /every path and (every )?command verbatim/i)(doc));
    assert.match(doc, /vendor-quoted text verbatim and (in quotes|quoted), never translated or reflowed: the not-a-replacement sentence\./);
    for (const line of [ORDER_LINE, INVARIANTS_LINE]) assert.equal(doc.split(LF).filter((item) => item === line).length, 1, line);
  });

  it('states the hand-over rule and carries no walk, no curl and no network sentence', () => {
    const doc = readFileSync(join(TOOLS, '../references/modes/jev.md'), 'utf8');
    for (const rule of [/The connect line is the user's: hand it over as printed and never run it/,
      /refuses without a terminal, and a terminal is not consent/, /install lines are the user's too/,
      /No command the guide prints is run by the agent\./]) assert.match(doc, rule);
    assert.doesNotMatch(doc, /Nothing in this mode is run/);
    assert.doesNotMatch(doc, /curl|STEP 3|walk|--trace|explicit yes|blocked host/i);
  });
});
