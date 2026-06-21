import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The memory substrate must "know nobody": it ships ONLY its own capability.json and NO
// family-wide tooling (schema/validator/injection/scanner — those are owned by the composition
// root). This guards the DAG at the package-content level.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_FILES = new Set([
  'validate.mjs',
  'schema.md',
  'inject-methodology.mjs',
  'methodology-slot.md',
  'release-scan.mjs',
]);
const FORBIDDEN_DIRS = new Set(['tools', 'manifest']);

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      acc.push({ kind: 'dir', name: entry, full });
      walk(full, acc);
    } else {
      acc.push({ kind: 'file', name: entry, full });
    }
  }
  return acc;
};

describe('memory package content — DAG guard (knows nobody)', () => {
  const entries = walk(ROOT);

  it('ships no family-wide tooling files', () => {
    const leaks = entries.filter((e) => e.kind === 'file' && FORBIDDEN_FILES.has(e.name));
    assert.deepEqual(leaks.map((e) => e.full), [], 'family tooling must not ship in the memory package');
  });

  it('has no tools/ or manifest/ directory', () => {
    const leaks = entries.filter((e) => e.kind === 'dir' && FORBIDDEN_DIRS.has(e.name));
    assert.deepEqual(leaks.map((e) => e.full), []);
  });

  it('package.json files[] does not enumerate any family tooling', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const offending = (pkg.files ?? []).filter((f) => /tools|manifest|validate|schema\.md|inject-methodology|release-scan/.test(f));
    assert.deepEqual(offending, []);
  });

  it('does ship its own capability.json (the only manifest it owns)', () => {
    assert.ok(entries.some((e) => e.kind === 'file' && e.name === 'capability.json' && basename(dirname(e.full)) === basename(ROOT)));
  });

  it('no source file names a specific sibling skill (knows nobody — generic "composition root" only)', () => {
    // Built from fragments so the literal sibling names never appear in THIS test's own source
    // (otherwise the walk below would flag this file).
    const d = '-';
    const SIBLINGS = [
      ['agent', 'workflow', 'kit'].join(d),
      ['codex', 'cli', 'bridge'].join(d),
      ['antigravity', 'cli', 'bridge'].join(d),
      ['agent', 'workflow', 'engine'].join(d),
    ];
    const offenders = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !/\.(md|mjs|json|sh|ya?ml)$/.test(e.name)) continue;
      const text = readFileSync(e.full, 'utf8');
      for (const sibling of SIBLINGS) {
        if (text.includes(sibling)) offenders.push(`${e.full} → "${sibling}"`);
      }
    }
    assert.deepEqual(offenders, [], 'memory must reference only the generic composition root, never a named sibling');
  });
});
