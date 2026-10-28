import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// One-home guard for the planning/review/process-fidelity lens. Its ONE canonical home is the
// engine's lens rules theme (LENS_THEME_REL of engine-source.mjs), which the kit's rules op lays
// down as docs/ai/rules/lens.md; no kit or memory file the packages ship carries a copy of a
// lens bullet, so an engine-only wording release never needs a mirror edit. Token presence is
// pinned once, in the engine's own lens-fragment.test.mjs.
//
// Reads the full monorepo checkout (sibling packages present) — the same cross-package precedent
// as lineage-head-drift.test.mjs / bridges-mirror.test.mjs. Lives under test/ (never ships).
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');
const ENGINE_ROOT = join(FAMILY_ROOT, 'agent-workflow-engine');
const SHIPPED_ROOTS = [join(KIT_ROOT, 'references'), join(FAMILY_ROOT, 'agent-workflow-memory', 'references')];

const listFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? listFiles(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
});
const themeBullets = async () => {
  const { LENS_THEME_REL } = await import('../tools/engine-source.mjs');
  assert.equal(typeof LENS_THEME_REL, 'string', 'engine-source.mjs exports LENS_THEME_REL');
  const bullets = readFileSync(join(ENGINE_ROOT, LENS_THEME_REL), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((line) => line.startsWith('- '));
  assert.ok(bullets.length > 0, 'the engine lens theme carries bullets');
  return bullets;
};
const copiesIn = (bullets, name, text) => {
  const lines = new Set(text.replace(/\r\n/g, '\n').split('\n'));
  return bullets.filter((bullet) => lines.has(bullet)).map((bullet) => `${name}: ${bullet.slice(0, 40)}`);
};

describe('the lens lives in the engine theme alone', () => {
  it('no file under the kit or memory references trees carries a bullet of the engine lens theme', async () => {
    const bullets = await themeBullets();
    assert.deepEqual(SHIPPED_ROOTS.flatMap(listFiles).flatMap((file) => copiesIn(bullets, relative(FAMILY_ROOT, file), readFileSync(file, 'utf8'))), []);
  });

  it('non-vacuity: a lens bullet pasted into a rules template copy is caught (injected)', async () => {
    const bullets = await themeBullets();
    const template = readFileSync(join(KIT_ROOT, 'references', 'templates', 'agent_rules.md'), 'utf8');
    assert.equal(copiesIn(bullets, 'pasted', `${template}\n${bullets[0]}\n`).length >= 1, true);
  });
});
