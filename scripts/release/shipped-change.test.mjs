import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo, cloneFixtureRepo } from '../testing/fixture-repo.mjs';
import { hermeticGitEnv } from '../../agent-workflow-kit/tools/git-env.mjs';
import { cwdBoundGitEnv } from '../suite-parity.mjs';

const SCRIPT = fileURLToPath(new URL('./shipped-change.mjs', import.meta.url));
const DIRECTORY = 'agent-workflow-memory';
const VERSION = '1.0.0';
const TAG = `${DIRECTORY}-v${VERSION}`;
const PACKAGE = { name: `@fixture/${DIRECTORY}`, version: VERSION };
const FRESH = 'sha512-fresh';
const PUBLISHED = 'sha512-published';
const ENTRY = { filename: 'fixture-agent-workflow-memory-1.0.0.tgz', integrity: FRESH };
const WORKFLOW = '.github/workflows/_publish-one.yml';
const TAG_LINE = 'tag="${{ inputs.dir }}-v$ver"\n';
const IDENTITY = ['-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
const TIMEOUT = 60_000;
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const makeScope = (test) => {
  const temporary = mkdtempSync(join(tmpdir(), 'shipped-change-'));
  test.after(() => rmSync(temporary, { recursive: true, force: true }));
  const home = join(temporary, 'home');
  const root = join(temporary, 'root');
  for (const directory of [home, root]) mkdirSync(directory);
  const env = cwdBoundGitEnv(hermeticGitEnv(process.env, home));
  const packed = join(temporary, 'pack.json');
  const packument = join(temporary, 'packument.json');
  const output = join(temporary, 'output');
  write(packed, JSON.stringify([ENTRY]));
  write(packument, JSON.stringify({ versions: { [VERSION]: { dist: { integrity: PUBLISHED } } } }));
  write(output, '');
  const git = (args, cwd = root, environment = env) => {
    const result = spawnSync('git', [...IDENTITY, ...args], { cwd, env: environment, encoding: 'utf8', timeout: TIMEOUT });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  return { temporary, home, root, env, packed, packument, output, git, to: 'a'.repeat(40) };
};
const commit = (fixture) => {
  fixture.git(['add', '.']);
  fixture.git(['commit', '--allow-empty', '-qm', 'fixture']);
  return fixture.git(['rev-parse', 'HEAD']);
};
const pushTag = (fixture, target, annotated = false, cwd = fixture.root) => {
  fixture.git(['tag', ...(annotated ? ['-a', '-m', 'fixture'] : []), TAG, target], cwd);
  fixture.git(['push', 'origin', `refs/tags/${TAG}`], cwd);
};
const makeRepository = (test, { changed, declaration, tag = 'previous', annotated = false, workflow = TAG_LINE } = {}) => {
  const fixture = makeScope(test);
  const { root, git, home, env, temporary } = fixture;
  const origin = makeFixtureRepo(git, join(temporary, 'origin.git'), ['--bare']);
  makeFixtureRepo(git, root);
  git(['remote', 'add', 'origin', origin]);
  for (const flag of ['--absolute-git-dir', '--git-common-dir', '--show-toplevel']) {
    assert.equal(git(['rev-parse', '--path-format=absolute', flag]),
      git(['rev-parse', '--path-format=absolute', flag], root, hermeticGitEnv(env, home)));
  }
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), realpathSync(root));
  const packageJson = declaration?.endsWith('Dependencies') ? { ...PACKAGE, [declaration]: [] }
    : { ...PACKAGE, ...(declaration ? { scripts: { [declaration]: 'node index.js' } } : {}) };
  write(join(root, DIRECTORY, 'package.json'), JSON.stringify(packageJson));
  write(join(root, DIRECTORY, 'index.js'), 'export const value = 1;\n');
  write(join(root, WORKFLOW), workflow);
  for (const path of ['.gitattributes', '.gitignore', '.npmignore']) write(join(root, path), '');
  write(join(root, 'package.json'), '{"private":true}\n');
  write(join(root, 'other/index.js'), 'outside\n');
  const previous = commit(fixture);
  if (changed) write(join(root, changed), changed.endsWith('package.json') ? '{"private":false}\n' : 'changed\n');
  const to = commit(fixture);
  const answer = { ...fixture, origin, previous, to };
  if (tag !== 'absent') pushTag(answer, tag === 'current' ? to : previous, annotated);
  return answer;
};
const flags = (fixture) => ['--root', fixture.root, '--dir', DIRECTORY, '--to', fixture.to,
  '--packed', fixture.packed, '--packument', fixture.packument, '--github-output', fixture.output];
const runChild = (fixture, args = flags(fixture), overrides = {}) => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} does not exist`);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fixture.temporary, env: { ...fixture.env, ...overrides }, encoding: 'utf8', timeout: TIMEOUT,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, text: result.stdout + result.stderr };
};
const assertFailure = (fixture, result, status, causes) => {
  assert.equal(result.status, status, result.text);
  assert.ok(result.text.includes('::error::'), result.text);
  for (const cause of causes) assert.ok(result.text.includes(cause), `${cause}: ${result.text}`);
  assert.equal(readFileSync(fixture.output, 'utf8'), '');
};
const assertNoop = (fixture, result, value) => {
  assert.equal(result.status, 0, result.text);
  assert.equal(readFileSync(fixture.output, 'utf8'), `noop=${value}\n`);
  assert.equal(result.stdout.split('\n').filter((line) => line.trim()).length, 1, result.text);
};
const assertChange = (fixture, result, causes = [], tagPresent = true) => {
  assertFailure(fixture, result, 1, [DIRECTORY, VERSION, FRESH, PUBLISHED, TAG, ...causes]);
  assert.match(result.text, /bump/i);
  if (tagPresent) assert.ok(result.text.includes(fixture.previous), result.text);
};
const equalIntegrity = (fixture) => write(fixture.packument,
  JSON.stringify({ versions: { [VERSION]: { dist: { integrity: FRESH } } } }));

describe('spec:shipped-change/S1 the reader', () => {
  it('record forms expose the same filename and integrity', async () => {
    const { readPackRecord } = await import('./shipped-change.mjs').catch(() => ({}));
    assert.equal(typeof readPackRecord, 'function', 'missing readPackRecord');
    for (const record of [[ENTRY], { [PACKAGE.name]: ENTRY }]) {
      const answer = readPackRecord(JSON.stringify(record), 'pack.json');
      assert.equal(answer.filename, ENTRY.filename);
      assert.equal(answer.integrity, ENTRY.integrity);
    }
  });
  for (const [name, record] of [['npm 11', [ENTRY]], ['npm 12', { [PACKAGE.name]: ENTRY }]]) {
    it(`record --filename prints ${name}`, (test) => {
      const fixture = makeScope(test);
      write(fixture.packed, JSON.stringify(record));
      const result = runChild(fixture, ['--filename', fixture.packed]);
      assert.equal(result.status, 0, result.text);
      assert.equal(result.stdout, `${ENTRY.filename}\n`);
      assert.equal(readFileSync(fixture.output, 'utf8'), '');
    });
  }
  for (const [name, text] of [['not JSON', '{'], ['empty array', '[]'], ['two entries', JSON.stringify([ENTRY, ENTRY])],
    ['two keys', JSON.stringify({ one: ENTRY, two: ENTRY })], ['missing integrity', JSON.stringify([{ filename: ENTRY.filename }])]]) {
    it(`record rejects ${name}`, (test) => {
      const fixture = makeScope(test);
      write(fixture.packed, text);
      assertFailure(fixture, runChild(fixture, ['--filename', fixture.packed]), 2, [fixture.packed]);
    });
  }
  it('packument without the version names its file', (test) => {
    const fixture = makeRepository(test);
    write(fixture.packument, '{"versions":{}}');
    assertFailure(fixture, runChild(fixture), 2, [fixture.packument]);
  });
});

describe('spec:shipped-change/S2 the judgment', () => {
  for (const equal of [true, false]) for (const tag of ['previous', 'absent', 'current']) {
    it(`${equal ? 'equal' : 'differing'} integrities with ${tag} tag`, (test) => {
      const fixture = makeRepository(test, { tag });
      if (equal) equalIntegrity(fixture);
      const result = runChild(fixture);
      if (!equal && tag === 'absent') assertChange(fixture, result, [], false);
      else assertNoop(fixture, result, tag === 'previous' ? 'yes' : 'no');
    });
  }
  for (const changed of [`${DIRECTORY}/index.js`, '.gitattributes', '.gitignore', '.npmignore', 'package.json']) {
    it(`differing integrities refuse changed ${changed}`, (test) => {
      const fixture = makeRepository(test, { changed });
      assertChange(fixture, runChild(fixture), [changed]);
    });
  }
  for (const declaration of ['prepack', 'prepare', 'postpack', 'bundleDependencies', 'bundledDependencies']) {
    it(`differing integrities refuse declared ${declaration}`, (test) => {
      const fixture = makeRepository(test, { declaration });
      assertChange(fixture, runChild(fixture), [declaration]);
    });
  }
  it('an outside change leaves differing integrities unchanged', (test) => {
    const fixture = makeRepository(test, { changed: 'other/index.js' });
    assertNoop(fixture, runChild(fixture), 'yes');
  });
  it('an annotated previous tag reports its peeled commit', (test) => {
    const fixture = makeRepository(test, { annotated: true, changed: `${DIRECTORY}/index.js` });
    assertChange(fixture, runChild(fixture), [`${DIRECTORY}/index.js`]);
  });
  for (const equal of [true, false]) it(`an annotated current tag refuses ${equal ? 'equal' : 'differing'} integrities`, (test) => {
    const fixture = makeRepository(test, { annotated: true, tag: 'current' });
    if (equal) equalIntegrity(fixture);
    assertFailure(fixture, runChild(fixture), 2, [TAG]);
  });
  for (const equal of [true, false]) for (const branch of [TAG, `refs/tags/${TAG}`]) {
    it(`branch ${branch} with ${equal ? 'equal' : 'differing'} integrities`, (test) => {
      const fixture = makeRepository(test, { tag: 'absent' });
      fixture.git(['push', 'origin', `${fixture.previous}:refs/heads/${branch}`]);
      if (equal) equalIntegrity(fixture);
      const result = runChild(fixture);
      if (branch !== TAG) assertFailure(fixture, result, 2, [`refs/heads/${branch}`]);
      else if (equal) assertNoop(fixture, result, 'no');
      else assertChange(fixture, result, [], false);
    });
  }
});

describe('spec:shipped-change/S3 the failures', () => {
  for (const flag of ['--root', '--dir', '--to', '--packed', '--packument', '--github-output', '--filename']) {
    for (const kind of ['missing', 'repeated']) it(`${kind} flag ${flag}`, (test) => {
      const fixture = makeScope(test);
      const args = flag === '--filename' ? ['--filename', fixture.packed] : flags(fixture);
      const index = args.indexOf(flag);
      const altered = kind === 'repeated' ? [...args, flag, args[index + 1]]
        : flag === '--filename' ? [flag] : args.filter((_, position) => position !== index && position !== index + 1);
      assertFailure(fixture, runChild(fixture, altered), 2, [flag]);
    });
  }
  for (const directory of [`./${DIRECTORY}`, `${DIRECTORY}/`]) it(`refuses --dir ${directory}`, (test) => {
    const fixture = makeRepository(test);
    const args = flags(fixture);
    args[args.indexOf('--dir') + 1] = directory;
    assertFailure(fixture, runChild(fixture, args), 2, [directory]);
  });
  for (const key of ['packed', 'packument']) it(`unreadable ${key} names its file`, (test) => {
    const fixture = makeRepository(test);
    rmSync(fixture[key]);
    assertFailure(fixture, runChild(fixture), 2, [fixture[key]]);
  });
  it('failed ls-remote names its cause', (test) => {
    const fixture = makeRepository(test);
    fixture.git(['remote', 'set-url', 'origin', join(fixture.temporary, 'missing.git')]);
    assertFailure(fixture, runChild(fixture), 2, ['ls-remote']);
  });
  it('failed fetch names its cause', (test) => {
    const fixture = makeRepository(test, { tag: 'absent' });
    const copy = cloneFixtureRepo(fixture.git, fixture.origin, join(fixture.temporary, 'copy'));
    const unique = 'unique.txt';
    write(join(copy, unique), `unique content ${fixture.temporary}\n`);
    fixture.git(['add', unique], copy);
    fixture.git(['commit', '-qm', 'unique'], copy);
    const target = fixture.git(['rev-parse', 'HEAD'], copy);
    pushTag(fixture, target, false, copy);
    const blob = fixture.git(['rev-parse', `${target}:${unique}`], copy);
    const object = join(fixture.origin, 'objects', blob.slice(0, 2), blob.slice(2));
    assert.ok(existsSync(object), object);
    rmSync(object);
    assert.ok(fixture.git(['ls-remote', 'origin', `refs/tags/${TAG}`]).includes(TAG));
    assertFailure(fixture, runChild(fixture), 2, ['fetch']);
  });
  for (const kind of ['outside', 'package folder', 'workflow']) it(`refuses root or workflow: ${kind}`, (test) => {
    const fixture = kind === 'outside' ? makeScope(test) : makeRepository(test,
      { workflow: kind === 'workflow' ? 'tag="${{ inputs.dir }}@$ver"\n' : TAG_LINE });
    const root = kind === 'package folder' ? join(fixture.root, DIRECTORY) : fixture.root;
    const args = flags({ ...fixture, root });
    assertFailure(fixture, runChild(fixture, args), 2, [kind === 'workflow' ? WORKFLOW : root]);
  });
  it('inherited GIT_DIR does not redirect the root', (test) => {
    const fixture = makeRepository(test);
    const other = makeFixtureRepo(fixture.git, join(fixture.temporary, 'other'));
    assertNoop(fixture, runChild(fixture, flags(fixture), { GIT_DIR: join(other, '.git') }), 'yes');
  });
});

describe('spec:shipped-change/S4 committed package facts', () => {
  for (const kind of ['version', 'prepack']) it(`uncommitted ${kind} changes nothing`, (test) => {
    const fixture = makeRepository(test);
    const packageJson = kind === 'version' ? { ...PACKAGE, version: '9.9.9' } : { ...PACKAGE, scripts: { prepack: 'exit 1' } };
    write(join(fixture.root, DIRECTORY, 'package.json'), JSON.stringify(packageJson));
    assertNoop(fixture, runChild(fixture), 'yes');
  });
});
