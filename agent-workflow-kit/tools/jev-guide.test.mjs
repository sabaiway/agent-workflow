import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, READ_ONLY, commandFor, routeInvocation } from './commands.mjs';

const loaded = await import('./jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CLI = join(TOOLS, 'jev-guide.mjs');
const LF = '\n';
const KEY = 'TYPESAFE_API_KEY';
const HEADING = 'WHERE IT PAYS IN THIS WORKFLOW';
const ENVELOPE_KEYS = ['schema', 'command', 'dir', 'text', 'skill', 'key', 'steps', 'prompts'];
const ROUTER_LINE = 'read-only — read `${CLAUDE_SKILL_DIR}/references/modes/jev.md` before acting.';
const RUN_LINE = 'node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json';

// The part's vendor texts, copied as literals (no suite reads docs/ai); a line wrap inside a quote reads as one space.
const NOT_A_REPLACEMENT = '"Jev is not a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot"';
const TICKETS = ['"I was charged twice this month."', '"The app crashes when I upload a file."',
  '"Is there a discount for a yearly plan?"'];
const CURL = `set +x; curl -q -sS -w ' HTTP %{http_code}' -X POST https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" -d '{"state":"Help! My payouts have been failing for 3 days.","model":"jev-latest","questions":{"department":{"type":"choice","instructions":"Which team should handle this?","criteria":{"billing":"Payments, invoicing, refunds","technical":"Bugs, outages, integrations","sales":"Pricing, upgrades, new accounts"}}}}'`;
const CHECK = 'HTTP 200 and a response whose answers.department carries a choice and a confidence; any other code reads by the four error meanings below';
const RESPONSE = '{"model":"jev-1.13.0","answers":{"department":{"type":"choice","choice":"billing","probabilities":{"billing":0.88,"technical":0.12,"sales":0.0},"confidence":0.81}},"usage":{"input_tokens":318,"output_tokens":34}}';
const FIELDS = [
  ['choice', 'The highest-probability option.'],
  ['probabilities', 'Every option mapped to its probability (floats that sum to 1).'],
  ['confidence', 'How certain the model is, derived from probabilities.'],
];
const ERRORS = [
  ['401', 'Missing or invalid API key. Check the `Authorization` header.'],
  ['422', 'The request body failed validation — for example a missing required field or a malformed question. The body details the offending field.'],
  ['429', 'You have exceeded your rate limit. Back off and retry after a short delay.'],
  ['529', 'TypeSafe is temporarily overloaded. Retry after a short delay.'],
];

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
const STEP_HEADINGS = ['STEP 1 — the key', 'STEP 2 — the vendor skill', 'STEP 3 — the first request'];
const ORDER_LINE = 'Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the three steps — the key with its line or its editor sentence and its mark, the vendor skill with its install lines and its mark, the first request with its curl line and its check; then the three prompts where it pays.';
const INVARIANTS_LINE = "**Invariants:** the guide is read-only and opens no connection · the agent runs STEP 3's curl line only on the user's explicit yes · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · process.exitCode, never process.exit().";
const CANARIES = ['tsk-C3d4', 'Yp8_another-longer-canary-value.z'];
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
  const api = join(tmp('api'), 'api.typesafe.ai');
  mkdirSync(api);
  cells.api = { dir: api, home: tmp('home'), env: {}, skill: withSkill(api) };
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
    for (const cell of ['bare', 'found', 'api']) {
      assert.deepEqual(linesOf(cell).slice(0, loaded.JEV_TEXT.length), [...loaded.JEV_TEXT], cell);
      assert.deepEqual(envelopeOf(cell).text, [...loaded.JEV_TEXT], cell);
    }
  });
});

describe('spec:jev-guide/S5 the first-request block quotes the vendor byte for byte', () => {
  it('carries the curl line, the check, the response, the meanings, the prompt and the success criterion, in that order', () => {
    for (const cell of ['bare', 'found']) {
      const [, , firstUse] = envelopeOf(cell).steps;
      const [prompt, ...extra] = firstUse.filter(has('using the TypeSafe skill', 'billing, technical or sales', 'one request each',
        'choice and confidence', ...TICKETS));
      assert.deepEqual(extra, [], cell);
      for (const line of [CURL, RESPONSE]) assert.equal(firstUse.filter((item) => item === line).length, 1, line);
      const [check] = firstUse.filter((item) => item.includes(CHECK));
      const [success] = firstUse.filter((item) => /three choices, each with a confidence/i.test(item));
      assert.equal(firstUse.filter((item) => item === check || item === success).length, 2, cell);
      const meanings = [...FIELDS, ...ERRORS].map(([, meaning]) => firstUse.findIndex((item) => item.includes(`"${meaning}"`)));
      const order = [CURL, check, RESPONSE].map((line) => firstUse.indexOf(line)).concat(meanings, [prompt, success].map((line) => firstUse.indexOf(line)));
      assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `${cell}: ${order}`);
    }
  });

  it('puts each field meaning and each error meaning, quoted, on one line with its own name or code', () => {
    for (const cell of ['bare', 'found']) {
      const lines = linesOf(cell);
      for (const group of [FIELDS, ERRORS]) {
        for (const [name, meaning] of group) {
          const holders = lines.filter((line) => line.includes(`"${meaning}"`));
          assert.equal(holders.length, 1, `${cell}: ${meaning}`);
          const rest = holders[0].replace(`"${meaning}"`, '');
          for (const [other] of group) {
            assert.equal(new RegExp(`\\b${other}\\b`).test(rest), other === name, `${cell}: ${name} line names ${other}`);
          }
        }
      }
    }
  });

  it('names api.typesafe.ai on exactly one line, the curl line, outside the lines naming a found path', () => {
    for (const cell of ['bare', 'found', 'api']) {
      const envelope = envelopeOf(cell);
      const { found } = envelope.skill;
      const outside = (items) => items.filter((item) => !found.some((path) => item.includes(path)))
        .filter((item) => item.includes('api.typesafe.ai'));
      assert.deepEqual(outside(linesOf(cell)), [CURL], cell);
      assert.deepEqual(outside([...envelope.steps.flat(), ...envelope.prompts]), [CURL], cell);
    }
    assert.ok(envelopeOf('api').skill.found.some((path) => path.includes('api.typesafe.ai')), 'the api cell finds its skill');
  });

  it('writes neither canary to stdout or stderr when bash -x runs the printed curl line with a stub curl first on PATH', () => {
    const bin = tmp('bin');
    writeFileSync(join(bin, 'curl'), "#!/bin/sh\nprintf ' HTTP 200'\n", { mode: 0o755 });
    const [curl] = linesOf('bare').filter((line) => line.includes('api.typesafe.ai'));
    assert.equal(curl, CURL);
    for (const canary of CANARIES) {
      const run = spawnSync('bash', ['-x', '-c', curl], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, [KEY]: canary } });
      assert.deepEqual([run.status, run.stdout], [0, ' HTTP 200'], run.stderr);
      for (const value of CANARIES) assert.ok(!run.stdout.includes(value) && !run.stderr.includes(value), `${canary}: ${value}`);
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
  it('answers --help or -h alone with the usage text at exit 0, reading neither the dir, the home, the key nor SHELL', () => {
    for (const flag of ['--help', '-h']) {
      const reads = [];
      const out = [];
      const io = new Proxy({ log: (text) => out.push(text), error: (text) => out.push(text), cwd: join(tmp('help'), 'absent'),
        env: {}, home: join(tmp('help'), 'absent') }, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
      assert.equal(main([flag], io), 0, flag);
      assert.deepEqual(reads.filter((prop) => !['log', 'error'].includes(prop)), [], flag);
      assert.match(out.join(LF), /Usage/, flag);
      assert.match(out.join(LF), /Reads only:[^\n]*\bSHELL\b/, `${flag}: the Reads only sentence names SHELL`);
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
    for (const [cell, found, set, profile] of [['bare', [], false, null], ['found', [join('.claude', 'skills', 'typesafe-ai', 'SKILL.md')], true, '~/.bashrc']]) {
      const envelope = envelopeOf(cell);
      assert.deepEqual(Object.keys(envelope), ENVELOPE_KEYS, cell);
      assert.deepEqual([envelope.schema, envelope.command, envelope.dir], [1, 'jev', cells[cell].dir], cell);
      assert.deepEqual(envelope.text, [...loaded.JEV_TEXT], cell);
      assert.deepEqual(envelope.skill, { found: found.map((path) => join(cells[cell].dir, path)) }, cell);
      assert.deepEqual(envelope.key, { set, profile }, cell);
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

  it('gives the mode doc its run line, the jev-connect declaration on line 3, both render sentences, the order and the invariants', () => {
    const doc = readFileSync(join(TOOLS, '../references/modes/jev.md'), 'utf8');
    assert.ok(doc.includes(RUN_LINE));
    assert.equal(doc.split(LF)[2], '<!-- opt-in-capability: jev-connect -->');
    assert.ok(has(/the user's (conversational )?language/, /never paste the JSON/i, /every path and (every )?command verbatim/i)(doc));
    assert.match(doc, /vendor-quoted text verbatim and (in quotes|quoted), never translated or reflowed: the not-a-replacement sentence, the curl line, the response, the three field meanings and the four error meanings/);
    for (const line of [ORDER_LINE, INVARIANTS_LINE]) assert.equal(doc.split(LF).filter((item) => item === line).length, 1, line);
  });

  it('states the walk rules: one step at a time, who runs each line, the curl line only on a yes and never tracing, the blocked host', () => {
    const doc = readFileSync(join(TOOLS, '../references/modes/jev.md'), 'utf8');
    for (const rule of [/one at a time/, /move on when the step's check passes or the user skips it/,
      /STEP 1: the user runs the key line[^.]*never the agent/, /STEP 2: the user runs the install lines/,
      /STEP 3: run the curl line only on the user's explicit yes/, /never with `-v`, `--trace` or any flag that prints request headers/,
      /a blocked host is named by the sandbox: the user allows it or runs the line in their own terminal/]) assert.match(doc, rule);
  });
});
