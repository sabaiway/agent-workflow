import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const loaded = await import('./migration-blocks.mjs').catch(() => ({}));
const main = loaded.main ?? (() => {
  throw new Error('migration-blocks.mjs is absent');
});
const HERE = dirname(fileURLToPath(import.meta.url));
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const COMMUNICATION = '## 🗣️ Communication language';
const ATTRIBUTION = '## ✍️ Attribution';
const ANCHOR = '## 🧭 Memory Map';
const TEMPLATE = readFileSync(resolve(HERE, '..', 'references', 'templates', 'AGENTS.md'), 'utf8')
  .replace('{{PROJECT_NAME}}', 'demo');
const ANSWERS = ['--language', 'Russian', '--attribution', 'off'];
const APPLY = [...ANSWERS, '--apply'];
const renderFull = (language = 'Russian', attribution = 'off') => TEMPLATE
  .replace('{{COMM_LANGUAGE}}', () => language)
  .replace('{{AGENT_ATTRIBUTION}}', () => attribution);
const getSpan = (text, heading) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, next < 0 ? lines.length : next).join(LF) + LF;
};
const removeSpan = (text, heading) => text.replace(getSpan(text, heading), '');
const FULL = renderFull();
const WITHOUT_ATTRIBUTION = removeSpan(FULL, ATTRIBUTION);
const WITHOUT_COMMUNICATION = removeSpan(FULL, COMMUNICATION);
const WITHOUT_BLOCKS = removeSpan(WITHOUT_ATTRIBUTION, COMMUNICATION);
const PADDED = WITHOUT_BLOCKS + ('filler' + LF).repeat(87 - WITHOUT_BLOCKS.trimEnd().split(LF).length);
const runtime = {};
before(() => {
  runtime.root = mkdtempSync(join(tmpdir(), 'migration-blocks-'));
});
after(() => rmSync(runtime.root, { recursive: true, force: true }));
const createProject = (body) => {
  const project = mkdtempSync(join(runtime.root, 'project-'));
  if (body !== undefined) writeFileSync(join(project, 'AGENTS.md'), body);
  return project;
};
const readEntry = (project) => readFileSync(join(project, 'AGENTS.md'), 'utf8');
const snapshot = (directory) => readdirSync(directory).sort().map((name) => {
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [name, 'symlink', readlinkSync(path)];
  if (stat.isDirectory()) return [name, 'directory', snapshot(path)];
  return [name, 'file', readFileSync(path)];
});
const createSpy = () => {
  const calls = { writeFile: [], rename: [], rm: [] };
  const deps = {
    writeFile: (...args) => {
      calls.writeFile.push(args);
      return writeFileSync(...args);
    },
    rename: (...args) => {
      calls.rename.push(args);
      return renameSync(...args);
    },
    rm: (path) => {
      calls.rm.push(path);
      return rmSync(path, { force: true });
    },
  };
  return { calls, deps };
};
const assertUnchanged = (project, previous, spy) => {
  assert.deepEqual(snapshot(project), previous);
  assert.deepEqual(Object.values(spy.calls).map((calls) => calls.length), [0, 0, 0]);
};
const run = async (project, args = [], deps = {}) => {
  const result = await main(['--cwd', project, ...args], deps);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  return result;
};
const assertStates = (result, communication, attribution, code = 0) => {
  assert.equal(result.code, code, result.stderr);
  const lines = result.stdout.trimEnd().split(LF);
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp('^communication: ' + communication));
  assert.match(lines[1], new RegExp('^attribution: ' + attribution));
  return lines;
};
const assertRefusal = (result, name) => {
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trimEnd().split(LF).length, 1);
  assert.match(result.stderr, new RegExp('^' + name + '(:|$)', 'm'));
};

describe('spec:upgrade-delivery/S6 preview', () => {
  it('the repository CLI previews missing answers and rejects missing cwd', () => {
    const project = createProject(WITHOUT_BLOCKS);
    const cli = join(HERE, 'migration-blocks.mjs');
    const preview = spawnSync(process.execPath, [cli, '--cwd', project], { encoding: 'utf8' });
    const lines = assertStates({ ...preview, code: preview.status }, 'needs', 'needs');
    assert.ok(lines[0].includes('--language'));
    assert.ok(lines[1].includes('--attribution'));
    assert.equal(readEntry(project), WITHOUT_BLOCKS);
    const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(usage.status, 2, usage.stderr);
  });
  for (const [name, args, state] of [
    ['no answers', [], 'needs'],
    ['both answers', ANSWERS, 'planned'],
  ]) {
    it(name, async () => {
      const project = createProject(WITHOUT_BLOCKS);
      const previous = snapshot(project);
      const spy = createSpy();
      const result = await run(project, args, spy.deps);
      const lines = assertStates(result, state, state);
      if (state === 'needs') {
        assert.ok(lines[0].includes('--language'));
        assert.ok(lines[1].includes('--attribution'));
      }
      assertUnchanged(project, previous, spy);
    });
  }
});

describe('spec:upgrade-delivery/S7 atomic insertion', () => {
  for (const [name, language, newline] of [
    ['both blocks', 'Russian', LF],
    ['literal replacement tokens', 'Tagalog $& $1 $$', LF],
    ['CRLF document', 'Russian', CRLF],
  ]) {
    it(name, async () => {
      const project = createProject(WITHOUT_BLOCKS.split(LF).join(newline));
      const spy = createSpy();
      const result = await run(project, ['--language', language, '--attribution', 'off', '--apply'], spy.deps);
      assertStates(result, 'inserted', 'inserted');
      const actual = readEntry(project);
      assert.equal(actual, renderFull(language, 'off').split(LF).join(newline));
      assert.equal(spy.calls.writeFile.length, 1);
      assert.equal(spy.calls.rename.length, 1);
      const temporary = spy.calls.writeFile[0][0];
      assert.equal(dirname(temporary), project);
      assert.notEqual(temporary, join(project, 'AGENTS.md'));
      assert.deepEqual(spy.calls.rename[0], [temporary, join(project, 'AGENTS.md')]);
      assert.deepEqual(readdirSync(project), ['AGENTS.md']);
      assert.ok(actual.indexOf(COMMUNICATION) < actual.indexOf(ATTRIBUTION));
      assert.ok(actual.indexOf(ATTRIBUTION) < actual.indexOf(ANCHOR));
      if (newline === CRLF) assert.ok(!actual.split(CRLF).join('').includes(LF));
    });
  }
});

describe('spec:upgrade-delivery/S8 present blocks', () => {
  it('a second apply ignores different answers without a write', async () => {
    const project = createProject(WITHOUT_BLOCKS);
    const first = await run(project, APPLY);
    assertStates(first, 'inserted', 'inserted');
    assert.equal(readEntry(project), FULL);
    const previous = snapshot(project);
    const spy = createSpy();
    const second = await run(project, ['--language', 'French', '--attribution', 'on', '--apply'], spy.deps);
    const lines = assertStates(second, 'present', 'present');
    for (const line of lines) assert.match(line, /\bignored\b/);
    assertUnchanged(project, previous, spy);
  });
  for (const [name, body] of [
    ['trailing heading spaces', FULL.replace(ATTRIBUTION, ATTRIBUTION + '   ')],
    ['over cap', FULL + ('filler' + LF).repeat(120)],
    ['anchor absent', FULL.replace(ANCHOR + LF, '')],
    ['anchor repeated', FULL.replace(ANCHOR, ANCHOR + LF + ANCHOR)],
  ]) {
    it(name, async () => {
      const project = createProject(body);
      const previous = snapshot(project);
      const spy = createSpy();
      assertStates(await run(project, ['--apply'], spy.deps), 'present', 'present');
      assertUnchanged(project, previous, spy);
    });
  }
  for (const [name, body, args, expected, states] of [
    ['only Attribution absent', WITHOUT_ATTRIBUTION, ['--attribution', 'on'], renderFull('Russian', 'on'), ['present', 'inserted']],
    ['only Communication absent', WITHOUT_COMMUNICATION, ['--language', 'French'], renderFull('French', 'off'), ['inserted', 'present']],
  ]) {
    it(name, async () => {
      const project = createProject(body);
      const result = await run(project, [...args, '--apply']);
      assertStates(result, ...states);
      assert.equal(readEntry(project), expected);
    });
  }
});

describe('spec:upgrade-delivery/S9 file and anchor refusals', () => {
  it('a regular file whose read fails is unreadable and remains unchanged', async () => {
    const project = createProject(FULL);
    const entry = join(project, 'AGENTS.md');
    const result = await run(project, [], {
      readFileSync: (path, encoding) => {
        if (path === entry) throw new Error('read boom');
        return readFileSync(path, encoding);
      },
    });
    assertRefusal(result, 'file-unreadable');
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('read boom'));
    assert.equal(readEntry(project), FULL);
  });
  for (const [name, body, reason] of [
    ['Communication twice, Attribution absent', WITHOUT_ATTRIBUTION + COMMUNICATION + LF, 'heading-twice'],
    ['no anchor', WITHOUT_BLOCKS.replace(ANCHOR + LF, ''), 'anchor-absent'],
    ['two anchors', WITHOUT_BLOCKS.replace(ANCHOR, ANCHOR + LF + ANCHOR), 'anchor-repeated'],
    ['87 lines before both inserts', PADDED, 'cap'],
  ]) {
    it(name, async () => {
      const project = createProject(body);
      const previous = snapshot(project);
      const spy = createSpy();
      const result = await run(project, APPLY, spy.deps);
      assertRefusal(result, reason);
      if (reason === 'heading-twice') assert.match(result.stderr, /communication/i);
      if (reason === 'cap') assert.ok((result.stderr.match(/[0-9]+/g) ?? []).some((value) => Number(value) > 100));
      assertUnchanged(project, previous, spy);
    });
  }
  it('87 lines with only Attribution planned remain below the cap', async () => {
    const project = createProject(PADDED);
    const previous = snapshot(project);
    const spy = createSpy();
    const result = await run(project, ['--attribution', 'off'], spy.deps);
    const lines = assertStates(result, 'needs', 'planned');
    assert.ok(lines[0].includes('--language'));
    assert.doesNotMatch(result.stderr, /^cap(:|$)/m);
    assertUnchanged(project, previous, spy);
  });
  for (const [kind, reason] of [
    ['absent', 'file-absent'],
    ['symlink', 'file-symlink'],
    ['directory', 'file-unreadable'],
  ]) {
    it('AGENTS.md is ' + kind, async () => {
      const project = createProject();
      const entry = join(project, 'AGENTS.md');
      const target = join(runtime.root, 'target.md');
      if (kind === 'symlink') {
        writeFileSync(target, FULL);
        symlinkSync(target, entry);
      }
      if (kind === 'directory') mkdirSync(entry);
      const previous = snapshot(project);
      const spy = createSpy();
      assertRefusal(await run(project, APPLY, spy.deps), reason);
      assertUnchanged(project, previous, spy);
      if (kind === 'symlink') assert.equal(readFileSync(target, 'utf8'), FULL);
    });
  }
});

describe('spec:upgrade-delivery/S10 answer and write refusals', () => {
  for (const [name, flag, value, reason] of [
    ['empty language', '--language', '', 'language'],
    ['blank language', '--language', '   ', 'language'],
    ['multiline language', '--language', 'Rus' + LF + 'sian', 'language'],
    ['tab in language', '--language', 'Rus' + String.fromCharCode(9) + 'sian', 'language'],
    ['DEL in language', '--language', String.fromCharCode(127), 'language'],
    ['yes attribution', '--attribution', 'yes', 'attribution'],
    ['uppercase attribution', '--attribution', 'OFF', 'attribution'],
    ['empty attribution', '--attribution', '', 'attribution'],
  ]) {
    it(name + ' before an absent file', async () => {
      const project = createProject();
      const spy = createSpy();
      assertRefusal(await run(project, [flag, value], spy.deps), reason);
      assertUnchanged(project, [], spy);
    });
  }
  for (const [name, template, body] of [
    ['missing template and absent file', undefined, undefined],
    ['Communication heading twice', TEMPLATE + COMMUNICATION + LF, undefined],
    ['Attribution placeholder absent', TEMPLATE.replace('{{AGENT_ATTRIBUTION}}', ''), undefined],
    ['Communication placeholder twice', TEMPLATE.replace('{{COMM_LANGUAGE}}', '{{COMM_LANGUAGE}}{{COMM_LANGUAGE}}'), undefined],
    ['missing template and full file', undefined, FULL],
  ]) {
    it(name, async () => {
      const project = createProject(body);
      const templateDirectory = mkdtempSync(join(runtime.root, 'template-'));
      const templatePath = join(templateDirectory, 'AGENTS.md');
      if (template !== undefined) writeFileSync(templatePath, template);
      const previous = snapshot(project);
      const spy = createSpy();
      const result = await run(project, APPLY, { ...spy.deps, templatePath });
      assertRefusal(result, 'template');
      assert.ok(result.stderr.includes('@sabaiway/agent-workflow-kit@latest init'));
      assertUnchanged(project, previous, spy);
    });
  }
  it('a missing Attribution answer withholds the Communication insert', async () => {
    const project = createProject(WITHOUT_BLOCKS);
    const previous = snapshot(project);
    const spy = createSpy();
    const result = await run(project, ['--language', 'X', '--apply'], spy.deps);
    assertRefusal(result, 'answer-missing');
    assert.equal(result.stderr.trim(), 'answer-missing');
    const needs = result.stdout.trimEnd().split(LF).find((line) => line.startsWith('attribution: needs'));
    assert.ok(needs?.includes('--attribution'));
    assertUnchanged(project, previous, spy);
  });
  for (const primitive of ['writeFile', 'rename', 'cleanup']) {
    it(primitive + ' failure is reported without replacing AGENTS.md', async () => {
      const project = createProject(WITHOUT_BLOCKS);
      const previous = snapshot(project);
      const spy = createSpy();
      const deps = { ...spy.deps };
      if (primitive === 'writeFile') {
        deps.writeFile = () => {
          throw new Error('write boom');
        };
      } else {
        deps.rename = () => {
          throw new Error('rename boom');
        };
      }
      if (primitive === 'cleanup') {
        deps.rm = () => {
          throw new Error('cleanup boom');
        };
      }
      const result = await run(project, APPLY, deps);
      assertRefusal(result, 'write-failed');
      assert.equal(readEntry(project), WITHOUT_BLOCKS);
      if (primitive === 'cleanup') {
        assert.match(result.stderr, /rename boom|cleanup boom/);
      } else {
        assert.ok(result.stderr.includes(primitive === 'writeFile' ? 'write boom' : 'rename boom'));
        assert.deepEqual(snapshot(project), previous);
      }
    });
  }
  for (const [name, args, includeCwd] of [
    ['unknown flag', ['--bogus'], true],
    ['apply twice', ['--apply', '--apply'], true],
    ['cwd missing', ['--apply'], false],
  ]) {
    it(name + ' is usage before an absent file', async () => {
      const project = createProject();
      const spy = createSpy();
      const argv = includeCwd ? ['--cwd', project, ...args] : args;
      const result = await main(argv, spy.deps);
      assert.equal(result.code, 2);
      assertUnchanged(project, [], spy);
    });
  }
});
