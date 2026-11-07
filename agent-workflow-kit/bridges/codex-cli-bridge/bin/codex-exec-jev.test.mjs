import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, chmodSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo, openSuiteScopes } from './codex-fixtures-harness.test.mjs';
const stripGitLocationEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));
const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = join(HERE, 'codex-exec.sh');
const HOSTS = 'api.typesafe.ai,docs.typesafe.ai';
const childEnv = (home, env = {}) => ({ ...stripGitLocationEnv(env), HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' });
const { repos, tmp, profileSkip } = await openSuiteScopes('codex-exec-jev');
const REAL_UNAME = spawnSync('bash', ['-c', 'type -P uname'], { encoding: 'utf8' }).stdout.trim();
const FAKE_CODEX = [
  '#!/usr/bin/env bash', 'set -u',
  'st() { if [[ -n "${!1+x}" ]]; then printf "[%s]" "${!1}"; else printf unset; fi; }', 'rec() { echo "$1 key=$(st TYPESAFE_API_KEY) openai=$(st OPENAI_API_KEY) codex=$(st CODEX_API_KEY) foo=$(st FOO_API_KEY) base=$(st OPENAI_BASE_URL) bar=$(st BAR_API_KEY)" >>"$CODEX_FAKE_LOG"; }',
  'case "${1:-}" in', '  login) rec login; echo "Logged in using ChatGPT"; exit 0 ;;',
  '  --version) rec version; echo "${CODEX_FAKE_VERSION-codex-cli 0.160.0}"; exit 0 ;;', '  debug) rec catalog; cat <<EOF',
  '{"models":[{"slug":"gpt-6.1-sol","priority":1,"visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"}]}]}',
  'EOF', '    exit 0 ;;', 'esac', 'rec run',
  '{ for a in "$@"; do echo "$a"; done; } >"$CODEX_FAKE_ARGV"', 'cat >"$CODEX_FAKE_STDIN"',
  'out=""; prev=""; for a in "$@"; do if [[ "$prev" == "-o" ]]; then out="$a"; fi; prev="$a"; done', 'if [[ -n "$out" ]]; then echo "${CODEX_FAKE_FINAL:-FAKE_FINAL}" >"$out"; fi',
  'echo "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"sess-jev\\"}"', 'if [[ -n "${CODEX_FAKE_PRE:-}" ]]; then echo "$CODEX_FAKE_PRE"; fi',
  'echo "{\\"type\\":\\"turn.started\\"}"', 'if [[ -n "${CODEX_FAKE_POST:-}" ]]; then echo "$CODEX_FAKE_POST"; fi',
  'echo "{\\"type\\":\\"turn.completed\\",\\"usage\\":{}}"', 'exit "${CODEX_FAKE_EXIT:-0}"', '',
].join('\n');
const FAKE_UNAME = ['#!/usr/bin/env bash', 'if [[ $# -eq 0 || "$1" == "-s" ]]; then echo "${CODEX_FAKE_UNAME:-Linux}"; exit 0; fi', `exec "${REAL_UNAME}" "$@"`, ''].join('\n');
const CONTRACT = '# dispatch\n\n```aw-dispatch-contract\n{"nonce":"n1","scope":"probe"}\n```\n';
const TEMPLATE = join(repos, 'template');
for (const name of ['bin', 'home', 'repo']) mkdirSync(join(TEMPLATE, name), { recursive: true });
for (const [name, body] of [['codex', FAKE_CODEX], ['uname', FAKE_UNAME]]) writeFileSync(join(TEMPLATE, 'bin', name), body, { mode: 0o755 });
{
  const repo = join(TEMPLATE, 'repo');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: childEnv(join(TEMPLATE, 'home'), { PATH: process.env.PATH }) });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  };
  makeFixtureRepo((args) => git(...args), repo, ['-q']);
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(repo, 'task.md'), CONTRACT);
}
const sandbox = (root = tmp) => {
  const dir = mkdtempSync(join(root, 'sb-'));
  cpSync(TEMPLATE, dir, { recursive: true });
  return { dir, bin: join(dir, 'bin'), home: join(dir, 'home'), repo: join(dir, 'repo'), state: join(dir, 'home', '.local', 'state', 'agent-workflow', 'codex-jev-profile-refused') };
};
const drive = (sb, args, env = {}, cwd = sb.repo) => {
  const cap = (name) => join(sb.dir, name);
  for (const name of ['log', 'argv', 'stdin']) rmSync(cap(name), { force: true });
  const r = spawnSync('bash', [sb.wrapper ?? EXEC, ...args], {
    cwd, input: 'do the thing', encoding: 'utf8', timeout: 60000,
    env: childEnv(sb.home, { PATH: `${sb.bin}:${process.env.PATH}`, TMPDIR: tmp, CODEX_FAKE_LOG: cap('log'),
      CODEX_FAKE_ARGV: cap('argv'), CODEX_FAKE_STDIN: cap('stdin'), ...env }),
  });
  assert.ifError(r.error);
  assert.equal(r.signal, null, r.stderr);
  const read = (name) => (existsSync(cap(name)) ? readFileSync(cap(name), 'utf8') : '');
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: read('log'), argv: read('argv').split('\n').slice(0, -1),
    prompt: read('stdin').replace(/\s+/g, ' ') };
};
const overrides = (argv) => Object.fromEntries(argv.flatMap((arg, i) => (argv[i - 1] === '-c'
  ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : [])));
const inline = (text) => {
  const cursor = { at: 0 };
  const eat = (re) => {
    const m = re.exec(text.slice(cursor.at));
    assert.ok(m, `an inline table: ${text}`);
    cursor.at += m[0].length;
    return m;
  };
  const value = () => {
    if (eat(/^\s*(\{?)/)[1] === '') return eat(/^"([^"]*)"|^([\w.:-]+)/).slice(1).find((part) => part !== undefined);
    const table = {};
    while (eat(/^\s*(\}?)/)[1] === '') {
      const key = value();
      eat(/^\s*=/);
      table[key] = value();
      eat(/^\s*,?/);
    }
    return table;
  };
  const parsed = value();
  assert.equal(text.slice(cursor.at).trim(), '', `nothing after the inline table: ${text}`);
  return parsed;
};
const EXEC_FS = { ':root': 'read', ':tmpdir': 'write', ':slash_tmp': 'write', ':workspace_roots': { '.': 'write' } };
const PROFILE_KEYS = ['default_permissions', 'permissions.jev.filesystem', 'permissions.jev.network.domains', 'permissions.jev.network.enabled'];
const profileKeys = (c) => Object.keys(c).filter((key) => key === 'default_permissions' || key.startsWith('permissions.')).sort();
const assertProfile = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const c = overrides(r.argv);
  assert.deepEqual(profileKeys(c), PROFILE_KEYS, r.argv.join(' '));
  assert.equal(c.default_permissions.replace(/^"(.*)"$/, '$1'), 'jev');
  assert.equal(c['permissions.jev.network.enabled'], 'true');
  assert.deepEqual(inline(c['permissions.jev.network.domains']), { 'api.typesafe.ai': 'allow', 'docs.typesafe.ai': 'allow' });
  assert.deepEqual(inline(c['permissions.jev.filesystem']), EXEC_FS);
  assert.equal(r.argv.includes('--sandbox') || 'sandbox_mode' in c, false, 'neither --sandbox nor sandbox_mode beside the profile');
};
const assertFallback = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const c = overrides(r.argv);
  assert.deepEqual(profileKeys(c), [], r.argv.join(' '));
  assert.ok(r.argv[r.argv.indexOf('--sandbox') + 1] === 'workspace-write' || c.sandbox_mode === 'workspace-write', r.argv.join(' '));
  assert.equal(c['sandbox_workspace_write.network_access'], 'false');
};
const bannerOf = (r) => r.stderr.split('\n').find((line) => line.startsWith('exec posture: ')) ?? '';
const banner = (sandboxValue, jev, session = 'fresh') => 'exec posture: model=gpt-6.1-sol effort=high tier=standard '
  + `sandbox=${sandboxValue} session=${session} jev=${jev} source=model:default,effort:default timeout=3600s`;
const unreachable = (reason) => banner('workspace-write', `unreachable (${reason})`);
const KEYS = { TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'sk-live', CODEX_API_KEY: 'ck', FOO_API_KEY: 'foo', OPENAI_BASE_URL: 'http://proxy' };
const PASSED = 'key=[jev-key] openai=unset codex=unset foo=unset base=unset bar=unset';
const spawnsOf = (r) => r.log.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]);
const runEnv = (r) => (spawnsOf(r).find(([kind]) => kind === 'run') ?? [])[1];
const item = (body) => JSON.stringify({ type: 'item.completed', item: body });
const P13_TEXT = 'Configured filesystem path `:slash_tmp` is not recognized by this version of Codex and will be ignored. Upgrade Codex if this path is required.';
const P13 = item({ id: 'item_0', type: 'error', message: P13_TEXT });
const P1 = item({ id: 'item_0', type: 'error', message: 'Permissions profile `jev` does not define any recognized filesystem entries for this version of Codex. Filesystem access will remain restricted.' });
const OTHER_SHAPE = item({ id: 'item_0', type: 'error', message: 'Unknown configuration key `permissions.jev.network.mode`.' });
const command = (output, exitCode, status) => item({ id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: output, exit_code: exitCode, status });
const BWRAP = 'bwrap: execvp /usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex: No such file or directory\n';
const receiptOf = (sb) => JSON.parse(readFileSync(join(sb.repo, '.git', 'agent-workflow-exec-receipt-5-codex-n1.json'), 'utf8'));
const RECEIPT_KEYS = ['schema', 'kind', 'state', 'backend', 'nonce', 'owner', 'contractDigest', 'wrapperVersion', 'posture', 'capS', 'killGraceS', 'sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength', 'timestamp'];
const stateLines = (sb) => (existsSync(sb.state) ? readFileSync(sb.state, 'utf8').split('\n').filter(Boolean) : []);
describe('the key rule on codex-exec — spec:jev-every-run/S1', () => {
  it('a fresh run hands codex only TYPESAFE_API_KEY of the keys, and the login, version and catalog spawns see the same env', () => {
    const r = drive(sandbox(), ['-'], KEYS);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([...new Set(spawnsOf(r).map(([kind]) => kind))].sort(), ['catalog', 'login', 'run', 'version'], r.log);
    for (const [kind, env] of spawnsOf(r)) assert.equal(env, PASSED, `${kind} spawn`);
  });
});
describe('a resumed run — spec:jev-every-run/S2', () => {
  it('keeps the key rule and carries the profile overrides with no sandbox_mode', { skip: profileSkip }, () => {
    const r = drive(sandbox(repos), ['--resume', 'sess-1', '-'], KEYS);
    assertProfile(r);
    assert.deepEqual(r.argv.slice(0, 3), ['exec', 'resume', 'sess-1']);
    for (const [kind, env] of spawnsOf(r)) assert.equal(env, PASSED, `${kind} spawn`);
  });
});
describe('an empty key and an unset key — spec:jev-every-run/S5', () => {
  it('an empty TYPESAFE_API_KEY reaches codex empty, an unset one stays unset, and the argv is the same with the key set', { skip: profileSkip }, () => {
    const runs = ['jev-key', '', undefined].map((value) => drive(sandbox(repos), ['-'], { TYPESAFE_API_KEY: value }));
    assert.deepEqual(runs.map((r) => runEnv(r)?.split(' ')[0]), ['key=[jev-key]', 'key=[]', 'key=unset']);
    const normalized = runs.map((r) => r.argv.map((arg, i) => (r.argv[i - 1] === '-o' ? '<out>' : arg)).join(' '));
    assert.equal(normalized[1], normalized[0]);
    assert.equal(normalized[2], normalized[0]);
    assertProfile(runs[0]);
  });
});
describe('the exec profile on Linux from codex-cli 0.160.0 — spec:jev-every-run/S7', () => {
  for (const version of ['0.160.0', '0.161.0', '1.0.0']) {
    it(`codex-cli ${version}: the exec profile exactly, neither --sandbox nor sandbox_mode`, { skip: profileSkip }, () => {
      assertProfile(drive(sandbox(repos), ['-'], { CODEX_FAKE_VERSION: `codex-cli ${version}` }));
    });
  }
});
describe('the fallback by OS and by temp root — spec:jev-every-run/S9', () => {
  it('a uname other than Linux runs today\'s flags with the key passed and names the reason', () => {
    const r = drive(sandbox(), ['-'], { ...KEYS, CODEX_FAKE_UNAME: 'Darwin' });
    assertFallback(r);
    assert.equal(runEnv(r), PASSED);
    assert.equal(bannerOf(r), unreachable('not linux (Darwin)'));
  });
  it('a repository root under the realpath of TMPDIR falls back; a sibling sharing its name prefix does not', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const root = join(sb.dir, 'pfx');
    cpSync(sb.repo, join(root, 'repo'), { recursive: true });
    const under = drive(sb, ['-'], { ...KEYS, TMPDIR: root }, join(root, 'repo'));
    assertFallback(under);
    assert.equal(runEnv(under), PASSED);
    assert.equal(bannerOf(under), unreachable(`repository under ${realpathSync(root)}`));
    cpSync(sb.repo, join(sb.dir, 'pfx-repo'), { recursive: true });
    assertProfile(drive(sb, ['-'], { TMPDIR: root }, join(sb.dir, 'pfx-repo')));
  });
  it('a worktree whose git common dir is under TMPDIR falls back', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const root = join(sb.dir, 'tmproot');
    cpSync(sb.repo, join(root, 'main'), { recursive: true });
    spawnSync('git', ['worktree', 'add', '-q', join(sb.dir, 'wt')], { cwd: join(root, 'main'), encoding: 'utf8', env: childEnv(sb.home, { PATH: process.env.PATH }) });
    writeFileSync(join(sb.dir, 'wt', 'task.md'), CONTRACT);
    const r = drive(sb, ['-'], { TMPDIR: root }, join(sb.dir, 'wt'));
    assertFallback(r);
    assert.equal(bannerOf(r), unreachable(`repository under ${realpathSync(root)}`));
    // A git older than 2.31 echoes an unknown --path-format=… as its own line before the answer.
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(sb.bin, 'git'), ['#!/usr/bin/env bash', 'args=()', 'for a in "$@"; do',
      '  if [[ "$a" == --path-format=* ]]; then echo "$a"; else args+=("$a"); fi', 'done', `exec ${realGit} "\${args[@]}"`, ''].join('\n'));
    chmodSync(join(sb.bin, 'git'), 0o755);
    const old = drive(sb, ['-'], { TMPDIR: root }, join(sb.dir, 'wt'));
    assertFallback(old);
    assert.equal(bannerOf(old), unreachable(`repository under ${realpathSync(root)}`));
  });
  it('a repository under /tmp falls back naming /tmp', () => {
    const repo = mkdtempSync(join(tmp, 'exec-jev-tmp-'));
    cpSync(join(TEMPLATE, 'repo'), repo, { recursive: true });
    const underTmp = realpathSync(repo).startsWith(`${realpathSync('/tmp')}/`);
    const r = drive(sandbox(), ['-'], { TMPDIR: underTmp ? tmp : tmpdir() }, repo);
    assertFallback(r);
    assert.equal(bannerOf(r), unreachable(`repository under ${underTmp ? '/tmp' : realpathSync(tmpdir())}`));
  });
});
describe('the fallback by version and by the refused record — spec:jev-every-run/S10', () => {
  const cases = [['codex-cli 0.159.0', 'codex 0.159.0 below 0.160.0'], ['codex-cli 0.160.0-alpha.1', 'codex 0.160.0-alpha.1 below 0.160.0'],
    ['codex-cli', 'codex version unreadable']];
  for (const [line, reason] of cases) {
    it(`a version line '${line}' runs today's flags with the key passed: ${reason}`, () => {
      const r = drive(sandbox(), ['-'], { ...KEYS, CODEX_FAKE_VERSION: line });
      assertFallback(r);
      assert.equal(runEnv(r), PASSED);
      assert.equal(bannerOf(r), unreachable(reason));
    });
  }
  it('a listed version with this run\'s digest falls back naming the file; another digest or another version runs the profile', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    assert.equal(drive(sb, ['-'], { CODEX_FAKE_PRE: P13 }).status, 72);
    const [entry] = stateLines(sb);
    assert.match(entry ?? '', /^0\.160\.0 [0-9a-f]{64}$/);
    const refused = drive(sb, ['-'], KEYS);
    assertFallback(refused);
    assert.equal(runEnv(refused), PASSED);
    assert.ok(bannerOf(refused).includes('jev=unreachable (profile not recognized by codex 0.160.0'), bannerOf(refused));
    assert.ok(bannerOf(refused).includes(sb.state), 'the banner reason names the file');
    for (const other of [`0.160.0 ${'a'.repeat(64)}`, `0.161.0 ${entry.split(' ')[1]}`]) {
      writeFileSync(sb.state, `${other}\n`);
      assertProfile(drive(sb, ['-']));
    }
  });
});
describe('the profile error item before the turn — spec:jev-every-run/S11', () => {
  for (const [label, shape] of [['the P13 shape', P13], ['the P1 shape', P1]]) {
    it(`${label}, printed twice before turn.started: exit 72, one entry appended, a transport-failure receipt`, { skip: profileSkip }, () => {
      const sb = sandbox(repos);
      const r = drive(sb, ['--nonce', 'n1', 'task.md'], { CODEX_FAKE_PRE: `${shape}\n${shape}` });
      assert.equal(r.status, 72, r.stderr);
      assert.ok(r.stderr.includes(JSON.parse(shape).item.message), 'the matched message is printed');
      assert.doesNotMatch(r.stderr, /update codex/i);
      assert.doesNotMatch(r.stdout, /FAKE_FINAL/, 'no final message is printed');
      assert.equal(stateLines(sb).length, 1);
      assert.match(stateLines(sb)[0], /^0\.160\.0 [0-9a-f]{64}$/);
      assert.equal(statSync(dirname(sb.state)).mode & 0o777, 0o700);
      assert.equal(receiptOf(sb).outcome, 'transport-failure');
    });
  }
  for (const [label, env] of [['after turn.started', { CODEX_FAKE_POST: P13 }], ['in another shape', { CODEX_FAKE_PRE: OTHER_SHAPE }]]) {
    it(`${label}: the run ends as today and nothing is appended`, { skip: profileSkip }, () => {
      const sb = sandbox(repos);
      const r = drive(sb, ['-'], env);
      assertProfile(r);
      assert.equal(existsSync(sb.state), false);
    });
  }
  it('a failed write warns once naming the path and still exits 72 with its receipt', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    mkdirSync(dirname(dirname(sb.state)), { recursive: true });
    writeFileSync(dirname(sb.state), 'a file where the state directory belongs\n');
    const r = drive(sb, ['--nonce', 'n1', 'task.md'], { CODEX_FAKE_PRE: P13 });
    assert.equal(r.status, 72, r.stderr);
    assert.equal(r.stderr.split('\n').filter((line) => line.includes(sb.state)).length, 1, r.stderr);
    assert.equal(receiptOf(sb).outcome, 'transport-failure');
  });
});
describe('bwrap: execvp in a failed command — spec:jev-every-run/S12', () => {
  it('exits 72 without touching the state file', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const r = drive(sb, ['--nonce', 'n1', 'task.md'], { CODEX_FAKE_POST: command(BWRAP, 1, 'failed') });
    assert.equal(r.status, 72, r.stderr);
    assert.ok(r.stderr.includes('bwrap: execvp'), r.stderr);
    assert.equal(existsSync(sb.state), false);
    assert.equal(receiptOf(sb).outcome, 'transport-failure');
  });
});
describe('the same strings where they never fire — spec:jev-every-run/S13', () => {
  it('inside a successful command\'s output and in the final message: exit 0, a success receipt, no state file', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const r = drive(sb, ['--nonce', 'n1', 'task.md'], { CODEX_FAKE_POST: command(`${P13_TEXT}\n${BWRAP}`, 0, 'completed'),
      CODEX_FAKE_FINAL: `${P13_TEXT} ${BWRAP}` });
    assertProfile(r);
    assert.ok(r.stdout.includes(P13_TEXT));
    assert.equal(receiptOf(sb).outcome, 'success');
    assert.equal(existsSync(sb.state), false);
  });
});
describe('the exec banner and the receipt — spec:jev-every-run/S14', () => {
  it('a profile run reads sandbox=jev-profile and the two hosts before source=, the receipt keys unchanged', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const r = drive(sb, ['--nonce', 'n1', 'task.md']);
    assertProfile(r);
    assert.equal(bannerOf(r), banner('jev-profile', HOSTS));
    assert.deepEqual(Object.keys(receiptOf(sb)), RECEIPT_KEYS);
    assert.deepEqual(Object.keys(receiptOf(sb).posture), ['model', 'effort', 'tier']);
  });
  it('a fallback run reads sandbox=workspace-write and jev=unreachable, timeout= last', () => {
    const r = drive(sandbox(), ['--resume', 'sess-1', '-'], { CODEX_FAKE_VERSION: 'codex-cli 0.159.0' });
    assert.equal(bannerOf(r), banner('workspace-write', 'unreachable (codex 0.159.0 below 0.160.0)', 'resume:sess-1'));
  });
});
describe('the execution directive and the resume reminder — spec:jev-every-run/S17', () => {
  const HOST_LINE = 'the reachable host list is api.typesafe.ai, docs.typesafe.ai; network access to any other host is an escalation: STOP and report.';
  it('a fresh profile run names the two hosts and the other-host escalation; a fallback run keeps network access whole', { skip: profileSkip }, () => {
    const profile = drive(sandbox(repos), ['-']);
    assertProfile(profile);
    assert.ok(profile.prompt.includes(`5. Do NOT commit. Network: ${HOST_LINE}`), profile.prompt);
    const fallback = drive(sandbox(), ['-'], { CODEX_FAKE_UNAME: 'Darwin' });
    assert.ok(fallback.prompt.includes('escalation (network access, writes outside the repo'), fallback.prompt);
    assert.doesNotMatch(fallback.prompt, /typesafe/);
  });
  it('a resume states its current posture: the hosts on a profile run, network access on the next run of the same session that falls back', { skip: profileSkip }, () => {
    const sb = sandbox(repos);
    const profile = drive(sb, ['--resume', 'sess-1', '-']);
    assertProfile(profile);
    assert.ok(profile.prompt.includes(`Network, as of this run (it replaces any earlier statement): ${HOST_LINE}`), profile.prompt);
    const fallback = drive(sb, ['--resume', 'sess-1', '-'], { CODEX_FAKE_UNAME: 'Darwin' });
    assertFallback(fallback);
    assert.ok(fallback.prompt.includes('Network, as of this run (it replaces any earlier statement): network access is an escalation: STOP and report.'), fallback.prompt);
    assert.doesNotMatch(fallback.prompt, /typesafe/);
  });
});
const copyBridge = (sb, transform = (lines) => lines) => {
  const directory = join(sb.dir, 'bridge');
  cpSync(HERE, join(directory, 'bin'), { recursive: true });
  cpSync(join(HERE, '..', 'capability.json'), join(directory, 'capability.json'));
  const shipped = readFileSync(join(HERE, '..', 'service-facts.txt'), 'utf8').trimEnd().split('\n');
  writeFileSync(join(directory, 'service-facts.txt'), `${transform(shipped).join('\n')}\n`);
  const wrapper = join(directory, 'bin', 'linked-exec');
  symlinkSync('codex-exec.sh', wrapper);
  return { ...sb, wrapper };
};
describe('injected facts through a symlink — spec:jev-every-run/S26', () => {
  it('renders only the injected hosts and passes exactly the listed variables, including empty values', { skip: profileSkip }, () => {
    const sb = copyBridge(sandbox(repos), (lines) => [lines[0], 'HOST=a.example', 'HOST=b.example', 'RUN_HOST=a.example', 'RUN_HOST=b.example', lines.find((line) => line.startsWith('WRITABLE_DIR=')), 'PASSED_VARIABLE=FOO_API_KEY', 'PASSED_VARIABLE=BAR_API_KEY']);
    const env = { ...KEYS, BAR_API_KEY: '' };
    const fresh = drive(sb, ['-'], env), resume = drive(sb, ['--resume', 'sess-1', '-'], env), help = drive(sb, ['--help'], env);
    for (const result of [fresh, resume, help]) { assert.equal(result.status, 0, result.stderr); assert.doesNotMatch([result.argv.join(' '), result.prompt, result.stderr, result.stdout].join('\n'), /typesafe\.ai/i); }
    for (const result of [fresh, resume]) {
      assert.equal(overrides(result.argv)['permissions.jev.network.domains'], '{"a.example"="allow","b.example"="allow"}');
      assert.equal(bannerOf(result), banner('jev-profile', 'a.example,b.example', result === resume ? 'resume:sess-1' : 'fresh'));
      assert.ok(spawnsOf(result).length > 0, result.log);
      for (const [kind, keys] of spawnsOf(result)) assert.equal(keys, 'key=unset openai=unset codex=unset foo=[foo] base=unset bar=[]', kind);
    }
    const phrase = 'the reachable host list is a.example, b.example; network access to any other host is an escalation: STOP and report.';
    assert.ok(fresh.prompt.includes(`5. Do NOT commit. Network: ${phrase}`), fresh.prompt);
    assert.ok(resume.prompt.includes(`Network, as of this run (it replaces any earlier statement): ${phrase}`), resume.prompt);
    assert.ok(help.stdout.includes('network where the profile runs (the reachable host list is a.example, b.example) and off elsewhere'), help.stdout);
  });
  it('an empty passed-variable list unsets every billing key and OPENAI_BASE_URL', () => {
    const result = drive(copyBridge(sandbox(), (lines) => lines.filter((line) => !line.startsWith('PASSED_VARIABLE='))), ['-'], { ...KEYS, BAR_API_KEY: 'bar' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(spawnsOf(result).length > 0, result.log);
    for (const [kind, keys] of spawnsOf(result)) assert.equal(keys, 'key=unset openai=unset codex=unset foo=unset base=unset bar=unset', kind);
  });
});
describe('run hosts choose posture and preserve the shipped profile — spec:jev-every-run/S27', () => {
  it('no RUN_HOST takes fallback before the OS reason and makes help say network off', () => {
    const sb = copyBridge(sandbox(), (lines) => lines.filter((line) => !line.startsWith('RUN_HOST=')));
    for (const env of [{}, { CODEX_FAKE_UNAME: 'Darwin' }]) {
      const result = drive(sb, ['-'], env);
      assertFallback(result);
      assert.equal(bannerOf(result), unreachable('no run host in service-facts.txt'));
    }
    const help = drive(sb, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout.split('\n')[0], /network off/);
  });
  it('characterize-first: both shipped profiles retain the exact overrides and recorded refusal digest', { skip: profileSkip }, () => {
    const common = ['default_permissions=jev', 'permissions.jev.network.enabled=true', 'permissions.jev.network.domains={"api.typesafe.ai"="allow","docs.typesafe.ai"="allow"}'];
    for (const [wrapper, filesystem, digest] of [['codex-exec.sh', 'permissions.jev.filesystem={":root"="read",":tmpdir"="write",":slash_tmp"="write",":workspace_roots"={"."="write"}}', 'f693ef134a9c6d5b41042b91260726d4179d99ccadc149270f1ddba09cdc99e8'], ['codex-review.sh', 'permissions.jev.filesystem={":root"="read"}', 'c68a3f5f7be241f7cecf5328a3541063e1f25365f216798aff42b719164f9159']]) {
      const sb = { ...sandbox(repos), wrapper: join(HERE, wrapper) };
      const result = drive(sb, wrapper === 'codex-exec.sh' ? ['-'] : ['plan', 'task.md'], { CODEX_FAKE_PRE: P13 });
      assert.equal(result.status, 72, result.stderr);
      assert.deepEqual(result.argv.flatMap((arg, index) => result.argv[index - 1] === '-c' && /^(default_permissions|permissions\.)/.test(arg) ? ['-c', arg] : []), [...common, filesystem].flatMap((arg) => ['-c', arg]));
      assert.deepEqual(stateLines(sb), [`0.160.0 ${digest}`]);
    }
  });
});
describe('the probe passthrough under the profile — spec:jev-every-run/S18', () => {
  for (const flag of [['--add-dir', '/x'], ['-C', '/x'], ['--cd', '/x'], ['--enable', 'foo'], ['--disable', 'foo']]) {
    it(`CODEX_PROBE=1 with ${flag[0]}: refused pre-spend under the profile, admitted under the fallback`, { skip: profileSkip }, () => {
      const refused = drive(sandbox(repos), ['-', '--', ...flag], { CODEX_PROBE: '1' });
      assert.equal(refused.status, 2, refused.stderr);
      assert.equal(spawnsOf(refused).some(([kind]) => kind === 'run'), false, 'no run is spent');
      const admitted = drive(sandbox(), ['-', '--', ...flag], { CODEX_PROBE: '1', CODEX_FAKE_UNAME: 'Darwin' });
      assertFallback(admitted);
      assert.ok(admitted.argv.includes(flag[0]), admitted.argv.join(' '));
    });
  }
  it('exactly these five: --ignore-rules stays admitted under the profile', { skip: profileSkip }, () => {
    const r = drive(sandbox(repos), ['-', '--', '--ignore-rules'], { CODEX_PROBE: '1' });
    assertProfile(r);
    assert.ok(r.argv.includes('--ignore-rules'));
  });
});
