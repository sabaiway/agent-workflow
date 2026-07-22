import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuoteArg } from './review-state.mjs';
import {
  EXIT, WORKTREES_STOP, composeHandoffStub, copyTreeIfMissing, handoffBasename, runCleanup, runCli,
} from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-landing-coverage-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const SATELLITE_HEAD = 'b'.repeat(40);
const TRANSFER_TREE = 'c'.repeat(40);
const PREPARED_TREE = 'd'.repeat(40);
const WORKTREES_TOOL = fileURLToPath(new URL('./worktrees.mjs', import.meta.url));
const TOOL_DIR = dirname(WORKTREES_TOOL);

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const porcelain = (entries) => `${entries.map((entry) => [
  `worktree ${entry.path}`,
  `HEAD ${entry.head}`,
  ...(entry.prunable ? ['prunable missing'] : [`branch refs/heads/${entry.branch}`]),
].join('\0')).join('\0\0')}\0\0`;

const writeHandoff = (worktree, slug, branch, includes = [], extra = [], prepared = null) => {
  const plans = join(worktree, 'docs/plans');
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, handoffBasename(slug)), composeHandoffStub({
    slug, branch, includes, nodeModules: 'absent', vscode: 'absent', prepared,
  }));
  for (const name of extra) {
    writeFileSync(join(plans, name), composeHandoffStub({
      slug: name.slice('handoff-'.length, -'.md'.length),
      branch: `aw/${name}`,
      includes: [],
      nodeModules: 'absent',
      vscode: 'absent',
    }));
  }
};

const addSatellite = (fixture, name, { slug = fixture.slug, branch = fixture.branch, handoff = true, extra = [] } = {}) => {
  const path = join(fixture.base, name);
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, 'docs/plans'), { recursive: true });
  if (handoff) writeHandoff(path, slug, branch, [], extra);
  fixture.state.entries.push({ path, head: fixture.state.satelliteHead, branch });
  return path;
};

const makeFixture = (name, {
  slug = 'feature', branch = null, includes = [], handoff = true, children = true, prepared = null,
} = {}) => {
  const base = join(TMP, name);
  const main = join(base, 'main');
  const worktree = join(base, 'satellite');
  const common = join(main, '.git-fake');
  const liveBranch = branch ?? `aw/${slug}`;
  mkdirSync(common, { recursive: true });
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  mkdirSync(join(worktree, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), '{"gates":[]}\n');
  if (handoff) writeHandoff(worktree, slug, liveBranch, includes, [], prepared);
  if (children) {
    mkdirSync(join(main, 'agent-workflow-kit/tools'), { recursive: true });
    mkdirSync(join(worktree, 'agent-workflow-kit/tools'), { recursive: true });
    writeFileSync(
      join(worktree, 'agent-workflow-kit/tools/review-state.mjs'),
      'process.stdout.write("review child green\\n");\n',
    );
    writeFileSync(
      join(main, 'agent-workflow-kit/tools/run-gates.mjs'),
      'process.stdout.write("gate child green\\n");\n',
    );
  }
  const state = {
    applied: false,
    applyError: null,
    calls: [],
    cleanupStaged: '',
    cleanupUnstaged: '',
    entries: [
      { path: main, head: HEAD, branch: 'main' },
      { path: worktree, head: HEAD, branch: liveBranch },
    ],
    ignored: '',
    landStaged: 'README.md\0',
    mainHead: HEAD,
    mainPorcelain: '',
    mainUntracked: '',
    mergeBaseError: false,
    removeError: null,
    resetError: null,
    satelliteHead: HEAD,
    syncDelta: '',
    worktreeUntracked: '',
  };
  const git = (args, cwd) => {
    state.calls.push({ args: [...args], cwd });
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(`${main}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${common}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${common}\n`);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return ok(`${cwd === main ? state.mainHead : state.satelliteHead}\n`);
    }
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain(state.entries));
    if (args[0] === 'status') {
      if (args.includes('docs/ai')) return ok();
      if (args.includes('--ignored')) return ok(state.ignored);
      if (cwd === main) return ok(state.applied ? 'M  README.md\0' : state.mainPorcelain);
      return ok();
    }
    if (args[0] === 'merge-base') {
      return state.mergeBaseError ? { status: 128, stdout: '', stderr: 'synthetic merge-base failure' } : ok();
    }
    if (args[0] === 'ls-files' && args.includes('--others')) {
      return ok(cwd === main ? state.mainUntracked : state.worktreeUntracked);
    }
    // The AD-069 ownership-gate lane probes (tracked-index + ignore), configurable per fixture.
    if (args[0] === 'ls-files' && args.includes('--cached') && args.includes('node_modules')) {
      return ok(state.nodeModulesTracked ?? '');
    }
    if (args[0] === 'check-ignore' && args.includes('node_modules')) {
      return state.nodeModulesIgnored ? ok('node_modules\n') : { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'diff') {
      if (args.includes('--binary')) return ok('synthetic binary patch\n');
      if (args.includes('docs/ai') && args.includes('docs/plans')) return ok();
      if (args.includes('--cached') && args.includes('HEAD')) return ok(state.cleanupStaged);
      if (args.includes('--cached')) return ok(state.landStaged);
      return ok(cwd === main ? state.syncDelta : state.cleanupUnstaged);
    }
    if (args[0] === 'write-tree') return ok(`${cwd === main ? PREPARED_TREE : TRANSFER_TREE}\n`);
    if (args[0] === 'apply') {
      if (state.applyError) return state.applyError;
      state.applied = true;
      return ok();
    }
    if (args[0] === 'reset') {
      if (state.resetError) return state.resetError;
      state.applied = false;
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      return state.removeError ?? ok();
    }
    if (args[0] === 'branch' || (args[0] === 'worktree' && args[1] === 'prune')) return ok();
    return { status: 128, stdout: '', stderr: `unexpected fake git call: ${args.join(' ')}` };
  };
  return { base, main, worktree, common, slug, branch: liveBranch, state, git };
};

const run = (fixture, argv, deps = {}) => {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd: fixture.main,
    git: fixture.git,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, text: out.join('\n'), errText: err.join('\n') };
};

const land = (fixture, deps = {}) => run(fixture, ['land', fixture.slug, '--prepare'], deps);
const cleanup = (fixture, extra = [], deps = {}) => run(fixture, [
  'cleanup', fixture.slug,
  ...(fixture.branch === `aw/${fixture.slug}` ? [] : ['--branch', fixture.branch]),
  ...extra,
], deps);
const greenSpawn = (command, args) => ({
  status: 0,
  stdout: [command, ...(args ?? [])].join(' ').includes('review-state.mjs')
    ? 'review child green\n'
    : 'gate child green\n',
  stderr: '',
});
const quotedAlways = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const assertComposedFailure = (text, { primary, secondaryName, secondary }) => {
  const head = `${primary}; ${secondaryName} failed`;
  const headAt = text.indexOf(head);
  assert.ok(headAt >= 0, `${head}\n\n${text}`);
  assert.ok(text.indexOf(secondary, headAt + head.length) > headAt, `${secondary}\n\n${text}`);
};
const failedCachedQuiet = { status: 128, stdout: '', stderr: 'synthetic cached-quiet failure' };
const installSyncAdapter = (fixture) => {
  const adapter = join(fixture.main, 'scripts/sync-mirrors.mjs');
  mkdirSync(dirname(adapter), { recursive: true });
  writeFileSync(adapter, 'process.exit(1);\n');
};
const failingSyncSpawn = (command, args) => [command, ...args].join(' ').includes('review-state.mjs')
  ? greenSpawn(command, args)
  : { status: 1, stdout: '', stderr: 'synthetic sync failure' };

describe('landing coverage — removal door', () => {
  // AD-069 moved node_modules out of the provision-owned roots (an untracked node_modules now
  // STOPs at the ownership gate), so the removal-door mechanics ride another owned root.
  it('recurses through known directories and preserves causeCode on enumerate/rmdir/special failures', () => {
    const success = makeFixture('remove-tree-success', { prepared: PREPARED_TREE });
    const successRoot = join(success.worktree, '.continue');
    mkdirSync(join(successRoot, 'nested'), { recursive: true });
    writeFileSync(join(successRoot, 'nested/file.txt'), 'x\n');
    success.state.worktreeUntracked = '.continue/nested/file.txt\0';
    assert.equal(cleanup(success).code, EXIT.ok);
    assert.equal(existsSync(successRoot), false);

    const enumerate = makeFixture('remove-tree-enumerate', { prepared: PREPARED_TREE });
    const enumerateRoot = join(enumerate.worktree, '.continue');
    mkdirSync(enumerateRoot, { recursive: true });
    writeFileSync(join(enumerateRoot, 'file.txt'), 'x\n');
    enumerate.state.worktreeUntracked = '.continue/file.txt\0';
    assert.throws(
      () => runCleanup({
        argvSlug: enumerate.slug,
        flags: { branch: null, abandon: false },
        cwd: enumerate.main,
        git: enumerate.git,
        deps: {
          readdir: (path) => {
            if (path === enumerateRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return readdirSync(path);
          },
        },
        log: () => {},
      }),
      (error) => error.code === WORKTREES_STOP && error.causeCode === 'EACCES' && /cannot enumerate/.test(error.message),
    );

    const removeDir = makeFixture('remove-tree-rmdir', { prepared: PREPARED_TREE });
    const removeDirRoot = join(removeDir.worktree, '.continue');
    mkdirSync(removeDirRoot, { recursive: true });
    writeFileSync(join(removeDirRoot, 'file.txt'), 'x\n');
    removeDir.state.worktreeUntracked = '.continue/file.txt\0';
    assert.throws(
      () => runCleanup({
        argvSlug: removeDir.slug,
        flags: { branch: null, abandon: false },
        cwd: removeDir.main,
        git: removeDir.git,
        deps: {
          rmdir: (path) => {
            if (path === removeDirRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return rmdirSync(path);
          },
        },
        log: () => {},
      }),
      (error) => error.code === WORKTREES_STOP && error.causeCode === 'EACCES' && /cannot remove directory/.test(error.message),
    );

    const special = makeFixture('remove-tree-special', { prepared: PREPARED_TREE });
    const specialRoot = join(special.worktree, '.continue');
    const specialLeaf = join(specialRoot, 'device');
    mkdirSync(specialRoot, { recursive: true });
    writeFileSync(specialLeaf, 'placeholder\n');
    special.state.worktreeUntracked = '.continue/device\0';
    const specialResult = cleanup(special, [], {
      lstat: (path) => path === specialLeaf
        ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
        : lstatSync(path),
    });
    assert.equal(specialResult.code, EXIT.stop);
    assert.match(specialResult.errText, /refusing to remove special node/);
  });

  it('composes a removal-door errno as cleanup failed (EACCES)', () => {
    const worktree = join(TMP, 'copy-cleanup-cause');
    const source = join(TMP, 'copy-cleanup-cause.txt');
    const destination = join(worktree, 'destination.txt');
    mkdirSync(worktree);
    writeFileSync(source, 'payload\n');
    assert.throws(
      () => copyTreeIfMissing({
        srcAbs: source,
        dstAbs: destination,
        wtRoot: worktree,
        rel: 'destination.txt',
        deps: {
          write: () => { throw Object.assign(new Error('copy failed'), { code: 'EIO' }); },
          unlink: (path) => {
            if (path === destination) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
            return unlinkSync(path);
          },
        },
      }),
      (error) => error.code === WORKTREES_STOP
        && /cleanup failed \(EACCES\)/.test(error.message)
        && /untrusted destination remains/.test(error.message),
    );
  });
});

describe('landing coverage — child and lock edges', () => {
  it('uses the default child runner and emits the complete green report', () => {
    const fixture = makeFixture('default-child');
    writeFileSync(
      join(fixture.main, 'docs/ai/gates.json'),
      '{"gates":[{"id":"noop","title":"noop","cmd":"node --version"}]}\n',
    );
    const result = land(fixture);
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.match(result.text, new RegExp(`prepared: ${PREPARED_TREE}`));
  });

  it('reports unknown lock age when stat fails and reports lock-release failure', () => {
    const held = makeFixture('lock-age-unreadable');
    const heldLock = join(held.common, 'aw-prepare-lock');
    mkdirSync(heldLock);
    const heldResult = land(held, {
      lstat: (path) => {
        if (path === heldLock) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return lstatSync(path);
      },
    });
    assert.equal(heldResult.code, EXIT.stop);
    assert.match(heldResult.errText, /age unknown/);

    const release = makeFixture('lock-release-failure');
    release.state.entries = [release.state.entries[0]];
    const releaseLock = join(release.common, 'aw-prepare-lock');
    const releaseResult = land(release, {
      rmdir: (path) => {
        if (path === releaseLock) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return rmdirSync(path);
      },
    });
    assert.equal(releaseResult.code, EXIT.stop);
    assert.match(releaseResult.errText, /could not release aw-prepare-lock.*EACCES/);
  });
});

describe('landing coverage — satellite selection and identity edges', () => {
  it('covers duplicate, fallback, absent, nonregular, and ambiguous handoff identities', () => {
    const duplicate = makeFixture('identity-duplicate');
    addSatellite(duplicate, 'satellite-two', { branch: 'aw/other' });
    assert.match(land(duplicate).errText, /multiple worktrees carry/);

    const fallback = makeFixture('identity-fallback', { handoff: false });
    assert.match(land(fallback).errText, /handoff identity mismatch: expected handoff-feature\.md/);

    const absent = makeFixture('identity-absent');
    absent.state.entries = [absent.state.entries[0]];
    assert.match(land(absent).errText, /no registered satellite worktree/);

    const nonregular = makeFixture('identity-nonregular', { handoff: false });
    mkdirSync(join(nonregular.worktree, 'docs/plans', handoffBasename(nonregular.slug)));
    assert.match(land(nonregular).errText, /is not a regular file/);

    const ambiguous = makeFixture('identity-ambiguous');
    writeHandoff(ambiguous.worktree, ambiguous.slug, ambiguous.branch, [], ['handoff-other.md']);
    assert.match(land(ambiguous).errText, /expected exactly handoff-feature\.md/);
  });

  it('surfaces a merge-base plumbing failure', () => {
    const fixture = makeFixture('merge-base-failure');
    fixture.state.mainHead = HEAD;
    fixture.state.satelliteHead = SATELLITE_HEAD;
    fixture.state.entries[1].head = SATELLITE_HEAD;
    fixture.state.mergeBaseError = true;
    const result = land(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /git merge-base failed: synthetic merge-base failure/);
  });
});

describe('landing coverage — rollback edges', () => {
  it('rolls main back when the transfer patch cannot be removed', () => {
    const fixture = makeFixture('patch-cleanup-failure');
    const result = land(fixture, {
      spawn: greenSpawn,
      unlink: (path) => {
        if (basename(path) === `aw-transfer-${fixture.slug}.patch`) {
          throw Object.assign(new Error('patch cleanup denied'), { code: 'EACCES' });
        }
        return unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /cannot remove .*aw-transfer-feature\.patch \(EACCES\)/);
    assert.ok(fixture.state.calls.some(({ args }) => args[0] === 'reset' && args[1] === '--hard'));
  });

  it('rolls main back when the prepared-tree record cannot be written', () => {
    const fixture = makeFixture('record-write-failure');
    const handoff = handoffBasename(fixture.slug);
    const result = land(fixture, {
      spawn: greenSpawn,
      writeFile: (path, body, options) => {
        if (path.includes(handoff)) throw Object.assign(new Error('record denied'), { code: 'EACCES' });
        return writeFileSync(path, body, options);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /record denied/);
    assert.ok(fixture.state.calls.some(({ args }) => args[0] === 'reset' && args[1] === '--hard'));
    assert.doesNotMatch(readFileSync(join(fixture.worktree, 'docs/plans', handoff), 'utf8'), /prepared-tree/);
  });
});

describe('landing fixups — dirty main recovery', () => {
  it('fixup: a first prepare lists user untracked files without removal commands', () => {
    const fixture = makeFixture('dirty-first-prepare');
    fixture.state.mainPorcelain = '?? user note.txt\0?? nested/data.bin\0';
    fixture.state.mainUntracked = 'user note.txt\0nested/data.bin\0';
    const result = land(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /user note\.txt/);
    assert.match(result.errText, /nested\/data\.bin/);
    assert.doesNotMatch(result.errText, /(?:^|\n)\s*(?:cd .* && )?rm -- /);
  });

  it('fixup: a converged re-run offers root-anchored removal commands', () => {
    const fixture = makeFixture('dirty-converged-prepare', { prepared: PREPARED_TREE });
    const leftover = 'nested/crash residue.txt';
    fixture.state.mainPorcelain = `?? ${leftover}\0`;
    fixture.state.mainUntracked = `${leftover}\0`;
    const result = land(fixture);
    const command = `  cd ${shellQuoteArg(fixture.main)} && rm -- ${shellQuoteArg(leftover)}`;
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /converged re-run/);
    assert.ok(result.errText.includes(command), `${command}\n\n${result.errText}`);
    assert.doesNotMatch(result.errText, /(?:^|\n)  rm -- /);
  });
});

describe('landing fixups — destructive cleanup edges', () => {
  it('fixup: rollback unlinks a leaf symlink without touching its target', () => {
    const fixture = makeFixture('rollback-leaf-symlink');
    const adapter = join(fixture.main, 'scripts/sync-mirrors.mjs');
    const target = join(fixture.base, 'outside-target.txt');
    const linkParent = join(fixture.main, 'sync-output');
    const link = join(linkParent, 'sync-link');
    const inspected = [];
    mkdirSync(join(fixture.main, 'scripts'), { recursive: true });
    mkdirSync(linkParent);
    writeFileSync(adapter, 'process.exit(1);\n');
    writeFileSync(target, 'target bytes stay\n');
    fixture.state.mainUntracked = 'sync-output/sync-link\0';
    const result = land(fixture, {
      lstat: (path) => {
        inspected.push(path);
        return lstatSync(path);
      },
      spawn: (command, args) => {
        if ([command, ...args].join(' ').includes('review-state.mjs')) return greenSpawn(command, args);
        symlinkSync(target, link);
        return { status: 1, stdout: '', stderr: 'synthetic sync failure' };
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.equal(readFileSync(target, 'utf8'), 'target bytes stay\n');
    assert.equal(existsSync(link), false, 'rollback removes the link itself');
    assert.ok(inspected.includes(linkParent), 'rollback checks the leaf parent containment');
    assert.equal(fixture.state.applied, false);
    assert.match(result.errText, /sync adapter failed/);
  });

  it('fixup: cleanup reports a failed probe cleanup with errno and leftover path', () => {
    const fixture = makeFixture('cleanup-probe-leftover');
    const probe = join(fixture.base, '.aw-write-probe-leftover');
    const result = cleanup(fixture, ['--abandon'], {
      rand: () => 'leftover',
      rmdir: (path) => {
        if (path === probe) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rmdirSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.ok(result.errText.includes(
      `the writability probe could not clean up its probe dir (EBUSY) — remove it by hand: ${probe}`,
    ), result.errText);
    assert.doesNotMatch(result.errText, /worktrees parent dir is not writable/);
    assert.equal(existsSync(probe), true);
  });

  it('fixup: destructive recovery carries the actual custom branch', () => {
    const branch = 'feature/custom-cleanup';
    const fixture = makeFixture('cleanup-custom-recovery', { branch });
    fixture.state.cleanupUnstaged = 'foreign.txt\0';
    const result = cleanup(fixture);
    const command = `Destructive recovery requires: cleanup ${fixture.slug} --branch ${branch} --abandon`;
    assert.equal(result.code, EXIT.stop);
    assert.ok(result.errText.includes(command), `${command}\n\n${result.errText}`);
    const source = readFileSync(new URL('./worktrees.mjs', import.meta.url), 'utf8');
    assert.equal((source.match(/Destructive recovery requires:/g) ?? []).length, 1);
  });
});

describe('landing fixups round 2 — installed tools and fallback', () => {
  it('round-2: land runs installed review and gates tools without a repo-local kit', () => {
    const fixture = makeFixture('installed-child-tools', { children: false });
    const calls = [];
    assert.equal(existsSync(join(fixture.main, 'agent-workflow-kit')), false);
    assert.equal(existsSync(join(fixture.worktree, 'agent-workflow-kit')), false);
    const reviewTool = join(TOOL_DIR, 'review-state.mjs');
    const gatesTool = join(TOOL_DIR, 'run-gates.mjs');
    const result = land(fixture, {
      spawn: (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        if (args[0] === reviewTool && args[1] === '--check' && options.cwd === fixture.worktree) {
          return { status: 0, stdout: 'installed review green\n', stderr: '' };
        }
        if (args[0] === gatesTool && args[1] === '--cwd' && args[2] === fixture.main) {
          return { status: 0, stdout: 'installed gates green\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: `unexpected child ${args.join(' ')}` };
      },
    });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.deepEqual(calls, [
      { command: process.execPath, args: [reviewTool, '--check'], cwd: fixture.worktree },
      { command: process.execPath, args: [gatesTool, '--cwd', fixture.main], cwd: fixture.main },
    ]);
  });

  it('round-2: cleanup fallback prints settings-native consent and the absolute own tool', () => {
    const fixture = makeFixture('cleanup-own-tool-fallback', { branch: 'feature/custom-fallback' });
    const result = cleanup(fixture, ['--abandon'], {
      mkdirPlain: (path) => {
        if (basename(path).startsWith('.aw-write-probe-')) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return mkdirSync(path);
      },
    });
    const settingsLine = `  .claude/settings.json → sandbox.filesystem.allowWrite += ${JSON.stringify(fixture.base)}`;
    const fallback = `  cd ${shellQuoteArg(fixture.main)} && node ${quotedAlways(WORKTREES_TOOL)} ` +
      `cleanup ${fixture.slug} --branch ${fixture.branch} --abandon`;
    assert.equal(result.code, EXIT.stop);
    assert.ok(result.errText.includes(settingsLine), `${settingsLine}\n\n${result.errText}`);
    assert.ok(result.errText.includes(fallback), `${fallback}\n\n${result.errText}`);
  });
});

describe('landing fixups round 2 — composed failures', () => {
  it('round-2: an action error stays primary when lock release also fails', () => {
    const fixture = makeFixture('action-and-lock-release');
    fixture.state.entries = [fixture.state.entries[0]];
    const lock = join(fixture.common, 'aw-prepare-lock');
    const result = land(fixture, {
      rmdir: (path) => {
        if (path === lock) throw Object.assign(new Error('release denied'), { code: 'EACCES' });
        return rmdirSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assertComposedFailure(result.errText, {
      primary: 'no registered satellite worktree for feature',
      secondaryName: 'lock release',
      secondary: 'EACCES',
    });
  });

  it('round-2: a git apply error stays primary when patch cleanup also fails', () => {
    const fixture = makeFixture('apply-and-patch-cleanup');
    fixture.state.applyError = { status: 128, stdout: '', stderr: 'synthetic apply refusal' };
    const result = land(fixture, {
      spawn: greenSpawn,
      unlink: (path) => {
        if (basename(path) === `aw-transfer-${fixture.slug}.patch`) {
          throw Object.assign(new Error('patch cleanup denied'), { code: 'EACCES' });
        }
        return unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assertComposedFailure(result.errText, {
      primary: 'git apply --index failed: synthetic apply refusal',
      secondaryName: 'patch cleanup',
      secondary: 'EACCES',
    });
  });

  it('round-2: an original action error stays primary when rollback fails', () => {
    const fixture = makeFixture('sync-and-reset-rollback');
    installSyncAdapter(fixture);
    fixture.state.resetError = { status: 128, stdout: '', stderr: 'synthetic reset refusal' };
    const result = land(fixture, { spawn: failingSyncSpawn });
    assert.equal(result.code, EXIT.stop);
    assertComposedFailure(result.errText, {
      primary: 'sync adapter failed',
      secondaryName: 'rollback',
      secondary: 'git reset --hard rollback failed: synthetic reset refusal',
    });
  });

  it('round-2: rollback attempts every removal and composes all failures', () => {
    const fixture = makeFixture('sync-and-multiple-removals');
    const first = join(fixture.main, 'cleanup-a.txt');
    const second = join(fixture.main, 'cleanup-b.txt');
    const attempted = [];
    installSyncAdapter(fixture);
    writeFileSync(first, 'a\n');
    writeFileSync(second, 'b\n');
    fixture.state.mainUntracked = 'cleanup-a.txt\0cleanup-b.txt\0';
    const result = land(fixture, {
      spawn: failingSyncSpawn,
      unlink: (path) => {
        if (path === first || path === second) {
          attempted.push(path);
          const code = path === first ? 'EACCES' : 'EPERM';
          throw Object.assign(new Error(`cannot remove ${basename(path)}`), { code });
        }
        return unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.deepEqual(attempted, [first, second]);
    assertComposedFailure(result.errText, {
      primary: 'sync adapter failed',
      secondaryName: 'rollback',
      secondary: 'cleanup-a.txt',
    });
    assert.match(result.errText, /cleanup-b\.txt/);
    assert.match(result.errText, /EACCES/);
    assert.match(result.errText, /EPERM/);
  });

  it('round-2: a rollback untracked-enumeration failure is collected and composed', () => {
    const fixture = makeFixture('sync-and-untracked-error');
    installSyncAdapter(fixture);
    const baseGit = fixture.git;
    let syncFailed = false;
    let postSyncEnumerations = 0;
    const spawn = (...spawnArgs) => {
      const outcome = failingSyncSpawn(...spawnArgs);
      syncFailed = true;
      return outcome;
    };
    const git = (args, cwd) => {
      if (args[0] === 'ls-files' && args.includes('--others') && cwd === fixture.main && syncFailed) {
        postSyncEnumerations += 1;
        if (postSyncEnumerations >= 2) {
          return { status: 128, stdout: '', stderr: 'synthetic untracked enumeration failure' };
        }
      }
      return baseGit(args, cwd);
    };
    const result = land(fixture, { git, spawn });
    assert.equal(result.code, EXIT.stop);
    assertComposedFailure(result.errText, {
      primary: 'sync adapter failed',
      secondaryName: 'rollback',
      secondary: 'synthetic untracked enumeration failure',
    });
    assert.equal(fixture.state.applied, false);
  });
});

describe('landing fixups round 3 — dirty recovery and adapter index', () => {
  it('round-3: reset advice is limited to a converged re-run without tracked unstaged changes', () => {
    const first = makeFixture('dirty-reset-first');
    first.state.mainPorcelain = 'M  first-staged.txt\0 M first-unstaged.txt\0';
    const firstResult = land(first);
    assert.equal(firstResult.code, EXIT.stop);
    assert.match(firstResult.errText, /first-staged\.txt/);
    assert.match(firstResult.errText, /first-unstaged\.txt/);
    assert.doesNotMatch(firstResult.errText, /git reset --hard/);

    const foreign = makeFixture('dirty-reset-foreign', { prepared: 'e'.repeat(40) });
    foreign.state.mainPorcelain = 'M  foreign-staged.txt\0';
    const foreignResult = land(foreign);
    assert.equal(foreignResult.code, EXIT.stop);
    assert.match(foreignResult.errText, /foreign-staged\.txt/);
    assert.doesNotMatch(foreignResult.errText, /git reset --hard/);

    const unstaged = makeFixture('dirty-reset-unstaged', { prepared: PREPARED_TREE });
    unstaged.state.mainPorcelain = ' M tracked-unstaged.txt\0';
    const unstagedResult = land(unstaged);
    assert.equal(unstagedResult.code, EXIT.stop);
    assert.match(unstagedResult.errText, /tracked-unstaged\.txt/);
    assert.doesNotMatch(unstagedResult.errText, /git reset --hard/);

    const converged = makeFixture('dirty-reset-converged', { prepared: PREPARED_TREE });
    converged.state.mainPorcelain = '?? crash-residue.txt\0';
    converged.state.mainUntracked = 'crash-residue.txt\0';
    const convergedResult = land(converged);
    assert.equal(convergedResult.code, EXIT.stop);
    assert.match(convergedResult.errText, /converged re-run/);
    assert.match(convergedResult.errText, /git reset --hard/);
  });

  it('round-3: an adapter-staged path reaches the sync report and overlap check', () => {
    const fixture = makeFixture('adapter-stages-transfer-path');
    const adapterTree = 'f'.repeat(40);
    const baseGit = fixture.git;
    let adapterRan = false;
    let beforeAdapterTreeReads = 0;
    let afterAdapterTreeReads = 0;
    installSyncAdapter(fixture);
    const git = (args, cwd) => {
      const result = baseGit(args, cwd);
      if (args[0] === 'write-tree' && cwd === fixture.main) {
        if (adapterRan) {
          afterAdapterTreeReads += 1;
          return ok(`${adapterTree}\n`);
        }
        beforeAdapterTreeReads += 1;
      }
      if (adapterRan && cwd === fixture.main && (
        args[0] === 'diff-tree' ||
        (args[0] === 'diff' && (
          args.includes('--cached') || args.includes(PREPARED_TREE) || args.includes(adapterTree)
        ))
      )) return ok('README.md\0');
      return result;
    };
    const spawn = (command, args) => {
      if (args[0] === join(fixture.main, 'scripts/sync-mirrors.mjs')) {
        adapterRan = true;
        return { status: 0, stdout: 'adapter staged README.md\n', stderr: '' };
      }
      return greenSpawn(command, args);
    };
    const result = land(fixture, { git, spawn });
    assert.equal(result.code, EXIT.ok, result.errText);
    assert.ok(beforeAdapterTreeReads >= 1, 'the main index tree is captured before the adapter runs');
    assert.ok(afterAdapterTreeReads >= 1, 'the main index tree is captured after the adapter runs');
    assert.match(result.text, /sync delta: README\.md/);
    assert.match(result.text, /mirror edit overwritten by canon sync: README\.md/);
  });
});

describe('landing fixups round 4 — rollback and drift honesty', () => {
  it('round-4: rollback preserves a tracked file recreated as untracked after a staged deletion', () => {
    const fixture = makeFixture('rollback-staged-delete-recreate');
    const tracked = join(fixture.main, 'tracked.txt');
    const adapterTree = '1'.repeat(40);
    const baseGit = fixture.git;
    let adapterRan = false;
    let rolledBack = false;
    installSyncAdapter(fixture);
    writeFileSync(tracked, 'tracked base\n');
    const git = (args, cwd) => {
      if (args[0] === 'write-tree' && cwd === fixture.main && adapterRan && !rolledBack) {
        return ok(`${adapterTree}\n`);
      }
      if (args[0] === 'diff' && args.includes(PREPARED_TREE) && args.includes(adapterTree)) {
        return ok('tracked.txt\0');
      }
      if (args[0] === 'ls-files' && args.includes('--others') && cwd === fixture.main && adapterRan) {
        return ok(rolledBack ? '' : 'tracked.txt\0');
      }
      if (args[0] === 'reset' && cwd === fixture.main) {
        const result = baseGit(args, cwd);
        writeFileSync(tracked, 'tracked base\n');
        rolledBack = true;
        return result;
      }
      if (args[0] === 'status' && cwd === fixture.main && rolledBack) {
        return ok(existsSync(tracked) ? '' : ' D tracked.txt\0');
      }
      return baseGit(args, cwd);
    };
    const spawn = (command, args) => {
      if (args[0] === join(fixture.main, 'scripts/sync-mirrors.mjs')) {
        unlinkSync(tracked);
        writeFileSync(tracked, 'adapter replacement\n');
        adapterRan = true;
        return { status: 1, stdout: '', stderr: 'adapter failed after staged deletion' };
      }
      return greenSpawn(command, args);
    };
    const result = land(fixture, { git, spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /sync adapter failed/);
    assert.equal(existsSync(tracked), true, 'rollback keeps the tracked file restored by reset');
    assert.equal(readFileSync(tracked, 'utf8'), 'tracked base\n');
    assert.equal(git(['status', '--porcelain=v1', '-z'], fixture.main).stdout, '');
  });

  it('round-4: a post-adapter observation failure rolls back and composes cleanup failure', () => {
    const fixture = makeFixture('sync-observation-and-rollback-failure');
    const leftover = join(fixture.main, 'observation-leftover.txt');
    const baseGit = fixture.git;
    let adapterRan = false;
    installSyncAdapter(fixture);
    const git = (args, cwd) => {
      if (args[0] === 'write-tree' && cwd === fixture.main && adapterRan) {
        return { status: 128, stdout: '', stderr: 'synthetic unmerged index' };
      }
      return baseGit(args, cwd);
    };
    const spawn = (command, args) => {
      if (args[0] === join(fixture.main, 'scripts/sync-mirrors.mjs')) {
        writeFileSync(leftover, 'partial output\n');
        fixture.state.mainUntracked = 'observation-leftover.txt\0';
        adapterRan = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      return greenSpawn(command, args);
    };
    const result = land(fixture, {
      git,
      spawn,
      unlink: (path) => {
        if (path === leftover) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
        return unlinkSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assertComposedFailure(result.errText, {
      primary: 'cannot snapshot the main index after sync: synthetic unmerged index',
      secondaryName: 'rollback',
      secondary: 'EACCES',
    });
    assert.equal(fixture.state.applied, false, 'observation failure still resets main');
  });

  it('round-4: untracked removal commands require the complete mayReset condition', () => {
    const fixture = makeFixture('dirty-mixed-no-removal', { prepared: PREPARED_TREE });
    fixture.state.mainPorcelain = ' M foreign-tracked.txt\0?? user-untracked.txt\0';
    fixture.state.mainUntracked = 'user-untracked.txt\0';
    const result = land(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /foreign-tracked\.txt/);
    assert.match(result.errText, /user-untracked\.txt/);
    assert.doesNotMatch(result.errText, /git reset --hard/);
    assert.doesNotMatch(result.errText, /(?:^|\n)\s*(?:cd .* && )?rm -- /);
  });

  it('round-4: a failing gate is followed by snapshot verification before recovery is reported', () => {
    const fixture = makeFixture('red-gate-mutates-tree');
    const mutatedTree = '2'.repeat(40);
    const baseGit = fixture.git;
    let gateRan = false;
    let afterGateTreeReads = 0;
    const git = (args, cwd) => {
      if (gateRan && args[0] === 'write-tree' && cwd === fixture.main) {
        afterGateTreeReads += 1;
        return ok(`${mutatedTree}\n`);
      }
      return baseGit(args, cwd);
    };
    const spawn = (command, args) => {
      if (args[0] === join(TOOL_DIR, 'run-gates.mjs')) {
        gateRan = true;
        return { status: 1, stdout: '', stderr: 'synthetic red gate with tree drift' };
      }
      return greenSpawn(command, args);
    };
    const result = land(fixture, { git, spawn });
    assert.equal(result.code, EXIT.stop);
    assert.ok(afterGateTreeReads >= 1, 'the prepared-tree snapshot is verified after a red gate');
    assert.match(result.errText, /main changed during gates|post-gates snapshot/i);
    assert.ok(result.errText.includes(`git reset --hard ${HEAD}`), result.errText);
    assert.doesNotMatch(result.errText, /prepared tree stays staged/i);
  });
});

describe('landing fixups round 5 — cleanup proof and preflight completeness', () => {
  it('round-5: abandon deletes an unmerged branch with -D while normal cleanup keeps -d', () => {
    const abandoned = makeFixture('cleanup-abandon-local-commit');
    abandoned.state.satelliteHead = SATELLITE_HEAD;
    const abandonedCalls = [];
    const abandonedGit = (args, cwd) => {
      abandonedCalls.push([...args]);
      if (args[0] === 'branch' && args[1] === '-d') {
        return { status: 1, stdout: '', stderr: 'synthetic branch is not fully merged' };
      }
      if (args[0] === 'branch' && args[1] === '-D') return ok();
      return abandoned.git(args, cwd);
    };
    const abandonedResult = cleanup(abandoned, ['--abandon'], { git: abandonedGit });
    assert.equal(abandonedResult.code, EXIT.ok, abandonedResult.errText);
    assert.ok(abandonedCalls.some((args) => args[0] === 'branch' && args[1] === '-D' && args[2] === abandoned.branch));
    assert.equal(abandonedCalls.some((args) => args[0] === 'branch' && args[1] === '-d'), false);

    const normal = makeFixture('cleanup-normal-unmerged', { prepared: PREPARED_TREE });
    const normalCalls = [];
    const normalGit = (args, cwd) => {
      normalCalls.push([...args]);
      if (args[0] === 'branch' && args[1] === '-d') {
        return { status: 1, stdout: '', stderr: 'synthetic normal unmerged refusal' };
      }
      return normal.git(args, cwd);
    };
    const normalResult = cleanup(normal, [], { git: normalGit });
    assert.equal(normalResult.code, EXIT.stop);
    assert.match(normalResult.errText, /synthetic normal unmerged refusal/);
    assert.ok(normalCalls.some((args) => args[0] === 'branch' && args[1] === '-d' && args[2] === normal.branch));
    assert.equal(normalCalls.some((args) => args.includes('-D')), false);
  });

  it('round-5: normal cleanup refuses an excluded-only worktree with no prepared OID', () => {
    const fixture = makeFixture('cleanup-never-prepared');
    const seed = join(fixture.worktree, 'docs/plans/feature.md');
    const handoff = join(fixture.worktree, 'docs/plans', handoffBasename(fixture.slug));
    writeFileSync(seed, '# Seed plan\n');
    const result = cleanup(fixture);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /prepared.*(?:absent|missing|null)|nothing (?:was|has been) landed/i);
    assert.match(result.errText, /--abandon/);
    assert.equal(existsSync(seed), true);
    assert.equal(existsSync(handoff), true);
    assert.equal(fixture.state.calls.some(({ args }) => args[0] === 'reset'), false);
    assert.equal(fixture.state.calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'remove'), false);
  });

  it('round-5: land probes satellite-parent writability before applying the transfer', () => {
    const fixture = makeFixture('land-parent-denied');
    const probe = join(fixture.base, '.aw-write-probe-land-denied');
    const result = land(fixture, {
      rand: () => 'land-denied',
      mkdirPlain: (path) => {
        if (path === probe) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return mkdirSync(path);
      },
      spawn: greenSpawn,
    });
    const fallback = `cd ${shellQuoteArg(fixture.main)} && node ${quotedAlways(WORKTREES_TOOL)} ` +
      `land ${shellQuoteArg(fixture.slug)} --prepare`;
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /worktrees parent dir is not writable/);
    assert.ok(result.errText.includes(fallback), `${fallback}\n\n${result.errText}`);
    assert.equal(fixture.state.applied, false);
    assert.equal(fixture.state.calls.some(({ args }) => args[0] === 'apply'), false);
  });

  it('round-5: copilot footprint globs return their root and never cover descendants', () => {
    const exact = makeFixture('cleanup-copilot-exact', { prepared: PREPARED_TREE });
    const exactPath = join(exact.worktree, '.github/copilot-instructions.md');
    mkdirSync(dirname(exactPath), { recursive: true });
    writeFileSync(exactPath, 'instructions\n');
    exact.state.worktreeUntracked = '.github/copilot-instructions.md\0';
    const exactResult = cleanup(exact);
    assert.equal(exactResult.code, EXIT.ok, exactResult.errText);
    assert.equal(existsSync(exactPath), false);

    const descendant = makeFixture('cleanup-copilot-descendant', { prepared: PREPARED_TREE });
    const descendantPath = join(descendant.worktree, '.github/copilot-bundle/nested.txt');
    mkdirSync(dirname(descendantPath), { recursive: true });
    writeFileSync(descendantPath, 'foreign\n');
    descendant.state.worktreeUntracked = '.github/copilot-bundle/nested.txt\0';
    const descendantResult = cleanup(descendant);
    assert.equal(descendantResult.code, EXIT.stop);
    assert.match(descendantResult.errText, /copilot-bundle\/nested\.txt/);
    assert.match(descendantResult.errText, /--abandon/);
    assert.equal(existsSync(descendantPath), true);
  });

  it('round-5: rollback removes empty directories created by the adapter', () => {
    const fixture = makeFixture('rollback-empty-adapter-directories');
    const generatedRoot = join(fixture.main, 'generated');
    const generatedFile = join(generatedRoot, 'deep/output.txt');
    const baseGit = fixture.git;
    installSyncAdapter(fixture);
    const git = (args, cwd) => {
      if (args[0] === 'status' && cwd === fixture.main && !fixture.state.applied) {
        return ok(existsSync(generatedRoot) ? '?? generated/\0' : '');
      }
      return baseGit(args, cwd);
    };
    const spawn = (command, args) => {
      if (args[0] === join(fixture.main, 'scripts/sync-mirrors.mjs')) {
        mkdirSync(dirname(generatedFile), { recursive: true });
        writeFileSync(generatedFile, 'partial output\n');
        fixture.state.mainUntracked = 'generated/deep/output.txt\0';
        return { status: 1, stdout: '', stderr: 'adapter failed after creating directories' };
      }
      return greenSpawn(command, args);
    };
    const result = land(fixture, { git, spawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /sync adapter failed/);
    assert.equal(existsSync(generatedRoot), false, 'rollback removes adapter-created empty parent directories');
    assert.equal(git(['status', '--porcelain=v1', '-z'], fixture.main).stdout, '');
  });
});

describe('landing fixups round 6 — cleanup data ownership', () => {
  it('round-6: ignored glob ownership is exact and names a foreign sibling path', () => {
    const owned = makeFixture('cleanup-ignored-copilot-owned', { prepared: PREPARED_TREE });
    owned.state.ignored = '!! .github/copilot-x\0';
    const ownedResult = cleanup(owned);
    assert.equal(ownedResult.code, EXIT.ok, ownedResult.errText);

    const foreign = makeFixture('cleanup-ignored-copilot-foreign', { prepared: PREPARED_TREE });
    foreign.state.ignored = '!! .github/copilot-x\0!! .github/private.secret\0';
    const foreignResult = cleanup(foreign);
    assert.equal(foreignResult.code, EXIT.stop);
    assert.match(foreignResult.errText, /\.github\/private\.secret/);
    assert.doesNotMatch(foreignResult.errText, /\.github\/copilot-x/);
    assert.match(foreignResult.errText, /--abandon/);
  });

  it('round-6: visible docs drift refuses cleanup before reset while the ignored handoff stays exempt', () => {
    const fixture = makeFixture('cleanup-visible-docs-drift', { prepared: PREPARED_TREE });
    const baseGit = fixture.git;
    const handoff = `docs/plans/${handoffBasename(fixture.slug)}`;
    fixture.state.ignored = `!! ${handoff}\0`;
    const git = (args, cwd) => {
      const explicitDocs = args.includes('docs/ai') || args.includes('docs/plans');
      if (cwd === fixture.worktree && explicitDocs && args[0] === 'status') {
        return ok(` M docs/ai/current_state.md\0 M docs/plans/user-plan.md\0!! ${handoff}\0`);
      }
      if (cwd === fixture.worktree && explicitDocs && args[0] === 'diff') {
        return ok('docs/ai/current_state.md\0docs/plans/user-plan.md\0');
      }
      return baseGit(args, cwd);
    };
    const result = cleanup(fixture, [], { git });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /docs\/ai\/current_state\.md/);
    assert.match(result.errText, /docs\/plans\/user-plan\.md/);
    assert.doesNotMatch(result.errText, new RegExp(handoff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fixture.state.calls.some(({ args }) => args[0] === 'reset'), false);
  });

  it('round-6: crash-residue removal requires a recorded prepared tree with a real staged delta', () => {
    const runDirty = (name, { headTree, hasStagedDelta, path }) => {
      const fixture = makeFixture(name, { prepared: PREPARED_TREE });
      const baseGit = fixture.git;
      fixture.state.mainPorcelain = `?? ${path}\0`;
      fixture.state.mainUntracked = `${path}\0`;
      const git = (args, cwd) => {
        if (cwd === fixture.main && args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return ok(`${headTree}\n`);
        }
        if (cwd === fixture.main && args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
          return { status: hasStagedDelta ? 1 : 0, stdout: '', stderr: '' };
        }
        return baseGit(args, cwd);
      };
      return { fixture, result: land(fixture, { git }) };
    };

    const committed = runDirty('dirty-post-commit-user-file', {
      headTree: PREPARED_TREE,
      hasStagedDelta: false,
      path: 'user-untracked.txt',
    });
    assert.equal(committed.result.code, EXIT.stop);
    assert.match(committed.result.errText, /user-untracked\.txt/);
    assert.doesNotMatch(committed.result.errText, /(?:^|\n)\s*(?:cd .* && )?rm -- /);

    const staged = runDirty('dirty-staged-crash-residue', {
      headTree: '3'.repeat(40),
      hasStagedDelta: true,
      path: 'sync-leftover.txt',
    });
    assert.equal(staged.result.code, EXIT.stop);
    assert.match(staged.result.errText, /converged re-run/);
    assert.match(staged.result.errText, /(?:^|\n)\s*cd .* && rm -- sync-leftover\.txt/);
  });
});

describe('landing fixups round 7 — typed ownership, literal paths, and metadata honesty', () => {
  it('round-7: file and glob ownership rejects directories with the same names', () => {
    const owned = makeFixture('cleanup-ignored-copilot-file', { prepared: PREPARED_TREE });
    const ownedPath = join(owned.worktree, '.github/copilot-x');
    mkdirSync(dirname(ownedPath), { recursive: true });
    writeFileSync(ownedPath, 'owned file\n');
    owned.state.ignored = '!! .github/copilot-x\0';
    const ownedResult = cleanup(owned);
    assert.equal(ownedResult.code, EXIT.ok, ownedResult.errText);

    const assertForeignDirectory = (name, relativePath) => {
      const fixture = makeFixture(name, { prepared: PREPARED_TREE });
      mkdirSync(join(fixture.worktree, relativePath), { recursive: true });
      fixture.state.ignored = `!! ${relativePath}/\0`;
      const result = cleanup(fixture);
      assert.equal(result.code, EXIT.stop);
      assert.ok(result.errText.includes(relativePath), result.errText);
      assert.match(result.errText, /--abandon/);
      assert.equal(fixture.state.calls.some(({ args }) => args[0] === 'reset'), false);
    };

    assertForeignDirectory('cleanup-ignored-copilot-directory', '.github/copilot-x');
    assertForeignDirectory('cleanup-ignored-file-root-directory', '.cursorrules');
  });

  it('round-7: git-returned magic-prefixed names are literalized before reuse as pathspecs', () => {
    const magicPath = ':(literal)decoy.txt';
    const literalPath = `:(literal)${magicPath}`;
    const commandName = (args) => args[0] === '--literal-pathspecs' ? args[1] : args[0];
    const isProtected = (args) => args.includes('--literal-pathspecs') || args.includes(literalPath);

    const landFixture = makeFixture('land-literal-pathspec');
    const landBaseGit = landFixture.git;
    const addCalls = [];
    installSyncAdapter(landFixture);
    writeFileSync(join(landFixture.main, magicPath), 'literal path bytes\n');
    landFixture.state.syncDelta = `${magicPath}\0`;
    const landGit = (args, cwd) => {
      if (cwd === landFixture.main && commandName(args) === 'add') {
        addCalls.push(args);
        return isProtected(args)
          ? ok()
          : { status: 128, stdout: '', stderr: `raw magic pathspec rejected: ${magicPath}` };
      }
      return landBaseGit(args, cwd);
    };
    const landResult = land(landFixture, { git: landGit, spawn: greenSpawn });
    assert.equal(landResult.code, EXIT.ok, landResult.errText);
    assert.equal(addCalls.length, 1);
    assert.equal(isProtected(addCalls[0]), true);
    assert.match(landResult.text, /:\(literal\)decoy\.txt/);

    const cleanupFixture = makeFixture('cleanup-literal-pathspec', { prepared: PREPARED_TREE });
    const cleanupBaseGit = cleanupFixture.git;
    const entryOid = '7'.repeat(40);
    const verificationCalls = [];
    writeFileSync(join(cleanupFixture.worktree, magicPath), 'literal path bytes\n');
    cleanupFixture.state.cleanupStaged = `${magicPath}\0`;
    const cleanupGit = (args, cwd) => {
      const command = commandName(args);
      if ((command === 'ls-files' && args.includes('--stage')) || command === 'ls-tree') {
        verificationCalls.push(args);
        if (!isProtected(args)) {
          return { status: 128, stdout: '', stderr: `raw magic pathspec rejected: ${magicPath}` };
        }
        return command === 'ls-files'
          ? ok(`100644 ${entryOid} 0\t${magicPath}\0`)
          : ok(`100644 blob ${entryOid}\t${magicPath}\0`);
      }
      return cleanupBaseGit(args, cwd);
    };
    const cleanupResult = cleanup(cleanupFixture, [], { git: cleanupGit });
    assert.equal(cleanupResult.code, EXIT.ok, cleanupResult.errText);
    assert.equal(verificationCalls.length, 2);
    assert.equal(verificationCalls.every(isProtected), true);
  });

  it('round-7: the mode contract names the one stored-metadata exception', () => {
    const mode = readFileSync(new URL('../references/modes/worktrees.md', import.meta.url), 'utf8');
    assert.ok(mode.includes(
      'The ONE stored-metadata exception is the PREPARED OID recorded in the handoff: land and cleanup read it back only for recovery.',
    ));
  });
});

describe('landing coverage — cleanup edges', () => {
  it('refuses an unsafe provision-record path', () => {
    const fixture = makeFixture('unsafe-record-path', { includes: ['../escape'], prepared: PREPARED_TREE });
    const result = cleanup(fixture, ['--abandon']);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /unsafe provision path: \.\.\/escape/);
  });

  it('prints the full custom-branch abandon command when the parent probe is denied', () => {
    const fixture = makeFixture('cleanup-probe-denied', { branch: 'feature/custom' });
    const result = cleanup(fixture, ['--abandon'], {
      rand: () => 'denied',
      mkdirPlain: (path) => {
        if (basename(path).startsWith('.aw-write-probe-')) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return mkdirSync(path);
      },
    });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /worktrees parent dir is not writable/);
    assert.match(result.errText, /cleanup feature --branch feature\/custom --abandon/);
  });

  it('rethrows a non-EBUSY worktree-remove refusal verbatim', () => {
    const fixture = makeFixture('cleanup-remove-refusal', { prepared: PREPARED_TREE });
    fixture.state.removeError = { status: 128, stdout: '', stderr: 'fatal: policy refusal' };
    const result = cleanup(fixture, ['--abandon']);
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /git worktree remove failed: fatal: policy refusal/);
    assert.doesNotMatch(result.errText, /lingering processes/);
  });

  it('a failing cached-quiet probe inside the dirty-main STOP is surfaced verbatim', () => {
    const fixture = makeFixture('dirty-main-cached-quiet', { prepared: PREPARED_TREE });
    fixture.state.mainPorcelain = ' M staged.txt\0';
    const baseGit = fixture.git;
    const git = (args, cwd) => (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')
      ? failedCachedQuiet
      : baseGit(args, cwd));
    const result = land(fixture, { git, spawn: greenSpawn });
    assert.equal(result.code, EXIT.stop);
    assert.match(result.errText, /git diff --cached --quiet failed: synthetic cached-quiet failure/);
  });
});
