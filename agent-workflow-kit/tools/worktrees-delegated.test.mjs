import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync,
  readFileSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { buildRecommendations } from './recommendations.mjs';
import { copyTreeIfMissing, EXIT, runCli, WORKTREES_STOP } from './worktrees.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySlot } from './write-lanes.mjs';
import { worktreesDirFingerprint } from './recommendations.mjs';
import { shellQuoteArg } from './repo-lex.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const worktreesCheck = (root) => {
  const slot = applySlot('worktrees-dir', { toolsDir, root });
  if (slot === null) throw new Error('worktrees-dir check line is absent');
  return slot.check;
};
const needWorktrees = async (name) => {
  const mod = await import('./worktrees.mjs');
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const advisorDeps = (home) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home,
});

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-delegated-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const REPO_GITS = new Map();
const HEAD = '1111111111111111111111111111111111111111';

after(() => rmSync(TMP, { recursive: true, force: true }));

const makeGit = (main) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    [`worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  return (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-tree') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const branch = args[3];
      const requested = args[4];
      const canonical = join(realpathSync(dirname(requested)), basename(requested));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  REPO_GITS.set(main, makeGit(main));
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd,
    git: deps.git ?? REPO_GITS.get(cwd),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const provisionOk = (repo, slug, extra = [], deps = {}) => {
  const result = run(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra], { cwd: repo, deps });
  assert.equal(result.code, EXIT.ok, result.errText);
  return join(dirname(repo), `${basename(repo)}--${slug}`);
};

const captureError = (fn) => {
  const caught = [];
  try {
    fn();
  } catch (error) {
    caught.push(error);
  }
  assert.equal(caught.length, 1, 'the operation must throw exactly once');
  return caught[0];
};

describe('delegated finding 1 — a failed copy leaves no untrusted destination', () => {
  it('cleans bytes written by a failing descriptor write and reports a cleanup refusal exactly', () => {
    const source = join(TMP, 'copy-failure-source.txt');
    const worktree = join(TMP, 'copy-failure-worktree');
    const destination = join(worktree, 'f.txt');
    const blockedDestination = join(worktree, 'blocked.txt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'trusted\n');
    const error = captureError(() => copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'f.txt',
      deps: {
        write: (fd, buffer, offset, length, position) => {
          writeSync(fd, buffer, offset, length, position);
          throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
        },
      },
    }));
    const cleanupError = captureError(() => copyTreeIfMissing({
      srcAbs: source,
      dstAbs: blockedDestination,
      wtRoot: worktree,
      rel: 'blocked.txt',
      deps: {
        write: (fd, buffer, offset, length, position) => {
          writeSync(fd, buffer, offset, length, position);
          throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
        },
        unlink: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      },
    }));
    assert.deepEqual(
      {
        removed: { code: error.code, message: error.message, destinationExists: existsSync(destination) },
        refused: {
          code: cleanupError.code,
          message: cleanupError.message,
          destinationExists: existsSync(blockedDestination),
        },
      },
      {
        removed: {
          code: WORKTREES_STOP,
          message: '[agent-workflow-kit] copy failed (EIO) at f.txt — partial destination removed; re-run provision',
          destinationExists: false,
        },
        refused: {
          code: WORKTREES_STOP,
          message: `[agent-workflow-kit] copy failed (EIO) at blocked.txt; cleanup failed (EACCES) — untrusted destination remains; remove it by hand: ${blockedDestination}`,
          destinationExists: true,
        },
      },
    );
  });

  it('refuses the source before destination creation when descriptor identity changed after lstat', () => {
    const source = join(TMP, 'copy-swap-source.txt');
    const worktree = join(TMP, 'copy-swap-worktree');
    const destination = join(worktree, 'f.txt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'trusted\n');
    const error = captureError(() => copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'f.txt',
      deps: {
        fstat: (fd) => {
          const descriptor = fstatSync(fd);
          return { isFile: () => true, dev: descriptor.dev, ino: descriptor.ino + 1 };
        },
      },
    }));
    assert.deepEqual(
      { code: error.code, message: error.message, destinationExists: existsSync(destination) },
      {
        code: WORKTREES_STOP,
        message: '[agent-workflow-kit] copy source changed between lstat and open: f.txt',
        destinationExists: false,
      },
    );
  });

  it('retries partial descriptor writes until every source byte is copied', () => {
    const source = join(TMP, 'copy-partial-source.txt');
    const worktree = join(TMP, 'copy-partial-worktree');
    const destination = join(worktree, 'f.txt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'partial writes stay complete\n');
    const lengths = [];
    copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'f.txt',
      deps: {
        write: (fd, buffer, offset, length, position) => {
          const shortLength = Math.min(3, length);
          lengths.push(shortLength);
          return writeSync(fd, buffer, offset, shortLength, position);
        },
      },
    });
    assert.ok(lengths.length > 1);
    assert.equal(readFileSync(destination, 'utf8'), 'partial writes stay complete\n');
  });

  it('does not unlink a destination raced into place before exclusive open', () => {
    const source = join(TMP, 'copy-raced-destination-source.txt');
    const worktree = join(TMP, 'copy-raced-destination-worktree');
    const destination = join(worktree, 'f.txt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, 'trusted\n');
    const error = captureError(() => copyTreeIfMissing({
      srcAbs: source,
      dstAbs: destination,
      wtRoot: worktree,
      rel: 'f.txt',
      deps: {
        open: (path, flags, mode) => {
          if (path === destination) writeFileSync(destination, 'raced\n');
          return openSync(path, flags, mode);
        },
      },
    }));
    assert.equal(error.code, WORKTREES_STOP);
    assert.match(error.message, /copy destination changed between lstat and open/);
    assert.equal(readFileSync(destination, 'utf8'), 'raced\n');
  });
});

describe('delegated finding 2 — symlink-parent provision resumes by canonical identity', () => {
  it('provisions, fails after add, then resumes the registered canonical worktree', () => {
    const repo = makeRepo('symlink-resume-main');
    const realParent = join(TMP, 'symlink-resume-real');
    const linkedParent = join(TMP, 'symlink-resume-linked');
    const targetLexical = join(linkedParent, 'feature');
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, linkedParent);
    const first = run(['provision', 'linkres', ...PLAN_ARGS, '--as', 'feature-linkres.md', '--dir', targetLexical], {
      cwd: repo,
      deps: { write: () => { throw Object.assign(new Error('injected failure'), { code: 'EIO' }); } },
    });
    const targetReal = realpathSync(targetLexical);
    const resumed = run(['provision', 'linkres', '--resume', ...PLAN_ARGS, '--as', 'feature-linkres.md', '--dir', targetLexical], { cwd: repo });
    assert.deepEqual(
      {
        firstCode: first.code,
        resumeCode: resumed.code,
        resumeError: resumed.errText,
        resumeReport: resumed.out.find((line) => line.startsWith('resuming provision at ')),
      },
      {
        firstCode: EXIT.stop,
        resumeCode: EXIT.ok,
        resumeError: '',
        resumeReport: `resuming provision at ${targetReal} (branch aw/linkres)`,
      },
    );
  });
});

describe('delegated finding 3 — access-positive writability stays unverified', () => {
  it('surfaces the host-specific write lane when provision can still receive EROFS', async (t) => {
    const repo = makeRepo('advisor-unverified-main');
    const probeDir = realpathSync(dirname(repo));
    const provision = run(['provision', 'denied', ...PLAN_ARGS, '--as', 'feature-denied.md'], {
      cwd: repo,
      deps: { mkdirPlain: () => { throw Object.assign(new Error('read-only sandbox'), { code: 'EROFS' }); } },
    });
    assert.equal(
      provision.errText.split('\n')[0],
      `[worktrees] [agent-workflow-kit] the worktrees parent dir is not writable from this session: ${probeDir}`,
    );
    await t.test('offers the harness grant and ack fallback with a home outside the repo parent', (arm) => {
      const home = mkdtempSync(join(tmpdir(), 'aw-wt-advisor-home-'));
      arm.after(() => rmSync(home, { recursive: true, force: true }));
      const { items } = buildRecommendations({ cwd: repo, deps: advisorDeps(home) });
      const item = items.find(({ key }) => key === 'worktrees-dir');
      const check = worktreesCheck(repo);
      assert.deepEqual(
        item && {
          variant: item.variant, lane: item.lane, what: item.what, benefit: item.benefit,
          check: item.check, apply: item.apply, detail: item.detail,
        },
        {
          variant: 'worktrees-dir', lane: 'harness',
          what: `write access to the worktrees parent dir ${probeDir} is not confirmed — provision may still stop`,
          benefit: 'parallel features — the host-specific write allowance or terminal fallback is surfaced before provision',
          check, apply: `${check} --apply --expect <digest>`,
          detail: `ack fallback, only on your word that this host ignores the settings key, instead of the grant: node ${shellQuoteArg(join(toolsDir, 'ack-write.mjs'))} --lane worktrees-dir --fingerprint ${worktreesDirFingerprint(probeDir, home)} --cwd ${shellQuoteArg(repo)}`,
        },
      );
    });
    await t.test('offers the user step when the worktrees parent holds the home', () => {
      const { items } = buildRecommendations({ cwd: repo, deps: advisorDeps(repo) });
      const item = items.find(({ key }) => key === 'worktrees-dir');
      assert.deepEqual(
        item && {
          variant: item.variant, lane: item.lane, what: item.what,
          check: item.check, detail: item.detail, apply: item.apply,
        },
        {
          variant: 'worktrees-dir.home', lane: 'user',
          what: `the worktrees parent dir ${probeDir} is the home or holds it — the kit grants no write surface there`,
          check: null, detail: null,
          apply: 'your own step — point docs/ai/worktrees.json parentDir at a dedicated directory, then run /agent-workflow-kit recommendations',
        },
      );
    });
  });
});

describe('spec:init-project/S41 — the provision stop prints the grant route line', () => {
  for (const configured of [false, true]) {
    it(`prints the ordered grant route and full fallback with the parent ${configured ? 'absent' : 'existing'}`, () => {
      const repo = makeRepo(`grant-stop-${configured ? 'absent' : 'existing'}-main`);
      if (configured) {
        writeFileSync(join(repo, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: join(TMP, 'grant-stop-farm', 'deep') }));
      }
      const probeDir = realpathSync(configured ? TMP : dirname(repo));
      const calls = [];
      const git = REPO_GITS.get(repo);
      const result = run(['provision', 'denied', ...PLAN_ARGS, '--as', 'feature-denied.md'], {
        cwd: repo,
        deps: {
          git: (args) => { calls.push([...args]); return git(args); },
          mkdirPlain: () => { throw Object.assign(new Error('read-only sandbox'), { code: 'EROFS' }); },
        },
      });
      assert.equal(result.code, EXIT.stop, result.errText);
      assert.equal(result.errText.split('\n')[0], `[worktrees] [agent-workflow-kit] the worktrees parent dir is not writable from this session: ${probeDir}`);
      assert.deepEqual(calls.filter(([command, operation]) => command === 'worktree' && operation === 'add'), []);
      const check = worktreesCheck(repo);
      assert.deepEqual(result.errText.split('\n'), [
        `[worktrees] [agent-workflow-kit] the worktrees parent dir is not writable from this session: ${probeDir}`,
        `the kit's worktrees-dir item grants the configured worktrees parent on your yes: the agent runs ${check} and, on your yes on its result, its apply line by the consent route, then runs this command again; when that check refuses, prints nothing to change, or grants a dir that does not hold this command's target, use the terminal fallback below`,
        'Or run the full command yourself in a plain terminal:',
        `  cd ${shellQuoteArg(repo)} && node '${join(toolsDir, 'worktrees.mjs').replace(/'/g, `'\\''`)}' provision denied --plan docs/plans/SEED-PROMPT-x.md --as feature-denied.md`,
        '(from the target repo root, when that checkout carries the kit at agent-workflow-kit/: node agent-workflow-kit/tools/worktrees.mjs provision denied --plan docs/plans/SEED-PROMPT-x.md --as feature-denied.md)',
      ]);
      assert.doesNotMatch(result.errText, /allowWrite \+=|Arm the ONE-TIME consent|HAND-APPLY/);
    });
  }

  it('exports each grant helper once and never calls either from a stop', () => {
    const source = readFileSync(join(toolsDir, 'worktrees.mjs'), 'utf8');
    for (const name of ['worktreesGrantDir', 'worktreesGrantHoldsHome']) {
      assert.equal(source.split(`export const ${name} = (`).length - 1, 1, `${name} export definition`);
      assert.equal([...source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length, 0, `${name} must not be called`);
    }
  });
});

describe('spec:init-project/S42 — one grant-dir derivation', () => {
  for (const configuration of ['absolute', 'relative', 'default']) {
    it(`derives the ${configuration} parent through the real path without walking to an ancestor`, async () => {
      const repo = makeRepo(`grant-dir-${configuration}-main`);
      const realParent = join(TMP, `grant-dir-${configuration}-real`);
      const linkedParent = join(TMP, `grant-dir-${configuration}-linked`);
      if (configuration === 'absolute') {
        mkdirSync(realParent);
        symlinkSync(realParent, linkedParent);
        writeFileSync(join(repo, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: linkedParent }));
      }
      if (configuration === 'relative') {
        writeFileSync(join(repo, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: '../rel-farm' }));
      }
      const expected = configuration === 'absolute' ? realpathSync(realParent)
        : configuration === 'relative' ? resolve(realpathSync(repo), '../rel-farm') : dirname(realpathSync(repo));
      const grantDir = await needWorktrees('worktreesGrantDir');
      assert.equal(grantDir(repo), expected);
    });
  }

  it('keeps an absent configured parent while the advisor probes its nearest existing ancestor', async () => {
    const repo = makeRepo('grant-dir-absent-main');
    const parentDir = join(TMP, 'x-farm', 'deep');
    writeFileSync(join(repo, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir }));
    const probes = [];
    buildRecommendations({
      cwd: repo,
      deps: { ...advisorDeps(repo), canWriteDir: (dir) => { probes.push(dir); return true; } },
    });
    assert.deepEqual(probes, [realpathSync(TMP)]);
    assert.equal(existsSync(parentDir), false);
    const grantDir = await needWorktrees('worktreesGrantDir');
    assert.equal(grantDir(repo), join(realpathSync(TMP), 'x-farm', 'deep'));
  });

  it('derives the same parent from a symlinked project dir and its real root', async () => {
    const repo = makeRepo('grant-dir-linked-main');
    const linkDir = join(TMP, 'grant-dir-project-links');
    mkdirSync(linkDir);
    const link = join(linkDir, 'project');
    symlinkSync(repo, link);
    writeFileSync(join(repo, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: '../linked-project-farm' }));
    const grantDir = await needWorktrees('worktreesGrantDir');
    assert.equal(grantDir(repo), resolve(realpathSync(repo), '../linked-project-farm'));
    assert.equal(grantDir(link), grantDir(repo));
  });

  for (const refusal of ['malformed JSON', 'not a regular file', 'not a plain directory', 'parentDir']) {
    it(`refuses ${refusal} in the grant derivation`, async () => {
      const repo = makeRepo(`grant-dir-refused-${refusal.replaceAll(' ', '-')}`);
      const config = join(repo, 'docs/ai/worktrees.json');
      const parentFile = join(TMP, 'grant-dir-parent-file');
      if (refusal === 'malformed JSON') writeFileSync(config, '{ nope');
      if (refusal === 'not a regular file') mkdirSync(config);
      if (refusal === 'not a plain directory') {
        const realAi = join(TMP, 'grant-dir-real-ai');
        mkdirSync(realAi);
        rmSync(join(repo, 'docs/ai'), { recursive: true });
        symlinkSync(realAi, join(repo, 'docs/ai'));
      }
      if (refusal === 'parentDir') {
        writeFileSync(parentFile, 'a file\n');
        writeFileSync(config, JSON.stringify({ parentDir: parentFile }));
      }
      const grantDir = await needWorktrees('worktreesGrantDir');
      if (refusal === 'parentDir') {
        assert.throws(() => grantDir(repo), {
          code: WORKTREES_STOP,
          message: `[agent-workflow-kit] docs/ai/worktrees.json: parentDir names an existing non-directory: ${parentFile}`,
        });
      } else {
        assert.throws(() => grantDir(repo), new RegExp(refusal));
      }
    });
  }

  it('holds the home itself and its ancestors but never a directory under it', async () => {
    const home = join(TMP, 'grant-home');
    mkdirSync(home);
    const holdsHome = await needWorktrees('worktreesGrantHoldsHome');
    assert.equal(holdsHome(home, home), true);
    assert.equal(holdsHome(dirname(home), home), true);
    assert.equal(holdsHome(join(home, 'under'), home), false);
  });

  it('holds the real directory targeted by a symlinked home', async () => {
    const realHome = join(TMP, 'grant-real-home');
    const link = join(TMP, 'grant-linked-home');
    mkdirSync(realHome);
    symlinkSync(realHome, link);
    const holdsHome = await needWorktrees('worktreesGrantHoldsHome');
    assert.equal(holdsHome(realpathSync(realHome), link), true);
  });

  for (const file of ['velocity-profile.mjs', 'apply-danger-check.mjs', 'recommendations.mjs']) {
    it(`${file} imports the grant derivation without spelling it again`, () => {
      const source = readFileSync(join(toolsDir, file), 'utf8');
      const imports = [...source.matchAll(/^\s*import\s*\{([^}]+)\}\s*from\s*['"]\.\/worktrees\.mjs['"]/gm)];
      assert.ok(imports.some(([, bindings]) => /\bworktreesGrantDir\b/.test(bindings)), `${file} must import worktreesGrantDir from ./worktrees.mjs`);
      assert.doesNotMatch(source, /\.parentDir|\bloadWorktreesConfig\b|\bresolveProbeDir\b/);
    });
  }
});

describe('delegated finding 4 — unsafe main .vscode/settings.json is never synthesized', () => {
  it('skips a symlinked settings file with the exact report and no destination', () => {
    const repo = makeRepo('vscode-symlink-main');
    mkdirSync(join(repo, '.vscode'), { recursive: true });
    writeFileSync(join(repo, '.vscode/base.json'), '{"editor.tabSize":2}\n');
    symlinkSync('base.json', join(repo, '.vscode/settings.json'));
    const result = run(['provision', 'vssym', ...PLAN_ARGS, '--as', 'feature-vssym.md'], { cwd: repo });
    const worktree = join(dirname(repo), `${basename(repo)}--vssym`);
    assert.deepEqual(
      {
        code: result.code,
        destinationExists: existsSync(join(worktree, '.vscode/settings.json')),
        report: result.out.find((line) => line.startsWith('  .vscode: main\'s')),
      },
      {
        code: EXIT.ok,
        destinationExists: false,
        report: "  .vscode: main's .vscode/settings.json is not a regular file — skipped",
      },
    );
  });

  it('skips a non-regular settings entry with the same exact report and no destination', () => {
    const repo = makeRepo('vscode-directory-main');
    mkdirSync(join(repo, '.vscode/settings.json'), { recursive: true });
    const worktree = provisionOk(repo, 'vsdir');
    const settingsReport = run(['provision', 'vsdir', '--resume', ...PLAN_ARGS, '--as', 'feature-vsdir.md'], { cwd: repo });
    assert.deepEqual(
      {
        destinationExists: existsSync(join(worktree, '.vscode/settings.json')),
        report: settingsReport.out.find((line) => line.startsWith('  .vscode: main\'s')),
      },
      {
        destinationExists: false,
        report: "  .vscode: main's .vscode/settings.json is not a regular file — skipped",
      },
    );
  });
});
