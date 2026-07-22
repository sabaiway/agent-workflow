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
  it('surfaces the host-specific write lane when provision can still receive EROFS', () => {
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
    const { items } = buildRecommendations({
      cwd: repo,
      deps: {
        findWrapper: () => false,
        env: { PATH: '/nonexistent-path-for-tests' },
        getenv: { PATH: '/nonexistent-path-for-tests' },
        home: repo,
      },
    });
    const item = items.find(({ key }) => key === 'worktrees-dir');
    assert.deepEqual(
      item && { what: item.what, benefit: item.benefit, detail: item.detail },
      {
        what: `write access to the worktrees parent dir ${probeDir} is not confirmed — provision may still stop`,
        benefit: 'parallel features — the host-specific write allowance or terminal fallback is surfaced before provision',
        detail: `HAND-APPLY FIRST: add ${JSON.stringify(probeDir)} to sandbox.filesystem.allowWrite in .claude/settings.json on settings-native hosts; on harness-managed hosts grant this dir for the session or use the provision terminal fallback; THEN this item's apply one-liner previews the dir-bound ack and prints the exact --apply that records it`,
      },
    );
    assert.match(item.apply, /--lane worktrees-dir/, 'the apply slot is the consent-gated dir-bound ack preview');
  });
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
