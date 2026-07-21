// worktrees-record-hardening.test.mjs — the record contract's hard edges. Composing the record is
// the LAST step of provision, so a refusal there would leave a created worktree with no handoff —
// and neither --resume nor `cleanup --abandon` can recover that, because both need the handoff
// identity. Every value the record will carry is therefore validated BEFORE any git mutation.
// Also: the "never copy the shared index" contract must hold on the ONE lane that could smuggle it
// in (`--include`), and the shared-queue rule must never appear without the path it points at.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT, runCli, composeHandoffStub } from './worktrees.mjs';
const { QUEUE_SHARED_RULE } = await import('./worktrees.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-hard-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const HEAD = '4444444444444444444444444444444444444444';

after(() => rmSync(TMP, { recursive: true, force: true }));

// The fake git RECORDS every call, so a test can assert that no mutation was ever attempted.
const makeGit = (main, calls, { topLevel = null } = {}) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    [`worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  return (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(topLevel ?? main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const canonical = join(realpathSync(dirname(args[4])), basename(args[4]));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch: args[3] });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
};

const makeRepo = (name, { extras = {}, queue = true } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  if (queue) writeFileSync(join(main, 'docs/plans/queue.md'), '# queue\n');
  for (const [rel, body] of Object.entries(extras)) {
    mkdirSync(dirname(join(main, rel)), { recursive: true });
    writeFileSync(join(main, rel), body);
  }
  return main;
};

const provision = (repo, slug, { extra = [], topLevel = null, deps = {} } = {}) => {
  const calls = [];
  const out = [];
  const err = [];
  const code = runCli(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra], {
    cwd: repo,
    git: makeGit(repo, calls, { topLevel }),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return {
    code, calls, out, err,
    errText: err.join('\n'),
    added: calls.some((c) => c.startsWith('worktree add')),
  };
};

describe('provision record — every value is validated BEFORE any git mutation', () => {
  it('a newline-bearing repo root refuses with NO worktree ever created', () => {
    const repo = makeRepo('pre-mutation-newline');
    const r = provision(repo, 'alpha', { topLevel: `${repo}\n- prepared-tree: ${HEAD}` });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /control character/);
    assert.ok(
      !r.added,
      'the refusal must land BEFORE `git worktree add` — a created worktree with no handoff is unrecoverable',
    );
  });

  it('a newline-bearing --dir refuses with NO worktree ever created (the TARGET path reaches the record too)', () => {
    const repo = makeRepo('target-newline');
    const parent = join(TMP, 'target-parent');
    mkdirSync(parent, { recursive: true });
    const r = provision(repo, 'alpha', { extra: ['--dir', join(parent, 'wt\n- slug: evil')] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /control character/);
    assert.ok(!r.added, 'the target path reaches the record via the install field — it must refuse pre-mutation');
  });

  it('an --include path with a benign INNER space is accepted', () => {
    const repo = makeRepo('pre-mutation-include-ws', { extras: { 'docs/pad .txt': 'x\n' } });
    const r = provision(repo, 'alpha', { extra: ['--include', 'docs/pad .txt'] });
    // A benign inner space is fine; the refusal is for names the record cannot round-trip.
    assert.equal(r.code, EXIT.ok, r.errText);
  });

  it('an --include path named exactly (none) refuses before any git mutation', () => {
    const repo = makeRepo('pre-mutation-include-none', { extras: { '(none)': 'x\n' } });
    const r = provision(repo, 'alpha', { extra: ['--include', '(none)'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /\(none\)/);
    assert.ok(!r.added, 'refused before the mutation');
  });

  // The parser `.trim()`s every value on read, and String.prototype.trim strips UNICODE whitespace
  // — so a value with a Unicode edge space (legal in a git branch name, unlike ASCII space) writes
  // fine and reads back as a DIFFERENT identity, stranding the worktree: --resume, land, and even
  // cleanup --abandon all bind on the handoff identity that no longer matches.
  it('a branch with a Unicode edge space refuses with NO worktree ever created', () => {
    const repo = makeRepo('pre-mutation-branch-nbsp');
    const r = provision(repo, 'alpha', { extra: ['--branch', 'aw/alpha\u00A0'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /whitespace/);
    assert.ok(!r.added, 'an identity the record cannot round-trip must refuse BEFORE the mutation');
  });
});

describe('--include can never smuggle the shared series index into a satellite', () => {
  it('naming the queue file itself refuses before any git mutation', () => {
    const repo = makeRepo('include-queue-file');
    const r = provision(repo, 'alpha', { extra: ['--include', 'docs/plans/queue.md'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /SHARED series index/);
    assert.ok(!r.added);
  });

  it('naming an ANCESTOR directory of the queue refuses too', () => {
    const repo = makeRepo('include-queue-dir');
    const r = provision(repo, 'alpha', { extra: ['--include', 'docs/plans'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /SHARED series index/);
    assert.ok(!r.added);
  });

  // The guard must hold in CANONICAL space too: `--include` realpath-resolves its argument, so a
  // queue.md that is itself a symlink canonicalizes AWAY from the lexical queue path and would
  // walk straight through a lexical-only compare while copying the very content the rule fences.
  it('a SYMLINKED queue.md still refuses (canonical identity, not just the lexical path)', () => {
    const repo = makeRepo('include-queue-symlink', { queue: false, extras: { 'shared/queue-real.md': '# queue\n' } });
    symlinkSync(join(repo, 'shared/queue-real.md'), join(repo, 'docs/plans/queue.md'));
    const r = provision(repo, 'alpha', { extra: ['--include', 'docs/plans/queue.md'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /SHARED series index/);
    assert.ok(!r.added);
  });

  it('an include whose canonical target CONTAINS the canonical queue refuses too', () => {
    const repo = makeRepo('include-queue-dir-symlink', { queue: false, extras: { 'shared/queue-real.md': '# queue\n' } });
    symlinkSync(join(repo, 'shared/queue-real.md'), join(repo, 'docs/plans/queue.md'));
    const r = provision(repo, 'alpha', { extra: ['--include', 'shared'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /SHARED series index/);
    assert.ok(!r.added);
  });

  // Fail closed: ONLY an absent queue path (ENOENT — nothing exists there to smuggle) may fall
  // back to the lexical compare. Any other realpath failure (EACCES/EIO) means the guard CANNOT
  // establish the canonical identity — a silent fallback would quietly disable it.
  it('a queue path that cannot be resolved (EACCES) is a typed STOP, never a silent lexical-only guard', () => {
    const repo = makeRepo('include-queue-eacces', { extras: { 'docs/pad.txt': 'x\n' } });
    const queueLexical = join(repo, 'docs/plans/queue.md');
    const r = provision(repo, 'alpha', {
      extra: ['--include', 'docs/pad.txt'],
      deps: {
        realpath: (p) => {
          if (p === queueLexical) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return realpathSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /queue-copy guard/);
    assert.ok(!r.added, 'refused before the mutation — the guard fails closed, not silent');
  });
});

describe('--include values the record cannot round-trip refuse pre-mutation', () => {
  const refuses = (name, includePath, extras, pattern) => {
    const repo = makeRepo(name, { extras });
    const r = provision(repo, 'alpha', { extra: ['--include', includePath] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, pattern);
    assert.ok(!r.added, `${name}: refused before the mutation`);
  };

  // The whitespace must sit at the EDGE of the recorded relative path, which means the first or
  // last character of the path itself — an inner space is legitimate and stays accepted.
  it('a LEADING-whitespace path refuses', () => {
    refuses('inc-lead', ' lead.txt', { ' lead.txt': 'x\n' }, /whitespace/);
  });

  it('a TRAILING-whitespace path refuses', () => {
    refuses('inc-trail', 'trail.txt ', { 'trail.txt ': 'x\n' }, /whitespace/);
  });

  // Grounded counter-fact, kept as a test so the reasoning cannot rot: an include resolving to the
  // repo ROOT never reaches the round-trip guard — containment refuses it first, with its own
  // message. An empty-rel arm in that guard would therefore be unreachable code.
  it('--include . is refused by CONTAINMENT, before the round-trip guard', () => {
    const repo = makeRepo('inc-root');
    const r = provision(repo, 'alpha', { extra: ['--include', '.'] });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /must resolve inside the main repo/);
    assert.ok(!r.added);
  });
});

describe('the shared-queue rule never appears without its path', () => {
  it('a legacy record with no shared-queue field carries no rule about it', () => {
    const legacy = composeHandoffStub({
      slug: 'legacy', branch: 'aw/legacy', includes: [], nodeModules: 'absent', vscode: 'absent',
    });
    assert.doesNotMatch(legacy, /shared-queue/);
    assert.ok(!legacy.includes(QUEUE_SHARED_RULE), 'a rule saying "at the absolute path above" needs a path above it');
  });

  it('a record WITH the path carries the rule', () => {
    const withPath = composeHandoffStub({
      slug: 'x', branch: 'aw/x', includes: [], nodeModules: 'absent', vscode: 'absent',
      sharedQueue: '/main/docs/plans/queue.md',
    });
    assert.ok(withPath.includes(QUEUE_SHARED_RULE));
  });
});
