// inject-methodology-cli.test.mjs — runCli branch pins the converted main spec cannot carry
// (Phase-5 coverage fill; inject-methodology.test.mjs is parity-frozen): the empty-argv usage
// refusal, the LEGACY-mode malformed-slot refusal, and the non-exit error rethrow.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCli, START_MARKER, END_MARKER, ORCH_START_MARKER, ORCH_END_MARKER, AUTONOMY_START_MARKER, AUTONOMY_END_MARKER,
} from './inject-methodology.mjs';

const ANCHOR_CELL = '| [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) |';
const LAYOUT_ROW = '| [`docs/ai/rules/effective/project-layout.md`](./docs/ai/rules/effective/project-layout.md) | Creating, moving or naming a file, a module or a spec | Only through `/agent-workflow-kit rules` |';
const TEMPLATES = ['../references/templates/AGENTS.md', '../../agent-workflow-memory/references/templates/AGENTS.md'];
const SLOT_PAIRS = [[START_MARKER, END_MARKER], [ORCH_START_MARKER, ORCH_END_MARKER], [AUTONOMY_START_MARKER, AUTONOMY_END_MARKER]];

const readTemplate = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const fillSlots = (text) => SLOT_PAIRS.reduce((acc, [start, end]) => acc.replace(`${start}\n${end}`, `${start}\n> pointer line\n${end}`), text);
const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const lineAfterAnchor = (text) => {
  const lines = text.split('\n');
  return lines[lines.findIndex((line) => line.startsWith(ANCHOR_CELL)) + 1];
};
const withTempDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-row-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const reconcileIn = (dir, args) => runCli(['reconcile', ...args], { env: {}, home: dir });

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

describe('spec:project-rules/S29 reconcile keeps the project-layout Memory Map row', () => {
  it('adds the row in its one write after the three pointers; the explicit fragment form adds none', async () => {
    await withTempDir(async (dir) => {
      const agents = join(dir, 'AGENTS.md');
      writeFileSync(agents, fillSlots(readTemplate(TEMPLATES[0])));
      const { code, stdout } = await reconcileIn(dir, [agents]);
      assert.match(stdout, /^\[inject-methodology\] reconcile: workflow-methodology pointer already present; orchestration-recipes pointer already present; autonomy pointer already present; the project-layout Memory Map row added\.$/m);
      assert.equal(code, 0);
      assert.equal(lineAfterAnchor(readFileSync(agents, 'utf8')), LAYOUT_ROW, 'the row sits right after the agent_rules row');
      const bare = join(dir, 'BARE.md');
      const fragment = join(dir, 'fragment.md');
      writeFileSync(bare, readTemplate(TEMPLATES[0]));
      writeFileSync(fragment, '> methodology line\n');
      const explicit = await reconcileIn(dir, [bare, fragment]);
      assert.equal(explicit.code, 0);
      assert.match(explicit.stdout, /filled the empty workflow-methodology pointer\./);
      assert.ok(!readFileSync(bare, 'utf8').includes('docs/ai/rules/effective/project-layout.md'), 'the explicit fragment form adds no row');
    });
  });

  it('a second run prints the zero-diff line with the row clause and writes nothing', async () => {
    await withTempDir(async (dir) => {
      const agents = join(dir, 'AGENTS.md');
      writeFileSync(agents, fillSlots(readTemplate(TEMPLATES[0])));
      await reconcileIn(dir, [agents]);
      const settled = readFileSync(agents, 'utf8');
      const { code, stdout } = await reconcileIn(dir, [agents]);
      assert.match(stdout, /all three pointers already present and filled; the project-layout Memory Map row already present — nothing to do \(zero-diff\)\./);
      assert.equal(code, 0);
      assert.equal(readFileSync(agents, 'utf8'), settled, 'the second run leaves the file byte-identical');
    });
  });

  it('a file with no docs/ai/agent_rules.md row exits 0 with the skip and stays byte-identical', async () => {
    await withTempDir(async (dir) => {
      const agents = join(dir, 'AGENTS.md');
      const text = fillSlots(readTemplate(TEMPLATES[0])).split('\n').filter((line) => !line.startsWith(ANCHOR_CELL)).join('\n');
      writeFileSync(agents, text);
      const { code, stdout } = await reconcileIn(dir, [agents]);
      assert.match(stdout, /the project-layout Memory Map row skipped — the Memory Map has no docs\/ai\/agent_rules\.md row to place it after/);
      assert.equal(code, 0);
      assert.equal(readFileSync(agents, 'utf8'), text, 'pointers and table unchanged');
    });
  });

  it('each package template, its three pointers filled, goes from 99 lines to exactly 100 with the row after agent_rules', async () => {
    for (const rel of TEMPLATES) {
      await withTempDir(async (dir) => {
        const agents = join(dir, 'AGENTS.md');
        const filled = fillSlots(readTemplate(rel));
        writeFileSync(agents, filled);
        await reconcileIn(dir, [agents]);
        const out = readFileSync(agents, 'utf8');
        assert.deepEqual([countLines(filled), countLines(out)], [99, 100], rel);
        assert.equal(lineAfterAnchor(out), LAYOUT_ROW, rel);
      });
    }
  });
});
