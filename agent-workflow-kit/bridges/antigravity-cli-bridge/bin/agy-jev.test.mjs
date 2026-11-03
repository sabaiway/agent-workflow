// agy-jev.test.mjs — spec jev-every-run, the agy group (D5(a)): agy-run and agy-review pass TYPESAFE_API_KEY by the
// shared key rule and widen nothing; agy-run prints its one limit line, never as agy-review's child; the documented
// opt-in stays admitted. A recording stub stands in front of the harness fake agy.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeSandbox, farmFor, FAKE_AGY } from './agy-review-harness.test.mjs';
import { stripGitLocationEnv } from '../../agent-workflow-kit/tools/git-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, 'agy-review.sh');
const AGY_RUN = join(HERE, 'agy.sh');
const LIMIT = `passed variables: TYPESAFE_API_KEY; a headless agy runs a request that uses them only where your agy permissions allow commands ${String.fromCharCode(0x2014)} the first denied command ends the run`;
const KEYS = { TYPESAFE_API_KEY: 'jev-key', ANTIGRAVITY_API_KEY: 'a', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'o', GOOGLE_GENAI_API_KEY: 'n', FOO_API_KEY: 'foo' };
const PASSED = 'key=[jev-key] google=unset,unset,unset,unset foo=unset bar=unset';

// Every spawn of agy appends its kind and the key states; a run also says so on stderr before the fake answers.
const RECORDER = [
  '#!/usr/bin/env bash',
  'st() { if [[ -n "${!1+x}" ]]; then printf "[%s]" "${!1}"; else printf unset; fi; }',
  'case "${1:-}" in --help|-h) kind=help ;; --version) kind=version ;; models) kind=models ;; *) kind=run; echo STUB-DISPATCH >&2 ;; esac',
  'echo "$kind key=$(st TYPESAFE_API_KEY) google=$(st ANTIGRAVITY_API_KEY),$(st GEMINI_API_KEY),$(st GOOGLE_API_KEY),$(st GOOGLE_GENAI_API_KEY) foo=$(st FOO_API_KEY) bar=$(st BAR_API_KEY) child=$(st AW_AGY_REVIEW_CHILD)" >>"$AGY_JEV_LOG"',
  'exec "$AGY_JEV_FAKE" "$@"',
  '',
].join('\n');

const made = [];
after(() => {
  for (const home of made) rmSync(home, { recursive: true, force: true });
});
const sandbox = () => {
  const sb = makeSandbox();
  made.push(sb.home);
  writeFileSync(join(sb.home, 'agy-fake'), FAKE_AGY, { mode: 0o755 });
  writeFileSync(join(sb.bin, 'agy'), RECORDER, { mode: 0o755 });
  writeFileSync(join(sb.repo, 'plan.md'), '# a plan under review\n');
  return sb;
};
const drive = (sb, wrapper, args, env = {}) => {
  const cap = (name) => join(sb.home, name);
  for (const name of ['jev-log', 'jev-argv']) rmSync(cap(name), { force: true });
  const r = spawnSync('bash', [wrapper, ...args], {
    cwd: sb.repo, input: '', encoding: 'utf8', timeout: 60000,
    env: { ...stripGitLocationEnv({ PATH: `${sb.bin}:${farmFor(['agy', 'agy-run'])}`, TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGY_JEV_LOG: cap('jev-log'), AGY_JEV_FAKE: cap('agy-fake'), AGY_FAKE_ARGV: cap('jev-argv'), ...env }),
      HOME: sb.home, XDG_CONFIG_HOME: join(sb.home, '.config'), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' },
  });
  assert.ifError(r.error);
  assert.equal(r.signal, null, r.stderr);
  const read = (name) => (existsSync(cap(name)) ? readFileSync(cap(name), 'utf8') : '');
  const spawns = read('jev-log').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, spawns, argv: read('jev-argv').split('\n').slice(0, -1) };
};
const runDirect = (sb, env, extra = []) => drive(sb, AGY_RUN, ['a probe prompt', ...extra], env);
const keysOf = (env) => env.split(' child=')[0];
const runSpawn = (r) => (r.spawns.find(([kind]) => kind === 'run') ?? [])[1] ?? '';
const limitLines = (r) => r.stderr.split('\n').filter((line) => /^(?:jev:|passed variables:)/.test(line));

describe('agy-run and agy-review pass the key and unset the rest — spec:jev-every-run/S4', () => {
  for (const [label, wrapper, args] of [['agy-run', AGY_RUN, ['a probe prompt']], ['agy-review plan', REVIEW, ['plan', 'plan.md']]]) {
    it(`${label}: every spawn of agy sees TYPESAFE_API_KEY with the four Google keys and FOO_API_KEY unset`, () => {
      const r = drive(sandbox(), wrapper, args, KEYS);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.spawns.some(([kind]) => kind === 'run'), 'agy ran');
      for (const [kind, env] of r.spawns) assert.equal(keysOf(env), PASSED, `${kind} spawn`);
    });
    it(`${label}: the facts read leaves the user's exported HOST to every spawn of agy`, () => {
      const sb = sandbox();
      writeFileSync(join(sb.bin, 'agy'), RECORDER.replace('child=$(st AW_AGY_REVIEW_CHILD)', '$& host=$(st HOST)'), { mode: 0o755 });
      const r = drive(sb, wrapper, args, { HOST: 'user-box' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.spawns.length > 0, 'agy ran');
      for (const [kind, env] of r.spawns) assert.match(env, / host=\[user-box\]$/, `${kind} spawn`);
    });
  }
});

const copyBridge = (sb) => {
  const directory = join(sb.home, 'bridge');
  cpSync(HERE, join(directory, 'bin'), { recursive: true });
  cpSync(join(HERE, '..', 'capability.json'), join(directory, 'capability.json'));
  const lines = readFileSync(join(HERE, '..', 'service-facts.txt'), 'utf8').trimEnd().split('\n');
  writeFileSync(join(directory, 'service-facts.txt'), [lines[0], 'HOST=a.example', 'HOST=b.example', 'RUN_HOST=a.example', 'RUN_HOST=b.example', lines.find((line) => line.startsWith('WRITABLE_DIR=')), 'PASSED_VARIABLE=FOO_API_KEY', 'PASSED_VARIABLE=BAR_API_KEY', ''].join('\n'));
  for (const name of ['agy.sh', 'agy-review.sh']) symlinkSync(name, join(directory, 'bin', `linked-${name}`));
  return directory;
};
describe('injected facts through symlinks — spec:jev-every-run/S26', () => {
  it('agy-run passes FOO_API_KEY and empty BAR_API_KEY and names only the non-empty passed variable', () => {
    const sb = sandbox();
    const directory = copyBridge(sb);
    const result = drive(sb, join(directory, 'bin', 'linked-agy.sh'), ['a probe prompt'], { ...KEYS, BAR_API_KEY: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.spawns.some(([kind]) => kind === 'run'), result.stderr);
    for (const [kind, keys] of result.spawns) assert.equal(keysOf(keys), 'key=unset google=unset,unset,unset,unset foo=[foo] bar=[]', kind);
    const expected = LIMIT.replace('TYPESAFE_API_KEY', 'FOO_API_KEY');
    assert.deepEqual(limitLines(result), [expected]);
    assert.ok(result.stderr.indexOf(expected) < result.stderr.indexOf('STUB-DISPATCH'), result.stderr);
  });
  it('agy-review runs its copied sibling with the same keys, ignoring a foreign agy-run on PATH and printing no limit', () => {
    const sb = sandbox();
    const directory = copyBridge(sb);
    const sentinel = join(sb.home, 'foreign-invoked');
    writeFileSync(join(sb.bin, 'agy-run'), `#!/usr/bin/env bash\nprintf invoked > '${sentinel}'\nexit 0\n`, { mode: 0o755 });
    const result = drive(sb, join(directory, 'bin', 'linked-agy-review.sh'), ['plan', 'plan.md'], { ...KEYS, BAR_API_KEY: '' });
    assert.equal(existsSync(sentinel), false, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.spawns.some(([kind]) => kind === 'run'), result.stderr);
    assert.equal(runSpawn(result), 'key=unset google=unset,unset,unset,unset foo=[foo] bar=[] child=[1]');
    for (const [kind, keys] of result.spawns) assert.equal(keysOf(keys), 'key=unset google=unset,unset,unset,unset foo=[foo] bar=[]', kind);
    assert.deepEqual(limitLines(result), []);
  });
});

describe('the agy half of S5: an empty key and an unset key on agy-run', () => {
  it('an empty TYPESAFE_API_KEY reaches agy empty, an unset one stays unset, and the argv is the same with the key set', () => {
    const runs = ['jev-key', '', undefined].map((value) => runDirect(sandbox(), { TYPESAFE_API_KEY: value }));
    assert.deepEqual(runs.map((r) => keysOf(runSpawn(r)).split(' ')[0]), ['key=[jev-key]', 'key=[]', 'key=unset']);
    assert.deepEqual([runs[1].argv, runs[2].argv], [runs[0].argv, runs[0].argv]);
  });
});

describe('agy-run prints its one limit line — spec:jev-every-run/S20', () => {
  it('a non-empty key: exactly the one limit line, before dispatch; an empty or an unset key: none', () => {
    const r = runDirect(sandbox(), { TYPESAFE_API_KEY: 'jev-key' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(limitLines(r), [LIMIT]);
    const lines = r.stderr.split('\n');
    assert.ok(lines.indexOf(LIMIT) < lines.indexOf('STUB-DISPATCH'), r.stderr);
    for (const value of ['', undefined]) {
      const quiet = runDirect(sandbox(), { TYPESAFE_API_KEY: value });
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.deepEqual(limitLines(quiet), [], JSON.stringify(value));
    }
  });
  it('as agy-review\'s child: agy-run runs marked AW_AGY_REVIEW_CHILD=1 with the key, and no limit line is printed', () => {
    const r = drive(sandbox(), REVIEW, ['plan', 'plan.md'], { TYPESAFE_API_KEY: 'jev-key' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(runSpawn(r), `${PASSED} child=[1]`);
    assert.deepEqual(limitLines(r), []);
  });
});

describe('the documented opt-in stays admitted — spec:jev-every-run/S21', () => {
  it('agy-run -- --dangerously-skip-permissions reaches agy\'s argv, the key beside it', () => {
    const r = runDirect(sandbox(), { TYPESAFE_API_KEY: 'jev-key' }, ['--', '--dangerously-skip-permissions']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.argv.includes('--dangerously-skip-permissions'), r.argv.join(' '));
    assert.equal(keysOf(runSpawn(r)), PASSED);
  });
});
