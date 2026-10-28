// inject-methodology-cli.test.mjs — the one command form of runCli: usage refusals and the rethrown filesystem error.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './inject-methodology.mjs';

const ENGINE_DIR = fileURLToPath(new URL('../../agent-workflow-engine', import.meta.url));
const BODY = '# demo\n\nproject text\n';

const withProject = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-cli-'));
  try {
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, BODY);
    await fn(dir, agents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const runIn = (dir, argv) => runCli(argv, { env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, home: dir });
const assertUsage = (result, dir, names = ['AGENTS.md']) => {
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /usage: inject-methodology\.mjs/);
  assert.equal(result.stdout, '');
  if (!dir) return;
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), BODY);
  assert.deepEqual(readdirSync(dir).sort(), names);
};

describe('spec:entry-pointers/S12 the entry point takes reconcile <AGENTS.md> alone', () => {
  it('no argument → usage on stderr, exit 2', async () => {
    assertUsage(await runCli([]));
  });

  it('a first word other than reconcile → usage on stderr, exit 2, the file untouched', async () => {
    await withProject(async (dir, agents) => {
      for (const argv of [[agents], ['inject', agents], ['Reconcile', agents]]) assertUsage(await runIn(dir, argv), dir);
    });
  });

  it('a third argument → usage on stderr, exit 2, the file untouched', async () => {
    await withProject(async (dir, agents) => {
      const fragment = join(dir, 'fragment.md');
      writeFileSync(fragment, '> methodology line\n');
      assertUsage(await runIn(dir, ['reconcile', agents, fragment]), dir, ['AGENTS.md', 'fragment.md']);
    });
  });

  it('a missing target path rejects with the filesystem error, never a composed line', async () => {
    await withProject(async (dir) => {
      await assert.rejects(runIn(dir, ['reconcile', join(dir, 'missing', 'AGENTS.md')]), { code: 'ENOENT' });
    });
  });
});
