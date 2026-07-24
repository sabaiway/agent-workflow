// worktrees-resume-verify-r1.test.mjs — slice R1 of the resume-verify design: the record
// attests only a VERIFIED provision (refresh LAST, after the in-flight check and the verify,
// in both lanes), and a TRACKED plans-chain path — the handoff or the seeded plan — refuses
// fail-closed in both lanes (its drift is undeliverable; tolerating it manufactures a dead
// end). Tolerance is unchanged this slice: the blanket clean-tree resume verify stays.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// Dynamic import so this spec LOADS against the pre-fix tree (the red-first doctrine).
const { EXIT, runCli, handoffBasename } = await import('./worktrees.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREES_MODE_DOC = join(HERE, '..', 'references', 'modes', 'worktrees.md');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-rv-r1-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── real-git harness (the posture-integration pattern) ─────────────────────────────────

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];

const makeRepo = (name, { pkg = { name: 'r', version: '1.0.0' }, excludes = EXCLUDES, trackDocsAi = false, gitignore = null } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify(pkg));
  if (gitignore !== null) writeFileSync(join(main, '.gitignore'), gitignore);
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  if (trackDocsAi) sh(['add', '-A'], main);
  else sh(['add', 'README.md', 'package.json', ...(gitignore !== null ? ['.gitignore'] : [])], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), excludes.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  return main;
};

const run = (argv, cwd) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, errText: err.join('\n') };
};

const provisionArgs = (slug, extra = [], asName = null) =>
  ['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', asName ?? `feature-${slug}.md`, ...extra];

const wtPath = (repo, slug) => join(dirname(repo), `${basename(repo)}--${slug}`);
const handoffPath = (repo, slug) => join(wtPath(repo, slug), 'docs/plans', handoffBasename(slug));
const readHandoff = (repo, slug) => readFileSync(handoffPath(repo, slug), 'utf8');

// A post-checkout hook (git runs it at `worktree add`, chdir'ed into the new worktree).
const installHook = (main, script) => {
  const hooks = join(main, '.git/hooks');
  mkdirSync(hooks, { recursive: true });
  const p = join(hooks, 'post-checkout');
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
};

// ── ordering-flip tests (real git) ─────────────────────────────────────────────────────

describe('the record attests only a verified provision (real git)', () => {
  it('failed-first-provision-verify-leaves-stub-record', () => {
    const repo = makeRepo('r1-fresh-dirt');
    const hook = installHook(repo, 'echo dirt > "$PWD/hook-dirt.txt"');
    const first = run(provisionArgs('freshdirt'), repo);
    assert.equal(first.code, EXIT.stop, 'hook dirt refuses the fresh provision at the verify');
    assert.match(first.errText, /post-provision verify failed/);
    assert.match(readHandoff(repo, 'freshdirt'), /- node_modules: pending/,
      'the record is still the STUB — the refresh never ran on a failed verify');
    rmSync(hook);
  });

  it('resume-after-failed-first-provision-binds-identity-from-stub', () => {
    const repo = makeRepo('r1-stub-binds');
    const hook = installHook(repo, 'echo dirt > "$PWD/hook-dirt.txt"');
    const first = run(provisionArgs('stubbind'), repo);
    assert.equal(first.code, EXIT.stop, first.errText);
    rmSync(hook);
    rmSync(join(wtPath(repo, 'stubbind'), 'hook-dirt.txt'));
    const resumed = run(provisionArgs('stubbind', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.doesNotMatch(readHandoff(repo, 'stubbind'), /- node_modules: pending/,
      'the completing resume refreshed the record');
  });

  // `failed-resume-verify-leaves-prior-record-bytes` lived here on a DIRTY-MANIFEST fixture, which
  // slice R2 legalized (the tolerance flip). The contract itself survives on the lanes that still
  // STOP and is pinned in worktrees-resume-verify-r2.test.mjs under the same name — this file
  // keeps the FRESH-lane record contracts only.

  it('successful-provision-record-bytes-unchanged', () => {
    const repo = makeRepo('r1-clean-resume');
    const first = run(provisionArgs('cleanres'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const before = readHandoff(repo, 'cleanres');
    const resumed = run(provisionArgs('cleanres', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.equal(readHandoff(repo, 'cleanres'), before, 'an unchanged satellite round-trips the record byte-exact');
  });

  it('in-flight-plan-stop-preserves-the-record-in-both-lanes', () => {
    // FRESH: a hook seeds a SECOND bare plan — the in-flight check fires BEFORE the refresh.
    const repo = makeRepo('r1-inflight');
    const hook = installHook(repo, 'mkdir -p "$PWD/docs/plans"\necho extra > "$PWD/docs/plans/other-plan.md"');
    const first = run(provisionArgs('inflight'), repo);
    assert.equal(first.code, EXIT.stop);
    assert.match(first.errText, /EXACTLY ONE in-flight plan/);
    assert.match(readHandoff(repo, 'inflight'), /- node_modules: pending/,
      'fresh lane: the stub survives the in-flight STOP');
    rmSync(hook);
    // RESUME: the pre-checks refuse before any write — the prior record stays byte-exact.
    const repo2 = makeRepo('r1-inflight-res');
    const ok = run(provisionArgs('inflightres'), repo2);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const before = readHandoff(repo2, 'inflightres');
    writeFileSync(join(wtPath(repo2, 'inflightres'), 'docs/plans/other-plan.md'), 'extra\n');
    const resumed = run(provisionArgs('inflightres', ['--resume']), repo2);
    assert.equal(resumed.code, EXIT.stop);
    assert.equal(readHandoff(repo2, 'inflightres'), before, 'resume lane: the prior record stays byte-exact');
  });
});

// ── D10: tracked plans-chain refusals (real git) ───────────────────────────────────────

const forceTrack = (cwd, rel, body = 'poisoned\n', { commit = false } = {}) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), body);
  sh(['add', '-f', '--', rel], cwd);
  if (commit) sh(['commit', '-q', '-m', `track ${rel}`], cwd);
};

// The fresh-lane poisoned-base state: the path is tracked in HEAD while MAIN's index is clean
// — the shipped docs/plans entry gate reads the dir as ignored again (live-probed: check-ignore
// consults the index), so the CAPTURED-COMMIT tree probe is the only door that can refuse.
const poisonHeadOnly = (cwd, rel, { tree = false } = {}) => {
  sh(['rm', '--cached', '-q', ...(tree ? ['-r'] : []), '--', rel], cwd);
};

describe('D10 — a tracked plans-chain path refuses fail-closed (real git)', () => {
  it('fresh-provision-refuses-head-tracked-handoff-pre-mutation', () => {
    const repo = makeRepo('r1-fresh-handoff');
    forceTrack(repo, `docs/plans/${handoffBasename('fhand')}`, 'x\n', { commit: true });
    poisonHeadOnly(repo, `docs/plans/${handoffBasename('fhand')}`);
    const r = run(provisionArgs('fhand'), repo);
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /tracked in the captured commit/i);
    assert.ok(!existsSync(wtPath(repo, 'fhand')), 'no worktree was created — the refusal is pre-mutation');
    // The reachable poisoned state has the removal ALREADY STAGED at main — the advice must
    // match it (a printed `rm --cached` would fail «pathspec did not match»), and executing
    // it must converge to a successful provision.
    assert.match(r.errText, /already staged/i, 'the advice matches the reachable state');
    sh(['commit', '-q', '-m', 'untrack the plans-chain path'], repo);
    const again = run(provisionArgs('fhand'), repo);
    assert.equal(again.code, EXIT.ok, `the advice converges: ${again.errText}`);
  });

  it('fresh-provision-refuses-head-tracked-seed-plan', () => {
    const repo = makeRepo('r1-fresh-seed');
    forceTrack(repo, 'docs/plans/feature-fseed.md', 'x\n', { commit: true });
    poisonHeadOnly(repo, 'docs/plans/feature-fseed.md');
    const r = run(provisionArgs('fseed'), repo);
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /tracked in the captured commit/i);
    assert.ok(!existsSync(wtPath(repo, 'fseed')), 'no worktree was created');
  });

  for (const [label, slug, relOf] of [
    ['handoff', 'reshand', (s) => `docs/plans/${handoffBasename(s)}`],
    ['seed plan', 'resseed', (s) => `docs/plans/feature-${s}.md`],
  ]) {
    it(`resume refuses a branch-HEAD-tracked ${label}: salvage first, then consented abandon`, () => {
      const repo = makeRepo(`r1-res-${slug}`);
      const ok = run(provisionArgs(slug), repo);
      assert.equal(ok.code, EXIT.ok, ok.errText);
      const wt = wtPath(repo, slug);
      const rel = relOf(slug);
      sh(['add', '-f', '--', rel], wt);
      sh(['commit', '-q', '-m', 'poison'], wt);
      const before = readHandoff(repo, slug);
      const resumed = run(provisionArgs(slug, ['--resume']), repo);
      assert.equal(resumed.code, EXIT.stop);
      assert.match(resumed.errText, /tracked in this worktree's branch HEAD/i);
      const salvageAt = resumed.errText.search(/salvage/i);
      const abandonAt = resumed.errText.indexOf('--abandon');
      assert.ok(salvageAt !== -1 && abandonAt !== -1 && salvageAt < abandonAt,
        `salvage comes FIRST, consented abandon after: ${resumed.errText}`);
      assert.doesNotMatch(resumed.errText, /--prepare/, 'recovery never routes through the delivery lane');
      assert.equal(readHandoff(repo, slug), before, 'the prior record bytes are untouched');
    });
  }

  it('head-tracked-handoff-stops-even-after-index-removal', () => {
    const repo = makeRepo('r1-bypass');
    const ok = run(provisionArgs('bypass'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'bypass');
    const rel = `docs/plans/${handoffBasename('bypass')}`;
    sh(['add', '-f', '--', rel], wt);
    sh(['commit', '-q', '-m', 'poison'], wt);
    sh(['rm', '--cached', '-q', '--', rel], wt);
    const resumed = run(provisionArgs('bypass', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop, 'an index-side removal of a HEAD-tracked path must not slip past the STOP');
    assert.match(resumed.errText, /tracked in this worktree's branch HEAD/i);
  });

  it('head-tracked-handoff-with-malformed-record-names-shipped-recovery', () => {
    const repo = makeRepo('r1-malformed');
    const ok = run(provisionArgs('malform'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'malform');
    const rel = `docs/plans/${handoffBasename('malform')}`;
    writeFileSync(join(wt, rel), '# Handoff — malform\n\nno record section\n');
    sh(['add', '-f', '--', rel], wt);
    sh(['commit', '-q', '-m', 'poison malformed'], wt);
    const resumed = run(provisionArgs('malform', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /tracked in this worktree's branch HEAD/i);
    assert.doesNotMatch(resumed.errText, /--abandon/, 'abandon is never promised where identity cannot bind');
    assert.match(resumed.errText, /does not bind: /, 'the identity diagnosis is INLINE — a re-run advice would loop (D10 fires before the identity STOP)');
    assert.doesNotMatch(resumed.errText, /re-run --resume and follow/, 'no looping re-run advice');
  });

  for (const [label, slug, relOf] of [
    ['handoff', 'idxhand', (s) => `docs/plans/${handoffBasename(s)}`],
    ['seed plan', 'idxseed', (s) => `docs/plans/feature-${s}.md`],
  ]) {
    it(`index-only tracked ${label}: surgical recovery converges`, () => {
      const repo = makeRepo(`r1-idx-${slug}`);
      const ok = run(provisionArgs(slug), repo);
      assert.equal(ok.code, EXIT.ok, ok.errText);
      const wt = wtPath(repo, slug);
      const rel = relOf(slug);
      sh(['add', '-f', '--', rel], wt);
      const before = readHandoff(repo, slug);
      const resumed = run(provisionArgs(slug, ['--resume']), repo);
      assert.equal(resumed.code, EXIT.stop);
      assert.match(resumed.errText, /staged in this worktree's index/i);
      assert.match(resumed.errText, /rm --cached/, 'the surgical index removal is named');
      assert.match(resumed.errText, /:\(literal\)/, 'the recovery command is pathspec-LITERAL');
      assert.doesNotMatch(resumed.errText, /restore the git-ignore rule/,
        'the ignore arm stays silent while the rule stands (the rule probe is index-independent)');
      assert.equal(readHandoff(repo, slug), before, 'prior record bytes intact');
      sh(['rm', '--cached', '-q', '--', rel], wt);
      const again = run(provisionArgs(slug, ['--resume']), repo);
      assert.equal(again.code, EXIT.ok, `the advice converges: ${again.errText}`);
    });
  }

  it('index-and-ignore-combined-handoff-recovery-converges', () => {
    // The de-ignore is the SESSION's own uncommitted .gitignore edit in the satellite: MAIN's
    // checkout keeps the rule (the entry gate passes), the worktree's live rules lost it.
    const RULE = '/docs/plans/\n';
    const repo = makeRepo('r1-comb', {
      excludes: EXCLUDES.filter((l) => l !== '/docs/plans/'),
      gitignore: RULE,
    });
    const ok = run(provisionArgs('comb'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'comb');
    const rel = `docs/plans/${handoffBasename('comb')}`;
    writeFileSync(join(wt, '.gitignore'), '# rule dropped by the session\n');
    sh(['add', '-f', '--', rel], wt);
    const resumed = run(provisionArgs('comb', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /rm --cached/);
    assert.match(resumed.errText, /restore the git-ignore rule/i, 'the lost ignore rule is named alongside the index removal');
    sh(['rm', '--cached', '-q', '--', rel], wt);
    writeFileSync(join(wt, '.gitignore'), RULE);
    const again = run(provisionArgs('comb', ['--resume']), repo);
    assert.equal(again.code, EXIT.ok, `both operations converge: ${again.errText}`);
  });

  it('magic-shaped-seed-plan-probes-literally', () => {
    // The adversarial D11 arm: `--as` admits pathspec-magic bytes; every probe and the
    // surgical recovery treat the name as BYTES.
    const slug = 'magic';
    const asName = 'feature-r1-[a].md';
    const repo = makeRepo('r1-magic');
    const ok = run(provisionArgs(slug, [], asName), repo);
    assert.equal(ok.code, EXIT.ok, `a magic-shaped seed name provisions cleanly: ${ok.errText}`);
    const wt = wtPath(repo, slug);
    const rel = `docs/plans/${asName}`;
    const decoyRel = 'docs/plans/feature-r1-a.md';
    writeFileSync(join(wt, decoyRel), 'decoy\n');
    sh(['add', '-f', '--', rel], wt);
    sh(['add', '-f', '--', decoyRel], wt);
    const resumed = run(provisionArgs(slug, ['--resume'], asName), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes(rel), 'the STOP names the exact magic-shaped path');
    // Execute the printed literal removal for the OFFENDING path only.
    const rm = spawnSync('git', ['rm', '--cached', '-q', '--', `:(literal)${rel}`], { cwd: wt, encoding: 'utf8' });
    assert.equal(rm.status, 0, rm.stderr);
    const staged = sh(['ls-files', '--cached', '--', 'docs/plans'], wt);
    assert.ok(!staged.includes(asName), 'the offending magic-shaped entry is gone');
    assert.ok(staged.includes('feature-r1-a.md'), 'the pattern-matching decoy is UNTOUCHED — the removal was literal');
    sh(['rm', '--cached', '-q', '--', `:(literal)${decoyRel}`], wt);
    rmSync(join(wt, decoyRel));
    const again = run(provisionArgs(slug, ['--resume'], asName), repo);
    assert.equal(again.code, EXIT.ok, again.errText);
  });

  for (const variant of ['force-add', 'commit']) {
    for (const [label, relOf] of [
      ['handoff', () => `docs/plans/${handoffBasename('hook')}`],
      ['seed plan', () => 'docs/plans/feature-hook.md'],
    ]) {
      it(`post-add hook ${variant} of the ${label} refuses before any provision write, and the recovery converges`, () => {
        const repo = makeRepo(`r1-hook-${variant}-${label.replace(' ', '')}`);
        const rel = relOf();
        const script = [
          'mkdir -p "$PWD/docs/plans"',
          `echo hookmade > "$PWD/${rel}"`,
          `git add -f -- "${rel}"`,
          ...(variant === 'commit' ? ['git -c user.email=h@h -c user.name=h commit -q -m hook'] : []),
        ].join('\n');
        const hook = installHook(repo, script);
        const r = run(provisionArgs('hook', [], 'feature-hook.md'), repo);
        assert.equal(r.code, EXIT.stop);
        assert.match(r.errText, /worktree remove --force/, 'the hand recovery names the plain-git removal');
        assert.match(r.errText, /branch -D/, 'and the branch deletion');
        assert.match(r.errText, /inspect|salvage|copy/i, 'inspect/salvage comes first');
        assert.doesNotMatch(r.errText, /--abandon/, 'cleanup --abandon is never named (no handoff identity exists yet)');
        assert.doesNotMatch(r.errText, /finish with:/, 'the generic kept-worktree NOTE is suppressed — its --resume advice would contradict the hand recovery');
        const wt = wtPath(repo, 'hook');
        assert.equal(readFileSync(join(wt, rel), 'utf8'), 'hookmade\n', 'no provision write touched the hook file');
        // Execute the recovery end-to-end.
        rmSync(hook);
        sh(['worktree', 'remove', '--force', wt], repo);
        sh(['branch', '-D', 'aw/hook'], repo);
        const again = run(provisionArgs('hook', [], 'feature-hook.md'), repo);
        assert.equal(again.code, EXIT.ok, `re-provision after the recovery succeeds: ${again.errText}`);
      });
    }
  }

  it('post-add hook staging an irregular entry fails closed without recovery commands', () => {
    const repo = makeRepo('r1-hook-irregular');
    const rel = `docs/plans/${handoffBasename('hook2')}`;
    const script = [
      'mkdir -p "$PWD/docs/plans"',
      'echo target > "$PWD/blobsrc.txt"',
      'oid=$(git hash-object -w -- blobsrc.txt)',
      'rm "$PWD/blobsrc.txt"',
      `git update-index --add --cacheinfo "120000,$oid,${rel}"`,
    ].join('\n');
    const hook = installHook(repo, script);
    const r = run(provisionArgs('hook2', [], 'feature-hook2.md'), repo);
    assert.equal(r.code, EXIT.stop);
    assert.doesNotMatch(r.errText, /worktree remove --force|branch -D|rm --cached|--abandon|finish with:/,
      'an irregular post-add entry carries NO recovery command, and the NOTE is suppressed');
    rmSync(hook);
  });

  it('an irregular index mode over a HEAD-regular path fails closed in both lanes', () => {
    // RESUME: the handoff is a regular blob in HEAD, but the index stages a symlink mode at
    // the SAME path — the kind must come from BOTH sources, else last-wins hides the
    // irregular stage and destructive advice covers irregular content.
    const repo = makeRepo('r1-dualkind');
    const ok = run(provisionArgs('dual'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'dual');
    const rel = `docs/plans/${handoffBasename('dual')}`;
    sh(['add', '-f', '--', rel], wt);
    sh(['commit', '-q', '-m', 'regular in HEAD'], wt);
    writeFileSync(join(wt, 'blobsrc.txt'), 'target\n');
    const oid = sh(['hash-object', '-w', '--', 'blobsrc.txt'], wt).trim();
    rmSync(join(wt, 'blobsrc.txt'));
    sh(['update-index', '--cacheinfo', `120000,${oid},${rel}`], wt);
    const resumed = run(provisionArgs('dual', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.doesNotMatch(resumed.errText, /--abandon|rm --cached|worktree remove/,
      'an irregular mode in EITHER source withholds every recovery command');
    // POST-ADD: a hook commits a regular file then stages a symlink mode over it.
    const repo2 = makeRepo('r1-dualkind-fresh');
    const rel2 = `docs/plans/${handoffBasename('dual2')}`;
    const script = [
      'mkdir -p "$PWD/docs/plans"',
      `echo hookmade > "$PWD/${rel2}"`,
      `git add -f -- "${rel2}"`,
      'git -c user.email=h@h -c user.name=h commit -q -m hook',
      'echo target > "$PWD/blobsrc.txt"',
      'oid=$(git hash-object -w -- blobsrc.txt)',
      'rm "$PWD/blobsrc.txt"',
      `git update-index --cacheinfo "120000,$oid,${rel2}"`,
    ].join('\n');
    const hook = installHook(repo2, script);
    const r2 = run(provisionArgs('dual2', [], 'feature-dual2.md'), repo2);
    assert.equal(r2.code, EXIT.stop);
    assert.doesNotMatch(r2.errText, /worktree remove --force|branch -D|rm --cached/,
      'the post-add STOP also fails closed when any source mode is irregular');
    rmSync(hook);
  });

  it('an unmerged plans-chain index entry fails closed on resume', () => {
    const repo = makeRepo('r1-unmerged');
    const ok = run(provisionArgs('unm'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'unm');
    const rel = 'docs/plans/feature-unm.md';
    writeFileSync(join(wt, 'blobsrc.txt'), 'target\n');
    const oid = sh(['hash-object', '-w', '--', 'blobsrc.txt'], wt).trim();
    rmSync(join(wt, 'blobsrc.txt'));
    const indexInfo = `100644 ${oid} 2\t${rel}\n100644 ${oid} 3\t${rel}\n`;
    const r = spawnSync('git', ['update-index', '--index-info'], { cwd: wt, input: indexInfo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const resumed = run(provisionArgs('unm', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.doesNotMatch(resumed.errText, /--abandon|rm --cached|worktree remove/,
      'a multistage (unmerged) index entry is never a surgical-recovery candidate');
    // A SINGLE non-zero-stage entry is just as unmerged — the stage byte itself must steer,
    // not only the entry count.
    const repo2 = makeRepo('r1-unmerged-single');
    const ok2 = run(provisionArgs('unm2'), repo2);
    assert.equal(ok2.code, EXIT.ok, ok2.errText);
    const wt2 = wtPath(repo2, 'unm2');
    writeFileSync(join(wt2, 'blobsrc.txt'), 'target\n');
    const oid2 = sh(['hash-object', '-w', '--', 'blobsrc.txt'], wt2).trim();
    rmSync(join(wt2, 'blobsrc.txt'));
    const single = spawnSync('git', ['update-index', '--index-info'],
      { cwd: wt2, input: `100644 ${oid2} 2\tdocs/plans/feature-unm2.md\n`, encoding: 'utf8' });
    assert.equal(single.status, 0, single.stderr);
    const resumed2 = run(provisionArgs('unm2', ['--resume']), repo2);
    assert.equal(resumed2.code, EXIT.stop);
    assert.doesNotMatch(resumed2.errText, /--abandon|rm --cached|worktree remove/,
      'a single stage-2 entry fails closed — no surgical advice on an unmerged path');
  });

  it('mixed head-tracked and index-only findings compose one salvage scenario', () => {
    const repo = makeRepo('r1-mixed-lanes');
    const ok = run(provisionArgs('mixl'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'mixl');
    const handoffRel = `docs/plans/${handoffBasename('mixl')}`;
    const seedRel = 'docs/plans/feature-mixl.md';
    sh(['add', '-f', '--', handoffRel], wt);
    sh(['commit', '-q', '-m', 'poison handoff'], wt);
    sh(['add', '-f', '--', seedRel], wt);
    const resumed = run(provisionArgs('mixl', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes(handoffRel) && resumed.errText.includes(seedRel),
      'both offending paths are listed');
    assert.doesNotMatch(resumed.errText, /rm --cached/,
      'index-only surgical commands are omitted — abandon disposes the whole worktree');
    const salvageAt = resumed.errText.search(/salvage/i);
    const abandonAt = resumed.errText.indexOf('--abandon');
    assert.ok(salvageAt !== -1 && abandonAt !== -1 && salvageAt < abandonAt, 'one salvage-then-abandon scenario');
  });

  it('index-only divergence: the staged blob is salvageable and -f converges', () => {
    const repo = makeRepo('r1-diverged');
    const ok = run(provisionArgs('div'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'div');
    const rel = 'docs/plans/feature-div.md';
    sh(['add', '-f', '--', rel], wt);
    writeFileSync(join(wt, rel), '# body\nlive edit after staging\n');
    const resumed = run(provisionArgs('div', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /rm --cached/);
    assert.match(resumed.errText, /-f/, 'the divergence caveat lane is named');
    assert.match(resumed.errText, /salvage|staged blob/i, 'salvaging the staged blob comes first');
    const plainRm = spawnSync('git', ['rm', '--cached', '--', `:(literal)${rel}`], { cwd: wt, encoding: 'utf8' });
    assert.notEqual(plainRm.status, 0, 'git itself refuses the plain removal on divergence — the caveat lane is real');
    const backup = join(TMP, 'div-staged-backup.md');
    const show = spawnSync('git', ['show', `:${rel}`], { cwd: wt, encoding: 'utf8' });
    assert.equal(show.status, 0, show.stderr);
    writeFileSync(backup, show.stdout);
    assert.equal(readFileSync(backup, 'utf8'), '# body\n', 'the STAGED blob is preserved outside the worktree');
    sh(['rm', '--cached', '-f', '-q', '--', `:(literal)${rel}`], wt);
    assert.equal(readFileSync(join(wt, rel), 'utf8'), '# body\nlive edit after staging\n', 'the live file survives -f untouched');
    const again = run(provisionArgs('div', ['--resume']), repo);
    assert.equal(again.code, EXIT.ok, `the caveat lane converges: ${again.errText}`);
  });

  it('a pattern-matching decoy alone never fires the plans-chain STOP', () => {
    const slug = 'magic2';
    const asName = 'feature-r2-[a].md';
    const repo = makeRepo('r1-magic-decoy');
    const ok = run(provisionArgs(slug, [], asName), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, slug);
    const decoyRel = 'docs/plans/feature-r2-a.md';
    writeFileSync(join(wt, decoyRel), 'decoy\n');
    sh(['add', '-f', '--', decoyRel], wt);
    rmSync(join(wt, decoyRel));
    const resumed = run(provisionArgs(slug, ['--resume'], asName), repo);
    // Slice R2 re-fixtured the consequence: the staged decoy is SESSION content the per-owned-path
    // verify never examines, so the resume COMPLETES. The literal-probe contract this arm was
    // authored for is unchanged and still proven — a pattern interpretation of the magic-shaped
    // seed name would have fired the plans-chain STOP on the decoy.
    assert.equal(resumed.code, EXIT.ok, `literal probes leave the decoy alone: ${resumed.errText}`);
    assert.doesNotMatch(resumed.errText, /staged in this worktree's index|tracked in this worktree's branch HEAD/,
      'a pattern interpretation would have fired the plans-chain STOP on the decoy — literal probes do not');
  });

  it('mixed regular and irregular resume findings withhold every recovery command', () => {
    const repo = makeRepo('r1-mixed');
    const ok = run(provisionArgs('mixed'), repo);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo, 'mixed');
    const handoffRel = `docs/plans/${handoffBasename('mixed')}`;
    sh(['add', '-f', '--', handoffRel], wt);
    writeFileSync(join(wt, 'blobsrc.txt'), 'target\n');
    const oid = sh(['hash-object', '-w', '--', 'blobsrc.txt'], wt).trim();
    rmSync(join(wt, 'blobsrc.txt'));
    sh(['update-index', '--add', '--cacheinfo', `120000,${oid},docs/plans/feature-mixed.md`], wt);
    sh(['commit', '-q', '-m', 'mixed poison'], wt);
    const before = readHandoff(repo, 'mixed');
    const resumed = run(provisionArgs('mixed', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes(handoffRel) && resumed.errText.includes('docs/plans/feature-mixed.md'),
      'both offending paths are listed');
    assert.doesNotMatch(resumed.errText, /--abandon|rm --cached|worktree remove/,
      'a set containing an irregular entry withholds EVERY recovery command — destructive advice must not cover irregular content');
    assert.equal(readHandoff(repo, 'mixed'), before, 'prior record bytes intact');
  });

  it('visible-mode-tracked-docs-ai-still-provisions', () => {
    const repo = makeRepo('r1-visible', {
      excludes: ['/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''],
      trackDocsAi: true,
    });
    const r = run(provisionArgs('visible'), repo);
    assert.equal(r.code, EXIT.ok, `docs/ai stays deliberately OUT of D10: ${r.errText}`);
  });

  it('d10-tree-shaped-handoff-entry-fails-closed', () => {
    // FRESH: a TREE at the handoff path in the captured commit — no worktree, no recovery command.
    const repo = makeRepo('r1-tree');
    const rel = `docs/plans/${handoffBasename('tree')}`;
    mkdirSync(join(repo, rel), { recursive: true });
    writeFileSync(join(repo, rel, 'inner.txt'), 'x\n');
    sh(['add', '-f', '--', `${rel}/inner.txt`], repo);
    sh(['commit', '-q', '-m', 'tree-shaped'], repo);
    poisonHeadOnly(repo, rel, { tree: true });
    const r = run(provisionArgs('tree'), repo);
    assert.equal(r.code, EXIT.stop);
    assert.ok(!existsSync(wtPath(repo, 'tree')), 'no worktree was created');
    assert.doesNotMatch(r.errText, /rm --cached|--abandon|worktree remove/, 'an irregular entry carries NO recovery command');
    // RESUME: a symlink-mode entry (120000) committed at the seed path — the same fail-closed floor.
    const repo2 = makeRepo('r1-kind');
    const ok = run(provisionArgs('kind'), repo2);
    assert.equal(ok.code, EXIT.ok, ok.errText);
    const wt = wtPath(repo2, 'kind');
    writeFileSync(join(wt, 'blobsrc.txt'), 'target\n');
    const oid = sh(['hash-object', '-w', '--', 'blobsrc.txt'], wt).trim();
    rmSync(join(wt, 'blobsrc.txt'));
    sh(['update-index', '--add', '--cacheinfo', `120000,${oid},docs/plans/feature-kind.md`], wt);
    sh(['commit', '-q', '-m', 'symlink-mode entry'], wt);
    const before = readHandoff(repo2, 'kind');
    const resumed = run(provisionArgs('kind', ['--resume']), repo2);
    assert.equal(resumed.code, EXIT.stop);
    assert.doesNotMatch(resumed.errText, /rm --cached|--abandon|worktree remove/,
      'an irregular entry carries NO recovery command on resume either');
    assert.equal(readHandoff(repo2, 'kind'), before, 'prior record bytes intact');
  });
});

// ── injected-git/fs arms (spy order, refresh failure, probe errors, one-commit binding) ─

const MOCK_HEAD = '4444444444444444444444444444444444444444';

const makeMockRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  return main;
};

// A minimal injected git covering the provision call surface; `overrides(args, cwd)` may
// return a result to intercept a call.
const makeMockGit = (main, { overrides = () => null } = {}) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const list = () => [
    [`worktree ${main}`, `HEAD ${MOCK_HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${MOCK_HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  const git = (args, cwd) => {
    const hit = overrides(args, cwd);
    if (hit) return hit;
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && (args.includes('--git-dir') || args.includes('--git-common-dir'))) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${MOCK_HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-tree') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(list());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const canonical = join(realpathSync(dirname(args[4])), basename(args[4]));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch: args[3] });
      git.added.push(args);
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
  git.added = [];
  return git;
};

const runMock = (argv, cwd, git, deps = {}) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, git, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, errText: err.join('\n') };
};

const mockArgs = (slug, extra = []) =>
  ['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, ...extra];

describe('ordering + probe-error contracts (injected git/fs)', () => {
  // The FRESH lane keeps the blanket clean-tree verify, so its ordering is still spied on the
  // porcelain call. Slice R2 replaced the resume lane's verify with the per-owned-path lane proof;
  // that lane's ordering spy lives in worktrees-resume-verify-r2.test.mjs
  // (`record-write-follows-the-resume-verify`).
  it('record-write-follows-every-verify', () => {
    const main = makeMockRepo('mock-order-fresh');
    const order = [];
    const git = makeMockGit(main, {
      overrides: (args) => {
        if (args[0] === 'status' && args[1] === '--porcelain') order.push('verify');
        return null;
      },
    });
    const deps = {
      rename: (src, dst) => {
        if (basename(dst).startsWith('handoff-')) order.push('record');
        return renameSync(src, dst);
      },
      readdir: (p, opts) => {
        if (basename(p) === 'plans' && p.includes('mock-order-fresh--ord')) order.push('inflight');
        return readdirSync(p, opts);
      },
    };
    const first = runMock(mockArgs('ord'), main, git, deps);
    assert.equal(first.code, EXIT.ok, first.errText);
    const inflight = order.indexOf('inflight');
    const verify = order.indexOf('verify');
    const record = order.lastIndexOf('record');
    assert.ok(inflight !== -1 && verify !== -1 && record !== -1, `all three stages observed: ${order.join(',')}`);
    assert.ok(inflight < verify && verify < record,
      `in-flight check → verify → record refresh, got ${order.join(',')}`);
  });

  it('record-refresh-failure-after-clean-verify-keeps-worktree-and-names-resume', () => {
    // FRESH: the stub rename (#1) succeeds, the refresh rename (#2) fails.
    {
      const main = makeMockRepo('mock-rf-fresh');
      const git = makeMockGit(main);
      let handoffRenames = 0;
      const deps = {
        rename: (src, dst) => {
          if (basename(dst).startsWith('handoff-')) {
            handoffRenames += 1;
            if (handoffRenames === 2) throw Object.assign(new Error('EIO: refresh rename failed'), { code: 'EIO' });
          }
          return renameSync(src, dst);
        },
      };
      const r = runMock(mockArgs('rff'), main, git, deps);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /KEPT/, 'fresh lane: the worktree is kept');
      assert.match(r.errText, /--resume/, 'and the finish command is named');
    }
    // RESUME: the only handoff rename of the run is the refresh — it fails after a clean verify.
    {
      const main = makeMockRepo('mock-rf-resume');
      const git = makeMockGit(main);
      const first = runMock(mockArgs('rfr'), main, git);
      assert.equal(first.code, EXIT.ok, first.errText);
      const recordPath = join(dirname(main), 'mock-rf-resume--rfr', 'docs/plans', handoffBasename('rfr'));
      const before = readFileSync(recordPath, 'utf8');
      const deps = {
        rename: (src, dst) => {
          if (basename(dst).startsWith('handoff-')) throw Object.assign(new Error('EIO: refresh rename failed'), { code: 'EIO' });
          return renameSync(src, dst);
        },
      };
      const r = runMock(mockArgs('rfr', ['--resume']), main, git, deps);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /KEPT/, 'resume lane: the worktree is kept and said so');
      assert.match(r.errText, /--resume/, 'the exact re-run command is named');
      assert.match(r.errText, /EIO|rename/, 'the original failure cause is preserved');
      assert.equal(readFileSync(recordPath, 'utf8'), before, 'the prior record bytes survive the failed refresh');
    }
  });

  it('fresh-lane-probe-and-add-bind-to-one-commit', () => {
    // The captured OID feeds BOTH the tree probe and the branch cut, even when HEAD moves
    // between the capture and the add.
    const main = makeMockRepo('mock-onecommit');
    const OID_A = 'a'.repeat(40);
    const OID_B = 'b'.repeat(40);
    let headCalls = 0;
    const probed = [];
    const git = makeMockGit(main, {
      overrides: (args) => {
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          headCalls += 1;
          return { status: 0, stdout: `${headCalls === 1 ? OID_A : OID_B}\n`, stderr: '' };
        }
        if (args[0] === 'ls-tree') probed.push(args);
        return null;
      },
    });
    const r = runMock(mockArgs('onec'), main, git);
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.ok(probed.some((args) => args.includes(OID_A)), 'the tree probe reads the captured OID');
    assert.ok(!probed.some((args) => args.includes(OID_B)), 'never the moved HEAD');
    const add = git.added.find((args) => args[2] === '-b');
    assert.ok(add, 'worktree add happened');
    assert.equal(add[5], OID_A, 'the branch is cut from the SAME captured OID');
  });

  it('d10-probe-git-error-fails-closed', () => {
    // PRE-ADD, captured-OID failure: no worktree, no recovery command.
    {
      const main = makeMockRepo('mock-err-oid');
      const git = makeMockGit(main, {
        overrides: (args, cwd) =>
          (args[0] === 'rev-parse' && args.includes('HEAD') && cwd === main)
            ? { status: 128, stdout: '', stderr: 'boom: rev-parse' } : null,
      });
      const r = runMock(mockArgs('erroid'), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.equal(git.added.length, 0, 'no worktree add was attempted');
      assert.match(r.errText, /boom: rev-parse/, 'the underlying git error is surfaced, not swallowed');
      assert.doesNotMatch(r.errText, /rm --cached|worktree remove|--abandon/, 'no recovery command');
    }
    // PRE-ADD, tree-probe failure: same contract, the underlying error surfaced.
    {
      const main = makeMockRepo('mock-err-tree');
      const git = makeMockGit(main, {
        overrides: (args, cwd) =>
          (args[0] === 'ls-tree' && cwd === main) ? { status: 128, stdout: '', stderr: 'boom: ls-tree' } : null,
      });
      const r = runMock(mockArgs('errtree'), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /boom: ls-tree/, 'the underlying error is surfaced');
      assert.equal(git.added.length, 0, 'no worktree add was attempted');
    }
    // POST-ADD probe failure: the worktree is KEPT, no provision write, --resume named.
    {
      const main = makeMockRepo('mock-err-postadd');
      const git = makeMockGit(main, {
        overrides: (args, cwd) =>
          (args[0] === 'ls-tree' && cwd !== main) ? { status: 128, stdout: '', stderr: 'boom: post-add' } : null,
      });
      const r = runMock(mockArgs('errpost'), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.equal(git.added.length, 1, 'the worktree exists');
      assert.match(r.errText, /KEPT/, 'and the STOP says so');
      assert.match(r.errText, /--resume/, 'the finish command is named');
      const handoff = join(dirname(main), 'mock-err-postadd--errpost', 'docs/plans', handoffBasename('errpost'));
      assert.ok(!existsSync(handoff), 'no provision write happened — the probe ran pre-write');
    }
    // RESUME probe failure: prior record bytes intact, no recovery command.
    {
      const main = makeMockRepo('mock-err-resume');
      let arm = false;
      const git = makeMockGit(main, {
        overrides: (args, cwd) =>
          (arm && args[0] === 'ls-tree' && cwd !== main) ? { status: 128, stdout: '', stderr: 'boom: resume probe' } : null,
      });
      const first = runMock(mockArgs('errres'), main, git);
      assert.equal(first.code, EXIT.ok, first.errText);
      const recordPath = join(dirname(main), 'mock-err-resume--errres', 'docs/plans', handoffBasename('errres'));
      const before = readFileSync(recordPath, 'utf8');
      arm = true;
      const r = runMock(mockArgs('errres', ['--resume']), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /boom: resume probe/, 'the underlying error is surfaced');
      assert.doesNotMatch(r.errText, /rm --cached|worktree remove|--abandon/, 'no recovery command');
      assert.equal(readFileSync(recordPath, 'utf8'), before, 'prior record bytes intact');
    }
    // FRESH, MAIN-index probe failure (runs only when the captured tree tracks the rel).
    {
      const main = makeMockRepo('mock-err-mainindex');
      const git = makeMockGit(main, {
        overrides: (args, cwd) => {
          if (args[0] === 'ls-tree' && cwd === main) {
            return { status: 0, stdout: `100644 blob ${'a'.repeat(40)}\tdocs/plans/${handoffBasename('errmi')}\0`, stderr: '' };
          }
          if (args[0] === 'ls-files' && cwd === main) return { status: 128, stdout: '', stderr: 'boom: main index' };
          return null;
        },
      });
      const r = runMock(mockArgs('errmi'), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /plans-chain index probe failed at main.*boom: main index/, 'the index-probe error is surfaced');
      assert.doesNotMatch(r.errText, /rm --cached|--abandon|worktree remove/, 'no recovery command rides a failed probe');
      assert.equal(git.added.length, 0, 'no worktree add was attempted');
    }
    // RESUME, live-index probe failure (the HEAD-tree probe succeeded).
    {
      const main = makeMockRepo('mock-err-liveindex');
      let arm = false;
      const git = makeMockGit(main, {
        overrides: (args, cwd) =>
          (arm && args[0] === 'ls-files' && cwd !== main) ? { status: 128, stdout: '', stderr: 'boom: live index' } : null,
      });
      const first = runMock(mockArgs('errli'), main, git);
      assert.equal(first.code, EXIT.ok, first.errText);
      arm = true;
      const r = runMock(mockArgs('errli', ['--resume']), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /plans-chain probe failed \(live index\).*boom: live index/, 'the live-index error is surfaced');
      assert.doesNotMatch(r.errText, /rm --cached|--abandon|worktree remove/, 'no recovery command rides a failed probe');
    }
    // RESUME, ignore-rule probe failure on an index-only finding.
    {
      const main = makeMockRepo('mock-err-rule');
      let arm = false;
      const git = makeMockGit(main, {
        overrides: (args, cwd) => {
          if (!arm || cwd === main) return null;
          if (args[0] === 'ls-files') {
            return { status: 0, stdout: `100644 ${'a'.repeat(40)} 0\tdocs/plans/${handoffBasename('errru')}\0`, stderr: '' };
          }
          if (args[0] === 'check-ignore' && args.includes('--no-index')) {
            return { status: 128, stdout: '', stderr: 'boom: rule probe' };
          }
          return null;
        },
      });
      const first = runMock(mockArgs('errru'), main, git);
      assert.equal(first.code, EXIT.ok, first.errText);
      arm = true;
      const r = runMock(mockArgs('errru', ['--resume']), main, git);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /ignore-rule probe failed.*boom: rule probe/, 'the rule-probe error is surfaced');
      assert.doesNotMatch(r.errText, /rm --cached/, 'no surgical command rides a failed probe');
    }
  });
});

// ── mode-doc pins (spec-first — authored WITH the doc edit) ────────────────────────────

describe('mode-doc pins (spec-first)', () => {
  // Narrowed in slice R2 to the D4 ORDER-ONLY contract: the tolerance clause this pin used to
  // quote was retired with the per-owned-path verify (the sanctioned D7 flip), while the ordering
  // it was authored for is unchanged.
  it('the mode doc states the verify-then-refresh order verbatim', () => {
    const doc = readFileSync(WORKTREES_MODE_DOC, 'utf8');
    assert.ok(doc.includes('The provision record is refreshed LAST, after the post-provision verify, in both lanes'));
  });
  it('the mode doc states the tracked plans-chain refusal contract verbatim', () => {
    const doc = readFileSync(WORKTREES_MODE_DOC, 'utf8');
    assert.ok(doc.includes('A TRACKED plans-chain path — the handoff or the seeded plan — refuses fail-closed in BOTH lanes'));
  });
});
