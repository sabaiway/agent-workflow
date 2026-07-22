// The node_modules ownership gate at worktree cleanup (AD-069): ownership is information
// content, decided live — class {absent, ephemeral, foreign} × lane {tracked, ignored,
// untracked}; the single exempt state is the ignored-lane matching symlink, re-proven
// immediately before removal; everything else stops surgically; probe errors fail closed.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as W from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-cleanup-ownership-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const IGNORE_LINK_FORM = '/node_modules';

const gitResult = (args, cwd) => spawnSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});

const sh = (args, cwd) => {
  const result = gitResult(args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const baseExcludes = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/.vscode/'];

const writeExcludes = (main, extra = []) =>
  writeFileSync(join(main, '.git/info/exclude'), [...baseExcludes, ...extra, ''].join('\n'));

const makeRepo = (name, { excludeNodeModules = true, mainNodeModules = null, trackedNodeModules = null, trackedSelfLink = false } = {}) => {
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
  if (trackedNodeModules) {
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    for (const [rel, body] of Object.entries(trackedNodeModules)) {
      writeFileSync(join(main, 'node_modules', rel), body);
    }
  }
  if (trackedSelfLink) symlinkSync(join(main, 'node_modules'), join(main, 'node_modules'));
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  writeExcludes(main, excludeNodeModules ? [IGNORE_LINK_FORM] : []);
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# feature plan\n');
  if (mainNodeModules === 'dir') {
    mkdirSync(join(main, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(main, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  } else if (mainNodeModules === 'file') {
    writeFileSync(join(main, 'node_modules'), 'a regular file named node_modules\n');
  } else if (mainNodeModules === 'fifo') {
    assert.equal(spawnSync('mkfifo', [join(main, 'node_modules')]).status, 0);
  }
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = W.runCli(argv, {
    cwd,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const childHarness = () => ({
  spawn: (command, args = []) => {
    const line = [command, ...args].join(' ');
    if (line.includes('review-state.mjs')) return { status: 0, stdout: 'green\n', stderr: '' };
    if (line.includes('run-gates.mjs')) return { status: 0, stdout: 'green\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  },
});

const provision = (name, options = {}) => {
  const main = makeRepo(name, options);
  const slug = options.slug ?? name.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const result = run(
    ['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', `feature-${slug}.md`],
    { cwd: main },
  );
  assert.equal(result.code, W.EXIT.ok, result.errText);
  const worktree = join(dirname(main), `${basename(main)}--${slug}`);
  return { main, worktree, slug, branch: `aw/${slug}`, handoff: join(worktree, 'docs/plans', W.handoffBasename(slug)) };
};

const landAndCommit = (fixture) => {
  writeFileSync(join(fixture.worktree, 'README.md'), `feature ${fixture.slug}\n`);
  sh(['add', '-A'], fixture.worktree);
  const prepared = run(['land', fixture.slug, '--prepare'], { cwd: fixture.main, deps: { spawn: childHarness().spawn } });
  assert.equal(prepared.code, W.EXIT.ok, prepared.errText);
  sh(['commit', '-q', '-m', `land ${fixture.slug}`], fixture.main);
  return fixture;
};

const prepareAndCommit = (name, options = {}) => landAndCommit(provision(name, options));

const cleanup = (fixture, extra = [], deps = {}) =>
  run(['cleanup', fixture.slug, ...extra], { cwd: fixture.main, deps });

const matchingLink = (fixture) => symlinkSync(join(fixture.main, 'node_modules'), join(fixture.worktree, 'node_modules'));

// A git dep that records every call, optionally mutating AFTER the real reset executes.
const trackingGit = ({ afterReset = null, fail = null } = {}) => {
  const calls = [];
  const git = (args, cwd) => {
    calls.push([...args]);
    if (fail) {
      const verdict = fail(args, calls);
      if (verdict) return { status: 128, stdout: '', stderr: 'injected probe failure' };
    }
    const result = W.spawnGit(args, cwd);
    if (afterReset && args[0] === 'reset' && args[1] === '--hard') afterReset();
    return result;
  };
  git.calls = calls;
  git.removed = () => calls.some((args) => args[0] === 'worktree' && args[1] === 'remove');
  return git;
};

const assertOwnershipStop = (result, { rm = null, lane = null } = {}) => {
  assert.equal(result.code, W.EXIT.stop, `expected STOP, got: ${result.errText || result.text}`);
  assert.ok(result.errText.includes(W.CLEANUP_OWNERSHIP_RULE), `ownership rule missing from: ${result.errText}`);
  if (rm) {
    assert.ok(result.errText.includes(rm), `expected ${JSON.stringify(rm)} in: ${result.errText}`);
    assert.ok(
      result.errText.indexOf(rm) < result.errText.indexOf('--abandon'),
      `surgical recovery must come before --abandon: ${result.errText}`,
    );
  }
  if (lane) {
    assert.ok(result.errText.includes(`in the ${lane} lane`), `expected the ${lane} lane in: ${result.errText}`);
  }
};

describe('classification — the matching link is the only ephemeral state', () => {
  it('ephemeral-symlink-cleanup-proceeds', () => {
    const fixture = provision('own-ephemeral', { mainNodeModules: 'dir' });
    assert.ok(lstatSync(join(fixture.worktree, 'node_modules')).isSymbolicLink(), 'provision must create the link');
    landAndCommit(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(existsSync(fixture.worktree), false);
  });

  it('main-node-modules-content-survives-matching-link-cleanup', () => {
    const fixture = provision('own-survive', { mainNodeModules: 'dir' });
    landAndCommit(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(readFileSync(join(fixture.main, 'node_modules/dep/index.js'), 'utf8'), 'module.exports = 1;\n');
  });

  it('dangling-matching-symlink-proceeds', () => {
    const fixture = prepareAndCommit('own-dangling');
    matchingLink(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(existsSync(fixture.worktree), false);
  });

  it('matching-link-to-regular-file-proceeds', () => {
    const fixture = prepareAndCommit('own-link-file', { mainNodeModules: 'file' });
    matchingLink(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
  });

  it('matching-link-to-special-proceeds', () => {
    const fixture = prepareAndCommit('own-link-fifo', { mainNodeModules: 'fifo' });
    matchingLink(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
  });

  it('relative-target-symlink-stops', () => {
    const fixture = prepareAndCommit('own-relative');
    symlinkSync(join('..', basename(fixture.main), 'node_modules'), join(fixture.worktree, 'node_modules'));
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -- ' });
  });

  it('retargeted-symlink-stops', () => {
    const fixture = prepareAndCommit('own-retargeted');
    symlinkSync(join(fixture.main, 'elsewhere'), join(fixture.worktree, 'node_modules'));
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -- ' });
  });

  it('decoded-equal-raw-different-target-stops', () => {
    const fixture = prepareAndCommit('own-�-bytes', { slug: 'own-bytes' });
    const good = Buffer.from(join(fixture.main, 'node_modules'));
    const marker = Buffer.from('�');
    const at = good.indexOf(marker);
    assert.ok(at > 0, 'the fixture path must carry the replacement character');
    const bad = Buffer.concat([good.subarray(0, at), Buffer.from([0xff]), good.subarray(at + marker.length)]);
    assert.equal(bad.toString(), good.toString(), 'decoded forms must be equal');
    assert.notEqual(Buffer.compare(bad, good), 0, 'raw bytes must differ');
    symlinkSync(bad, join(fixture.worktree, 'node_modules'));
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -- ' });
  });

  it('plain-directory-stops-with-surgical-recovery', () => {
    const fixture = prepareAndCommit('own-dir');
    mkdirSync(join(fixture.worktree, 'node_modules'));
    writeFileSync(join(fixture.worktree, 'node_modules/data.bin'), 'user bytes\n');
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -rf -- ' });
    assert.equal(readFileSync(join(fixture.worktree, 'node_modules/data.bin'), 'utf8'), 'user bytes\n');
  });

  it('regular-file-stops', () => {
    const fixture = prepareAndCommit('own-file');
    writeFileSync(join(fixture.worktree, 'node_modules'), 'not a directory\n');
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -- ' });
  });

  it('special-node-stops', () => {
    const fixture = prepareAndCommit('own-fifo');
    assert.equal(spawnSync('mkfifo', [join(fixture.worktree, 'node_modules')]).status, 0);
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -- ' });
  });

  it('absent-proceeds', () => {
    const fixture = prepareAndCommit('own-absent');
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
  });
});

describe('lane — tracked has priority and never gets an rm', () => {
  it('untracked-node-modules-dir-stops', () => {
    const fixture = prepareAndCommit('own-untracked-dir', { excludeNodeModules: false });
    mkdirSync(join(fixture.worktree, 'node_modules'));
    writeFileSync(join(fixture.worktree, 'node_modules/keep.js'), 'x\n');
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -rf -- ', lane: 'untracked' });
  });

  it('untracked-matching-link-stops', () => {
    const fixture = prepareAndCommit('own-untracked-link', { excludeNodeModules: false });
    matchingLink(fixture);
    const result = cleanup(fixture);
    assertOwnershipStop(result, { rm: 'rm -- ', lane: 'untracked' });
    assert.ok(!result.errText.includes('rm -rf'), `link recovery must never be recursive: ${result.errText}`);
  });

  it('empty-untracked-directory-stops', () => {
    const fixture = prepareAndCommit('own-empty-dir', { excludeNodeModules: false });
    mkdirSync(join(fixture.worktree, 'node_modules'));
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -rf -- ', lane: 'untracked' });
  });

  it('ignored-real-directory-stops-and-preserves', () => {
    const fixture = prepareAndCommit('own-ignored-dir');
    mkdirSync(join(fixture.worktree, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(fixture.worktree, 'node_modules/pkg/built.js'), 'user-built artifact\n');
    const result = cleanup(fixture);
    assertOwnershipStop(result, { rm: 'rm -rf -- ', lane: 'ignored' });
    assert.equal(existsSync(fixture.worktree), true, 'the worktree must survive');
    assert.equal(
      readFileSync(join(fixture.worktree, 'node_modules/pkg/built.js'), 'utf8'),
      'user-built artifact\n',
    );
  });

  it('tracked-matching-link-stops', () => {
    const fixture = prepareAndCommit('own-tracked-link', { excludeNodeModules: false, trackedSelfLink: true });
    assert.ok(lstatSync(join(fixture.worktree, 'node_modules')).isSymbolicLink(), 'checkout must materialize the tracked link');
    const result = cleanup(fixture);
    assertOwnershipStop(result, { lane: 'tracked' });
    assert.doesNotMatch(result.errText, /\brm /, `tracked recovery must never offer rm: ${result.errText}`);
  });

  it('tracked-node-modules-dir-stops', () => {
    const fixture = prepareAndCommit('own-tracked-dir', {
      excludeNodeModules: false, trackedNodeModules: { 'pinned.js': 'vendored\n' },
    });
    assertOwnershipStop(cleanup(fixture), { lane: 'tracked' });
  });

  it('tracked-wins-over-ignore-rule', () => {
    const fixture = prepareAndCommit('own-tracked-wins', {
      excludeNodeModules: true, trackedNodeModules: { 'pinned.js': 'vendored\n' },
    });
    assertOwnershipStop(cleanup(fixture), { lane: 'tracked' });
  });

  it('tracked-descendant-makes-lane-tracked', () => {
    const fixture = prepareAndCommit('own-tracked-desc', {
      excludeNodeModules: false, trackedNodeModules: { 'pinned.js': 'vendored\n' },
    });
    writeFileSync(join(fixture.worktree, 'node_modules/extra.log'), 'scratch\n');
    assertOwnershipStop(cleanup(fixture), { lane: 'tracked' });
  });

  it('tracked-stop-recovery-names-tracked-lane', () => {
    const fixture = prepareAndCommit('own-tracked-msg', {
      excludeNodeModules: false, trackedNodeModules: { 'pinned.js': 'vendored\n' },
    });
    const result = cleanup(fixture);
    assertOwnershipStop(result, { lane: 'tracked' });
    assert.match(result.errText, /land its removal from MAIN/);
    assert.match(result.errText, /--abandon/);
    assert.doesNotMatch(result.errText, /\brm /);
  });

  it('absent-node-with-tracked-index-entry-stops', () => {
    const fixture = prepareAndCommit('own-skip-worktree', {
      excludeNodeModules: false, trackedNodeModules: { 'pinned.js': 'vendored\n' },
    });
    sh(['update-index', '--skip-worktree', 'node_modules/pinned.js'], fixture.worktree);
    rmSync(join(fixture.worktree, 'node_modules'), { recursive: true });
    assert.ok(
      !sh(['status', '--porcelain'], fixture.worktree).includes('node_modules'),
      'the skip-worktree deletion must be invisible to status',
    );
    const result = cleanup(fixture);
    assertOwnershipStop(result, { lane: 'tracked' });
    assert.doesNotMatch(result.errText, /\brm /);
  });
});

describe('the landed-removal lane and the reduction lock', () => {
  it('base-tracked-landed-removal-cleanup-converges', () => {
    const fixture = provision('own-landed-removal', {
      excludeNodeModules: false, trackedNodeModules: { 'dep.js': 'vendored\n' },
    });
    sh(['rm', '-r', '-q', 'node_modules'], fixture.worktree);
    const prepared = run(['land', fixture.slug, '--prepare'], { cwd: fixture.main, deps: { spawn: childHarness().spawn } });
    assert.equal(prepared.code, W.EXIT.ok, prepared.errText);
    sh(['commit', '-q', '-m', 'land the removal'], fixture.main);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(existsSync(fixture.worktree), false);
  });

  it('clean-absent-has-no-post-reset-ownership-arm', () => {
    const fixture = prepareAndCommit('own-no-arm');
    const nmPath = join(fixture.worktree, 'node_modules');
    const seen = { lstat: 0, readlink: 0, probeAfterReset: 0, scopedLsTree: 0, scopedStatus: 0, removed: 0 };
    let resetSeen = false;
    const git = (args, cwd) => {
      if (args[0] === 'reset' && args[1] === '--hard') resetSeen = true;
      if (args[0] === 'worktree' && args[1] === 'remove') seen.removed += 1;
      const touchesNm = args.some((arg) => String(arg).includes('node_modules'));
      if (touchesNm && (args[0] === 'ls-files' || args[0] === 'check-ignore') && resetSeen) seen.probeAfterReset += 1;
      if (touchesNm && args[0] === 'ls-tree') seen.scopedLsTree += 1;
      if (touchesNm && args[0] === 'status') seen.scopedStatus += 1;
      return W.spawnGit(args, cwd);
    };
    const result = cleanup(fixture, [], {
      git,
      lstat: (path) => {
        if (path === nmPath) seen.lstat += 1;
        return lstatSync(path);
      },
      readlink: (path, opts) => {
        if (path === nmPath) seen.readlink += 1;
        return readlinkSync(path, opts);
      },
    });
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(seen.lstat, 1, 'exactly one gate lstat for clean-absent');
    assert.equal(seen.readlink, 0);
    assert.equal(seen.probeAfterReset, 0, 'no post-reset lane probe for clean-absent');
    assert.equal(seen.scopedLsTree, 0, 'no ownership ls-tree');
    assert.equal(seen.scopedStatus, 0, 'no node_modules-scoped status');
    assert.equal(seen.removed, 1, 'plain worktree remove still runs');
  });

  it('gate-uses-no-follow-probes-only', () => {
    const fixture = prepareAndCommit('own-probe-discipline');
    matchingLink(fixture);
    const nmPath = join(fixture.worktree, 'node_modules');
    const probes = { lstat: 0, readlink: 0, realpath: 0, bufferForm: 0 };
    const result = cleanup(fixture, [], {
      lstat: (path) => {
        if (path === nmPath) probes.lstat += 1;
        return lstatSync(path);
      },
      readlink: (path, opts) => {
        if (path === nmPath) {
          probes.readlink += 1;
          if (opts && opts.encoding === 'buffer') probes.bufferForm += 1;
        }
        return readlinkSync(path, opts);
      },
      realpath: (path) => {
        if (path === nmPath) probes.realpath += 1;
        return realpathSync(path);
      },
    });
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(probes.lstat, 2, 'one gate + one revalidation lstat');
    assert.equal(probes.readlink, 2, 'one gate + one revalidation readlink');
    assert.equal(probes.bufferForm, 2, 'readlink must use the buffer form');
    assert.equal(probes.realpath, 0, 'the target is never resolved');
  });
});

describe('the record is never consulted', () => {
  it('no-dependencies-record-with-live-matching-link-proceeds', () => {
    const fixture = prepareAndCommit('own-record-none');
    const text = readFileSync(fixture.handoff, 'utf8');
    writeFileSync(fixture.handoff, text.replace(/- node_modules: .*/, `- node_modules: ${W.NODE_MODULES_NONE}`));
    matchingLink(fixture);
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.ok, result.errText);
  });

  it('record-is-not-consulted', () => {
    const fixture = prepareAndCommit('own-record-flip');
    const text = readFileSync(fixture.handoff, 'utf8');
    writeFileSync(fixture.handoff, text.replace(/- node_modules: .*/, '- node_modules: symlinked'));
    mkdirSync(join(fixture.worktree, 'node_modules'));
    writeFileSync(join(fixture.worktree, 'node_modules/data.js'), 'live wins\n');
    assertOwnershipStop(cleanup(fixture), { rm: 'rm -rf -- ' });
    assert.equal(readFileSync(join(fixture.worktree, 'node_modules/data.js'), 'utf8'), 'live wins\n');
  });
});

describe('revalidation — the exemption is re-proven before removal', () => {
  const ephemeralFixture = (name) => {
    const fixture = prepareAndCommit(name);
    matchingLink(fixture);
    return fixture;
  };

  it('verdict-class-change-after-reset-stops', () => {
    const fixture = ephemeralFixture('own-reval-class');
    const nmPath = join(fixture.worktree, 'node_modules');
    const git = trackingGit({
      afterReset: () => {
        unlinkSync(nmPath);
        mkdirSync(nmPath);
        writeFileSync(join(nmPath, 'late.js'), 'appeared mid-cleanup\n');
      },
    });
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, W.EXIT.stop, result.errText || result.text);
    assert.equal(git.removed(), false, 'remove must not run after a class change');
    assert.equal(readFileSync(join(nmPath, 'late.js'), 'utf8'), 'appeared mid-cleanup\n');
  });

  it('authorization-lane-change-after-reset-stops', () => {
    const fixture = ephemeralFixture('own-reval-lane');
    const git = trackingGit({ afterReset: () => writeExcludes(fixture.main, []) });
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, W.EXIT.stop, result.errText || result.text);
    assert.equal(git.removed(), false);
  });

  it('verdict-change-to-absent-after-reset-stops', () => {
    const fixture = ephemeralFixture('own-reval-absent');
    const git = trackingGit({ afterReset: () => unlinkSync(join(fixture.worktree, 'node_modules')) });
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, W.EXIT.stop, result.errText || result.text);
    assert.match(result.errText, /re-run cleanup/);
    assert.equal(git.removed(), false);
  });
});

describe('probe errors fail closed, with no removal command offered', () => {
  const assertErrorStop = (result, git = null) => {
    assert.equal(result.code, W.EXIT.stop, result.errText || result.text);
    assert.ok(result.errText.includes(W.CLEANUP_OWNERSHIP_RULE), result.errText);
    assert.match(result.errText, /cannot inspect/);
    assert.doesNotMatch(result.errText, /\brm /);
    assert.doesNotMatch(result.errText, /--abandon/);
    if (git) assert.equal(git.removed(), false);
  };

  const failing = (code) => Object.assign(new Error(`injected ${code}`), { code });

  it('lstat-error-stops', () => {
    const fixture = prepareAndCommit('own-err-lstat');
    const nmPath = join(fixture.worktree, 'node_modules');
    const git = trackingGit();
    assertErrorStop(cleanup(fixture, [], {
      git,
      lstat: (path) => {
        if (path === nmPath) throw failing('EACCES');
        return lstatSync(path);
      },
    }), git);
  });

  it('readlink-error-stops', () => {
    const fixture = prepareAndCommit('own-err-readlink');
    matchingLink(fixture);
    const nmPath = join(fixture.worktree, 'node_modules');
    const git = trackingGit();
    assertErrorStop(cleanup(fixture, [], {
      git,
      readlink: (path, opts) => {
        if (path === nmPath) throw failing('EIO');
        return readlinkSync(path, opts);
      },
    }), git);
  });

  it('gate-tracked-index-probe-error-stops', () => {
    const fixture = prepareAndCommit('own-err-lsfiles');
    matchingLink(fixture);
    const git = trackingGit({
      fail: (args) => args[0] === 'ls-files' && args.some((a) => String(a).includes('node_modules')),
    });
    assertErrorStop(cleanup(fixture, [], { git }), git);
  });

  it('gate-ignore-probe-error-stops', () => {
    const fixture = prepareAndCommit('own-err-checkignore');
    matchingLink(fixture);
    const git = trackingGit({
      fail: (args) => args[0] === 'check-ignore' && args.some((a) => String(a).includes('node_modules')),
    });
    assertErrorStop(cleanup(fixture, [], { git }), git);
  });

  const nthPathCall = (fn, nmPath, failAt, err) => {
    let seen = 0;
    return (path, opts) => {
      if (path === nmPath) {
        seen += 1;
        if (seen >= failAt) throw err;
      }
      return fn(path, opts);
    };
  };

  it('post-reset-lstat-error-stops', () => {
    const fixture = prepareAndCommit('own-err-lstat2');
    matchingLink(fixture);
    const git = trackingGit();
    assertErrorStop(cleanup(fixture, [], {
      git,
      lstat: nthPathCall(lstatSync, join(fixture.worktree, 'node_modules'), 2, failing('EACCES')),
    }), git);
  });

  it('post-reset-readlink-error-stops', () => {
    const fixture = prepareAndCommit('own-err-readlink2');
    matchingLink(fixture);
    const git = trackingGit();
    assertErrorStop(cleanup(fixture, [], {
      git,
      readlink: nthPathCall(readlinkSync, join(fixture.worktree, 'node_modules'), 2, failing('EIO')),
    }), git);
  });

  const nthGitFail = (command, failAt) => {
    let seen = 0;
    return (args) => {
      if (args[0] === command && args.some((a) => String(a).includes('node_modules'))) {
        seen += 1;
        return seen >= failAt;
      }
      return false;
    };
  };

  it('post-reset-tracked-index-probe-error-stops', () => {
    const fixture = prepareAndCommit('own-err-lsfiles2');
    matchingLink(fixture);
    const git = trackingGit({ fail: nthGitFail('ls-files', 2) });
    assertErrorStop(cleanup(fixture, [], { git }), git);
  });

  it('post-reset-ignore-probe-error-stops', () => {
    const fixture = prepareAndCommit('own-err-checkignore2');
    matchingLink(fixture);
    const git = trackingGit({ fail: nthGitFail('check-ignore', 2) });
    assertErrorStop(cleanup(fixture, [], { git }), git);
  });
});

describe('the destructive arm and the contract surface', () => {
  it('abandon-still-removes-everything', () => {
    const fixture = prepareAndCommit('own-abandon');
    mkdirSync(join(fixture.worktree, 'node_modules'));
    writeFileSync(join(fixture.worktree, 'node_modules/user.js'), 'data\n');
    const result = cleanup(fixture, ['--abandon']);
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(existsSync(fixture.worktree), false);
  });

  it('stop-surface-emits-ownership-contract', () => {
    assert.equal(typeof W.CLEANUP_OWNERSHIP_RULE, 'string');
    assert.ok(W.CLEANUP_OWNERSHIP_RULE.length > 0, 'the contract constant must be exported');
    const fixture = prepareAndCommit('own-contract');
    mkdirSync(join(fixture.worktree, 'node_modules'));
    writeFileSync(join(fixture.worktree, 'node_modules/x.js'), 'x\n');
    const result = cleanup(fixture);
    assert.equal(result.code, W.EXIT.stop);
    assert.ok(result.errText.includes(W.CLEANUP_OWNERSHIP_RULE));
  });
});
