// check-docs-size-ensure.test.mjs — the navigator WRITE contract (containment + atomic publication)
// and the idempotent `--ensure-index` finalizer mode. A separate file because the main spec pair is
// suite-parity-frozen; single responsibility: what the write refuses, and what the mode reports.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './check-docs-size.mjs';

const DOC = (title) =>
  `---\ntype: state\nlastUpdated: 2026-08-15\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# ${title}\n`;

const makeTree = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'ai', 'a.md'), DOC('a'));
  return dir;
};

const drop = (...dirs) => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};

const tempFiles = (docsAi) => readdirSync(docsAi).filter((name) => name.endsWith('.tmp'));

describe('check-docs-size navigator write — containment', () => {
  it('refuses a symlinked index.md, exit 2, naming the path', async () => {
    const root = makeTree('cds-leaf-');
    const target = mkdtempSync(join(tmpdir(), 'cds-leaf-target-'));
    try {
      const indexPath = join(root, 'docs', 'ai', 'index.md');
      symlinkSync(join(target, 'sink.md'), indexPath);
      const { code, stderr } = await runCli(['--write-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.match(stderr, /symlink/);
      assert.ok(stderr.includes(indexPath), `refusal must name ${indexPath}, got: ${stderr}`);
    } finally {
      drop(root, target);
    }
  });

  it('refuses a symlinked docs/ai, exit 2, naming the path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cds-docsai-'));
    const real = mkdtempSync(join(tmpdir(), 'cds-docsai-real-'));
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(real, 'a.md'), DOC('a'));
      symlinkSync(real, join(root, 'docs', 'ai'));
      const { code, stderr } = await runCli(['--write-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.ok(stderr.includes(join(root, 'docs', 'ai')), `refusal must name the symlinked dir, got: ${stderr}`);
    } finally {
      drop(root, real);
    }
  });

  it('refuses a symlinked docs, exit 2, naming the path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cds-docs-'));
    const real = mkdtempSync(join(tmpdir(), 'cds-docs-real-'));
    try {
      mkdirSync(join(real, 'ai'), { recursive: true });
      writeFileSync(join(real, 'ai', 'a.md'), DOC('a'));
      symlinkSync(real, join(root, 'docs'));
      const { code, stderr } = await runCli(['--write-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.ok(stderr.includes(join(root, 'docs')), `refusal must name the symlinked dir, got: ${stderr}`);
    } finally {
      drop(root, real);
    }
  });

  it('refuses a symlinked project root, exit 2, naming the path', async () => {
    const real = makeTree('cds-root-real-');
    const host = mkdtempSync(join(tmpdir(), 'cds-root-host-'));
    const link = join(host, 'project');
    try {
      symlinkSync(real, link);
      const { code, stderr } = await runCli(['--write-index', `--root=${link}`]);
      assert.equal(code, 2);
      assert.ok(stderr.includes(link), `refusal must name the symlinked root, got: ${stderr}`);
    } finally {
      drop(real, host);
    }
  });

  it('writes an absent index rather than refusing it', async () => {
    const root = makeTree('cds-absent-');
    try {
      const { code } = await runCli(['--write-index', `--root=${root}`]);
      assert.equal(code, 0);
      assert.ok(existsSync(join(root, 'docs', 'ai', 'index.md')));
    } finally {
      drop(root);
    }
  });

  // The temp name is exclusive-create for a reason: a collision means the name is SOMEONE ELSE's
  // file, which this run never wrote and must never delete.
  it('never removes a temp name it lost the exclusive-create race for', async () => {
    const root = makeTree('cds-collision-');
    const removed = [];
    try {
      const { code, stderr } = await runCli(['--write-index', `--root=${root}`], {
        writeFile: () => {
          throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
        },
        rm: (target) => { removed.push(target); },
      });
      assert.equal(code, 2);
      assert.match(stderr, /EEXIST/);
      assert.deepEqual(removed, [], 'a collision is not this run\'s file to discard');
    } finally {
      drop(root);
    }
  });

  it('discards the temp when the write itself dies mid-flight', async () => {
    const root = makeTree('cds-partial-');
    const removed = [];
    try {
      const { code } = await runCli(['--write-index', `--root=${root}`], {
        writeFile: () => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        },
        rm: (target) => { removed.push(target); },
      });
      assert.equal(code, 2);
      assert.equal(removed.length, 1, 'the partially-created temp is the run\'s own to discard');
      assert.match(removed[0], /\.tmp$/);
    } finally {
      drop(root);
    }
  });

  it('names the temp it could not remove instead of swallowing the cleanup failure', async () => {
    const root = makeTree('cds-cleanup-');
    try {
      const { code, stderr } = await runCli(['--write-index', `--root=${root}`], {
        rename: () => {
          throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
        },
        rm: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        },
      });
      assert.equal(code, 2);
      assert.match(stderr, /could not be removed/);
      assert.match(stderr, /\.tmp/);
    } finally {
      drop(root);
    }
  });

  it('leaves no temp file and no index behind when the publication fails', async () => {
    const root = makeTree('cds-tmp-');
    try {
      const { code } = await runCli(['--write-index', `--root=${root}`], {
        rename: () => {
          throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
        },
      });
      assert.equal(code, 2);
      assert.deepEqual(tempFiles(join(root, 'docs', 'ai')), []);
      assert.equal(existsSync(join(root, 'docs', 'ai', 'index.md')), false);
    } finally {
      drop(root);
    }
  });
});

describe('check-docs-size --ensure-index', () => {
  it('reports regenerated and materializes the navigator on a fresh tree', async () => {
    const root = makeTree('cds-ensure-fresh-');
    try {
      const { code, stdout } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 0);
      assert.match(stdout, /ensure-index: regenerated/);
      const { code: checkCode } = await runCli(['--check-index', `--root=${root}`]);
      assert.equal(checkCode, 0);
    } finally {
      drop(root);
    }
  });

  it('reports already-current on a second run and leaves the bytes identical', async () => {
    const root = makeTree('cds-ensure-idem-');
    try {
      await runCli(['--ensure-index', `--root=${root}`]);
      const first = readFileSync(join(root, 'docs', 'ai', 'index.md'), 'utf8');
      const { code, stdout } = await runCli(['--ensure-index', `--root=${root}`, '--today=2027-01-01']);
      assert.equal(code, 0);
      assert.match(stdout, /ensure-index: already-current/);
      assert.equal(readFileSync(join(root, 'docs', 'ai', 'index.md'), 'utf8'), first);
    } finally {
      drop(root);
    }
  });

  // A symlink whose TARGET happens to hold the current bytes reads as fresh through the link — so a
  // freshness-first finalizer would report `already-current` over a file it would never write
  // through: an exit 0 that proves nothing about the deployment's own navigator.
  it('refuses a symlinked navigator even when its target holds the CURRENT bytes', async () => {
    const root = makeTree('cds-ensure-symlink-fresh-');
    try {
      const indexPath = join(root, 'docs', 'ai', 'index.md');
      await runCli(['--ensure-index', `--root=${root}`]);
      const current = readFileSync(indexPath, 'utf8');
      rmSync(indexPath);
      const target = join(root, 'elsewhere-index.md');
      writeFileSync(target, current);
      symlinkSync(target, indexPath);

      const { code, stdout, stderr } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 2, `a symlinked navigator must be refused, got: ${stdout}${stderr}`);
      assert.match(stderr, /ensure-index: write-refused/);
      assert.equal(readFileSync(target, 'utf8'), current, 'the link target is untouched');
    } finally {
      drop(root);
    }
  });

  // The two refusals name STAGES: a reader told the PROBE failed will go looking at the tree, while
  // a write that died may have left the navigator half-published.
  it('reports a WRITE failure as write-refused, never as a failed probe', async () => {
    const root = makeTree('cds-write-stage-');
    try {
      const { code, stderr } = await runCli(['--ensure-index', `--root=${root}`], {
        writeFile: () => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        },
        rm: () => {},
      });
      assert.equal(code, 2);
      assert.match(stderr, /ensure-index: write-refused/);
      assert.match(stderr, /EIO/);
    } finally {
      drop(root);
    }
  });

  // "Could not read" is not "nothing there": a finalizer that swallowed the difference would publish
  // a navigator missing whatever it failed to see, and report success over it.
  it('refuses a tree it cannot fully read instead of writing an incomplete navigator', async () => {
    const root = makeTree('cds-strict-meta-');
    try {
      const { code, stderr } = await runCli(['--ensure-index', `--root=${root}`], {
        readdir: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      });
      assert.equal(code, 2);
      assert.match(stderr, /ensure-index: probe-failed/);
      assert.match(stderr, /EACCES/);
      assert.equal(existsSync(join(root, 'docs', 'ai', 'index.md')), false, 'nothing written over a tree it could not read');
    } finally {
      drop(root);
    }
  });

  // "Unknown" must not read as "empty" either: a reader that throws WITHOUT an fs code is still not
  // evidence that the tree is absent, so the finalizer refuses rather than publishing a short index.
  it('refuses a code-less read failure too, instead of treating it as an absence', async () => {
    const root = makeTree('cds-codeless-');
    try {
      const { code, stderr } = await runCli(['--ensure-index', `--root=${root}`], {
        readdir: () => {
          throw new Error('the injected reader failed without an fs code');
        },
      });
      assert.equal(code, 2);
      assert.match(stderr, /ensure-index: probe-failed/);
      assert.equal(existsSync(join(root, 'docs', 'ai', 'index.md')), false);
    } finally {
      drop(root);
    }
  });

  it('a MALFORMED package.json stays the documented basename fallback, never a refusal', async () => {
    const root = makeTree('cds-badpkg-');
    try {
      writeFileSync(join(root, 'package.json'), '{ not json');
      const { code, stdout } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 0, 'authored content that is malformed is not an unreadable tree');
      assert.match(stdout, /ensure-index: regenerated/);
    } finally {
      drop(root);
    }
  });

  it('closes with ONE named probe-failed line when the tree cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cds-ensure-nodocs-'));
    try {
      const { code, stderr } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.match(stderr, /ensure-index: probe-failed/);
      assert.equal(/at .*check-docs-size/.test(stderr), false, 'a named refusal, never a stack trace');
    } finally {
      drop(root);
    }
  });

  it('reports a named write-refused, exit 2, when the write cannot be published', async () => {
    const root = makeTree('cds-ensure-refused-');
    const target = mkdtempSync(join(tmpdir(), 'cds-ensure-refused-target-'));
    try {
      const indexPath = join(root, 'docs', 'ai', 'index.md');
      symlinkSync(join(target, 'sink.md'), indexPath);
      const { code, stderr } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.match(stderr, /ensure-index: write-refused/);
      assert.ok(stderr.includes(indexPath), `the refusal must name ${indexPath}, got: ${stderr}`);
    } finally {
      drop(root, target);
    }
  });

  it('reports regenerated when the on-disk navigator went stale', async () => {
    const root = makeTree('cds-ensure-stale-');
    try {
      await runCli(['--ensure-index', `--root=${root}`]);
      writeFileSync(join(root, 'docs', 'ai', 'b.md'), DOC('b'));
      const { code, stdout } = await runCli(['--ensure-index', `--root=${root}`]);
      assert.equal(code, 0);
      assert.match(stdout, /ensure-index: regenerated/);
      const { code: checkCode } = await runCli(['--check-index', `--root=${root}`]);
      assert.equal(checkCode, 0);
    } finally {
      drop(root);
    }
  });
});
