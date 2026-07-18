// inject-methodology-cli.test.mjs — runCli branch pins the converted main spec cannot carry
// (Phase-5 coverage fill; inject-methodology.test.mjs is parity-frozen): the empty-argv usage
// refusal, the LEGACY-mode malformed-slot refusal, and the non-exit error rethrow.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, START_MARKER, END_MARKER } from './inject-methodology.mjs';

describe('inject-methodology runCli — refusal branches', () => {
  it('no AGENTS.md argument → usage on stderr, exit 2', async () => {
    const { code, stderr } = await runCli([]);
    assert.equal(code, 2);
    assert.match(stderr, /usage: inject-methodology\.mjs/);
  });

  it('LEGACY mode on a malformed (duplicate) slot → refusal, exit 1, file untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inject-cli-'));
    try {
      const agents = join(dir, 'AGENTS.md');
      const malformed = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
      writeFileSync(agents, malformed);
      const { code, stderr } = await runCli([agents]);
      assert.equal(code, 1);
      assert.match(stderr, /malformed slot — refusing to edit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-exit error (missing AGENTS path) is rethrown, never swallowed into a code', async () => {
    await assert.rejects(runCli(['reconcile', join(tmpdir(), 'definitely-missing', 'AGENTS.md')]), /ENOENT/);
  });
});
