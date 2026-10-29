// project-root.test.mjs — the one project-root finder: three levels above its module file's directory, in a
// deployment and in the canon alike; and the four CLIs that take it plus the installer, each run from a temp
// deployment's kit folder with cwd elsewhere, read and write under that deployment's root and nowhere else.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = dirname(HERE);
const KIT = join('scripts', 'agent-workflow');
const TODAY = '--today=2026-07-28';

const FM = (type, cap) => `---\ntype: ${type}\nlastUpdated: 2026-07-28\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n`;
const ADR = (id) => `## AD-${id} — Decision ${id}\n\n**Date:** 2026-01-01 · **Status:** Accepted\n\nbody of AD-${id}`;
const DOCS = {
  'changelog.md': `${FM('history', 700)}\n# Changelog\n\n## 2026-07-28 — hot iso\n\nbody hot.\n\n## 2026.07.10 — warm dotted\n\nbody warm.\n\n## 2026.03.02 — cold dotted\n\n**Goal:** cold body.\n`,
  'known_issues.md': `${FM('reference', 240)}\n# Known Issues\n\n### ~~Issue-001 — done long ago~~\n\n- **Status:** ✅ FIXED (2026.04.10)\n\n### Issue-002 — still open\n\n**Status:** Open\n`,
  'decisions.md': `${FM('reference', 400)}\n# ADRs\n\n> Newest at the bottom.\n\n${ADR('050')}\n\n${ADR('051')}\n`,
};

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key) && key !== 'NODE_TEST_CONTEXT'));
const envAt = (home) => ({ ...BASE_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

// Every file under a directory, relative path -> bytes, so a run that wrote anywhere in it shows.
const snapshot = (dir, rel = '') =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? snapshot(dir, child) : [[child, readFileSync(join(dir, child)).toString('base64')]];
  }).sort(([a], [b]) => (a < b ? -1 : 1));

// A temp deployment from the manifest's deployed entries, its root path holding a space and a #; a cwd outside it
// holds the same docs as a decoy, so a CLI that read or wrote the cwd changes it.
const withDeployment = async (run) => {
  const { readFamily } = await import('../family.mjs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'project-root-')));
  const [root, cwd, home] = [join(base, 'my project #1'), join(base, 'elsewhere'), join(base, 'home')];
  try {
    const deployed = readFamily(CANON).filter((entry) => entry.role === 'deployed').map((entry) => entry.path);
    for (const path of deployed) {
      mkdirSync(dirname(join(root, KIT, path)), { recursive: true });
      copyFileSync(join(CANON, path), join(root, KIT, path));
    }
    for (const dir of [root, cwd]) {
      mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
      for (const [name, text] of Object.entries(DOCS)) writeFileSync(join(dir, 'docs', 'ai', name), text);
      writeFileSync(join(dir, 'guard.mjs'), '// a stand-in commit-guard tool\n');
    }
    mkdirSync(home);
    const [cwdBefore, kitBefore] = [snapshot(cwd), snapshot(join(root, KIT))];
    const cli = (path, args) => spawnSync(process.execPath, [join(root, KIT, path), ...args], { cwd, env: envAt(home), encoding: 'utf8' });
    await run({ root, cwd, home, cli });
    assert.deepEqual(snapshot(cwd), cwdBefore, 'the cwd outside the deployment was read as a project and written');
    assert.deepEqual(snapshot(join(root, KIT)), kitBefore, 'a run wrote inside the kit folder, taking it for the root');
    assert.deepEqual(readdirSync(base).sort(), ['elsewhere', 'home', 'my project #1'], 'a run wrote beside the root');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};
const exits = (r, code) => assert.equal(r.status, code, `${r.stdout}${r.stderr}`);
const docsAt = (root, rel) => join(root, 'docs', 'ai', rel);

describe('spec:script-family/S8 the project root is three levels above the module file directory', () => {
  it('answers the deployment root for scripts/agent-workflow/<module>/ and the package for references/scripts/<module>/', async () => {
    const { findProjectRoot } = await import('./project-root.mjs');
    for (const name of ['plain', 'with space', 'hash #1', 'both # and space']) {
      const root = join(tmpdir(), name);
      const deployed = pathToFileURL(join(root, KIT, 'archives', 'archive-decisions.mjs'));
      const canon = pathToFileURL(join(root, 'references', 'scripts', 'docs-size', 'check-docs-size.mjs'));
      for (const url of [deployed, canon]) {
        assert.equal(resolve(findProjectRoot(url)), resolve(root), `${url.href} as a URL`);
        assert.equal(resolve(findProjectRoot(url.href)), resolve(root), `${url.href} as its href`);
      }
    }
    assert.equal(resolve(findProjectRoot(new URL('./project-root.mjs', import.meta.url))), resolve(CANON, '..', '..'), 'this canon file');
    assert.equal((await import('./index.mjs')).findProjectRoot, findProjectRoot, 'the shared index re-exports the one finder');
  });

  it('the docs checker reads and writes the deployment root: --check-index, then --write-index', async () => {
    await withDeployment(({ root, cli }) => {
      const checker = 'docs-size/check-docs-size.mjs';
      exits(cli(checker, ['--check-index', TODAY]), 1);
      exits(cli(checker, ['--write-index', TODAY]), 0);
      assert.match(readFileSync(docsAt(root, 'index.md'), 'utf8'), /\| \[`known_issues\.md`\]\(\.\/known_issues\.md\) \| reference \|/);
      exits(cli(checker, ['--check-index', TODAY]), 0);
    });
  });

  it('the changelog archiver checks, then rotates, the deployment root', async () => {
    await withDeployment(({ root, cli }) => {
      const checked = cli('archives/archive-changelog.mjs', ['--check', TODAY]);
      exits(checked, 1);
      assert.match(checked.stderr, /2026\.07\.10 — warm dotted/);
      exits(cli('archives/archive-changelog.mjs', [TODAY]), 0);
      assert.match(readFileSync(docsAt(root, 'history/recent.md'), 'utf8'), /warm dotted/);
      exits(cli('archives/archive-changelog.mjs', ['--check', TODAY]), 0);
    });
  });

  it('the issues archiver checks, then rotates, the deployment root', async () => {
    await withDeployment(({ root, cli }) => {
      const checked = cli('archives/archive-issues.mjs', ['--check', TODAY]);
      exits(checked, 1);
      assert.match(checked.stderr, /Issue-001/);
      exits(cli('archives/archive-issues.mjs', [TODAY]), 0);
      assert.match(readFileSync(docsAt(root, 'history/issues-resolved.md'), 'utf8'), /Issue-001/);
      exits(cli('archives/archive-issues.mjs', ['--check', TODAY]), 0);
    });
  });

  it('the decisions rotator checks the deployment root and writes its navigator there', async () => {
    await withDeployment(({ root, cli }) => {
      const stale = cli('archives/archive-decisions.mjs', ['--check', TODAY]);
      exits(stale, 1);
      assert.match(stale.stdout, /2 ADR\(s\) in the HOT window/);
      exits(cli('archives/archive-decisions.mjs', ['--write-navigator', TODAY]), 0);
      assert.ok(existsSync(docsAt(root, 'adr/log.md')), 'the navigator lands under the deployment root');
      assert.match(readFileSync(docsAt(root, 'index.md'), 'utf8'), /\[`adr\/`\]/, 'the spawned docs checker regenerated the root index');
      exits(cli('archives/archive-decisions.mjs', ['--check', TODAY]), 0);
    });
  });

  it('the installer writes the hook of the deployment root repository and resolves a relative guard there', async () => {
    await withDeployment(({ root, home, cli }) => {
      exits(spawnSync('git', ['init', '-q'], { cwd: root, env: envAt(home), encoding: 'utf8' }), 0);
      exits(cli('git-hooks/install-git-hooks.mjs', ['--commit-guard', 'guard.mjs']), 0);
      const hook = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
      assert.ok(hook.includes(`node "${join(root, 'guard.mjs')}" --check\n`), hook);
    });
  });
});
