// session-close-check.test.mjs — the read-only checker of a session close (docs/ai/specs/kit/tier/
// session-rules/, part session-close-check). Red first: the module is imported dynamically, so each
// cell fails at its first call into it, after its fixture ran for real.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLine } from './carriers.mjs';
import { stripGitLocationEnv } from './git-env.mjs';
import { APPROVED_PLAN_BODY } from './plan-approval/approved-plan-harness.test.mjs';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';

const loaded = await import('./session-close-check.mjs').catch(() => ({}));
const ABSENT = 'session-close-check.mjs main is absent';
const main = (...args) => (loaded.main ?? (() => { throw new Error(ABSENT); }))(...args);
const lines = () => {
  assert.ok(loaded.OUTCOME_LINES, 'session-close-check.mjs OUTCOME_LINES is absent');
  return loaded.OUTCOME_LINES;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'session-close-check.mjs');
const PURITY_TEST = join(HERE, '..', 'test', 'read-graph-purity.test.mjs');
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BOM = String.fromCharCode(0xfeff);
const HANDOVER = 'docs/ai/handover.md';
const HEADING = '## For the user';
const DONE = '**What was done, and for what:**';
const NEXT = '**What is next, and why:**';
const NEXT_HEADING = '## Next session';
const SLOT = 'docs/plans/next-session.json';
const PLAN = 'docs/plans/guide.md';
const RENDER_LINE = 'node <kit>/tools/stage-render/cli.mjs docs/plans/next-session.json';
const ACCEPT_LINE = 'session-close-check: accept — the handover carries the For the user section with both labels and their text, and the Next session block in its one form';
const PAUSE_SLOTS = { schema: 1, stage: 'pause', date: '2026-11-25' };
const NEXT_BLOCK = [NEXT_HEADING, '', RENDER_LINE];
const CYRILLIC = String.fromCharCode(0x0441, 0x0434, 0x0435, 0x043b, 0x0430, 0x043d, 0x043e);
const INVALID_UTF8 = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
const PLACEHOLDER_RE = /<kit>|<project>|undefined|\[object |\$\{/;
const bases = [];

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

const handover = (section = [HEADING, '', DONE, '- The queue is seeded.', '', NEXT, '- Write the tests.'], next = NEXT_BLOCK) =>
  ['# Handover', '', '**Active recipes:** solo', '', ...section, '', ...next, '', '## What was done last session', '', '- Work.', ''].join(LF);

// project({ text, docsAi, link }) → { root, base }: text is the handover (a string or a Buffer; null
// leaves it out; { kind: 'directory' } or { kind: 'symlink' } places that object instead); docsAi is
// 'directory' (default), 'absent', 'symlink' or 'file'; link 'root' or 'docs' links that component.
const project = ({ text = handover(), docsAi = 'directory', link, slots = PAUSE_SLOTS } = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'session-close-'));
  bases.push(base);
  const real = join(base, link ? 'real' : 'project');
  const docs = join(real, 'docs');
  mkdirSync(docs, { recursive: true });
  if (docsAi === 'file') writeFileSync(join(docs, 'ai'), 'not a directory');
  if (docsAi === 'symlink') {
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), join(docs, 'ai'));
  }
  if (docsAi === 'directory') {
    mkdirSync(join(docs, 'ai'));
    mkdirSync(join(docs, 'plans'));
    if (slots !== null) writeFileSync(join(real, SLOT), JSON.stringify(slots));
    const path = join(real, HANDOVER);
    if (typeof text === 'string' || Buffer.isBuffer(text)) writeFileSync(path, text);
    else if (text?.kind === 'directory') mkdirSync(path);
    else if (text?.kind === 'symlink') {
      writeFileSync(join(base, 'outside.md'), handover());
      symlinkSync(join(base, 'outside.md'), path);
    }
  }
  if (link === 'root') {
    symlinkSync(real, join(base, 'project'));
    return { root: join(base, 'project'), base };
  }
  if (link === 'docs') {
    mkdirSync(join(base, 'project'));
    symlinkSync(docs, join(base, 'project', 'docs'));
    return { root: join(base, 'project'), base };
  }
  return { root: real, base };
};

const snapshot = (path) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(path) };
  if (stat.isFile()) return { kind: 'file', bytes: readFileSync(path).toString('hex') };
  return { kind: 'directory', entries: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) };
};

const REAL = { lstatSync, lstat: lstatSync, open: openSync, fstat: fstatSync, readFile: readFileSync, close: closeSync };
const check = (root, deps = {}) => {
  const before = snapshot(root);
  const outcome = main(['--check', '--cwd', root], { ...REAL, ...deps });
  assert.ok(!(outcome instanceof Promise), 'main returns synchronously');
  assert.deepEqual(Object.keys(outcome).sort(), ['code', 'stderr', 'stdout']);
  assert.deepEqual(snapshot(root), before, 'the checker writes nothing');
  return outcome;
};
const failing = (code) => () => { throw Object.assign(new Error(`${code}: injected`), { code }); };
const assertRefusals = (outcome, expected) => {
  assert.equal(outcome.code, 1, outcome.stdout);
  assert.equal(outcome.stdout, '');
  assert.deepEqual(outcome.stderr.split(LF), expected);
};
const assertCannotJudge = (outcome, name) => {
  assert.equal(outcome.code, 2, outcome.stdout);
  assert.equal(outcome.stdout, '');
  assert.equal(outcome.stderr, name);
};
const assertAccept = (outcome) => {
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, ACCEPT_LINE);
  assert.equal(outcome.stdout.split(LF).length, 1);
  assert.equal(outcome.stderr, '');
};
const cleanEnv = () => {
  const env = stripGitLocationEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  return env;
};

describe('spec:session-rules/S5 the checker accepts on one conjunction', () => {
  for (const [name, text] of [
    ['an LF handover', handover()],
    ['a CRLF handover', handover().split(LF).join(CR + LF)],
    ['a handover whose text is in another language', handover([HEADING, DONE, `- ${CYRILLIC}.`, NEXT, `- ${CYRILLIC}.`])],
    ['labels carrying their text on their own line', handover([HEADING, `${DONE} the queue is seeded.`, `${NEXT} write the tests.`])],
    ['a section ending the file', ['# Handover', '', ...NEXT_BLOCK, '', HEADING, DONE, '- Done.', NEXT, '- Next.'].join(LF)],
    ['a byte-order mark before a first-line heading', [`${BOM}${HEADING}`, DONE, '- Done.', NEXT, '- Next.', ...NEXT_BLOCK].join(LF)],
  ]) {
    it(`accepts ${name}: one line, exit 0, nothing written`, () => {
      assertAccept(check(project({ text }).root));
    });
  }
});

describe('spec:session-rules/S6 usage is judged before any read; main returns and never asks', () => {
  const throwing = Object.fromEntries(Object.keys(REAL).map((name) => [name, () => { throw new Error(`${name} was called`); }]));
  for (const [name, argv] of [
    ['a --cwd missing its value', ['--check', '--cwd']],
    ['a --cwd followed by a flag', ['--cwd', '--check']],
    ['an unknown flag', ['--check', '--apply']],
    ['--check given twice', ['--check', '--check']],
    ['--cwd given twice', ['--check', '--cwd', '/a', '--cwd', '/b']],
    ['a missing --check', ['--cwd', '/nowhere']],
    ['no argument at all', []],
    ['--help beside --check', ['--help', '--check']],
  ]) {
    it(`exits 2 for ${name} before any read`, () => {
      const outcome = main(argv, throwing);
      assert.equal(outcome.code, 2, outcome.stdout);
      assert.equal(outcome.stdout, '');
      assert.equal(outcome.stderr.split(LF).length, 1);
      assert.match(outcome.stderr, /^usage: /);
    });
  }

  it('prints the help for --help alone at exit 0 before any read', () => {
    const outcome = main(['--help'], throwing);
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout, lines().help());
    assert.match(outcome.stdout, /--check/);
    assert.match(outcome.stdout, /Next session/);
    assert.equal(outcome.stderr, '');
  });

  it('reaches the filesystem through the injected deps, passed whole to every read', () => {
    const { root } = project();
    assertCannotJudge(check(root, { lstatSync: failing('EIO') }), 'no-deployment');
    assertCannotJudge(check(root, { open: failing('EACCES') }), 'handover-unreadable');
  });

  it('never exits and never reads from the terminal', () => {
    assert.doesNotMatch(readFileSync(MODULE, 'utf8'), /process\.exit\(|process\.stdin|node:readline/);
  });

  it('runs as a command, the project directory defaulting to the current one', () => {
    const { root } = project();
    const env = cleanEnv();
    const accepted = spawnSync(process.execPath, [MODULE, '--check'], { cwd: root, encoding: 'utf8', env });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, `${ACCEPT_LINE}${LF}`);
    const usage = spawnSync(process.execPath, [MODULE, '--bogus'], { cwd: root, encoding: 'utf8', env });
    assert.equal(usage.status, 2);
    assert.equal(usage.stdout, '');
  });
});

describe('spec:session-rules/S7 each cannot-judge state answers by its name alone at exit 2', () => {
  for (const [name, options, deps] of [
    ['docs/ai absent', { docsAi: 'absent' }],
    ['docs/ai a symlink', { docsAi: 'symlink' }],
    ['docs/ai a regular file', { docsAi: 'file' }],
    ['a symlinked root', { link: 'root' }],
    ['a symlinked docs component', { link: 'docs' }],
    ['a failed lstat of docs', {}, (root) => ({ lstatSync: (path) => (path === join(root, 'docs') ? failing('EACCES')() : lstatSync(path)) })],
  ]) {
    it(`answers no-deployment for ${name}`, () => {
      const { root } = project(options);
      assertCannotJudge(check(root, deps ? deps(root) : {}), 'no-deployment');
    });
  }

  for (const [state, name, options, deps] of [
    ['handover-symlink', 'a symlinked handover', { text: { kind: 'symlink' } }],
    ['handover-not-regular', 'a directory at the handover path', { text: { kind: 'directory' } }],
    ['handover-unreadable', 'a failed open', {}, { open: failing('EACCES') }],
    ['handover-unreadable', 'a failed read', {}, { readFile: failing('EIO') }],
    ['handover-unreadable', 'bytes that are not UTF-8', { text: INVALID_UTF8 }],
  ]) {
    it(`answers ${state} for ${name}`, () => {
      assertCannotJudge(check(project(options).root, deps), state);
    });
  }
});

describe('spec:session-rules/S8 each refusal answers by its name at exit 1, every one found printed', () => {
  it('refuses a close with no handover as handover-absent', () => {
    assertRefusals(check(project({ text: null }).root), ['handover-absent']);
  });

  for (const [name, section] of [
    ['no heading', [DONE, '- Done.', NEXT, '- Next.']],
    ['a heading with a trailing space', [`${HEADING} `, DONE, '- Done.', NEXT, '- Next.']],
    ['a third-level heading', [`#${HEADING}`, DONE, '- Done.', NEXT, '- Next.']],
  ]) {
    it(`refuses ${name} as section-absent`, () => {
      assertRefusals(check(project({ text: handover(section, []) }).root), ['section-absent', 'next-absent']);
    });
  }

  it('refuses a doubled section as section-twice and withholds the label judgement', () => {
    const text = handover([HEADING, NEXT, HEADING, DONE], []);
    assertRefusals(check(project({ text }).root), ['section-twice', 'next-absent']);
  });

  it('ends the section at the next level-two heading', () => {
    const text = ['# Handover', HEADING, '', '## Elsewhere', DONE, '- Done.', NEXT, '- Next.', ...NEXT_BLOCK, ''].join(LF);
    assertRefusals(check(project({ text }).root), [`label-absent: ${DONE}`, `label-absent: ${NEXT}`]);
  });

  it('refuses each missing label with its name and label, in label order', () => {
    assertRefusals(check(project({ text: handover([HEADING, NEXT, '- Next.']) }).root), [`label-absent: ${DONE}`]);
    assertRefusals(check(project({ text: handover([HEADING, '- Text.']) }).root), [`label-absent: ${DONE}`, `label-absent: ${NEXT}`]);
  });

  it('refuses a label on two lines as label-twice and judges the other label alone', () => {
    const text = handover([HEADING, DONE, '- Done.', `${DONE} again`, NEXT]);
    assertRefusals(check(project({ text }).root), [`label-twice: ${DONE}`, `label-empty: ${NEXT}`]);
  });

  it('refuses labels in the wrong order as label-order, its name alone', () => {
    const text = handover([HEADING, NEXT, '- Next.', DONE, '- Done.']);
    assertRefusals(check(project({ text }).root), ['label-order']);
  });

  it('refuses a label with no text before the next label as label-empty', () => {
    const text = handover([HEADING, DONE, '', '  ', NEXT, '- Next.']);
    assertRefusals(check(project({ text }).root), [`label-empty: ${DONE}`]);
  });

  it('refuses a label with no text before the section end as label-empty, CR stripped', () => {
    const text = handover([HEADING, DONE, '- Done.', `${NEXT}  `, '']).split(LF).join(CR + LF);
    assertRefusals(check(project({ text }).root), [`label-empty: ${NEXT}`]);
  });

  it('prints every refusal found in one run, one per line, in state order', () => {
    const text = handover([HEADING, NEXT, DONE]);
    assertRefusals(check(project({ text }).root), ['label-order', `label-empty: ${DONE}`, `label-empty: ${NEXT}`]);
  });

  it('judges order and emptiness only over labels present exactly once', () => {
    const text = handover([HEADING, NEXT, NEXT, '- Next.']);
    assertRefusals(check(project({ text }).root), [`label-absent: ${DONE}`, `label-twice: ${NEXT}`]);
  });
});

describe('spec:session-rules/S16 every printed line comes from the one OUTCOME_LINES table', () => {
  it('exports exactly the five composers, each rendering no placeholder or unrendered argument', () => {
    const table = lines();
    assert.ok(Object.isFrozen(table));
    assert.deepEqual(Object.keys(table).sort(), ['accept', 'help', 'labelState', 'state', 'usage']);
    for (const line of [table.accept(), table.help(), table.state('label-order'), table.labelState('label-empty', DONE),
      table.usage('unknown argument --bogus')]) {
      assert.doesNotMatch(line, PLACEHOLDER_RE, line);
    }
  });

  it('renders a control byte in a composed detail as a safe line', () => {
    assert.equal(lines().usage(`unknown argument --a${LF}b`).split(LF).length, 1);
  });
});

describe('spec:session-rules/S17 the next-session block accepts on one conjunction', () => {
  it('accepts the canonical line with blank lines and a CRLF section ending the file', () => {
    const text = [handover(undefined, []), NEXT_HEADING, '  ', RENDER_LINE, '', ''].join(LF).replaceAll(LF, CR + LF);
    assertAccept(check(project({ text, slots: { ...PAUSE_SLOTS, stage: 'empty-queue' } }).root));
  });

  const { root } = project({ slots: { ...PAUSE_SLOTS, stage: 'tests', plan: PLAN } });
  writeFileSync(join(root, PLAN), APPROVED_PLAN_BODY);
  writeFileSync(join(root, 'docs/readme.md'), 'Guide.\n');
  it('accepts the canonical line of a tests slot file whose plan has no approval record', () => {
    assertAccept(check(root));
  });

  it('the render of that same tests slot file refuses without an approval record', () => {
    makeFixtureRepo((args) => {
      const result = spawnSync('git', args, { encoding: 'utf8', env: cleanEnv() });
      assert.equal(result.status, 0, result.stderr);
    }, root, ['--quiet']);
    const rendered = spawnSync(process.execPath, [join(HERE, 'stage-render/cli.mjs'), SLOT], {
      cwd: root, encoding: 'utf8', env: { ...cleanEnv(), AGENT_WORKFLOW_ENGINE_DIR: resolve(HERE, '../../agent-workflow-engine') },
    });
    assert.ifError(rendered.error);
    assert.equal(rendered.status, 1, rendered.stderr);
    assert.match(rendered.stdout + rendered.stderr, /waiting-on-approval/);
    assert.match(rendered.stdout + rendered.stderr, /plan-approval\/cli\.mjs\s+record\b/);
  });
});

describe('spec:session-rules/S18 each next-session refusal prints after every For the user refusal found', () => {
  const section = [HEADING, NEXT, DONE];
  const userRefusals = ['label-order', `label-empty: ${DONE}`, `label-empty: ${NEXT}`];
  for (const [name, next, expected] of [
    ['next-absent', [], 'next-absent'],
    ['next-twice', [NEXT_HEADING, 'wrong form', NEXT_HEADING], 'next-twice'],
    ['next-empty', [NEXT_HEADING, '', '  '], 'next-empty'],
    ['next-many', [NEXT_HEADING, RENDER_LINE, 'another line'], 'next-many'],
    ['next-form', [NEXT_HEADING, 'node\t<kit>/tools/stage-render/cli.mjs docs/plans/next-session.json'], `next-form: ${RENDER_LINE}`],
    ['next-form for a noncanonical quoted operand', [NEXT_HEADING, "node <kit>/tools/stage-render/cli.mjs 'docs/plans/next-session.json'"], "next-form: node <kit>/tools/stage-render/cli.mjs 'docs/plans/next-session.json'"],
    ['next-form for an empty quoted operand', [NEXT_HEADING, "node <kit>/tools/stage-render/cli.mjs ''"], "next-form: node <kit>/tools/stage-render/cli.mjs ''"],
  ]) {
    it(`answers ${name} beside all For the user refusals`, () => {
      assertRefusals(check(project({ text: handover(section, next) }).root), [...userRefusals, expected]);
      assertRefusals(check(project({ text: handover(undefined, next) }).root), [expected]);
    });
  }

  for (const [name, slots] of [['absent', null], ['invalid', { ...PAUSE_SLOTS, extra: 'text' }]]) {
    it(`answers next-file with the door's reason for an ${name} slot file`, async () => {
      const { root } = project({ text: handover(section), slots });
      const outcome = check(root);
      assert.equal(outcome.code, 1);
      assert.equal(outcome.stdout, '');
      assert.match(outcome.stderr.split(LF).at(-1), /^next-file: /);
      const { loadStages, validateSlots } = await import('./stage-render/index.mjs');
      const table = loadStages(readFileSync(join(HERE, 'stage-render/stages.json'), 'utf8'));
      assert.throws(() => validateSlots({ root, slotFile: SLOT, table }), (error) => {
        assertRefusals(outcome, [...userRefusals, `next-file: ${safeLine(error.message)}`]);
        return true;
      });
    });
  }

  it('validates the slot through the injected reads even when the For the user section passes', () => {
    const { root } = project();
    const refuseSlot = (path, ...args) => path === join(root, SLOT) ? failing('EACCES')() : lstatSync(path, ...args);
    const outcome = check(root, { lstatSync: refuseSlot, lstat: refuseSlot });
    assert.equal(outcome.code, 1, outcome.stdout);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /^next-file: [^\n]+$/);
  });

  it('reads the slot file through the injected open and stats it without an injected lstat', () => {
    const { root } = project();
    const refuseOpen = (path, ...args) => path === join(root, SLOT) ? failing('EACCES')() : openSync(path, ...args);
    const refused = check(root, { open: refuseOpen });
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, /^next-file: cannot read [^\n]+$/);
    assertAccept(check(root, { lstatSync: undefined, lstat: undefined }));
  });
});

describe('spec:session-rules/S19 the checker never renders, reads the engine or the approval record', () => {
  it('gains only the stage-render door among its direct imports and uses no render or approval API', () => {
    const source = readFileSync(MODULE, 'utf8');
    const imports = [...source.matchAll(/(?:^|\n)\s*import\s[^'"]*?['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), ['node:path', '../references/scripts/shared/index.mjs', './carriers.mjs',
      './checker-gates-read.mjs', './direct-run.mjs', './fs-read-nofollow.mjs', './stage-render/index.mjs'].sort());
    assert.doesNotMatch(source, /\b(?:renderStage|composeRenderCommand|stepsOf|composeDispatchPart|findMatch|readEngineFragment|resolveEngineDir)\b/);
  });

  it('reaches the deployment probe and the no-follow reader, and no write module', () => {
    const listed = readFileSync(PURITY_TEST, 'utf8').match(WRITE_MODULES_RE);
    assert.ok(listed, 'read-graph-purity.test.mjs declares WRITE_MODULES');
    const writers = [...listed[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(writers.includes('atomic-write.mjs'), 'the write-module list is not vacuous');
    const seen = new Set();
    const queue = [MODULE];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) queue.push(resolve(dirname(file), match[1]));
    }
    const names = [...seen].map((file) => relative(HERE, file));
    assert.ok(names.includes('checker-gates-read.mjs'), names.join(', '));
    assert.ok(names.includes('fs-read-nofollow.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
  });
});
