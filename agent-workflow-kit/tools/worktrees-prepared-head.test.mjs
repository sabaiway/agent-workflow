// worktrees-prepared-head.test.mjs — `land --prepare` records prepared-head beside prepared-tree
// (delegation Plan 3, Phase 3, D8): a tree comparison alone cannot close the rung's window, because
// a clean post-commit index reproduces the committed tree. Its OWN suite (D6): no existing
// worktrees assertion or fixture moves.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, handoffBasename, runCli } from './worktrees.mjs';
import { composeProvisionRecordSection, parseProvisionRecord } from './worktrees-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-prepared-head-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, text: out.join('\n'), errText: err.join('\n') };
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'base\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({
    gates: [{ id: 'review-state', title: 'review state', cmd: 'node review-state.mjs --check' }],
  }, null, 2));
  mkdirSync(join(main, 'agent-workflow-kit/tools'), { recursive: true });
  writeFileSync(join(main, 'agent-workflow-kit/tools/review-state.mjs'), 'export {};\n');
  writeFileSync(join(main, 'agent-workflow-kit/tools/run-gates.mjs'), 'export {};\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/.vscode/', '/node_modules', ''].join('\n'));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# feature plan\n');
  return main;
};

const stubChildren = () => (command, args = []) => {
  const line = [command, ...args].join(' ');
  if (line.includes('review-state.mjs')) return { status: 0, stdout: 'satellite review-state: green\n', stderr: '' };
  if (line.includes('run-gates.mjs')) return { status: 0, stdout: 'gate matrix: green\n', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

describe('land --prepare — the prepared-head record', () => {
  it('land --prepare records prepared-head', () => {
    const main = makeRepo('ph-land');
    const slug = 'ph-land';
    const provisioned = run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature.md'], { cwd: main });
    assert.equal(provisioned.code, EXIT.ok, provisioned.errText);
    const worktree = join(dirname(main), `${basename(main)}--${slug}`);
    writeFileSync(join(worktree, 'README.md'), 'feature\n');
    sh(['add', '-A'], worktree);
    const headBefore = sh(['rev-parse', 'HEAD'], main).trim();
    const landed = run(['land', slug, '--prepare'], { cwd: main, deps: { spawn: stubChildren() } });
    assert.equal(landed.code, EXIT.ok, landed.errText);
    const text = readFileSync(join(worktree, 'docs/plans', handoffBasename(slug)), 'utf8');
    assert.ok(text.includes(`- prepared-head: ${headBefore}`), text);
    const record = parseProvisionRecord(text);
    assert.equal(record.preparedHead, headBefore);
    assert.equal(record.prepared !== null, true, 'prepared-tree still rides the same refresh');
  });

  it('a record written without prepared-head round-trips unchanged', () => {
    const base = { slug: 's1', branch: 'aw/s1', includes: [], nodeModules: 'skipped', vscode: 'skipped', prepared: 'a'.repeat(40) };
    const withoutHead = composeProvisionRecordSection(base);
    assert.equal(withoutHead.includes('prepared-head'), false, 'an absent optional field renders as absence, never as a dangling line');
    const parsed = parseProvisionRecord(withoutHead);
    assert.equal(parsed.preparedHead, null, 'an older kit record reads back as null, not undefined');
    assert.equal(composeProvisionRecordSection({ ...base, preparedHead: parsed.preparedHead }), withoutHead, 'the write-read round-trip is byte-stable');
    const oid = 'b'.repeat(40);
    const withHead = composeProvisionRecordSection({ ...base, preparedHead: oid });
    assert.ok(withHead.includes(`- prepared-head: ${oid}`));
    assert.equal(parseProvisionRecord(withHead).preparedHead, oid);
  });
});
