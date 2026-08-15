// entrypoint-closure.test.mjs — the same D6 invariant for the KIT's own fallback bootstrap: every
// `docs/ai` reference in the WHOLE Memory Map section of the entry-point template it deploys must
// resolve to a shipped template, a GENERATED artifact whose finalizer the fallback prose documents,
// or an EXACT closed exception list. The kit duplicated the memory substrate's broken navigator
// reference once already; this is the checker that makes the duplication impossible to reintroduce.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(KIT_ROOT, 'references', 'templates');
const ENTRY_POINT = join(TEMPLATES, 'AGENTS.md');
// The fallback bootstrap prose — the kit's own deploy path when no memory substrate is installed.
const BOOTSTRAP_PROSE = join(KIT_ROOT, 'references', 'modes', 'bootstrap.md');

const DOCS_AI = 'docs/ai/';
const MEMORY_MAP_HEADING = 'Memory Map';
const FINALIZER_FLAG = '--ensure-index';
const GENERATED = Object.freeze(['docs/ai/index.md']);
const EXCEPTIONS = Object.freeze(['docs/ai/history/']);

const memoryMapSection = (text) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(MEMORY_MAP_HEADING));
  assert.notEqual(start, -1, 'the entry-point template must carry a Memory Map section');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

const referencesIn = (section) => {
  const found = new Set();
  for (const match of section.matchAll(/docs\/ai\/[A-Za-z0-9_./-]*/g)) {
    const raw = match[0];
    // Trailing punctuation is prose, not path — EXCEPT when the segment IS a traversal: trimming
    // `docs/ai/..` first would collapse it to the bare directory and drop the one reference this
    // guard must refuse out loud.
    const ref = raw.split('/').includes('..') ? raw : raw.replace(/\.+$/, '');
    if (ref !== DOCS_AI) found.add(ref);
  }
  return [...found].sort();
};

// A `..` segment would let `join()` resolve a reference OUTSIDE the shipped template set and pass a
// stray repo file off as deployed content — the reference is refused by shape, before any lookup.
const isShippedTemplate = (ref) => {
  const rel = ref.slice(DOCS_AI.length);
  if (rel === '' || rel.split('/').includes('..')) return false;
  return existsSync(join(TEMPLATES, rel));
};

const section = memoryMapSection(readFileSync(ENTRY_POINT, 'utf8'));
const references = referencesIn(section);
const prose = readFileSync(BOOTSTRAP_PROSE, 'utf8');

describe('entry-point closure (kit fallback) — every docs/ai reference resolves', () => {
  it('the Memory Map names references at all (a vacuous section would pass everything)', () => {
    assert.ok(references.length >= 5, `expected the Memory Map to name several docs/ai files, got ${references.length}`);
    assert.ok(references.includes('docs/ai/index.md'), 'the always-loaded navigator is the reference this guard exists for');
  });

  it('every reference is shipped, generated, or a declared exception', () => {
    const unresolved = references.filter((ref) => !isShippedTemplate(ref) && !GENERATED.includes(ref));
    assert.deepEqual(
      unresolved,
      [...EXCEPTIONS],
      'a docs/ai reference the fallback deploy never creates — ship a template, generate it with a documented finalizer, or declare it here',
    );
  });

  it('the generated set is never ALSO shipped as a template (one writer, no split brain)', () => {
    for (const ref of GENERATED) {
      assert.equal(isShippedTemplate(ref), false, `${ref} is generated — a template beside the generator is a second source of truth`);
    }
  });

  it('a traversal reference can never pass as a shipped template', () => {
    assert.equal(isShippedTemplate('docs/ai/../../package.json'), false);
    assert.equal(isShippedTemplate('docs/ai/'), false);
    assert.equal(isShippedTemplate('docs/ai/handover.md'), true, 'and a real template still resolves');
  });

  it('a traversal reference SURVIVES extraction instead of being normalized away', () => {
    assert.deepEqual(referencesIn('see docs/ai/.. and docs/ai/history/.. here'), ['docs/ai/..', 'docs/ai/history/..']);
    assert.deepEqual(referencesIn('the map names docs/ai/handover.md.'), ['docs/ai/handover.md']);
  });

  it('the fallback bootstrap prose documents a finalizer for every generated reference', () => {
    for (const ref of GENERATED) {
      assert.ok(prose.includes(ref), `the fallback prose must name ${ref} as the artifact it materializes`);
      assert.ok(prose.includes(FINALIZER_FLAG), `the fallback prose must run the ${FINALIZER_FLAG} finalizer that writes ${ref}`);
    }
  });
});
