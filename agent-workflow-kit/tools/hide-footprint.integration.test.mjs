// Integration acceptance for hide-footprint against a REAL `git` — what injected-git mocks cannot
// prove: real `git rev-parse --git-path info/exclude` (incl. a linked worktree), real precedence
// (tracked .gitignore > .git/info/exclude > global core.excludesFile), and the delegated-memory
// hand-off (fresh + stale). Every test ISOLATES the git environment (per-test HOME + GIT_CONFIG_GLOBAL
// + GIT_CONFIG_NOSYSTEM) so the host's real ~/.gitignore_global — which already hides /AGENTS.md,
// /docs/ai/ — cannot make a real check-ignore pass/fail for host-state reasons (review fold #8).

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hideFootprint, excludePath, main, START_MARKER, START_MARKER as S, END_MARKER as E } from './hide-footprint.mjs';
import { MASKS_FENCE_START as MS, MASKS_FENCE_END as ME } from './sandbox-masks.mjs';
import { DEPLOYED_SCRIPTS, KIT_SCRIPTS_DIR } from './node-evidence.mjs';
import { PRIOR_FILES } from './script-priors.mjs';
import { hermeticGitEnv, stripGitLocationEnv } from './git-env.mjs';
const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
let gitOk = true;
before(() => { try { execFileSync('git', ['--version'], { env: stripGitLocationEnv(inheritedEnvironment), encoding: 'utf8' }); } catch { gitOk = false; } });

const made = [];
const mkdtemp = (tag) => { const d = mkdtempSync(join(tmpdir(), tag)); made.push(d); return d; };
afterEach(() => { while (made.length) { try { rmSync(made.pop(), { recursive: true, force: true }); } catch { /* best effort */ } } });

// An isolated repo: empty global config (no host excludesFile), committer identity in env.
const setup = () => {
  const home = mkdtemp('aw-home-');
  const dir = mkdtemp('aw-repo-');
  const gcfg = join(home, '.gitconfig');
  writeFileSync(gcfg, '');
  const env = { ...hermeticGitEnv(inheritedEnvironment, home), GIT_CONFIG_GLOBAL: gcfg,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  return { home, dir, gcfg, env, git, deps: { env, home } };
};
const readExclude = (dir) => { const p = join(dir, '.git/info/exclude'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const count = (s, sub) => s.split(sub).length - 1;
const checkIgnoreSource = (git, dir, probe) => {
  try { return git(['check-ignore', '-v', '--', probe], dir).split('\t')[0]; } catch { return null; }
};

describe('hide-footprint integration (real git)', { skip: !gitOk }, () => {
  let env;
  beforeEach(() => { env = setup(); });

  it('resolves info/exclude, writes ONE managed block, and real check-ignore reports it', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const ep = excludePath(deps, dir);
    assert.ok(ep.endsWith('.git/info/exclude'));
    const r = hideFootprint({ dir }, deps);
    assert.equal(r.action, 'created');
    const content = readExclude(dir);
    assert.equal(count(content, START_MARKER), 1, 'exactly one managed block');
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/);
    // Idempotent: a second run changes nothing.
    const r2 = hideFootprint({ dir }, deps);
    assert.equal(r2.action, 'noop');
    assert.equal(readExclude(dir), content);
  });

  it('works inside a linked git worktree', () => {
    const { dir, git, deps, env: e } = env;
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = mkdtemp('aw-wt-');
    rmSync(wt, { recursive: true, force: true }); // git worktree add wants a non-existent path
    git(['worktree', 'add', '-q', wt]);
    writeFileSync(join(wt, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir: wt }, deps);
    assert.equal(r.visibility, 'hidden');
    assert.equal(count(r.wrote.join('\n'), '/AGENTS.md'), 1);
    assert.match(checkIgnoreSource((a, c) => execFileSync('git', a, { cwd: c, env: e, encoding: 'utf8' }), wt, 'AGENTS.md') ?? '', /exclude/);
  });

  it('precedence: a path in a TRACKED .gitignore is dropped (redundant), reported by .gitignore', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, '.gitignore'), '/docs/ai/\n');
    git(['add', '.gitignore']);
    const r = hideFootprint({ dir }, deps);
    assert.ok(r.dropped.includes('/docs/ai/'), 'covered by tracked .gitignore → dropped');
    assert.ok(!r.wrote.includes('/docs/ai/'));
    assert.match(checkIgnoreSource(git, dir, 'docs/ai/') ?? '', /\.gitignore/);
  });

  it('precedence: a path in BOTH global excludes and the local block is reported by the LOCAL block', () => {
    const { dir, git, deps } = env;
    const globalExcludes = join(env.home, 'gitignore_global');
    writeFileSync(globalExcludes, '# agent-workflow-kit hidden mode (machine-local; remove these lines to un-hide)\n/AGENTS.md\n');
    git(['config', 'core.excludesFile', globalExcludes]);
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir }, deps); // default keeps the global block
    assert.ok(r.wrote.includes('/AGENTS.md'));
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/, 'local exclude wins precedence');
    assert.equal(r.global.action, 'kept');
  });

  it('a machine-global core.excludesFile NAMED .gitignore is not mistaken for a project .gitignore (no spurious STOP)', () => {
    const { dir, git, deps } = env;
    const globalGitignore = join(env.home, '.gitignore'); // basename collides with a project .gitignore
    writeFileSync(globalGitignore, '/AGENTS.md\n');
    git(['config', 'core.excludesFile', globalGitignore]);
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir }, deps); // must not STOP probing an outside-repo path
    assert.ok(r.wrote.includes('/AGENTS.md'), 'AGENTS.md hidden project-local, not dropped as a "tracked .gitignore"');
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/);
  });

  it('delegated-hidden, FRESH memory: bare project-local lines are absorbed into ONE canonical fence', () => {
    const { dir, deps } = env;
    // What a 1.1.0 memory writes project-local (bare, no fence):
    writeFileSync(join(dir, '.git/info/exclude'), '/AGENTS.md\n/CLAUDE.md\n/docs/ai/\n');
    const r = hideFootprint({ dir }, deps);
    const content = readExclude(dir);
    assert.equal(count(content, START_MARKER), 1, 'one fence');
    assert.equal(count(content, '/AGENTS.md\n'), 1, 'no duplicate AGENTS.md rule');
    // the bare lines are now INSIDE the fence, not loose above it.
    assert.ok(content.indexOf('/AGENTS.md') > content.indexOf(START_MARKER));
    assert.ok(r.wrote.includes('/AGENTS.md') && r.wrote.includes('/docs/ai/'));
  });

  // The mcp mode (AD-108) writes .mcp.json at the project root; hidden mode must keep it out of git.
  it('an untracked .mcp.json is seated in the managed block and really ignored', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
    const r = hideFootprint({ dir }, deps);
    assert.ok(r.wrote.includes('/.mcp.json'), 'the registration is in the written set');
    assert.ok(readExclude(dir).includes('/.mcp.json'), 'and inside the managed fence');
    assert.match(checkIgnoreSource(git, dir, '.mcp.json') ?? '', /info\/exclude/, 'git really ignores it');
  });

  it('a TRACKED .mcp.json is an ASK, never written into the block and never un-tracked', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
    git(['add', '.mcp.json']);
    git(['commit', '-m', 'team commits its own mcp registration']);
    const r = hideFootprint({ dir }, deps);
    assert.ok(!r.wrote.includes('/.mcp.json'), 'a tracked path is never hidden silently');
    const ask = r.asks.find((a) => a.path === '/.mcp.json');
    assert.match(ask?.reason ?? '', /tracked in git/, 'it is surfaced as the tracked ASK');
    assert.equal(git(['ls-files', '--', '.mcp.json']).trim(), '.mcp.json', 'still tracked');
  });

  it('a bootstrapped spec layer is hidden: real check-ignore on both kit-folder spec-schema files and docs/ai/specs/x.md', () => {
    const { dir, git, deps } = env;
    const pair = DEPLOYED_SCRIPTS.filter(({ module }) => module === 'spec-schema');
    assert.equal(pair.length, 2, 'the spec-schema module deploys a pair');
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
    for (const { deployed, bundled } of pair) {
      mkdirSync(dirname(join(dir, deployed)), { recursive: true });
      writeFileSync(join(dir, deployed), readFileSync(new URL(`../${bundled}`, import.meta.url)));
    }
    writeFileSync(join(dir, 'docs', 'ai', 'specs', 'x.md'), '---\ntype: spec\n---\n# Spec: x\n');
    const r = hideFootprint({ dir }, deps);
    assert.ok(r.wrote.includes(`/${KIT_SCRIPTS_DIR}/`), 'the kit folder is in the written set');
    assert.deepEqual(r.wrote.filter((path) => PRIOR_FILES.some((name) => path === `/scripts/${name}`)), []);
    for (const probe of [...pair.map(({ deployed }) => deployed), 'docs/ai/specs/x.md']) {
      assert.match(checkIgnoreSource(git, dir, probe) ?? '', /info\/exclude/, `${probe} is really ignored`);
    }
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']).trim(), '', 'nothing of the spec layer is visible to git');
  });

  describe('spec:hide-footprint/S7 legacy global block stays byte-identical', () => {
    const writeLegacyBlock = () => {
      const { home, dir, git } = env;
      const path = join(home, 'gitignore_global');
      writeFileSync(path, '# agent-workflow-kit hidden mode (machine-local; remove these lines to un-hide)\n/AGENTS.md\n/docs/ai/\n/docs/ai/.memory-version\n');
      git(['config', 'core.excludesFile', path]);
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      return { path, before: readFileSync(path) };
    };

    for (const [title, flags] of [
      ['A: hide keeps the global bytes and names the removal item', []],
      ['B: reconcile on a hidden deployment keeps the global bytes and names the removal item', ['--reconcile']],
      ['C: unhide after the hide keeps the global bytes and names the removal item', ['--unhide']],
    ]) {
      it(title, () => {
        const { dir, git, deps } = env;
        const { path, before } = writeLegacyBlock();
        if (flags.length > 0) hideFootprint({ dir }, deps);
        const lines = [];
        const errors = [];
        const log = (text) => lines.push(...text.split('\n'));
        const errlog = (text) => errors.push(text);
        assert.equal(main([...flags, '--dir', dir], { ...deps, log, errlog }), 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(readFileSync(path), before);
        assert.deepEqual(lines.filter((line) => line.includes('residual legacy machine-global block')), [
          `  • residual legacy machine-global block in ${path} (3 path line(s)) — KEPT + reported; the advisor's footprint-global item removes it (with a printed backup)`,
        ]);
        assert.ok(!lines.some((line) => line.includes('pass --remove-global')));
        if (flags.length === 0) assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/);
      });
    }

    it('D: an old caller removeGlobal option keeps the global bytes', () => {
      const { dir, deps } = env;
      const { path, before } = writeLegacyBlock();
      const r = hideFootprint({ dir, removeGlobal: true }, deps);
      assert.equal(r.global.action, 'kept');
      assert.deepEqual(readFileSync(path), before);
    });
  });

  describe('visibility inference (D16)', () => {
    it('tracked anchor → VISIBLE → --reconcile writes zero bytes', () => {
      const { dir, git, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      git(['add', 'AGENTS.md']);
      const before = readExclude(dir);
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.visibility, 'visible');
      assert.equal(readExclude(dir), before, 'no bytes written in visible mode');
    });

    it('untracked + ignored anchor → HIDDEN → --reconcile runs the hide', () => {
      const { dir, git, deps } = env;
      const globalExcludes = join(env.home, 'gitignore_global');
      writeFileSync(globalExcludes, '/AGENTS.md\n');
      git(['config', 'core.excludesFile', globalExcludes]);
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.visibility, 'hidden');
      assert.ok(r.wrote.includes('/AGENTS.md'));
    });

    it('untracked + not ignored anchor → AMBIGUOUS → --reconcile surfaces it, writes nothing', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const before = readExclude(dir);
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.ambiguous, true);
      assert.equal(r.visibility, 'ambiguous');
      assert.equal(readExclude(dir), before, 'ambiguous → no write, agent ASKs');
    });
  });

  describe('mixed-ending reconcile reproduction (spec:hide-footprint/S1)', () => {
    it('dry-run and applied reconcile answer noop and preserve every byte', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      hideFootprint({ dir }, deps);
      const before = readExclude(dir).replaceAll('\n', '\r\n') + `${MS}\n/.claude/skills\n${ME}\n`;
      writeFileSync(join(dir, '.git/info/exclude'), before);
      for (const dryRun of [true, false]) {
        const result = hideFootprint({ dir, reconcile: true, dryRun }, deps);
        assert.equal(result.action, 'noop');
        assert.equal(readExclude(dir), before);
      }
    });
  });

  describe('foreign block preservation and fence placement (spec:hide-footprint/S2)', () => {
    it('hide, reconcile and unhide keep the indented LF block and grant no high-risk consent', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      writeFileSync(join(dir, 'GEMINI.md'), '# foreign\n');
      const BLOCK = `  ${MS}\n/CLAUDE.md\n/GEMINI.md\n  ${ME}\n`;
      writeFileSync(join(dir, '.git/info/exclude'), `# mine\r\n${BLOCK}# tail\r\n`);
      for (const options of [{}, { reconcile: true }, { unhide: true }]) {
        const result = hideFootprint({ dir, ...options }, deps);
        const content = readExclude(dir);
        assert.ok(content.indexOf(BLOCK) >= 0);
        assert.equal(count(content, BLOCK), 1);
        assert.equal(count(content, '/GEMINI.md'), 1);
        if (!options.unhide) {
          assert.deepEqual(result.removedOutside, []);
          assert.ok(!result.wrote.includes('/GEMINI.md'));
          assert.ok(result.asks.some((ask) => ask.path === '/GEMINI.md'));
        }
      }
    });

    it('creates the fence after a terminated foreign block', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const block = `${MS}\n/x\n${ME}\n`;
      writeFileSync(join(dir, '.git/info/exclude'), `# mine\r\n${block}`);
      assert.equal(hideFootprint({ dir }, deps).action, 'created');
      const content = readExclude(dir);
      assert.ok(content.includes(block));
      assert.ok(content.indexOf(S) > content.indexOf(ME));
    });

    it('creates the fence immediately before a foreign block with no final line ending', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const block = `${MS}\n/x\n${ME}`;
      writeFileSync(join(dir, '.git/info/exclude'), `# mine\r\n${block}`);
      assert.equal(hideFootprint({ dir }, deps).action, 'created');
      assert.ok(readExclude(dir).endsWith(`${E}\r\n${block}`));
    });
  });

  describe('verbatim removed lines in file order (spec:hide-footprint/S3)', () => {
    const OUT = ['docs/ai/', '# standalone local-dev agent skills (AD-013)'];
    const captureReport = (argv, deps) => {
      const lines = [];
      const errors = [];
      const log = (text) => lines.push(...text.split('\n'));
      const errlog = (text) => errors.push(text);
      assert.equal(main(argv, { ...deps, log, errlog }), 0);
      assert.deepEqual(errors, []);
      return lines;
    };

    it('dry-run and apply list each removed line after all deltas and fold the rule into the fence', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const before = OUT.join('\n') + '\n';
      writeFileSync(join(dir, '.git/info/exclude'), before);
      assert.deepEqual(hideFootprint({ dir, dryRun: true }, deps).removedOutside, OUT);
      assert.equal(readExclude(dir), before);
      for (const [flags, verb] of [[['--dry-run'], 'would-remove'], [[], 'removed']]) {
        const lines = captureReport(['--dir', dir, ...flags], deps);
        const machineLines = lines.map((line) => line.trimStart()).filter((line) => line.startsWith('[hide-footprint] '));
        assert.deepEqual(machineLines, OUT.map((line) => `[hide-footprint] ${verb}=${line}`));
        const deltaIndexes = lines.flatMap((line, index) => /^• [+−]/u.test(line.trim()) ? [index] : []);
        assert.ok(deltaIndexes.length > 0);
        for (const [index, line] of lines.entries()) {
          if (line.trimStart().startsWith('[hide-footprint] ')) assert.ok(deltaIndexes.every((delta) => delta < index));
        }
        if (verb === 'would-remove') assert.equal(readExclude(dir), before);
      }
      const content = readExclude(dir);
      const ruleIndex = content.indexOf('/docs/ai/\n');
      assert.ok(ruleIndex > content.indexOf(S) && ruleIndex < content.indexOf(E));
      for (const line of OUT) assert.ok(!content.split('\n').includes(line));
    });

    it('subsequent apply and dry-run print no removal lines and return an empty removedOutside', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      writeFileSync(join(dir, '.git/info/exclude'), OUT.join('\n') + '\n');
      hideFootprint({ dir }, deps);
      for (const flags of [[], ['--dry-run']]) {
        const lines = captureReport(['--dir', dir, ...flags], deps);
        assert.ok(!lines.some((line) => /^\[hide-footprint\] (?:removed|would-remove)=/u.test(line.trim())));
        assert.deepEqual(hideFootprint({ dir, dryRun: flags.length > 0 }, deps).removedOutside, []);
      }
    });
  });

  describe('malformed blocks refuse without writing (spec:hide-footprint/S4)', () => {
    const shapes = [
      ['damaged-fence-pair', ['# >>> agent-workflow-kit hidden mode v2 >>>', '/AGENTS.md', '# <<< agent-workflow-kit hidden mode v2 <<<'], 2],
      ['fence-start-in-masks', [MS, S, '/AGENTS.md', E, ME], 3],
      ['masks-opener-in-fence', [S, MS, '/x', ME, E], 3],
      ['closer-without-opener', [ME], 2],
      ['fence-end-after-masks-opener', [MS, '/x', E], 4],
      ['masks-closer-after-fence-start', [S, '/AGENTS.md', ME], 4],
      ['masks-closer-without-trailing', [MS, '/x', '# <<< agent-workflow sandbox-masks'], 4],
      ['v2-opener-masks-closer', ['# >>> agent-workflow sandbox-masks-v2 — managed block >>>', '/x', ME], 4],
      ['masks-shorter-closer', [MS, '/x', '# <<< agent-workflow <<<'], 4],
      ['never-closed', [MS, '/x'], 2],
      ['repeated-same-wording', [MS, '/x', ME, MS, '/y', ME], 5],
      ['repeated-other-wording', [MS, '/x', ME, '# >>> agent-workflow sandbox-masks — other words >>>', '/y', ME], 7],
    ];
    const modes = [['apply', []], ['dry-run', ['--dry-run']], ['unhide', ['--unhide']]];
    for (const [id, lines, faultLine] of shapes) {
      for (const [mode, flags] of modes) {
        it(`${id}: ${mode} refuses at line ${faultLine} and preserves every byte`, () => {
          const { dir, deps } = env;
          writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
          const before = ['# mine', ...lines].join('\n') + '\n';
          writeFileSync(join(dir, '.git/info/exclude'), before);
          const output = [];
          const errors = [];
          const log = (text) => output.push(...text.split('\n'));
          const errlog = (text) => errors.push(text);
          assert.equal(main(['--dir', dir, ...flags], { ...deps, log, errlog }), 1);
          const message = errors.join('\n');
          assert.ok(message.startsWith(`[agent-workflow-kit] refusing to edit a malformed managed block in ${excludePath(deps, dir)}`));
          assert.match(message, new RegExp(`\\bline ${faultLine}\\b`, 'u'));
          assert.equal(readExclude(dir), before);
        });
      }
    }
  });
});
