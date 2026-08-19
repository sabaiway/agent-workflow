// worktrees-seed-plan.test.mjs — the seed-plan refusals that only a raced filesystem reaches
// (delegation Plan 3, Phase 2, round-5 fold).
//
// Its own suite, and a small one: the round-5 fold routed every seed-plan diagnostic through the
// shared escaper, and one of those diagnostics sits in a branch no ordinary run takes — the node
// classified as a regular file and then failed to resolve. A branch nothing can reach is a claim
// nothing checks, so it gets an injected race rather than an argument.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-seed-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/.vscode/', '/node_modules', ''].join('\n'));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# plan body\n');
  return main;
};

describe('worktrees seed plan — the raced refusal', () => {
  it('a plan that classifies as a regular file and then fails to resolve refuses with the path escaped', () => {
    const repo = makeRepo('seed-race');
    // The window between the no-follow classification and the realpath: injected, because a real
    // race is not a thing a test can schedule. The path carries a C1 byte so the SAME run proves
    // both that the branch refuses and that its diagnostic renders the value safely.
    const planFlag = `docs/plans/SEED${String.fromCharCode(0x9b)}-PROMPT-feature.md`;
    writeFileSync(join(repo, planFlag), '# plan body\n');
    const out = [];
    const err = [];
    const code = runCli(['provision', 'race', '--plan', planFlag, '--as', 'feature-race.md'], {
      cwd: repo,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      realpath: (p) => {
        if (String(p).endsWith(planFlag.slice('docs/plans/'.length))) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return realpathSync(p);
      },
    });
    const text = err.join('\n');
    assert.equal(code, 1, text);
    assert.match(text, /--plan: not found:/);
    assert.match(text, /\\u009b/, 'the path renders escaped');
    assert.doesNotMatch(text, new RegExp(String.fromCharCode(0x9b)), 'and never raw');
  });
});
