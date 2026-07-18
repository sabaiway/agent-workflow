// check-docs-size-cli.test.mjs — runCli branch pins the subprocess smokes cannot reach
// in-process (Phase-5 coverage fill; the main spec file is parity-frozen, so these ride a
// colocated file): the unknown-argument refusal and the written-empty-index guard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './check-docs-size.mjs';

const cli = async (argv) => {
  const { code, stdout, stderr } = await runCli(argv);
  return { code, stdout, stderr };
};

describe('check-docs-size runCli — refusal branches', () => {
  it('an unknown argument exits 2 naming it', async () => {
    const { code, stderr } = await cli(['--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown argument: --bogus/);
  });

  it('--write-index landing on a sink path (index stat size 0) is the loud written-empty refusal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cds-cli-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      writeFileSync(
        join(root, 'docs', 'ai', 'a.md'),
        '---\ntype: state\nlastUpdated: 2026-07-18\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# a\n',
      );
      // The index path is a symlink into /dev/null: the write lands, the stat reads size 0 —
      // the guard must refuse loudly instead of reporting a written index.
      symlinkSync('/dev/null', join(root, 'docs', 'ai', 'index.md'));
      const { code, stderr } = await cli(['--write-index', `--root=${root}`]);
      assert.equal(code, 2);
      assert.match(stderr, /index\.md was written empty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
