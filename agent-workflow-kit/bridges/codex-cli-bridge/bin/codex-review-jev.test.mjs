// codex-review-jev.test.mjs — spec jev-every-run on codex-review: the key rule, the review profile (no write entry),
// the fallback, the loud failure on each attempt's own trace, the banner, the fence home's skill link and the
// directives. Standalone harness with its own fake codex and a fake uname.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, 'codex-review.sh');
const HOSTS = 'api.typesafe.ai,docs.typesafe.ai';
// The same layout as codex-exec-jev: repositories under the package's node_modules, TMPDIR their sibling.
const FIXTURES = join(HERE, '..', 'node_modules', '.aw-fixtures');
const TMP = join(FIXTURES, 'tmp');
mkdirSync(TMP, { recursive: true });
mkdirSync(join(FIXTURES, 'repos'), { recursive: true });
const ROOT = mkdtempSync(join(FIXTURES, 'repos', 'review-jev-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const REAL_UNAME = spawnSync('bash', ['-c', 'type -P uname'], { encoding: 'utf8' }).stdout.trim();

// Every spawn appends its kind and key states; a run also records argv, stdin and what $HOME/.agents/skills is.
const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'st() { if [[ -n "${!1+x}" ]]; then printf "[%s]" "${!1}"; else printf unset; fi; }',
  'rec() { echo "$1 key=$(st TYPESAFE_API_KEY) openai=$(st OPENAI_API_KEY) codex=$(st CODEX_API_KEY) foo=$(st FOO_API_KEY) base=$(st OPENAI_BASE_URL)" >>"$CODEX_FAKE_LOG"; }',
  'case "${1:-}" in',
  '  login) rec login; echo "Logged in using ChatGPT"; exit 0 ;;',
  '  --version) rec version; echo "${CODEX_FAKE_VERSION-codex-cli 0.160.0}"; exit 0 ;;',
  '  debug) rec catalog; cat <<EOF',
  '{"models":[{"slug":"gpt-6.1-sol","priority":1,"visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"}]}]}',
  'EOF',
  '    exit 0 ;;',
  'esac',
  'rec run',
  '{ for a in "$@"; do echo "$a"; done; } >"$CODEX_FAKE_ARGV"',
  'cat >"$CODEX_FAKE_STDIN"',
  'if [[ -L "$HOME/.agents/skills" ]]; then echo "link $(readlink -f "$HOME/.agents/skills")"; elif [[ -e "$HOME/.agents/skills" ]]; then echo present; else echo absent; fi >"$CODEX_FAKE_SKILLS"',
  'out=""; prev=""; schema=""',
  'for a in "$@"; do if [[ "$prev" == "-o" ]]; then out="$a"; fi; if [[ "$a" == "--output-schema" ]]; then schema=1; fi; prev="$a"; done',
  'if [[ -n "$out" ]]; then printf "%s\\n" "${CODEX_FAKE_FINAL:-FAKE_REVIEW}" "Verdict: ship" >"$out"; fi',
  'echo "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"sess-review\\"}"',
  'if [[ -n "$schema" ]]; then pre="${CODEX_FAKE_PRE_SCHEMA:-}"; else pre="${CODEX_FAKE_PRE_PLAIN:-}"; fi',
  'if [[ -n "${CODEX_FAKE_PRE:-}$pre" ]]; then echo "${CODEX_FAKE_PRE:-}$pre"; fi',
  'echo "{\\"type\\":\\"turn.started\\"}"',
  'if [[ -n "${CODEX_FAKE_POST:-}" ]]; then echo "$CODEX_FAKE_POST"; fi',
  'echo "{\\"type\\":\\"turn.completed\\",\\"usage\\":{}}"',
  'if [[ -n "$schema" && -n "${CODEX_FAKE_FAIL_ON_SCHEMA:-}" ]]; then exit 1; fi',
  'exit 0',
  '',
].join('\n');
const FAKE_UNAME = ['#!/usr/bin/env bash', 'if [[ $# -eq 0 || "$1" == "-s" ]]; then echo "${CODEX_FAKE_UNAME:-Linux}"; exit 0; fi',
  `exec "${REAL_UNAME}" "$@"`, ''].join('\n');

const TEMPLATE = join(ROOT, 'template');
mkdirSync(join(TEMPLATE, 'bin'), { recursive: true });
mkdirSync(join(TEMPLATE, 'home'));
mkdirSync(join(TEMPLATE, 'repo'));
writeFileSync(join(TEMPLATE, 'bin', 'codex'), FAKE_CODEX);
writeFileSync(join(TEMPLATE, 'bin', 'uname'), FAKE_UNAME);
{
  const git = (...args) => spawnSync('git', args, { cwd: join(TEMPLATE, 'repo'), encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  writeFileSync(join(TEMPLATE, 'repo', 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  writeFileSync(join(TEMPLATE, 'repo', 'plan.md'), '# Plan\n\nDo a thing in two steps.\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
}

let sequence = 0;
const sandbox = ({ skills = true } = {}) => {
  const dir = join(ROOT, `sb-${++sequence}`);
  cpSync(TEMPLATE, dir, { recursive: true });
  for (const name of ['codex', 'uname']) chmodSync(join(dir, 'bin', name), 0o755);
  const sb = { dir, bin: join(dir, 'bin'), home: join(dir, 'home'), repo: join(dir, 'repo'),
    state: join(dir, 'home', '.local', 'state', 'agent-workflow', 'codex-jev-profile-refused') };
  if (skills) {
    mkdirSync(join(sb.home, '.agents', 'skills', 'typesafe-ai'), { recursive: true });
    writeFileSync(join(sb.home, '.agents', 'skills', 'typesafe-ai', 'SKILL.md'), '# the vendor skill\n');
  }
  writeFileSync(join(sb.repo, 'pending.txt'), 'an uncommitted change to review\n');
  return sb;
};
const PLAN = ['plan', 'plan.md'];
const drive = (sb, args, env = {}, cwd = sb.repo) => {
  const cap = (name) => join(sb.dir, name);
  for (const name of ['log', 'argv', 'stdin', 'skills']) rmSync(cap(name), { force: true });
  const r = spawnSync('bash', [REVIEW, ...args], {
    cwd, input: '', encoding: 'utf8', timeout: 60000,
    env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, TMPDIR: TMP, CODEX_FAKE_LOG: cap('log'), CODEX_FAKE_ARGV: cap('argv'),
      CODEX_FAKE_STDIN: cap('stdin'), CODEX_FAKE_SKILLS: cap('skills'), ...env },
  });
  const read = (name) => (existsSync(cap(name)) ? readFileSync(cap(name), 'utf8') : '');
  const spawns = read('log').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, spawns, runs: spawns.filter(([kind]) => kind === 'run').length,
    argv: read('argv').split('\n').slice(0, -1), prompt: read('stdin').replace(/\s+/g, ' '), skills: read('skills').trim() };
};

const overrides = (argv) => Object.fromEntries(argv.flatMap((arg, i) => (argv[i - 1] === '-c'
  ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : [])));
// A reader for the TOML inline tables a profile override carries.
const inline = (text) => {
  let at = 0;
  const eat = (re) => {
    const m = re.exec(text.slice(at));
    assert.ok(m, `an inline table: ${text}`);
    at += m[0].length;
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
  assert.equal(text.slice(at).trim(), '', `nothing after the inline table: ${text}`);
  return parsed;
};
const PROFILE_KEYS = ['default_permissions', 'permissions.jev.filesystem', 'permissions.jev.network.domains', 'permissions.jev.network.enabled'];
const profileKeys = (c) => Object.keys(c).filter((key) => key === 'default_permissions' || key.startsWith('permissions.')).sort();
const assertProfile = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const c = overrides(r.argv);
  assert.deepEqual(profileKeys(c), PROFILE_KEYS, r.argv.join(' '));
  assert.equal(c.default_permissions.replace(/^"(.*)"$/, '$1'), 'jev');
  assert.equal(c['permissions.jev.network.enabled'], 'true');
  assert.deepEqual(inline(c['permissions.jev.network.domains']), { 'api.typesafe.ai': 'allow', 'docs.typesafe.ai': 'allow' });
  assert.deepEqual(inline(c['permissions.jev.filesystem']), { ':root': 'read' }, 'the review profile carries no write entry');
  assert.equal(r.argv.includes('--sandbox') || 'sandbox_mode' in c, false, 'no --sandbox read-only beside the profile');
};
const assertFallback = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(profileKeys(overrides(r.argv)), [], r.argv.join(' '));
  assert.equal(r.argv[r.argv.indexOf('--sandbox') + 1], 'read-only', r.argv.join(' '));
};
const bannerOf = (r) => r.stderr.split('\n').find((line) => line.startsWith('review posture: ')) ?? '';
const banner = (jev) => `review posture: model=gpt-6.1-sol effort=high tier=standard jev=${jev} source=model:default,effort:default timeout=1800s`;
const KEYS = { TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'sk-live', CODEX_API_KEY: 'ck', FOO_API_KEY: 'foo', OPENAI_BASE_URL: 'http://proxy' };
const PASSED = 'key=[jev-key] openai=unset codex=unset foo=unset base=unset';
const runEnv = (r) => (r.spawns.find(([kind]) => kind === 'run') ?? [])[1];
const item = (body) => JSON.stringify({ type: 'item.completed', item: body });
const P13_TEXT = 'Configured filesystem path `:root` is not recognized by this version of Codex and will be ignored. Upgrade Codex if this path is required.';
const P13 = item({ id: 'item_0', type: 'error', message: P13_TEXT });
const command = (output, exitCode, status) => item({ id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: output, exit_code: exitCode, status });
const BWRAP = 'bwrap: execvp /usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex: No such file or directory\n';
const receiptsOf = (sb) => {
  const file = join(sb.repo, '.git', 'agent-workflow-review-receipts.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const RECEIPT_KEYS = ['schema', 'artifact', 'fresh', 'fingerprint', 'backend', 'verdict', 'grounded', 'factsHash', 'wrapperVersion', 'timestamp',
  'probe', 'durationS', 'blocking', 'artifactPath', 'posture'];
const stateLines = (sb) => (existsSync(sb.state) ? readFileSync(sb.state, 'utf8').split('\n').filter(Boolean) : []);

describe('the key rule on codex-review — spec:jev-every-run/S3', () => {
  it('passes TYPESAFE_API_KEY and unsets every other key on the login, version, catalog and run spawns', () => {
    const r = drive(sandbox(), PLAN, KEYS);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([...new Set(r.spawns.map(([kind]) => kind))].sort(), ['catalog', 'login', 'run', 'version']);
    for (const [kind, env] of r.spawns) assert.equal(env, PASSED, `${kind} spawn`);
  });
  it('the review half of S5: an empty key reaches codex empty, an unset one stays unset, the argv the same as with the key set', () => {
    const runs = ['jev-key', '', undefined].map((value) => drive(sandbox(), PLAN, { TYPESAFE_API_KEY: value }));
    assert.deepEqual(runs.map((r) => runEnv(r)?.split(' ')[0]), ['key=[jev-key]', 'key=[]', 'key=unset']);
    const normalized = runs.map((r) => r.argv.map((arg, i) => (r.argv[i - 1] === '-o' ? '<out>' : arg)).join(' '));
    assert.deepEqual([normalized[1], normalized[2]], [normalized[0], normalized[0]]);
    assertProfile(runs[0]);
  });
});

describe('the review profile on Linux from codex-cli 0.160.0 — spec:jev-every-run/S8', () => {
  for (const args of [PLAN, ['code']]) {
    it(`codex-review ${args[0]}: :root read and no write entry, the two hosts, no --sandbox read-only`, () => {
      assertProfile(drive(sandbox(), args));
    });
  }
});

describe('the review half of S9 and S10: the fallback, and the temp-root rule that is codex-exec\'s alone', () => {
  for (const [label, env, reason] of [['a uname other than Linux', { CODEX_FAKE_UNAME: 'Darwin' }, 'not linux (Darwin)'],
    ['codex-cli 0.159.0', { CODEX_FAKE_VERSION: 'codex-cli 0.159.0' }, 'codex 0.159.0 below 0.160.0']]) {
    it(`${label}: --sandbox read-only with the key passed, the reason named`, () => {
      const r = drive(sandbox(), PLAN, { ...KEYS, ...env });
      assertFallback(r);
      assert.equal(runEnv(r), PASSED);
      assert.equal(bannerOf(r), banner(`unreachable (${reason})`));
    });
  }
  it('a review from a repository under TMPDIR still runs the profile', () => {
    const sb = sandbox();
    const root = join(sb.dir, 'tmproot');
    cpSync(sb.repo, join(root, 'repo'), { recursive: true });
    assertProfile(drive(sb, PLAN, { TMPDIR: root }, join(root, 'repo')));
  });
  it('its own refused entry falls back naming the file; another digest of the same version runs the profile', () => {
    const sb = sandbox();
    assert.equal(drive(sb, PLAN, { CODEX_FAKE_PRE: P13 }).status, 72);
    const refused = drive(sb, PLAN);
    assertFallback(refused);
    assert.ok(bannerOf(refused).includes('jev=unreachable (profile not recognized by codex 0.160.0'), bannerOf(refused));
    assert.ok(bannerOf(refused).includes(sb.state), 'the banner reason names the file');
    writeFileSync(sb.state, `0.160.0 ${'a'.repeat(64)}\n`);
    assertProfile(drive(sb, PLAN));
  });
});

describe('the review half of S11-S13: the loud failure on each attempt\'s own trace', () => {
  it('a P13 item before turn.started exits 72 with no receipt and appends one entry', () => {
    const sb = sandbox();
    const r = drive(sb, PLAN, { CODEX_FAKE_PRE: `${P13}\n${P13}` });
    assert.equal(r.status, 72, r.stderr);
    assert.ok(r.stderr.includes(P13_TEXT));
    assert.doesNotMatch(r.stderr, /update codex/i);
    assert.deepEqual(receiptsOf(sb), []);
    assert.equal(stateLines(sb).length, 1);
    assert.match(stateLines(sb)[0], /^0\.160\.0 [0-9a-f]{64}$/);
  });
  it('bwrap: execvp in a failed command exits 72 with no receipt and no state file', () => {
    const sb = sandbox();
    const r = drive(sb, PLAN, { CODEX_FAKE_POST: command(BWRAP, 1, 'failed') });
    assert.equal(r.status, 72, r.stderr);
    assert.deepEqual(receiptsOf(sb), []);
    assert.equal(existsSync(sb.state), false);
  });
  it('the same strings in a successful command and in the final message leave the review and its receipt as today', () => {
    const sb = sandbox();
    const r = drive(sb, PLAN, { CODEX_FAKE_POST: command(`${P13_TEXT}\n${BWRAP}`, 0, 'completed'), CODEX_FAKE_FINAL: `${P13_TEXT} ${BWRAP}` });
    assertProfile(r);
    assert.equal(receiptsOf(sb).length, 1);
    assert.equal(existsSync(sb.state), false);
  });
  it('a schema attempt that carries the item exits 72 before the retry', () => {
    const r = drive(sandbox(), PLAN, { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FAIL_ON_SCHEMA: '1', CODEX_FAKE_PRE_SCHEMA: P13 });
    assert.equal(r.status, 72, r.stderr);
    assert.equal(r.runs, 1, 'no retry is spent');
  });
  it('a retry that carries the item is scanned on its own trace and exits 72', () => {
    const r = drive(sandbox(), PLAN, { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FAIL_ON_SCHEMA: '1', CODEX_FAKE_PRE_PLAIN: P13 });
    assert.equal(r.status, 72, r.stderr);
    assert.equal(r.runs, 2);
  });
});

describe('the review half of S14: the banner and the receipt', () => {
  it('a profile run names the two hosts before source=, timeout= last; the receipt keys unchanged', () => {
    const sb = sandbox();
    const r = drive(sb, PLAN);
    assertProfile(r);
    assert.equal(bannerOf(r), banner(HOSTS));
    assert.deepEqual(Object.keys(receiptsOf(sb)[0]), RECEIPT_KEYS);
    assert.deepEqual(Object.keys(receiptsOf(sb)[0].posture), ['model', 'effort', 'tier']);
  });
});

describe('the fence home links the real Codex skill root — spec:jev-every-run/S15', () => {
  for (const [label, env, assertPosture] of [['a profile run', {}, assertProfile], ['a fallback run', { CODEX_FAKE_UNAME: 'Darwin' }, assertFallback]]) {
    it(`${label}: .agents/skills links to the real root when it exists, no link when it does not, and the review runs`, () => {
      const sb = sandbox();
      const linked = drive(sb, PLAN, env);
      assertPosture(linked);
      assert.equal(linked.skills, `link ${realpathSync(join(sb.home, '.agents', 'skills'))}`);
      const bare = drive(sandbox({ skills: false }), PLAN, env);
      assertPosture(bare);
      assert.equal(bare.skills, 'absent');
    });
  }
});

describe('the three fence directives — spec:jev-every-run/S16', () => {
  const NO_WRITE = 'do NOT edit, create, or delete any file';
  it('each directive admits the linked skill and names the two hosts on a profile run, and still forbids every write', () => {
    for (const [args, env] of [[PLAN, {}], [['code'], {}], [['code'], { CODEX_REVIEW_MAX_TOTAL_BYTES: '1' }]]) {
      const r = drive(sandbox(), args, env);
      assertProfile(r);
      for (const text of ['.agents/skills', 'api.typesafe.ai', 'docs.typesafe.ai', NO_WRITE]) assert.ok(r.prompt.includes(text), `${args[0]} ${text}`);
    }
  });
  it('the oversized code review keeps its one exception, the precomputed-diff file', () => {
    const r = drive(sandbox(), ['code'], { CODEX_REVIEW_MAX_TOTAL_BYTES: '1' });
    assertProfile(r);
    assert.match(r.prompt, /with ONE exception . the precomputed-diff file at \S*codex-review-diff\.\d+; read it IN FULL/);
  });
  it('a fallback run names no host, and no skill is admitted when no link is made', () => {
    const fallback = drive(sandbox(), PLAN, { CODEX_FAKE_UNAME: 'Darwin' });
    assertFallback(fallback);
    assert.doesNotMatch(fallback.prompt, /typesafe/);
    assert.ok(fallback.prompt.includes('.agents/skills'), 'the link is made on a fallback run too');
    const bare = drive(sandbox({ skills: false }), PLAN);
    assertProfile(bare);
    assert.equal(bare.prompt.includes('.agents/skills'), false);
  });
});
