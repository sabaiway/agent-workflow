// worktrees-prompt-cli.test.mjs — the two print sites of the satellite cold-start prompt
// (delegation Plan 3, Phase 2): the read-only `worktrees prompt <slug>` subcommand, and the tail of
// `provision`'s report. Its OWN suite so the recorded worktrees.test.mjs baseline does not grow and
// the D6 characterization claim — no existing assertion or fixture moves — stays literally true.
//
// Real git: the prompt is derived from a live worktree registry, and a faked registry would prove
// the composer twice instead of the print sites once.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, rmSync, existsSync,
  symlinkSync, unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, spawnGit } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-prompt-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const run = (argv, cwd, deps = {}) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, text: out.join('\n'), errText: err.join('\n') };
};

// Content-level snapshot: the "writes nothing" claim is about BYTES, so a listing alone would miss
// an in-place rewrite. `.git` is skipped — git's own reads touch it (index stat cache, refs) — and
// the git-call recorder below is what covers that half of the claim.
const snapshot = (dir) => {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const child = join(abs, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) out.push(`${r} -> ${readlinkSync(child)}`);
      else if (e.isDirectory()) walk(child, r);
      else out.push(`${r} ${createHash('sha256').update(readFileSync(child)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
};

const recordingGit = (calls) => (args, cwd) => {
  calls.push(args);
  return spawnGit(args, cwd);
};

const makeRepo = (name, { packageJson = null, nodeModules = false } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  if (packageJson !== null) writeFileSync(join(main, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  if (nodeModules) {
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    writeFileSync(join(main, 'node_modules/marker.txt'), 'nm\n');
  }
  writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/.vscode/', '/node_modules', ''].join('\n'));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/queue.md'), 'index\n');
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# plan body\n');
  return main;
};

let MAIN;
let WT;
let PROVISION;

before(() => {
  MAIN = makeRepo('main');
  WT = join(dirname(MAIN), `${basename(MAIN)}--alpha`);
  PROVISION = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md'], MAIN);
  assert.equal(PROVISION.code, 0, `provision failed: ${PROVISION.errText}`);
});

describe('worktrees prompt — the read-only re-print', () => {
  it('prompt prints the composed prompt and writes nothing', () => {
    const before = [...snapshot(MAIN), ...snapshot(WT)];
    const calls = [];
    const r = run(['prompt', 'alpha'], MAIN, { git: recordingGit(calls) });
    assert.equal(r.code, 0, r.errText);
    assert.ok(r.text.includes('# Satellite session — alpha'), r.text);
    assert.ok(r.text.includes(WT), 'the satellite path must be stated');
    assert.ok(r.text.includes('docs/plans/handoff-alpha.md'), 'the return channel must be named');
    assert.deepEqual([...snapshot(MAIN), ...snapshot(WT)], before);
    // Bytes alone would miss a git-side write (an index refresh, a ref update), which no content
    // snapshot of the work tree can see. The lane's git surface is therefore a CLOSED read-only set.
    const allowed = [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--path-format=absolute', '--git-dir'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['worktree', 'list', '--porcelain', '-z'],
    ];
    const unexpected = calls.filter((args) => !allowed.some((ok) => ok.length === args.length && ok.every((v, i) => v === args[i])));
    assert.deepEqual(unexpected, [], 'the prompt lane may make only the listed read-only git calls');
  });

  it('a valid-but-absent slug is a runtime STOP with exit 1', () => {
    const r = run(['prompt', 'nosuch'], MAIN);
    assert.equal(r.code, 1);
    assert.match(r.errText, /no registered satellite worktree for nosuch/);
  });

  it('a malformed slug is usage with exit 2', () => {
    const r = run(['prompt', 'Alpha'], MAIN);
    assert.equal(r.code, 2);
    // The refusal must be about the SLUG — an unknown-subcommand exit is also 2, so the code alone
    // would pass on a tool that never learned this verb.
    assert.match(r.errText, /invalid slug "Alpha"/);
  });
});

describe('worktrees provision — the report ends with the prompt', () => {
  it('provision report ends with the composed prompt', () => {
    const reprint = run(['prompt', 'alpha'], MAIN);
    assert.equal(reprint.code, 0, reprint.errText);
    assert.ok(reprint.text.includes('# Satellite session — alpha'));
    assert.ok(PROVISION.text.endsWith(reprint.text), PROVISION.text);
  });

  it('the composed prompt re-probes nothing — the plan is read once and the install posture is the recorded one', () => {
    const repo = makeRepo('probe-once');
    const wt = join(dirname(repo), `${basename(repo)}--probe`);
    const plansReads = [];
    const r = run(['provision', 'probe', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-probe.md'], repo, {
      readdir: (path, options) => {
        if (path === join(wt, 'docs/plans')) plansReads.push(path);
        return readdirSync(path, options);
      },
    });
    assert.equal(r.code, 0, r.errText);
    // ONE read: the EXACTLY-ONE in-flight check. The composition takes the name that check produced
    // instead of asking the directory a second time.
    assert.equal(plansReads.length, 1, 'the satellite plans dir must be read exactly once');
    // And the install the prompt offers comes from the SAME derivation the record took: this fixture
    // resolves a runnable install, so the recorded posture IS that command — and it appears in the
    // prompt exactly once, on its attributed line. One derivation, so no second probe can disagree.
    const handoff = readFileSync(join(wt, 'docs/plans/handoff-probe.md'), 'utf8');
    const recorded = handoff.split('\n').find((l) => l.startsWith('- install: ')).slice('- install: '.length);
    // Scoped to the PROMPT: provision's own report line about the node_modules lane is a report of
    // what the tool did, not a cold-start instruction, and it predates this phase.
    const prompt = r.text.slice(r.text.indexOf('# Satellite session'));
    const carrying = prompt.split('\n').filter((line) => line.includes(recorded));
    assert.deepEqual(carrying, [`    HERE $ ${recorded}`], 'the recorded install appears once, attributed');
  });

  it('a failure at the record write prints no success line and leaves the record bytes untouched', () => {
    const repo = makeRepo('write-fail');
    const wt = join(dirname(repo), `${basename(repo)}--wf`);
    let armed = false;
    const r = run(['provision', 'wf', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-wf.md'], repo, {
      // The record refresh is the LAST write; arming on the handoff path lets it fail exactly there.
      writeFile: (path, data, options) => {
        if (String(path).includes('handoff-wf.md') && armed) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        armed = true;
        return writeFileSync(path, data, options);
      },
    });
    assert.equal(r.code, 1, r.text);
    assert.ok(!r.text.includes('[worktrees] provisioned'), 'no success line may precede a failing record write');
    assert.ok(!r.text.includes('# Satellite session'), 'and no prompt is printed for a provision that failed');
    // The prompt is composed BEFORE this write, so the failure is the write's own — and the record
    // keeps the stub bytes the earlier step left.
    const handoff = readFileSync(join(wt, 'docs/plans/handoff-wf.md'), 'utf8');
    assert.match(handoff, /provisioned, nothing done yet/, 'the stub bytes survive a failed refresh');
  });

  it('a symlinked node_modules offers its removal as an attributed HERE command even when no install command is derivable', () => {
    // The ambiguous packageManager leaves the advice prose-only, but the REMOVAL is still runnable —
    // and a runnable line loose inside prose is exactly what an attributed grammar exists to prevent.
    // A declared dependency keeps the checkout from being provably install-free (so the lane really
    // symlinks), while the unrecognised packageManager leaves the install advice prose-only.
    const repo = makeRepo('nm-symlink', {
      packageJson: { name: 'x', packageManager: 'weird@1', dependencies: { 'a-dep': '1.0.0' } },
      nodeModules: true,
    });
    const wt = join(dirname(repo), `${basename(repo)}--nm`);
    const r = run(['provision', 'nm', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nm.md'], repo);
    assert.equal(r.code, 0, r.errText);
    const hereLines = r.text.split('\n').filter((line) => line.startsWith('    HERE $ '));
    assert.equal(hereLines.length, 1, r.text);
    assert.equal(hereLines[0], `    HERE $ rm ${join(wt, 'node_modules')}`);
    assert.ok(r.text.includes('package manager is ambiguous or unknown'), 'the prose half still states why no install command is offered');
    // And the RECORD keeps the flattened posture it has always carried.
    const handoff = readFileSync(join(wt, 'docs/plans/handoff-nm.md'), 'utf8');
    assert.match(handoff, /- install: the provisioned node_modules is a symlink into MAIN .* for isolation remove it first: rm /);
  });

  it('a node_modules symlink that does not point at MAIN is reported as unverified, with no removal advised', () => {
    // The provisioned link points at MAIN. A link pointing anywhere else was put there by the
    // session or a later hand, so claiming "a symlink into MAIN" would state a live fact nothing
    // checked — and advising its removal would offer to delete something this tool never placed.
    const repo = makeRepo('nm-foreign', {
      packageJson: { name: 'x', packageManager: 'weird@1', dependencies: { 'a-dep': '1.0.0' } },
      nodeModules: true,
    });
    const wt = join(dirname(repo), `${basename(repo)}--fg`);
    assert.equal(run(['provision', 'fg', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-fg.md'], repo).code, 0);
    const link = join(wt, 'node_modules');
    const elsewhere = join(TMP, 'nm-foreign-elsewhere');
    mkdirSync(elsewhere, { recursive: true });

    for (const target of [elsewhere, join(TMP, 'nm-foreign-absent')]) {
      unlinkSync(link);
      symlinkSync(target, link);
      const r = run(['prompt', 'fg'], repo);
      assert.equal(r.code, 0, r.errText);
      // The wording states the PROVEN fact and no more: the raw target is not the absolute path
      // provision writes. It does not claim where the link resolves, nor who created it.
      assert.ok(r.text.includes('raw target is not the absolute MAIN node_modules path'), r.text);
      assert.ok(r.text.includes('its ownership is unproven'), r.text);
      assert.ok(r.text.includes(target), 'the raw target it carries is named');
      // The MAIN claim may survive ONLY as the record's frozen value, named as a divergence — never
      // as the live line, which is the one a reader acts on.
      const claiming = r.text.split('\n').filter((line) => line.includes('is a symlink into MAIN'));
      assert.ok(claiming.every((line) => line.trim().startsWith('record divergence:')), claiming.join('\n'));
      assert.ok(r.text.includes('record divergence'), 'the frozen record value is named, not silently dropped');
      assert.deepEqual(r.text.split('\n').filter((line) => line.startsWith('    HERE $ ')), [], 'no removal is advised');
    }
  });

  it('a node_modules link whose target cannot be read is unverified too, and names no target', () => {
    // Unreadable is not ownership. The branch exists because a read failure must fall to the same
    // unverified answer as a foreign target — never to the into-MAIN claim by omission.
    const repo = makeRepo('nm-unreadable', {
      packageJson: { name: 'x', dependencies: { 'a-dep': '1.0.0' } },
      nodeModules: true,
    });
    const wt = join(dirname(repo), `${basename(repo)}--nr`);
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nr.md'];
    assert.equal(run(['provision', 'nr', ...seed], repo).code, 0);

    const denied = join(wt, 'node_modules');
    const r = run(['prompt', 'nr'], repo, {
      readlink: (p, options) => {
        if (String(p) === denied) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return readlinkSync(p, options);
      },
    });
    assert.equal(r.code, 0, r.errText);
    // Its OWN wording, not the foreign one: "points somewhere else" would state what the failed read
    // never established. The errno survives so the reader knows what to inspect.
    assert.ok(r.text.includes('a symlink whose target could not be read'), r.text);
    assert.ok(r.text.includes('(EACCES)'), 'the read failure names itself');
    assert.ok(!r.text.includes('raw target is not the absolute MAIN'), 'an unreadable link claims nothing about its target');
    assert.deepEqual(r.text.split('\n').filter((line) => line.startsWith('    HERE $ ')), []);
  });

  it('the install report never advises removing a node_modules link this tool did not place', () => {
    // The report and the prompt are read together. Advising rm for a link whose target was never
    // established would offer to delete someone else's node — and the prompt, which now refuses to
    // claim anything about that link, would contradict the report in the same breath.
    const repo = makeRepo('nm-install', {
      packageJson: { name: 'x', dependencies: { 'a-dep': '1.0.0' } },
      nodeModules: true,
    });
    const wt = join(dirname(repo), `${basename(repo)}--ni`);
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-ni.md'];
    assert.equal(run(['provision', 'ni', ...seed], repo).code, 0);
    const link = join(wt, 'node_modules');
    const elsewhere = join(TMP, 'nm-install-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    unlinkSync(link);
    symlinkSync(elsewhere, link);

    const r = run(['provision', 'ni', '--resume', '--install', ...seed], repo);
    assert.equal(r.code, 0, r.errText);
    assert.ok(r.text.includes('raw target is not the absolute MAIN node_modules path'), r.text);
    assert.deepEqual(r.text.split('\n').filter((line) => line.includes(' rm ')), [], 'no removal is advised anywhere in the report');
  });

  it('every seed-plan refusal renders its value escaped, whichever check fires first', () => {
    const repo = makeRepo('seed-escapes');
    const calls = [];
    // C1 and the Unicode line terminators are exactly what JSON.stringify would have passed through.
    for (const cp of [0x85, 0x9b, 0x2028]) {
      const r = run(['provision', 'esc', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', `feature${String.fromCharCode(cp)}.md`], repo, { git: recordingGit(calls) });
      assert.equal(r.code, 2, r.errText);
      assert.match(r.errText, new RegExp(`\\\\u${cp.toString(16).padStart(4, '0')}`));
      assert.doesNotMatch(r.errText, new RegExp(String.fromCharCode(cp)));
    }
    // And the check that fires FIRST for a plain bad name still renders it safely.
    const notMd = run(['provision', 'esc', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature.txt'], repo, { git: recordingGit(calls) });
    assert.equal(notMd.code, 2);
    assert.match(notMd.errText, /--as must be a basename ending in \.md/);
    assert.ok(!calls.some((args) => args[0] === 'worktree' && args[1] === 'add'), 'no worktree may be created by any of these');
  });

  it('a resume against a hand-edited record renders the recorded value escaped', () => {
    const repo = makeRepo('resume-escapes');
    const wt = join(dirname(repo), `${basename(repo)}--re`);
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-re.md'];
    assert.equal(run(['provision', 're', ...seed], repo).code, 0);
    const handoff = join(wt, 'docs/plans/handoff-re.md');
    // A hand edit the WRITER would have refused: the reader must not repeat it raw into a terminal.
    writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('- branch: aw/re', `- branch: aw/re${String.fromCharCode(0x9b)}1m`));

    const r = run(['provision', 're', '--resume', ...seed], repo);
    assert.equal(r.code, 1);
    assert.match(r.errText, /identity mismatch/);
    assert.match(r.errText, /\\u009b/);
    assert.doesNotMatch(r.errText, new RegExp(String.fromCharCode(0x9b)));
  });

  it('a seeded plan name carrying a control character refuses before git worktree add', () => {
    const repo = makeRepo('hostile-name');
    // Outside docs/plans: a bare plan name INSIDE it is refused by an older rule, which would hide
    // the one under test. The basename becomes the seeded name because no --as is given.
    const hostile = `feature${String.fromCharCode(0x0a)}    MAIN $ git push --force.md`;
    writeFileSync(join(repo, hostile), '# body\n');
    const calls = [];
    const r = run(['provision', 'hostile', '--plan', hostile], repo, { git: recordingGit(calls) });
    assert.equal(r.code, 1, r.text);
    assert.match(r.errText, /control character/);
    assert.ok(!calls.some((args) => args[0] === 'worktree' && args[1] === 'add'), 'no worktree may be created');
    assert.equal(existsSync(join(dirname(repo), `${basename(repo)}--hostile`)), false, 'no target dir may be left behind');
  });
});
