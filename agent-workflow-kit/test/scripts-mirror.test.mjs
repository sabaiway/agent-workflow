import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Drift-guard: the memory substrate OWNS references/scripts/ (the enforcement scripts deployed
// into a consumer's scripts/); the kit ships a BYTE-IDENTICAL fallback copy so the bundled-
// fallback bootstrap path deploys the same bytes the delegated path does. Until now only the
// package-content pins existed (presence, not equality) — this test pins the mirror itself for
// ALL shared reference scripts, the bridges-mirror.test.mjs pattern: file-list set-equality +
// per-file byte equality.
//
// Lives under test/ (monorepo-only dev test — it reads the sibling memory package, which is
// outside the kit tarball); runs via the `agent-workflow-kit/test/*.test.mjs` gate glob.
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_SCRIPTS = join(HERE, '..', 'references', 'scripts');
const MEMORY_SCRIPTS = join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'scripts');

const listFiles = (root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

describe('reference-scripts mirror — kit fallback copies stay byte-identical to the memory canon', () => {
  it('file list set-equality (memory === kit)', () => {
    assert.deepEqual(
      listFiles(KIT_SCRIPTS),
      listFiles(MEMORY_SCRIPTS),
      'references/scripts file list drifted between memory and the kit fallback — re-sync the kit copy',
    );
  });

  it('every shared script byte-for-byte (memory === kit)', () => {
    for (const name of listFiles(MEMORY_SCRIPTS)) {
      const memoryBytes = readFileSync(join(MEMORY_SCRIPTS, name));
      const kitBytes = readFileSync(join(KIT_SCRIPTS, name));
      assert.ok(
        memoryBytes.equals(kitBytes),
        `references/scripts/${name} drifted between memory and the kit fallback — the two deploy paths would diverge`,
      );
    }
  });

  it('the mirror includes the ADR-store enforcement pair (reverse pin — a deleted pair must not pass silently)', () => {
    const files = listFiles(MEMORY_SCRIPTS);
    for (const required of ['archive-decisions.mjs', 'archive-decisions.test.mjs']) {
      assert.ok(files.includes(required), `references/scripts must ship ${required}`);
    }
  });

  // memory's own --ensure-current suite ships in neither package, so it also runs here against the kit copy: the
  // copy's lines execute under the gate's coverage, not only by byte equality.
  it("memory's own archive-decisions-ensure suite passes against the kit copy", () => {
    const suite = join(HERE, '..', '..', 'agent-workflow-memory', 'scripts', 'archive-decisions-ensure.test.mjs');
    const env = { ...process.env, AW_ARCHIVE_DECISIONS: join(KIT_SCRIPTS, 'archive-decisions.mjs') };
    delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it skips every test and exits 0
    // Node 22 picks tap for a piped stdout, spec only for a TTY: name the reporter the asserts read.
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^\u2139 pass [1-9]\d*$/m, r.stdout);
    assert.match(r.stdout, /^\u2139 fail 0$/m, r.stdout);
  });
});
