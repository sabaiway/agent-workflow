// Shared fixture module for the core-evidence facade suite and its leaf suites.
import { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ── hermetic fixtures (the family idiom: mkdtemp repo + a clean AW_-stripped env) ─────────────────

export const gitInit = (root) => {
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  return g;
};

export const fixtureEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, ...extra };
};

// Every makeRepo starts from the SAME committed base — built once, cloned per test (a per-test
// `git init`+commit dominated this suite's wall).
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'core-evidence-template-'));
  const g = gitInit(dir);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

export const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'core-evidence-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  return { root, g: (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }) };
};

export const headOf = (root) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
export const storeOf = (root) => join(root, '.git', 'agent-workflow-core-evidence.jsonl');

export const validRedProof = (over = {}) => ({
  schema: 1, kind: 'red-proof', testId: 'lib.test.mjs#red case', file: 'lib.test.mjs',
  fileHash: 'a'.repeat(64), runs: 3, reds: 3, base: 'b'.repeat(40), fingerprint: 'c'.repeat(64),
  timestamp: '2026-07-16T00:00:00Z', ...over,
});
export const validDegrade = (over = {}) => ({
  schema: 1, kind: 'degrade', backend: 'agy', reason: 'oversized diff — headless permission lane missing',
  fingerprint: 'c'.repeat(64), timestamp: '2026-07-16T00:00:00Z', ...over,
});
