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
const CYRILLIC = String.fromCharCode(0x0441, 0x0434, 0x0435, 0x043b, 0x0430, 0x043d, 0x043e);
const INVALID_UTF8 = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
const PLACEHOLDER_RE = /<kit>|<project>|undefined|\[object |\$\{/;
const bases = [];

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

const handover = (section = [HEADING, '', DONE, '- The queue is seeded.', '', NEXT, '- Write the tests.']) =>
  ['# Handover', '', '**Active recipes:** solo', '', ...section, '', '## What was done last session', '', '- Work.', ''].join(LF);

// project({ text, docsAi, link }) → { root, base }: text is the handover (a string or a Buffer; null
// leaves it out; { kind: 'directory' } or { kind: 'symlink' } places that object instead); docsAi is
// 'directory' (default), 'absent', 'symlink' or 'file'; link 'root' or 'docs' links that component.
const project = ({ text = handover(), docsAi = 'directory', link } = {}) => {
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

describe('spec:session-rules/S5 the checker accepts on one conjunction', () => {
  for (const [name, text] of [
    ['an LF handover', handover()],
    ['a CRLF handover', handover().split(LF).join(CR + LF)],
    ['a handover whose text is in another language', handover([HEADING, DONE, `- ${CYRILLIC}.`, NEXT, `- ${CYRILLIC}.`])],
    ['labels carrying their text on their own line', handover([HEADING, `${DONE} the queue is seeded.`, `${NEXT} write the tests.`])],
    ['a section ending the file', ['# Handover', '', HEADING, DONE, '- Done.', NEXT, '- Next.'].join(LF)],
    ['a byte-order mark before a first-line heading', `${BOM}${HEADING}${LF}${DONE}${LF}- Done.${LF}${NEXT}${LF}- Next.${LF}`],
  ]) {
    it(`accepts ${name}: one line, exit 0, nothing written`, () => {
      const outcome = check(project({ text }).root);
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.equal(outcome.stdout, lines().accept());
      assert.equal(outcome.stdout.split(LF).length, 1);
      assert.equal(outcome.stderr, '');
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
    const env = { ...process.env };
    const accepted = spawnSync(process.execPath, [MODULE, '--check'], { cwd: root, encoding: 'utf8', env });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, `${lines().accept()}${LF}`);
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
      assertRefusals(check(project({ text: handover(section) }).root), ['section-absent']);
    });
  }

  it('refuses a doubled section as section-twice and withholds the label judgement', () => {
    const text = handover([HEADING, NEXT, HEADING, DONE]);
    assertRefusals(check(project({ text }).root), ['section-twice']);
  });

  it('ends the section at the next level-two heading', () => {
    const text = ['# Handover', HEADING, '', '## Elsewhere', DONE, '- Done.', NEXT, '- Next.', ''].join(LF);
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

describe('the import closure of the checker', () => {
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
