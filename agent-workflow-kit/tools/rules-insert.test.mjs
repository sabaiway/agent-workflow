import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, OUTCOME_LINES as LENS_LINES } from './lens-region.mjs';

const loaded = await import('./rules-insert.mjs').catch(() => ({}));
const failAbsent = () => {
  throw new Error('rules-insert.mjs is absent');
};
const main = loaded.main ?? failAbsent;
const OUTCOME_LINES = loaded.OUTCOME_LINES ?? new Proxy({}, { get: failAbsent });
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', '..', 'agent-workflow-engine');
const BUNDLED_TEMPLATE = join(HERE, '..', 'references', 'templates', 'agent_rules.md');
const CLI = join(HERE, 'rules-insert.mjs');
const CLI_TIMEOUT = 10000;
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const CAP = 150;
const REFUSAL_CAP = 1;
const HEADER = ['---', 'maxLines: ' + CAP, '---', '# Rules', '', '## 2. Rules', '', ''].join(LF);
const COMMUNICATION = ['### 2.5. Communication (user-facing messages)', 'Speak plainly.', '', ''].join(LF);
const STORY = ['### 2.7. Story sessions', 'Keep sessions separate.', '', ''].join(LF);
const PRESERVED = [
  '### 2.9. Local rules', 'Keep nine.', '',
  '### 2.3. Planning, review & process-fidelity invariants', 'Local lens.', '', '',
].join(LF);
const TAIL = ['---', '', '## 3. Tail', 'Keep tail.', ''].join(LF);
const TEMPLATE = HEADER + COMMUNICATION + STORY + TAIL;
const ABSENT = HEADER + PRESERVED + TAIL;
const COMMS_ONLY = HEADER + COMMUNICATION + PRESERVED + TAIL;
const STORY_ONLY = HEADER + STORY + PRESERVED + TAIL;
const PRESENT = HEADER + COMMUNICATION + STORY + PRESERVED + TAIL;
const COMMUNICATION_TEN = COMMUNICATION.replace('2.5.', '2.10.');
const STORY_TEN = STORY.replace('2.7.', '2.10.');
const INSERTED = HEADER + PRESERVED + COMMUNICATION_TEN + STORY.replace('2.7.', '2.11.') + TAIL;
const APPLY = ['--apply'];
// A lone continuation byte: valid in cp1251 or latin-1, never valid UTF-8.
const INVALID_UTF8 = Buffer.from([0xA0]);
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const READ_ERROR = 'read boom';
const TEMPLATE_ERROR = 'template read boom';
const WRITE_ERROR = 'write boom';
const RENAME_ERROR = 'rename boom';
const CLEANUP_ERROR = 'cleanup boom';
const REINSTALL = 'npx @sabaiway/agent-workflow-kit@latest init';
const ERROR_PREFIX = '[rules-insert] error=';
const DIAGNOSTIC_REFUSALS = ['template', 'file-unreadable', 'write-failed'];
const REFUSAL_COMPOSERS = {
  'file-absent': 'fileAbsent', 'file-symlink': 'fileSymlink', 'file-unreadable': 'fileUnreadable',
  template: 'templateDefect', 'heading-twice': 'headingTwice', 'anchor-absent': 'anchorAbsent',
  cap: 'capRefused', 'write-failed': 'writeFailed',
};
const PRIMITIVES = {
  writeFile: writeFileSync, rename: renameSync, rm: (path) => rmSync(path, { force: true }),
};
const runtime = {};
before(() => {
  runtime.root = mkdtempSync(join(tmpdir(), 'rules-insert-'));
  runtime.templatePath = join(runtime.root, 'template.md');
  writeFileSync(runtime.templatePath, TEMPLATE);
});
after(() => rmSync(runtime.root, { recursive: true, force: true }));
const getTarget = (project) => join(project, 'docs', 'ai', 'agent_rules.md');
const readTarget = (project) => readFileSync(getTarget(project), 'utf8');
const createProject = (body) => {
  const project = mkdtempSync(join(runtime.root, 'project-'));
  mkdirSync(dirname(getTarget(project)), { recursive: true });
  if (body !== undefined) writeFileSync(getTarget(project), body);
  return project;
};
const snapshot = (directory) => readdirSync(directory).sort().map((name) => {
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [name, 'symlink', readlinkSync(path)];
  if (stat.isDirectory()) return [name, 'directory', snapshot(path)];
  return [name, 'file', readFileSync(path)];
});
const createSpy = (failures = {}) => {
  const calls = Object.fromEntries(Object.keys(PRIMITIVES).map((name) => [name, []]));
  const deps = Object.fromEntries(Object.entries(PRIMITIVES).map(([name, primitive]) => [
    name, (...args) => {
      calls[name].push(args);
      if (failures[name]) throw new Error(failures[name]);
      return primitive(...args);
    },
  ]));
  return { calls, deps };
};
const assertUnchanged = (project, previous, spy) => {
  assert.deepEqual(snapshot(project), previous);
  assert.deepEqual(Object.values(spy.calls).map((calls) => calls.length), [0, 0, 0]);
};
const run = async (project, args = [], deps = {}) => {
  const result = await main(['--cwd', project, ...args], { templatePath: runtime.templatePath, ...deps });
  assert.deepEqual(Object.keys(result).sort(), ['code', 'stderr', 'stdout']);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  return result;
};
const splitOutput = (text) => (text.endsWith(LF) ? text.slice(0, -LF.length) : text).split(LF);
const assertStates = (result, communication, story) => {
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(splitOutput(result.stdout), [
    'communication: ' + communication, 'story-sessions: ' + story,
  ]);
};
const assertRefusal = (result, name, args = [], cause) => {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const lines = splitOutput(result.stderr);
  assert.equal(lines[0], OUTCOME_LINES[REFUSAL_COMPOSERS[name]](...args));
  assert.doesNotMatch(lines[0], new RegExp('(^|[^a-z-])' + name + '([^a-z-]|$)', 'i'));
  assert.equal(lines[1], '[rules-insert] refusal=' + name);
  assert.equal(lines.length, DIAGNOSTIC_REFUSALS.includes(name) ? 3 : 2);
  if (DIAGNOSTIC_REFUSALS.includes(name)) {
    assert.ok(lines[2].startsWith(ERROR_PREFIX));
    const raw = JSON.parse(lines[2].slice(ERROR_PREFIX.length));
    assert.equal(typeof raw, 'string');
    assert.ok(raw.length > 0);
    assert.ok(!lines[0].includes(raw));
    if (cause !== undefined) assert.equal(raw, cause);
  }
};

describe('spec:rules-regions/S5 default preview', () => {
  for (const [body, communication, story] of [
    [ABSENT, 'planned', 'planned'], [COMMS_ONLY, 'present', 'planned'],
    [STORY_ONLY, 'planned', 'present'], [PRESENT, 'present', 'present'],
  ]) {
    it(communication + ' communication and ' + story + ' story sessions without writes', async () => {
      const project = createProject(body);
      const previous = snapshot(project);
      const spy = createSpy();
      assertStates(await run(project, [], spy.deps), communication, story);
      assertUnchanged(project, previous, spy);
    });
  }
});

describe('spec:rules-regions/S6 one absent region', () => {
  for (const [name, body, expected, states, current] of [
    ['Communication', STORY_ONLY, HEADER + STORY + PRESERVED + COMMUNICATION_TEN + TAIL,
      ['inserted', 'present'], 'commsCurrent'],
    ['Story sessions', COMMS_ONLY, HEADER + COMMUNICATION + PRESERVED + STORY_TEN + TAIL,
      ['present', 'inserted'], 'storyCurrent'],
    ['CRLF', COMMS_ONLY.split(LF).join(CRLF),
      (HEADER + COMMUNICATION + PRESERVED + STORY_TEN + TAIL).split(LF).join(CRLF),
      ['present', 'inserted'], 'storyCurrent'],
    ['EOF without newline', (HEADER + COMMUNICATION + PRESERVED).trimEnd(),
      (HEADER + COMMUNICATION + PRESERVED).trimEnd() + LF + STORY_TEN,
      ['present', 'inserted'], 'storyCurrent'],
  ]) {
    it(name + ' takes number ten and reconciles as current', async () => {
      const project = createProject(body);
      assertStates(await run(project, APPLY), ...states);
      assert.equal(readTarget(project), expected);
      const previous = snapshot(project);
      const logs = [];
      const errors = [];
      const code = await runCli(['reconcile', getTarget(project)], {
        log: (line) => logs.push(line), logError: (line) => errors.push(line),
        env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE },
        fs: { ...asyncFs, readFile: async (path, encoding) =>
          path === BUNDLED_TEMPLATE ? TEMPLATE : asyncFs.readFile(path, encoding) },
      });
      assert.equal(code, 0, errors.join(LF));
      assert.deepEqual(errors, []);
      assert.ok(logs.includes(LENS_LINES[current]()));
      assert.deepEqual(snapshot(project), previous);
    });
  }
});

it('spec:rules-regions/S7 both regions land in one atomic replace', async () => {
  const project = createProject(ABSENT);
  const spy = createSpy();
  assertStates(await run(project, APPLY, spy.deps), 'inserted', 'inserted');
  assert.equal(readTarget(project), INSERTED);
  assert.equal(spy.calls.writeFile.length, 1);
  assert.equal(spy.calls.rename.length, 1);
  assert.equal(spy.calls.rm.length, 0);
  const [temporary, body, options] = spy.calls.writeFile[0];
  assert.equal(dirname(temporary), dirname(getTarget(project)));
  assert.notEqual(temporary, getTarget(project));
  assert.equal(body, INSERTED);
  assert.deepEqual(options, { encoding: 'utf8', flag: 'wx' });
  assert.deepEqual(spy.calls.rename[0], [temporary, getTarget(project)]);
  assert.deepEqual(readdirSync(dirname(getTarget(project))), ['agent_rules.md']);
});

describe('spec:rules-regions/S8 present regions are a no-op', () => {
  for (const secondApply of [false, true]) {
    it(secondApply ? 'second apply' : 'both present on the first run', async () => {
      const project = createProject(secondApply ? ABSENT : PRESENT);
      if (secondApply) assertStates(await run(project, APPLY), 'inserted', 'inserted');
      const previous = snapshot(project);
      const spy = createSpy();
      assertStates(await run(project, APPLY, spy.deps), 'present', 'present');
      assertUnchanged(project, previous, spy);
    });
  }
});

describe('spec:rules-regions/S9 file states refuse without writes', () => {
  for (const [kind, name] of [
    ['absent', 'file-absent'], ['symlink', 'file-symlink'], ['directory', 'file-unreadable'],
    ['non-regular', 'file-unreadable'], ['read failure', 'file-unreadable'],
  ]) {
    it(kind, async () => {
      const project = createProject(['non-regular', 'read failure'].includes(kind) ? ABSENT : undefined);
      const target = getTarget(project);
      const linkTarget = join(project, 'linked.md');
      if (kind === 'symlink') {
        writeFileSync(linkTarget, ABSENT);
        symlinkSync(linkTarget, target);
      }
      if (kind === 'directory') mkdirSync(target);
      const previous = snapshot(project);
      const spy = createSpy();
      const result = await run(project, APPLY, {
        ...spy.deps,
        lstatSync: (path) => path === target && kind === 'non-regular'
          ? { isSymbolicLink: () => false, isFile: () => false } : lstatSync(path),
        readFileSync: (path, encoding) => {
          if (path === target && kind === 'read failure') throw new Error(READ_ERROR);
          return readFileSync(path, encoding);
        },
      });
      assertRefusal(result, name, [target], kind === 'read failure' ? READ_ERROR : undefined);
      assertUnchanged(project, previous, spy);
      if (kind === 'symlink') assert.equal(readFileSync(linkTarget, 'utf8'), ABSENT);
    });
  }

  it('a byte sequence that is not UTF-8 refuses instead of rewriting it', async () => {
    const project = createProject(Buffer.concat([Buffer.from(ABSENT), INVALID_UTF8]));
    const previous = snapshot(project);
    const spy = createSpy();
    assertRefusal(await run(project, APPLY, spy.deps), 'file-unreadable', [getTarget(project)]);
    assertUnchanged(project, previous, spy);
  });

  it('a leading byte-order mark survives the insert', async () => {
    const project = createProject(Buffer.concat([BOM, Buffer.from(ABSENT)]));
    const result = await run(project, APPLY);
    assertStates(result, 'inserted', 'inserted');
    assert.equal(result.stderr, '', 'the target declares maxLines, so no cap-skip note is true of it');
    assert.deepEqual(readFileSync(getTarget(project)), Buffer.concat([BOM, Buffer.from(INSERTED)]));
  });

  it('a byte-order mark never hides the cap refusal', async () => {
    const lowCap = ABSENT.replace('maxLines: ' + CAP, 'maxLines: ' + REFUSAL_CAP);
    const project = createProject(Buffer.concat([BOM, Buffer.from(lowCap)]));
    const previous = snapshot(project);
    const spy = createSpy();
    const result = await run(project, APPLY, spy.deps);
    assert.equal(result.code, 1);
    assert.equal(splitOutput(result.stderr)[1], '[rules-insert] refusal=cap');
    assertUnchanged(project, previous, spy);
  });
});

describe('spec:rules-regions/S10 template defects precede file probes', () => {
  for (const [name, template] of [
    ['unreadable', null], ['Communication absent', TEMPLATE.replace(COMMUNICATION, '')],
    ['Communication twice', TEMPLATE + COMMUNICATION], ['Story sessions absent', TEMPLATE.replace(STORY, '')],
    ['Story sessions twice', TEMPLATE + STORY],
  ]) {
    for (const body of [undefined, PRESENT]) {
      it(name + (body === undefined ? ' with absent target' : ' with both regions present'), async () => {
        const project = createProject(body);
        const previous = snapshot(project);
        const spy = createSpy();
        const probes = [];
        const reads = [];
        const result = await run(project, APPLY, {
          ...spy.deps,
          lstatSync: (path) => {
            probes.push(path);
            return lstatSync(path);
          },
          readFileSync: (path, encoding) => {
            reads.push(path);
            if (path !== runtime.templatePath) return readFileSync(path, encoding);
            if (template === null) throw new Error(TEMPLATE_ERROR);
            return template;
          },
        });
        assertRefusal(result, 'template', [], template === null ? TEMPLATE_ERROR : undefined);
        assert.ok(result.stderr.includes(REINSTALL));
        assert.ok(!probes.includes(getTarget(project)));
        assert.deepEqual(reads, [runtime.templatePath]);
        assertUnchanged(project, previous, spy);
      });
    }
  }
});

describe('spec:rules-regions/S11 judgement and writer refusals', () => {
  for (const [name, body, label] of [
    ['heading-twice', HEADER + COMMUNICATION + COMMUNICATION + PRESERVED + TAIL,
      '### 2.x. Communication (user-facing messages)'],
    ['heading-twice', HEADER + STORY + STORY + PRESERVED + TAIL, '### 2.x. Story sessions'],
    ['anchor-absent', HEADER + TAIL, null],
    ['cap', ABSENT.replace('maxLines: ' + CAP, 'maxLines: ' + REFUSAL_CAP), null],
  ]) {
    it(name + (label ? ' ' + label : ''), async () => {
      const project = createProject(body);
      const previous = snapshot(project);
      const spy = createSpy();
      const count = INSERTED.trimEnd().split(LF).length;
      const args = name === 'heading-twice' ? [label, getTarget(project)]
        : name === 'cap' ? [getTarget(project), count, REFUSAL_CAP] : [getTarget(project)];
      const result = await run(project, APPLY, spy.deps);
      assertRefusal(result, name, args);
      if (label) assert.match(result.stderr, label.includes('Communication') ? /Communication/ : /Story sessions/i);
      if (name === 'cap') assert.ok(result.stderr.includes(String(count)));
      assertUnchanged(project, previous, spy);
    });
  }
  it('no maxLines skips the guard with a note', async () => {
    const project = createProject(ABSENT.replace('maxLines: ' + CAP + LF, ''));
    const result = await run(project, APPLY);
    assertStates(result, 'inserted', 'inserted');
    assert.equal(readTarget(project), INSERTED.replace('maxLines: ' + CAP + LF, ''));
    assert.match(result.stderr, /maxLines/);
    assert.match(result.stderr, /skip/i);
  });
  for (const [name, failures, cause, counts] of [
    ['writeFile', { writeFile: WRITE_ERROR }, WRITE_ERROR, [1, 0, 0]],
    ['rename', { rename: RENAME_ERROR }, RENAME_ERROR, [1, 1, 1]],
    ['rm', { rename: RENAME_ERROR, rm: CLEANUP_ERROR }, CLEANUP_ERROR, [1, 1, 1]],
  ]) {
    it(name + ' failure keeps target bytes and reports the actual cause', async () => {
      const project = createProject(ABSENT);
      const previous = snapshot(project);
      const spy = createSpy(failures);
      assertRefusal(await run(project, APPLY, spy.deps), 'write-failed', [getTarget(project)], cause);
      assert.equal(readTarget(project), ABSENT);
      assert.deepEqual(Object.values(spy.calls).map((calls) => calls.length), counts);
      if (name === 'rm') {
        const temporary = spy.calls.writeFile[0][0];
        assert.deepEqual(spy.calls.rm[0], [temporary]);
        assert.equal(readFileSync(temporary, 'utf8'), INSERTED);
      } else {
        assert.deepEqual(snapshot(project), previous);
      }
    });
  }
});

describe('spec:rules-regions/S12 usage before reads', () => {
  for (const [name, args, includeCwd] of [
    ['unknown flag', ['--bogus'], true], ['repeated flag', ['--apply', '--apply'], true],
    ['missing cwd', ['--apply'], false], ['flag-shaped cwd value', ['--cwd', '--apply'], false],
  ]) {
    it(name + ' returns without reading or exiting', async (context) => {
      const project = createProject();
      const previous = snapshot(project);
      const spy = createSpy();
      const reads = [];
      const probes = [];
      const exit = context.mock.method(process, 'exit', () => assert.fail('main must return'));
      const result = await main(includeCwd ? ['--cwd', project, ...args] : args, {
        ...spy.deps,
        readFileSync: (...values) => reads.push(values),
        lstatSync: (...values) => probes.push(values),
      });
      assert.equal(result.code, 2);
      assert.equal(typeof result.stdout, 'string');
      assert.equal(typeof result.stderr, 'string');
      assert.deepEqual(reads, []);
      assert.deepEqual(probes, []);
      assert.equal(exit.mock.callCount(), 0);
      assertUnchanged(project, previous, spy);
    });
  }
});

it('the repository CLI previews and rejects missing cwd', () => {
  const project = createProject(ABSENT);
  const previous = snapshot(project);
  const options = { encoding: 'utf8', input: '', timeout: CLI_TIMEOUT };
  const preview = spawnSync(process.execPath, [CLI, '--cwd', project], options);
  assertStates({ ...preview, code: preview.status }, 'planned', 'planned');
  assert.equal(preview.stderr, '');
  assert.deepEqual(snapshot(project), previous);
  const usage = spawnSync(process.execPath, [CLI], options);
  assert.equal(usage.status, 2, usage.stderr);
});
