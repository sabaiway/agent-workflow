// worktrees-node-modules-link.test.mjs — the edge of the node_modules ownership answer that only an
// injected filesystem reaches (delegation Plan 3, Phase 2, round-6 fold).
//
// Ownership is decided on the RAW TARGET BYTES, and the target is then decoded FATALLY before it may
// be quoted into the record or the prompt: a lossy decode would fold undecodable bytes to U+FFFD and
// hand both guards a sanitized string where a typed refusal was promised. Bytes that are not text at
// all therefore get the unreadable answer — nothing claimed, nothing advised. Its own suite so the
// branch is reached rather than argued, and so no recorded suite grows for it.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, spawnGit } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-nmlink-'));
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

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), `${JSON.stringify({ name: 'x', dependencies: { 'a-dep': '1.0.0' } }, null, 2)}\n`);
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  mkdirSync(join(main, 'node_modules'), { recursive: true });
  writeFileSync(join(main, 'node_modules/marker.txt'), 'nm\n');
  writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/.vscode/', '/node_modules', ''].join('\n'));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# plan body\n');
  return main;
};

describe('worktrees node_modules link — a matching target is only half the proof', () => {
  it('a TRACKED link with the right target advises no removal, at either print site', () => {
    // Matching bytes say where it points; the ignored lane says whether this tool placed it. A
    // tracked path is repository content the landing lane protects — offering rm there would advise
    // destroying it. Both print sites are checked, because they used to be able to disagree.
    const repo = makeRepo('nm-tracked');
    const wt = join(dirname(repo), `${basename(repo)}--nt`);
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nt.md'];
    assert.equal(run(['provision', 'nt', ...seed], repo).code, 0);
    sh(['add', '-f', 'node_modules'], wt);

    const prompt = run(['prompt', 'nt'], repo);
    assert.equal(prompt.code, 0, prompt.errText);
    assert.ok(prompt.text.includes('a TRACKED symlink'), prompt.text);
    assert.deepEqual(prompt.text.split('\n').filter((line) => line.startsWith('    HERE $ ')), [], 'the prompt advises nothing');

    const report = run(['provision', 'nt', '--resume', '--install', ...seed], repo);
    assert.equal(report.code, 0, report.errText);
    assert.ok(report.text.includes('a TRACKED symlink'), report.text);
    assert.deepEqual(report.text.split('\n').filter((line) => line.includes(' rm ')), [], 'and so does the report');
  });
});

describe('worktrees node_modules link — a lane the probe cannot settle', () => {
  it('an unsettled lane says so in its own words, never that the target could not be read', () => {
    // The target WAS read and it matches; only the lane is unknown. Borrowing the failed-read wording
    // would report a fact that did not happen, which is the whole thing these verdicts exist to avoid.
    const repo = makeRepo('nm-lane');
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nl.md'];
    assert.equal(run(['provision', 'nl', ...seed], repo).code, 0);

    const r = run(['prompt', 'nl'], repo, {
      git: (args, cwd) => (args[0] === 'check-ignore' && args.includes('--no-index')
        ? { status: 128, stdout: '', stderr: 'fatal: injected probe failure' }
        : spawnGit(args, cwd)),
    });
    assert.equal(r.code, 0, r.errText);
    assert.ok(r.text.includes('could not establish that the path sits in the ignored lane'), r.text);
    assert.ok(!r.text.includes('whose target could not be read'), 'the target read succeeded and the wording must say so');
    assert.deepEqual(r.text.split('\n').filter((line) => line.startsWith('    HERE $ ')), [], 'nothing is advised');
  });
});

describe('worktrees node_modules link — a target that is not decodable text', () => {
  it('an undecodable link target is answered as unreadable, quoted nowhere and advising nothing', () => {
    const repo = makeRepo('nm-bytes');
    const wt = join(dirname(repo), `${basename(repo)}--nb`);
    const seed = ['--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nb.md'];
    assert.equal(run(['provision', 'nb', ...seed], repo).code, 0);

    const link = join(wt, 'node_modules');
    // A lone 0xFF is not valid UTF-8 in any position: the fatal decode refuses it, where a lossy one
    // would have produced U+FFFD and passed a string neither guard could recognise as hostile.
    const r = run(['prompt', 'nb'], repo, {
      readlink: (p, options) => (String(p) === link ? Buffer.from([0xff, 0xfe]) : options),
    });
    assert.equal(r.code, 0, r.errText);
    assert.ok(r.text.includes('its target is not decodable text'), r.text);
    assert.ok(!r.text.includes('raw target is not the absolute MAIN'), 'no claim about where it points');
    assert.deepEqual(r.text.split('\n').filter((line) => line.startsWith('    HERE $ ')), [], 'nothing is advised');
  });
});
