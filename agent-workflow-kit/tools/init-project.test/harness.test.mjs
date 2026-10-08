// The fixtures of the init-project batch suites: a temp project with a scripted terminal and a recording spawn, and
// its real-writer variant over the advisor. It declares no test.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecommendations } from '../recommendations.mjs';
import { detectBackends } from '../detect-backends.mjs';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';

export const init = await import('../init-project.mjs').catch(() => ({}));
export const lanes = await import('../write-lanes.mjs').catch(() => ({}));
export const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
export const APPLY = 'apply? y/N: ';
export const SUDO = 'the sandbox install may ask for your sudo password: y runs it, Enter skips: ';
export const RUN_NONE = 'y applies every preview above (a sudo install asks once more on its own line); run none of their commands yourself';
export const RESTART = 'restart the agent from this folder: init changed its configuration';
export const FIVE = ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'gate-hook', 'mcp-channel'];
const WANTED = new Set([...FIVE, 'autonomy-render']);
export const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
export const item = (variant, what = variant) => ({
  key: variant.split('.')[0], variant, lane: 'console', severity: 'optional',
  what, benefit: '', apply: '', detail: null,
});
export const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
export const ok = (stdout = '', status = 0) => ({ status, stdout, stderr: '' });
export const isApply = (argv) => argv.includes('--apply');
export const applies = (f) => f.calls.filter(({ argv }) => isApply(argv));
export const facts = (f) => ({ toolsDir: TOOLS, root: f.root, home: f.home, env: f.env, platform: 'linux' });
export const hashTree = (root) => {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      entries.push([path, stat.mode, stat.isDirectory() ? null : readFileSync(path).toString('hex')]);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
};
export const fixture = (t, queue = [], answers = ['y']) => {
  const base = mkdtempSync(join(tmpdir(), 'init-batch-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(home);
  put(join(bin, 'codex-review'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'codex-review'), 0o755);
  put(join(root, 'docs/ai/.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  put(join(root, 'docs/ai/gates.json'), JSON.stringify({ gates: [{ id: 'test', title: 'Tests', cmd: 'node --test' }] }));
  put(join(root, '.claude/settings.json'), '{}\n');
  put(join(root, '.mcp.json'), '{"mcpServers":{}}\n');
  const f = {
    root, home, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    printed: [], questions: [], calls: [], events: [], recommendations: [],
    answers, queues: [queue, []],
  };
  f.respond = () => ok();
  f.recommend = () => ({ items: f.queues.shift() ?? [] });
  const terminal = {
    isTTY: true,
    print: (line) => {
      f.printed.push(line);
      f.events.push(['print', line]);
    },
    ask: async (prompt) => {
      f.questions.push(prompt);
      f.events.push(['ask', prompt]);
      assert.ok(f.answers.length, `unexpected question: ${prompt}`);
      const answer = f.answers.shift();
      return typeof answer === 'function' ? await answer() : answer;
    },
  };
  f.deps = {
    ...facts(f), cwd: root, terminal,
    spawn: (argv, opts) => {
      f.calls.push({ argv, opts });
      f.events.push(['spawn', argv]);
      return f.respond(argv, opts);
    },
    recommend: (project, state) => {
      f.recommendations.push({ root: project, facts: state });
      return f.recommend(project, state);
    },
  };
  return f;
};
export const realFixture = (t, wanted = WANTED) => {
  const f = fixture(t);
  f.env.CODEX_CLI_BRIDGE_DIR = join(TOOLS, '..', 'bridges', 'codex-cli-bridge');
  const bin = join(dirname(f.root), 'bin');
  for (const name of ['codex', 'codex-exec']) {
    put(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  put(join(f.home, '.codex/auth.json'), '{}');
  const codex = detectBackends({ getenv: f.env, home: f.home }).find(({ name }) => name === 'codex-cli-bridge');
  assert.equal(codex?.readiness, 'ready', 'realFixture must make codex-cli-bridge ready');
  f.respond = (argv, opts) => {
    assert.equal(argv[0], 'node');
    assert.ok(['velocity-profile.mjs', 'gate-hook.mjs', 'mcp.mjs'].some((name) => argv[1] === join(TOOLS, name)));
    const r = spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  f.recommend = (root) => ({
    items: root === null ? [] : buildRecommendations({
      cwd: root,
      deps: { getenv: f.env, env: f.env, home: f.home, findWrapper: (c) => c === 'codex-review' },
    }).items.filter((i) => wanted.has(i.variant)),
  });
  return f;
};
export const pending = (f) => f.recommend(f.root).items.map((i) => i.variant);
export const policy = (f, activity = 'plan-execution') => put(join(f.root, 'docs/ai/autonomy.json'), JSON.stringify({ [activity]: { autonomy: 'sandbox' } }));
export const changed = (variant, path) => `not applied: ${variant} — ${path} changed outside this batch`;
