import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from './git-env.mjs';

export const load = () => import('./feedback-record-cli.mjs');
export const MIB = 1024 * 1024;
export const git = (repo, args) => {
  const result = spawnSync('git', args, { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
export const commit = (repo) => {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return git(repo, ['rev-parse', 'HEAD']);
};
export const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'feedback-record-cli-'));
  const home = join(root, '.home');
  mkdirSync(home);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  const env = {
    ...hermeticGitEnv(process.env, home),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
  const repo = { root, env };
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'anchor.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  return { ...repo, head: commit(repo) };
};
export const row = ({ id = 1, claim = 'Claim', evidence = '`anchor.txt:1-3`', verdict = 'confirmed', disposition = 'queue ROW-A' } = {}) =>
  `| ${id} | ${claim} | ${evidence} | ${verdict} | ${disposition} |`;
export const record = (head, { rows = [row()], notes = null } = {}) => [
  '# Feedback: Fixture report', '', 'Source: field report', '', `Head: ${head}`, '', '## Claims', '',
  '| # | Claim | Evidence | Verdict | Disposition |', '| --- | --- | --- | --- | --- |', ...rows,
  ...(notes === null ? [] : ['', '## Notes', notes]), '',
].join('\n');
export const putRecord = (repo, text = record(repo.head), name = 'record.md') => {
  const path = join(repo.root, name);
  writeFileSync(path, text);
  return path;
};
export const invoke = async (repo, argv, overrides = {}) => {
  const logs = [];
  const errors = [];
  const calls = [];
  const delegate = overrides.spawn ?? spawnSync;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return delegate(command, args, options);
  };
  const code = (await load()).main(argv, {
    cwd: repo.root, env: repo.env, log: (line) => logs.push(String(line)),
    error: (line) => errors.push(String(line)), now: () => new Date('2026-09-03T00:00:00Z'),
    ...overrides, spawn,
  });
  return { code, logs, errors, calls };
};
export const clean = async (fn) => {
  const repo = makeRepo();
  try { return await fn(repo); } finally { rmSync(repo.root, { recursive: true, force: true }); }
};
