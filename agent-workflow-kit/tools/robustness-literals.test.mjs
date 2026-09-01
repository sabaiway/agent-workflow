import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixtures } from './hostile-git-harness.test.mjs';
import {
  GIT_LOCATION_STATES, GIT_MAX_BUFFER, hermeticGitEnv, resolveGitLocation, stripGitLocationEnv,
} from './git-env.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { lexicalRepoRelative } from './repo-lex.mjs';
import {
  digestOf, readRobustnessLiterals, readShippedRobustnessLiterals,
} from './robustness-literals.mjs';

const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(TOOL_ROOT, '..');
const REPO_ROOT = resolve(KIT_ROOT, '..');
const LIST_REL = 'agent-workflow-kit/references/robustness-literals.json';
const makeTemp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const write = (root, rel, body) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const baseList = () => ({
  schema: 1,
  version: 1,
  classes: [{
    id: 'sample',
    prove: 'Prove the measured sample.',
    members: [{ literal: 'SAMPLE', kind: 'state', note: 'Measured sample.', source: 'src/sample.mjs' }],
  }],
});
const readFixture = (mutate) => {
  const root = makeTemp('robustness-reader');
  const value = baseList();
  mutate(value);
  return () => readRobustnessLiterals(write(root, 'list.json', `${JSON.stringify(value)}\n`));
};

const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const containedDir = (root, rel) => {
  assert.equal(lexicalRepoRelative(rel).ok, true, `source directory is lexically contained: ${rel}`);
  const rootReal = realpathSync(root);
  const path = resolve(root, rel);
  const parentReal = realpathSync(dirname(path));
  assert.equal(isInside(rootReal, parentReal), true, `source directory parent is contained: ${rel}`);
  const leafReal = realpathSync(path);
  assert.equal(isInside(rootReal, leafReal), true, `source directory leaf is contained: ${rel}`);
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `source directory is not a symlink: ${rel}`);
  assert.equal(stat.isDirectory(), true, `source directory is a directory: ${rel}`);
  return path;
};
const walkFiles = (root, directory = root) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(root, path) : entry.isFile() || entry.isSymbolicLink() ? [relative(root, path).split(sep).join('/')] : [];
  });
const readContained = (root, rel) => {
  assert.equal(lexicalRepoRelative(rel).ok, true, `source path is lexically contained: ${rel}`);
  const rootReal = realpathSync(root);
  const path = resolve(root, rel);
  const parentReal = realpathSync(dirname(path));
  assert.equal(isInside(rootReal, parentReal), true, `source parent is contained: ${rel}`);
  const leafReal = realpathSync(path);
  assert.equal(isInside(rootReal, leafReal), true, `source leaf is contained: ${rel}`);
  const read = readRegularFileNoFollow(path);
  assert.equal(read.outcome, 'ok', `source is a regular no-follow file: ${rel} (${read.outcome})`);
  return read.content;
};
const resolveSource = (root, source) => {
  const docs = join(root, 'docs', 'ai');
  if (/^AD-\d+$/u.test(source)) {
    try { realpathSync(docs); } catch (error) {
      if (error?.code === 'ENOENT') return { skip: `${source}: docs/ai is absent` };
      throw error;
    }
    const log = readContained(root, 'docs/ai/adr/log.md');
    const row = log.split('\n').find((line) => line.startsWith(`| ${source} |`));
    assert.ok(row, `${source} is present in docs/ai/adr/log.md`);
    const target = /\]\(([^)]+)\)/u.exec(row)?.[1];
    assert.ok(target, `${source} has a record link`);
    return { rel: relative(root, resolve(root, 'docs/ai/adr', target)).split(sep).join('/') };
  }
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source)) {
    try { realpathSync(docs); } catch (error) {
      if (error?.code === 'ENOENT') return { skip: `${source}: docs/ai is absent` };
      throw error;
    }
    const matches = walkFiles(root, containedDir(root, 'docs/ai/specs')).filter((rel) => {
      const parts = rel.split('/');
      const leaf = parts.at(-1);
      return leaf === `${source}.md` || (leaf === 'index.md' && parts.at(-2) === source);
    });
    assert.equal(matches.length, 1, `${source} resolves to one spec document`);
    return { rel: matches[0] };
  }
  return { rel: source };
};

const HARNESS_MEMBERS = Object.freeze({
  workTree: ['work-tree'],
  notARepository: ['not-a-repository', 'exit 128'],
  redirectedGitDir: ['GIT_DIR', 'redirected'],
  workTreeAtSecondTree: ['GIT_WORK_TREE', 'redirected'],
  commonDirAtSecondRepo: ['GIT_COMMON_DIR', 'redirected'],
  envOnly: ['env-only'],
  bare: ['no-work-tree'],
  insideGitDir: ['no-work-tree'],
  hookShapedEnv: ['GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH'],
  killedGit: ['signal'],
  absentGit: ['ENOENT'],
  throwingRunner: ['synchronous throw'],
  unmerged: ['unmerged stage 1', 'unmerged stage 2', 'unmerged stage 3', 'unmerged path twice'],
  showUntrackedNo: ['status.showUntrackedFiles', '--exclude-standard'],
  autocrlf: ['core.autocrlf'],
  heldIndexLock: ['index.lock'],
  partialWrite: ['partial UTF-8 sequence'],
  stoppedAm: ['rebase-apply'],
  stoppedRebase: ['rebase-merge', 'REBASE_HEAD'],
  textconv: ['--no-textconv'],
  ignoreSubmodulesAll: ['--ignore-submodules=none'],
  poisonedHost: ['HOME', 'XDG_CONFIG_HOME', 'LC_ALL=C'],
});

const RAW_BUFFER_EXCEPTIONS = new Set([
  'git-env.mjs', 'repo-search.mjs', 'path-inventory.mjs', 'mcp-stdio.mjs', 'run-gates.mjs', 'control-bytes.mjs',
]);
const scanBufferHomes = (root) => {
  const files = walkFiles(root).filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs'));
  const findings = files.flatMap((rel) => {
    const text = readContained(root, rel);
    const fileFindings = [];
    const definitions = text.match(/(?:export\s+)?const\s+GIT_MAX_BUFFER\b/gu) ?? [];
    if (rel === 'git-env.mjs' && definitions.length !== 1) fileFindings.push(`git-env.mjs: ${definitions.length} GIT_MAX_BUFFER definitions in the home`);
    if (definitions.length > 0 && rel !== 'git-env.mjs') fileFindings.push(`${rel}: second GIT_MAX_BUFFER definition`);
    if (/\d+\s*\*\s*1024\s*\*\s*1024/u.test(text) && !RAW_BUFFER_EXCEPTIONS.has(rel)) fileFindings.push(`${rel}: copied MiB literal`);
    for (const line of text.split('\n').filter((entry) => entry.includes('maxBuffer:'))) {
      if (!line.includes('maxBuffer: GIT_MAX_BUFFER') && !(rel === 'run-gates.mjs' && line.includes('MAX_GATE_OUTPUT_BYTES'))) {
        fileFindings.push(`${rel}: git spawn buffer is not GIT_MAX_BUFFER`);
      }
    }
    if (text.includes('maxBuffer: GIT_MAX_BUFFER') && rel !== 'git-env.mjs' && !/import\s+\{[^}]*GIT_MAX_BUFFER[^}]*\}\s+from '\.\/git-env\.mjs';/su.test(text)) {
      fileFindings.push(`${rel}: GIT_MAX_BUFFER is not imported from git-env.mjs`);
    }
    return fileFindings;
  });
  if (!files.includes('git-env.mjs')) findings.unshift('git-env.mjs: 0 GIT_MAX_BUFFER definitions in the home');
  return findings;
};

const checkVersion = (head, current) => {
  if (current.version < head.version) throw new Error(`version ${current.version} is below HEAD ${head.version}`);
  if (digestOf(current) !== digestOf(head) && current.version <= head.version) throw new Error('changed digest needs a strictly greater version');
};
const headReadEnv = (env) => ({ ...stripGitLocationEnv(env), LC_ALL: 'C' });

describe('robustness literals — closed reader, parity and version', () => {
  it('S1 drives every named refusal from one table and parses the shipped list (spec:robustness-literals/S1)', () => {
    const cases = {
      'unknown-key': (v) => { v.extra = true; },
      'missing-key': (v) => { delete v.schema; },
      type: (v) => { v.classes = {}; },
      'empty-string': (v) => { v.classes[0].prove = ''; },
      control: (v) => { v.classes[0].members[0].note = 'bad\nline'; },
      'class-id': (v) => { v.classes[0].id = 'Not-A-Slug'; },
      'duplicate-class': (v) => { v.classes.push(structuredClone(v.classes[0])); },
      'duplicate-literal': (v) => { v.classes[0].members.push(structuredClone(v.classes[0].members[0])); },
      'empty-class': (v) => { v.classes[0].members = []; },
      kind: (v) => { v.classes[0].members[0].kind = 'string'; },
      source: (v) => { v.classes[0].members[0].source = '../escape.mjs'; },
      version: (v) => { v.version = 0; },
      schema: (v) => { v.schema = 2; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      assert.throws(readFixture(mutate), (error) => error.code === name, name);
    }
    const shipped = readShippedRobustnessLiterals();
    assert.equal(shipped.schema, 1);
    assert.equal(shipped.version, 1);
  });

  it('S2 derives both superset halves and resolves every source before its no-follow read (spec:robustness-literals/S2)', async (t) => {
    const list = readShippedRobustnessLiterals();
    const literals = new Set(list.classes.flatMap((entry) => entry.members.map((member) => member.literal)));
    const captured = new Set();
    const spawn = (_command, args) => {
      captured.add(args[1]);
      const answer = args[1] === '--show-toplevel' ? '/repo' : '/repo/.git';
      return { status: 0, signal: null, stdout: `${answer}\n`, stderr: '' };
    };
    assert.equal(resolveGitLocation('/repo', { spawn, env: { PATH: '/bin' }, realpath: (path) => path }).state, 'work-tree');
    const gitEnvSide = [...GIT_LOCATION_STATES, ...Object.keys(hermeticGitEnv({}, '/home')), ...captured, ...Object.keys({ GIT_MAX_BUFFER })];
    for (const literal of gitEnvSide) assert.ok(literals.has(literal), `git-env literal ${literal}`);
    assert.deepEqual(Object.keys(HARNESS_MEMBERS), Object.keys(fixtures), 'the harness map is total');
    for (const [fixture, members] of Object.entries(HARNESS_MEMBERS)) {
      for (const literal of members) assert.ok(literals.has(literal), `${fixture} maps to ${literal}`);
    }
    const docMembers = [];
    for (const entry of list.classes) for (const member of entry.members) {
      if (/^AD-\d+$/u.test(member.source) || /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(member.source)) {
        docMembers.push(member);
      } else {
        const target = resolveSource(REPO_ROOT, member.source);
        const text = readContained(REPO_ROOT, target.rel);
        if (member.kind !== 'state') assert.ok(text.includes(member.literal), `${member.source} contains ${member.literal}`);
      }
    }
    await t.test('every ADR or spec source resolves', (sub) => {
      try {
        realpathSync(join(REPO_ROOT, 'docs/ai'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        sub.skip(`docs/ai is absent — ${docMembers.length} ADR/spec source(s) not resolved`);
        return;
      }
      for (const member of docMembers) {
        const target = resolveSource(REPO_ROOT, member.source);
        const text = readContained(REPO_ROOT, target.rel);
        if (member.kind !== 'state') assert.ok(text.includes(member.literal), `${member.source} contains ${member.literal}`);
      }
    });
  });

  it('source containment refuses a symlinked parent and redirected ADR/spec targets', () => {
    const root = makeTemp('robustness-source');
    const outside = makeTemp('robustness-outside');
    write(outside, 'target.mjs', 'outside\n');
    symlinkSync(outside, join(root, 'linked'));
    assert.throws(() => readContained(root, 'linked/target.mjs'), /contained/);
    write(root, 'docs/ai/adr/log.md', '| AD-1 | sample | [record](./record.md) |\n');
    symlinkSync(join(outside, 'target.mjs'), join(root, 'docs/ai/adr/record.md'));
    assert.throws(() => readContained(root, resolveSource(root, 'AD-1').rel), /contained/);
    mkdirSync(join(root, 'docs/ai/specs'), { recursive: true });
    symlinkSync(join(outside, 'target.mjs'), join(root, 'docs/ai/specs/sample.md'));
    assert.throws(() => readContained(root, resolveSource(root, 'sample').rel), /contained/);
    const linkedSpecsRoot = makeTemp('robustness-linked-specs');
    mkdirSync(join(linkedSpecsRoot, 'docs/ai'), { recursive: true });
    write(outside, 'specs/sample.md', 'outside spec\n');
    symlinkSync(join(outside, 'specs'), join(linkedSpecsRoot, 'docs/ai/specs'));
    assert.throws(() => resolveSource(linkedSpecsRoot, 'sample'), /contained/);
  });

  it('the one-home scan is recursive and catches a nested copied buffer', () => {
    assert.deepEqual(scanBufferHomes(TOOL_ROOT), []);
    const root = makeTemp('robustness-buffer-home');
    write(root, 'git-env.mjs', 'export const GIT_MAX_BUFFER = 256 * 1024 * 1024;\n');
    assert.deepEqual(scanBufferHomes(root), []);
    write(root, 'nested/bad.mjs', "const GIT_MAX_BUFFER = 64 * 1024 * 1024;\nspawnSync('git', [], { maxBuffer: GIT_MAX_BUFFER });\n");
    const nestedFindings = scanBufferHomes(root);
    assert.equal(nestedFindings.some((line) => line.includes('definitions in the home')), false);
    assert.ok(nestedFindings.some((line) => line.startsWith('nested/bad.mjs:')));
    const duplicateHome = makeTemp('robustness-duplicate-buffer-home');
    write(duplicateHome, 'git-env.mjs', 'export const GIT_MAX_BUFFER = 256 * 1024 * 1024;\nconst GIT_MAX_BUFFER = 64 * 1024 * 1024;\n');
    assert.ok(scanBufferHomes(duplicateHome).includes('git-env.mjs: 2 GIT_MAX_BUFFER definitions in the home'));
  });

  it('S3 rejects a version rollback and a changed digest without a bump (spec:robustness-literals/S3)', () => {
    const head = baseList();
    assert.throws(() => checkVersion({ ...head, version: 2 }, head), /below HEAD/);
    const changed = structuredClone(head);
    changed.classes[0].members[0].note = 'Changed measurement.';
    assert.throws(() => checkVersion(head, changed), /strictly greater/);
    changed.version = 2;
    assert.doesNotThrow(() => checkVersion(head, changed));
  });

  it('the HEAD read pins git wording with LC_ALL=C over the stripped env', () => {
    const env = headReadEnv({ GIT_DIR: '/elsewhere/.git', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', PATH: '/usr/bin' });
    assert.equal(env.LC_ALL, 'C', 'git wording is pinned so the absent-in-HEAD skip is recognised under any host locale');
    assert.equal(Object.keys(env).some((key) => /^[Gg][Ii][Tt]_/u.test(key)), false, 'no GIT_-named variable reaches the HEAD read');
    assert.equal(env.PATH, '/usr/bin');
  });

  it('compares the shipped list with HEAD, naming only the admitted skips', (t) => {
    const location = resolveGitLocation(REPO_ROOT, { spawn: spawnSync, env: process.env });
    if (['not-a-repository', 'redirected', 'no-work-tree', 'env-only'].includes(location.state)) {
      t.skip(`HEAD version rule: git location is ${location.state}`);
      return;
    }
    assert.equal(location.state, 'work-tree', location.cause);
    const shown = spawnSync('git', ['show', `HEAD:${LIST_REL}`], {
      cwd: REPO_ROOT, env: headReadEnv(process.env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
    });
    assert.equal(shown.error, undefined, shown.error?.message);
    assert.equal(shown.signal, null, `git show was killed by ${shown.signal}`);
    if (shown.status === 128 && /does not exist in 'HEAD'|exists on disk, but not in 'HEAD'/u.test(shown.stderr)) {
      t.skip('HEAD version rule: robustness-literals.json is absent in HEAD');
      return;
    }
    assert.equal(shown.status, 0, shown.stderr);
    checkVersion(JSON.parse(shown.stdout), readShippedRobustnessLiterals());
  });
});
