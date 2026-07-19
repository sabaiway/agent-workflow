import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, handoffBasename, runCli, spawnGit } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-landing-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const EXCLUDES = [
  '/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md',
  '/node_modules', '/extra.txt', '/.vscode/', '',
];

const gitResult = (args, cwd) => spawnSync('git', args, {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
});

const sh = (args, cwd) => {
  const result = gitResult(args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const makeRepo = (name, { gates = true, sync = false, include = false } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'base\n');
  writeFileSync(join(main, 'old.txt'), 'rename me\n');
  writeFileSync(join(main, 'run.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(main, '.gitattributes'), '*.special diff=fixture-textconv\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  if (gates) {
    writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({
      gates: [{ id: 'review-state', title: 'review state', cmd: 'node review-state.mjs --check' }],
    }, null, 2));
  }
  mkdirSync(join(main, 'agent-workflow-kit/tools'), { recursive: true });
  writeFileSync(join(main, 'agent-workflow-kit/tools/review-state.mjs'), 'export {};\n');
  writeFileSync(join(main, 'agent-workflow-kit/tools/run-gates.mjs'), 'export {};\n');
  if (sync) {
    mkdirSync(join(main, 'scripts'), { recursive: true });
    writeFileSync(join(main, 'scripts/sync-mirrors.mjs'), 'export {};\n');
    writeFileSync(join(main, 'mirror.txt'), 'mirror base\n');
  }
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  writeFileSync(join(main, '.git/info/exclude'), EXCLUDES.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# feature plan\n');
  if (include) writeFileSync(join(main, 'extra.txt'), 'included\n');
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const childHarness = ({
  reviewStatus = 0,
  reviewStdout = 'satellite review-state: green\n',
  gateStatus = 0,
  gateStdout = 'gate matrix: green\n',
  syncStatus = 0,
  syncStdout = 'sync: green\n',
  onGates = null,
  onSync = null,
} = {}) => {
  const calls = [];
  const spawn = (command, args = [], options = {}) => {
    const call = { command, args: [...args], cwd: options.cwd };
    calls.push(call);
    const line = [command, ...args].join(' ');
    if (line.includes('review-state.mjs')) {
      return { status: reviewStatus, stdout: reviewStdout, stderr: '' };
    }
    if (line.includes('sync-mirrors.mjs')) {
      const result = onSync?.(call);
      return result ?? { status: syncStatus, stdout: syncStdout, stderr: '' };
    }
    if (line.includes('run-gates.mjs')) {
      const result = onGates?.(call);
      return result ?? { status: gateStatus, stdout: gateStdout, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { spawn, calls };
};

const provision = (name, options = {}) => {
  const main = makeRepo(name, options);
  const slug = options.slug ?? name.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const branch = options.branch ?? `aw/${slug}`;
  const extra = [
    ...(options.branch ? ['--branch', options.branch] : []),
    ...(options.include ? ['--include', 'extra.txt'] : []),
  ];
  const result = run([
    'provision', slug,
    '--plan', 'docs/plans/SEED-PROMPT-feature.md',
    '--as', `feature-${slug}.md`,
    ...extra,
  ], { cwd: main });
  assert.equal(result.code, EXIT.ok, result.errText);
  const worktree = join(dirname(main), `${basename(main)}--${slug}`);
  return { main, worktree, slug, branch, handoff: join(worktree, 'docs/plans', handoffBasename(slug)) };
};

const stageFeature = (fixture, { path = 'README.md', body = `feature ${fixture.slug}\n` } = {}) => {
  writeFileSync(join(fixture.worktree, path), body);
  sh(['add', '-A'], fixture.worktree);
};

const commonDir = (main) => resolve(main, sh(['rev-parse', '--git-common-dir'], main).trim());
const lockPath = (main) => join(commonDir(main), 'aw-prepare-lock');

const land = (fixture, deps = {}) => run(
  ['land', fixture.slug, '--prepare'],
  { cwd: fixture.main, deps },
);

const cleanup = (fixture, extra = [], deps = {}) => run(
  ['cleanup', fixture.slug, ...(fixture.branch === `aw/${fixture.slug}` ? [] : ['--branch', fixture.branch]), ...extra],
  { cwd: fixture.main, deps },
);

const prepareAndCommit = (name, options = {}) => {
  const fixture = provision(name, options);
  stageFeature(fixture);
  const child = childHarness();
  const prepared = land(fixture, { spawn: child.spawn });
  assert.equal(prepared.code, EXIT.ok, prepared.errText);
  sh(['commit', '-q', '-m', `land ${fixture.slug}`], fixture.main);
  return { ...fixture, child, prepared };
};

const assertDriftRecipe = (text, fixture, oldHead) => {
  assert.ok(text.includes(oldHead), 'the old satellite HEAD is the rollback datum');
  assert.match(text, /git add -A/);
  assert.match(text, /git diff --cached --binary --no-ext-diff --no-textconv/);
  assert.ok(text.includes(`--output=docs/plans/aw-rebase-${fixture.slug}.patch`));
  assert.match(text, /git reset --hard/);
  assert.match(text, /git apply --index/);
  assert.match(text, /patch is KEPT|keep.*patch/i);
};

describe('land --prepare — main, identity, and report contract', () => {
  it('stages the finished satellite diff on clean main, never commits, and reports all OIDs', () => {
    const fixture = provision('land-green');
    stageFeature(fixture);
    const mainHead = sh(['rev-parse', 'HEAD'], fixture.main).trim();
    const satelliteBefore = sh(['status', '--porcelain=v1', '-z'], fixture.worktree);
    const child = childHarness();
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.equal(sh(['rev-parse', 'HEAD'], fixture.main).trim(), mainHead, 'land never commits');
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.worktree), satelliteBefore, 'satellite stays untouched');
    assert.match(sh(['diff', '--cached', '--name-only'], fixture.main), /^README\.md$/m);
    assert.match(result.text, /main HEAD: [0-9a-f]{40}/);
    assert.match(result.text, /transfer: [0-9a-f]{40}/);
    assert.match(result.text, /prepared: [0-9a-f]{40}/);
    assert.match(result.text, /sync delta: none/);
    assert.match(result.text, /this tool did not commit/);
  });

  it('refuses a dirty main before changing the satellite or index', () => {
    const fixture = provision('land-dirty-main');
    stageFeature(fixture);
    writeFileSync(join(fixture.main, 'README.md'), 'dirty main\n');
    const satelliteBefore = sh(['status', '--porcelain=v1', '-z'], fixture.worktree);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /main is not clean/);
    assert.match(result.errText, /README\.md/);
    assert.doesNotMatch(result.errText, /git reset --hard/);
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.worktree), satelliteBefore);
  });

  it('refuses a handoff slug or branch mismatch before transfer', () => {
    const fixture = provision('land-identity');
    stageFeature(fixture);
    const text = readFileSync(fixture.handoff, 'utf8').replace('- slug: land-identity', '- slug: another');
    writeFileSync(fixture.handoff, text);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /handoff identity mismatch/);
    assert.match(result.errText, /expected slug land-identity/);
    assert.equal(sh(['diff', '--cached', '--name-only'], fixture.main).trim(), '');
  });

  it('land and cleanup refuse a cwd inside the linked worktree and name main', () => {
    const fixture = provision('landing-cwd');
    stageFeature(fixture);
    const landed = run(['land', fixture.slug, '--prepare'], { cwd: fixture.worktree, deps: { spawn: childHarness().spawn } });
    assert.equal(landed.code, EXIT.stop);
    assert.match(landed.errText, /run .* from the main worktree/i);
    assert.ok(landed.errText.includes(fixture.main));
    const cleaned = run(['cleanup', fixture.slug, '--abandon'], { cwd: fixture.worktree });
    assert.equal(cleaned.code, EXIT.stop);
    assert.match(cleaned.errText, /run .* from the main worktree/i);
    assert.ok(cleaned.errText.includes(fixture.main));
  });
});

describe('land --prepare — transient serialization lock', () => {
  it('a held lock refuses with age and manual-removal recovery', () => {
    const fixture = provision('lock-held');
    stageFeature(fixture);
    const lock = lockPath(fixture.main);
    mkdirSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    const result = land(fixture, { spawn: childHarness().spawn, now: () => Date.now() });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /aw-prepare-lock/);
    assert.match(result.errText, /age/i);
    assert.match(result.errText, /remove .* by hand/i);
  });

  it('the lock is released after success and after a typed STOP', () => {
    const successful = provision('lock-success');
    stageFeature(successful);
    const ok = land(successful, { spawn: childHarness().spawn });
    assert.equal(ok.code, EXIT.ok, ok.errText);
    assert.equal(existsSync(lockPath(successful.main)), false);

    const stopped = provision('lock-stop');
    const noDiff = land(stopped, { spawn: childHarness().spawn });
    assert.equal(noDiff.code, EXIT.stop);
    assert.match(noDiff.errText, /empty staged diff/i);
    assert.equal(existsSync(lockPath(stopped.main)), false);
  });

  it('the lock is released after an injected catchable exception', () => {
    const fixture = provision('lock-exception');
    stageFeature(fixture);
    const child = childHarness();
    const spawn = (command, args, options) => {
      if ([command, ...(args ?? [])].join(' ').includes('run-gates.mjs')) throw new Error('injected child exception');
      return child.spawn(command, args, options);
    };
    const result = land(fixture, { spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /injected child exception/);
    assert.equal(existsSync(lockPath(fixture.main)), false);
  });

  it('removing a stale lock by hand allows the next prepare', () => {
    const fixture = provision('lock-recover');
    stageFeature(fixture);
    const lock = lockPath(fixture.main);
    mkdirSync(lock);
    const blocked = land(fixture, { spawn: childHarness().spawn });
    assert.equal(blocked.code, EXIT.stop);
    rmdirSync(lock);
    const recovered = land(fixture, { spawn: childHarness().spawn });
    assert.equal(recovered.code, EXIT.ok, recovered.errText);
  });

  it('two contending prepares have one winner and one lock STOP', () => {
    const fixture = provision('lock-contend');
    stageFeature(fixture);
    let nested = null;
    const mkdirPlain = (path) => {
      mkdirSync(path);
      if (basename(path) === 'aw-prepare-lock' && nested === null) {
        nested = land(fixture, { spawn: childHarness().spawn });
      }
    };
    const winner = land(fixture, { spawn: childHarness().spawn, mkdirPlain });
    assert.equal(winner.code, EXIT.ok, winner.errText);
    assert.equal(nested?.code, EXIT.stop);
    assert.match(nested?.errText ?? '', /aw-prepare-lock/);
  });
});

describe('land --prepare — divergence and satellite discipline', () => {
  it('classifies a behind satellite and prints the complete kept-patch drift recipe', () => {
    const fixture = provision('drift-behind');
    const oldHead = sh(['rev-parse', 'HEAD'], fixture.worktree).trim();
    writeFileSync(join(fixture.main, 'main-only.txt'), 'main\n');
    sh(['add', 'main-only.txt'], fixture.main);
    sh(['commit', '-q', '-m', 'main ahead'], fixture.main);
    stageFeature(fixture);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /behind/i);
    assertDriftRecipe(result.errText, fixture, oldHead);
  });

  it('classifies local satellite commits and prints cherry-pick recovery', () => {
    const fixture = provision('drift-local');
    stageFeature(fixture);
    sh(['commit', '-q', '-m', 'satellite commit'], fixture.worktree);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /local commits/i);
    assert.match(result.errText, /cherry-pick/i);
  });

  it('classifies both behind and local commits and orders commit recovery first', () => {
    const fixture = provision('drift-both');
    stageFeature(fixture);
    sh(['commit', '-q', '-m', 'satellite commit'], fixture.worktree);
    writeFileSync(join(fixture.main, 'main-only.txt'), 'main\n');
    sh(['add', 'main-only.txt'], fixture.main);
    sh(['commit', '-q', '-m', 'main ahead'], fixture.main);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /both|behind.*local commits|local commits.*behind/i);
    assert.ok(result.errText.indexOf('cherry-pick') < result.errText.indexOf('git add -A'));
  });

  it('refuses visible-mode docs/ai drift and lists every path', () => {
    const fixture = provision('discipline-docs');
    stageFeature(fixture);
    writeFileSync(join(fixture.worktree, 'docs/ai/gates.json'), '{"changed":true}\n');
    sh(['add', '-f', 'docs/ai/gates.json'], fixture.worktree);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /docs\/ai.*byte-equal|docs\/ai.*HEAD/i);
    assert.match(result.errText, /docs\/ai\/gates\.json/);
    assert.match(result.errText, /handoff/);
  });

  it('refuses staged excluded paths and names the unstage-to-handoff recovery', () => {
    const fixture = provision('discipline-excluded');
    stageFeature(fixture);
    writeFileSync(join(fixture.worktree, 'docs/plans/private.md'), 'must stay satellite-only\n');
    sh(['add', '-f', 'docs/plans/private.md'], fixture.worktree);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /staged excluded path/i);
    assert.match(result.errText, /docs\/plans\/private\.md/);
    assert.match(result.errText, /unstage.*handoff/i);
  });

  it('refuses and lists unstaged and untracked-not-ignored leftovers', () => {
    const fixture = provision('discipline-leftovers');
    writeFileSync(join(fixture.worktree, 'run.sh'), '#!/bin/sh\nexit 1\n');
    sh(['add', 'run.sh'], fixture.worktree);
    writeFileSync(join(fixture.worktree, 'README.md'), 'unstaged\n');
    writeFileSync(join(fixture.worktree, 'foreign.txt'), 'untracked\n');
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /README\.md/);
    assert.match(result.errText, /foreign\.txt/);
    assert.match(result.errText, /leftover/i);
  });

  it('refuses an empty staged satellite diff', () => {
    const fixture = provision('discipline-empty');
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /empty staged diff/i);
  });

  it('requires the satellite review-state discipline before transfer', () => {
    const fixture = provision('discipline-review');
    stageFeature(fixture);
    const child = childHarness({ reviewStatus: 1, reviewStdout: 'satellite review-state is red\n' });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /satellite review-state is not green/i);
    assert.match(result.errText, /finish the in-flight plan and council/i);
    assert.equal(sh(['diff', '--cached', '--name-only'], fixture.main).trim(), '');
  });
});

describe('land --prepare — transfer and rollback', () => {
  it('preserves rename, mode, symlink, binary, and textconv-shaped bytes in the staged tree', () => {
    const fixture = provision('transfer-kinds');
    sh(['mv', 'old.txt', 'moved.txt'], fixture.worktree);
    chmodSync(join(fixture.worktree, 'run.sh'), 0o755);
    symlinkSync('README.md', join(fixture.worktree, 'readme-link'));
    writeFileSync(join(fixture.worktree, 'blob.bin'), Buffer.from([0, 255, 1, 254, 2]));
    writeFileSync(join(fixture.worktree, 'sample.special'), 'textconv-shaped\n');
    sh(['add', '-A'], fixture.worktree);
    const transferTree = sh(['write-tree'], fixture.worktree).trim();
    const satelliteBefore = sh(['status', '--porcelain=v1', '-z'], fixture.worktree);
    const mainHead = sh(['rev-parse', 'HEAD'], fixture.main).trim();
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.equal(sh(['write-tree'], fixture.main).trim(), transferTree);
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.worktree), satelliteBefore);
    assert.equal(sh(['rev-parse', 'HEAD'], fixture.main).trim(), mainHead);
  });

  it('uses the binary/no-ext-diff/no-textconv contract and fixed exclusion pathspec', () => {
    const fixture = provision('transfer-argv');
    stageFeature(fixture);
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = land(fixture, { git, spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    const diff = calls.find((args) => args[0] === 'diff' && args.includes('--cached') && args.includes('--binary'));
    assert.ok(diff, 'the staged transfer diff is observed');
    assert.ok(diff.includes('--no-ext-diff'));
    assert.ok(diff.includes('--no-textconv'));
    assert.deepEqual(diff.slice(diff.indexOf('--')), ['--', ':!docs/ai', ':!docs/plans']);
  });

  it('an apply failure rolls main back byte-clean and leaves the satellite untouched', () => {
    const fixture = provision('transfer-rollback');
    stageFeature(fixture);
    const satelliteBefore = sh(['status', '--porcelain=v1', '-z'], fixture.worktree);
    const git = (args, cwd) => args[0] === 'apply' && args.includes('--index')
      ? { status: 1, stdout: '', stderr: 'synthetic apply failure' }
      : spawnGit(args, cwd);
    const result = land(fixture, { git, spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /synthetic apply failure/);
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.main), '');
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.worktree), satelliteBefore);
  });
});

describe('land --prepare — sync adapter', () => {
  it('states an absent sync adapter and keeps the sync delta empty', () => {
    const fixture = provision('sync-absent');
    stageFeature(fixture);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.match(result.text, /sync adapter: absent.*skipped/i);
    assert.match(result.text, /sync delta: none/);
  });

  it('invokes sync as a child, observes its porcelain delta, and stages exactly that delta', () => {
    const fixture = provision('sync-delta', { sync: true });
    stageFeature(fixture);
    const child = childHarness({
      onSync: ({ cwd }) => {
        writeFileSync(join(cwd, 'mirror.txt'), 'synced mirror\n');
        return { status: 0, stdout: 'sync complete\n', stderr: '' };
      },
    });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.ok(child.calls.some((call) => call.args.some((arg) => String(arg).includes('sync-mirrors.mjs'))));
    assert.match(sh(['diff', '--cached', '--name-only'], fixture.main), /^mirror\.txt$/m);
    assert.match(result.text, /sync delta: mirror\.txt/);
  });

  it('a failed sync rolls back tracked and observed-new-untracked paths only', () => {
    const fixture = provision('sync-failure', { sync: true });
    stageFeature(fixture);
    const child = childHarness({
      onSync: ({ cwd }) => {
        writeFileSync(join(cwd, 'mirror.txt'), 'partial mirror\n');
        writeFileSync(join(cwd, 'sync-new.txt'), 'partial new\n');
        return { status: 1, stdout: '', stderr: 'sync adapter failed' };
      },
    });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /sync adapter failed/);
    assert.equal(sh(['status', '--porcelain=v1', '-z'], fixture.main), '');
    assert.equal(existsSync(join(fixture.main, 'sync-new.txt')), false);
    assert.equal(readFileSync(join(fixture.main, 'mirror.txt'), 'utf8'), 'mirror base\n');
  });

  it('warns when canon sync overwrites a path also touched by the satellite', () => {
    const fixture = provision('sync-overlap', { sync: true });
    stageFeature(fixture, { path: 'mirror.txt', body: 'satellite mirror\n' });
    const child = childHarness({
      onSync: ({ cwd }) => {
        writeFileSync(join(cwd, 'mirror.txt'), 'canon mirror\n');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.match(result.text, /mirror edit overwritten by canon sync.*mirror\.txt/i);
    assert.equal(readFileSync(join(fixture.main, 'mirror.txt'), 'utf8'), 'canon mirror\n');
  });
});

describe('land --prepare — gates and post-gates snapshot', () => {
  it('refuses when docs/ai/gates.json is absent', () => {
    const fixture = provision('gates-absent', { gates: false });
    stageFeature(fixture);
    const result = land(fixture, { spawn: childHarness().spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /gates\.json.*absent/i);
  });

  it('runs the main matrix with no main plan in flight', () => {
    const fixture = provision('gates-main');
    stageFeature(fixture);
    const child = childHarness();
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    const gate = child.calls.find((call) => call.args.some((arg) => String(arg).includes('run-gates.mjs')));
    assert.ok(gate, 'the main gate runner is invoked');
    assert.equal(gate.cwd, fixture.main);
    assert.match(result.text, /gate matrix: green/);
  });

  it('a red matrix keeps the prepared tree and names both recovery lanes', () => {
    const fixture = provision('gates-red');
    stageFeature(fixture);
    const child = childHarness({ gateStatus: 1, gateStdout: 'gate matrix: RED fixture\n' });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /gate matrix: RED fixture/);
    assert.notEqual(sh(['diff', '--cached', '--name-only'], fixture.main).trim(), '');
    assert.match(result.errText, /reset main.*fix in satellite.*re-land/i);
    assert.match(result.errText, /maintainer-directed fix at main/i);
  });

  it('a gate-mutated HEAD, write-tree, or porcelain trips post-gates re-verification', () => {
    const fixture = provision('gates-mutation');
    stageFeature(fixture);
    const child = childHarness({
      onGates: ({ cwd }) => {
        writeFileSync(join(cwd, 'README.md'), 'gate mutation\n');
        return { status: 0, stdout: 'gate said green\n', stderr: '' };
      },
    });
    const result = land(fixture, { spawn: child.spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /changed during gates|post-gates snapshot/i);
    assert.match(result.errText, /git reset --hard/);
  });
});

describe('land --prepare — second prepare is reset-only', () => {
  it('prints the current staged write-tree and reset/re-run recovery', () => {
    const fixture = provision('second-prepare');
    stageFeature(fixture);
    const first = land(fixture, { spawn: childHarness().spawn });
    assert.equal(first.code, EXIT.ok, first.errText);
    const preparedTree = sh(['write-tree'], fixture.main).trim();
    const second = land(fixture, { spawn: childHarness().spawn });
    assert.equal(second.code, EXIT.stop);
    assert.ok(second.errText.includes(preparedTree));
    assert.match(second.errText, /git reset --hard/);
    assert.match(second.errText, /re-run .*land .*--prepare/i);
  });

  it('lists crash-residue untracked paths with one paste-ready removal each', () => {
    const fixture = provision('second-crash');
    stageFeature(fixture);
    const first = land(fixture, { spawn: childHarness().spawn });
    assert.equal(first.code, EXIT.ok, first.errText);
    writeFileSync(join(fixture.main, 'sync-leftover.txt'), 'crash residue\n');
    const second = land(fixture, { spawn: childHarness().spawn });
    assert.equal(second.code, EXIT.stop);
    assert.match(second.errText, /sync-leftover\.txt/);
    assert.match(second.errText, /rm .*sync-leftover\.txt/);
  });

  it('reset plus listed removal lets a fresh prepare converge', () => {
    const fixture = provision('second-converge');
    stageFeature(fixture);
    const first = land(fixture, { spawn: childHarness().spawn });
    assert.equal(first.code, EXIT.ok, first.errText);
    writeFileSync(join(fixture.main, 'sync-leftover.txt'), 'crash residue\n');
    assert.equal(land(fixture, { spawn: childHarness().spawn }).code, EXIT.stop);
    sh(['reset', '--hard'], fixture.main);
    unlinkSync(join(fixture.main, 'sync-leftover.txt'));
    const retried = land(fixture, { spawn: childHarness().spawn });
    assert.equal(retried.code, EXIT.ok, retried.errText);
  });
});

describe('cleanup — live landed verification and plain removal', () => {
  it('removes a landed worktree, uses plain remove, branch -d, and prune', () => {
    const fixture = prepareAndCommit('cleanup-green');
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.equal(existsSync(fixture.worktree), false);
    assert.ok(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')));
    assert.ok(calls.some((args) => args[0] === 'branch' && args[1] === '-d' && args[2] === fixture.branch));
    assert.ok(calls.some((args) => args[0] === 'worktree' && args[1] === 'prune'));
    assert.equal(calls.some((args) => args.includes('-D') || args.includes('--force')), false);
    assert.match(result.text, /cleanup complete/);
  });

  it('live verification handles deleted and renamed entries', () => {
    const fixture = provision('cleanup-delete-rename');
    sh(['mv', 'old.txt', 'moved.txt'], fixture.worktree);
    unlinkSync(join(fixture.worktree, 'run.sh'));
    sh(['add', '-A'], fixture.worktree);
    const prepared = land(fixture, { spawn: childHarness().spawn });
    assert.equal(prepared.code, EXIT.ok, prepared.errText);
    sh(['commit', '-q', '-m', 'land delete rename'], fixture.main);
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.ok, result.errText);
  });

  it('refuses a mismatched entry with the honest dual-cause wording', () => {
    const fixture = prepareAndCommit('cleanup-mismatch');
    writeFileSync(join(fixture.worktree, 'README.md'), 'changed after land\n');
    sh(['add', 'README.md'], fixture.worktree);
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /README\.md/);
    assert.match(result.errText, /differs — canon-overwritten at land OR changed after land; confirm via the handoff/);
  });

  it('a foreign ignored top-level entry requires --abandon', () => {
    const fixture = prepareAndCommit('cleanup-ignored');
    const exclude = join(fixture.main, '.git/info/exclude');
    writeFileSync(exclude, `${readFileSync(exclude, 'utf8')}\n/foreign.cache\n`);
    writeFileSync(join(fixture.worktree, 'foreign.cache'), 'foreign ignored work\n');
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /foreign\.cache/);
    assert.match(result.errText, /--abandon/);
  });

  it('ignored provision footprint is removed only by plain worktree remove', () => {
    const fixture = prepareAndCommit('cleanup-ignored-owned');
    const unlinks = [];
    const result = cleanup(fixture, [], {
      unlink: (path) => {
        unlinks.push(path);
        unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.deepEqual(unlinks, [], 'ignored provision content is not pre-removed');
  });

  it('a provision-record include that becomes untracked-not-ignored is removed before plain remove', () => {
    const fixture = provision('cleanup-include', { include: true });
    stageFeature(fixture);
    const prepared = land(fixture, { spawn: childHarness().spawn });
    assert.equal(prepared.code, EXIT.ok, prepared.errText);
    sh(['commit', '-q', '-m', 'land include'], fixture.main);
    unlinkSync(join(fixture.main, 'extra.txt'));
    const exclude = join(fixture.main, '.git/info/exclude');
    writeFileSync(exclude, readFileSync(exclude, 'utf8').split('\n').filter((line) => line !== '/extra.txt').join('\n'));
    const unlinks = [];
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = cleanup(fixture, [], {
      git,
      unlink: (path) => {
        unlinks.push(path);
        unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.ok(unlinks.includes(join(fixture.worktree, 'extra.txt')));
    assert.ok(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')));
  });

  it('a foreign untracked path refuses normal cleanup', () => {
    const fixture = prepareAndCommit('cleanup-foreign');
    writeFileSync(join(fixture.worktree, 'foreign.txt'), 'foreign\n');
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /foreign\.txt/);
    assert.match(result.errText, /unlanded or foreign work/i);
  });
});

describe('cleanup — abandon, branch, prune, and errors', () => {
  it('normal cleanup refuses unlanded work and names the explicit destructive recovery', () => {
    const fixture = provision('cleanup-unlanded');
    stageFeature(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /unlanded or foreign work/i);
    assert.match(result.errText, /cleanup cleanup-unlanded --abandon/);
    assert.equal(existsSync(fixture.worktree), true);
  });

  it('--abandon over-warns and is the only worktree-remove --force path', () => {
    const fixture = provision('cleanup-abandon');
    stageFeature(fixture);
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = cleanup(fixture, ['--abandon'], { git });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.match(result.text, /WARNING: cleanup --abandon DESTROYS unlanded work/);
    assert.ok(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove' && args.includes('--force')));
    assert.equal(calls.filter((args) => args.includes('--force')).length, 1);
  });

  it('--abandon refuses when the handoff is absent and never calls --force', () => {
    const fixture = provision('cleanup-orphaned');
    stageFeature(fixture);
    unlinkSync(fixture.handoff);
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = cleanup(fixture, ['--abandon'], { git });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /handoff-cleanup-orphaned\.md is absent/);
    assert.match(result.errText, /force deletion is forbidden/);
    assert.equal(calls.some((args) => args.includes('--force')), false);
  });

  it('a custom branch is deleted with -d and never -D', () => {
    const fixture = prepareAndCommit('cleanup-custom-branch', { branch: 'feature/custom-cleanup' });
    const calls = [];
    const git = (args, cwd) => {
      calls.push([...args]);
      return spawnGit(args, cwd);
    };
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.ok(calls.some((args) => args[0] === 'branch' && args[1] === '-d' && args[2] === fixture.branch));
    assert.equal(calls.some((args) => args.includes('-D')), false);
  });

  it('git branch -d unmerged refusal is surfaced verbatim', () => {
    const fixture = provision('cleanup-unmerged');
    stageFeature(fixture);
    sh(['commit', '-q', '-m', 'satellite-only commit'], fixture.worktree);
    writeFileSync(join(fixture.main, 'README.md'), `feature ${fixture.slug}\n`);
    sh(['add', 'README.md'], fixture.main);
    sh(['commit', '-q', '-m', 'same bytes independently'], fixture.main);
    writeFileSync(
      fixture.handoff,
      readFileSync(fixture.handoff, 'utf8').replace(
        '- vscode-settings:',
        `- prepared-tree: ${'e'.repeat(40)}\n- vscode-settings:`,
      ),
    );
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /not fully merged|not merged/i);
  });

  it('a registered worktree whose directory vanished is pruned rather than crashed', () => {
    const fixture = provision('cleanup-prunable');
    rmSync(fixture.worktree, { recursive: true, force: true });
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.match(result.text, /pruned.*deleted worktree|prunable.*removed/i);
  });

  it('an EBUSY worktree removal names likely causes and one retry lane', () => {
    const fixture = prepareAndCommit('cleanup-ebusy');
    const git = (args, cwd) => args[0] === 'worktree' && args[1] === 'remove'
      ? { status: 128, stdout: '', stderr: 'fatal: Device or resource busy' }
      : spawnGit(args, cwd);
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /EBUSY|Device or resource busy/);
    assert.match(result.errText, /lingering processes|open file descriptors/i);
    assert.match(result.errText, /close them and retry/i);
  });
});

describe('landing-half surface markings', () => {
  it('removes every temporary arrival marking and keeps the live caution wording', () => {
    const worktrees = readFileSync(new URL('./worktrees.mjs', import.meta.url), 'utf8');
    const commands = readFileSync(new URL('./commands.mjs', import.meta.url), 'utf8');
    const commandTests = readFileSync(new URL('./commands.test.mjs', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const mode = readFileSync(new URL('../references/modes/worktrees.md', import.meta.url), 'utf8');
    for (const [name, text] of Object.entries({ worktrees, commands, commandTests, readme, mode })) {
      assert.doesNotMatch(text, /arrive(?:s)? with this release(?:'s)? landing half/i, `${name} has no temporary arrival marking`);
    }
    assert.doesNotMatch(commandTests, /TEMPORARY \(remove with the landing half/);
    assert.match(worktrees, /land <slug> --prepare/);
    assert.match(worktrees, /cleanup <slug> \[--branch <name>\] \[--abandon\]/);
    assert.match(commands, /cleanup --abandon destroys unlanded work/);
    assert.match(readme, /commit ALWAYS stays a dialogue ask/);
    assert.match(mode, /live landed-verification against main HEAD/i);
  });
});
