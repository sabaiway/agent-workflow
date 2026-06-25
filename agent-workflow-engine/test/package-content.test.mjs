import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The methodology engine ships ONLY its own capability.json + the methodology canon
// (references/) and NO family-wide tooling (schema/validator/injection/scanner — those are
// owned by the composition root). This guards the DAG at the package-content level. Unlike
// memory's guard, methodology-slot.md is NOT forbidden here: the engine legitimately ships
// references/methodology-slot.md as its OWN canon (memory forbids it because there it is the
// kit's tooling copy). planning.md is likewise the engine's own canon.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_FILES = new Set([
  'validate.mjs',
  'schema.md',
  'inject-methodology.mjs',
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

describe('engine package content — DAG guard (knows nobody)', () => {
  const entries = walk(ROOT);

  it('ships no family-wide tooling files', () => {
    const leaks = entries.filter((e) => e.kind === 'file' && FORBIDDEN_FILES.has(e.name));
    assert.deepEqual(leaks.map((e) => e.full), [], 'family tooling must not ship in the engine package');
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

  it('package.json files[] ships the methodology canon (references/) and excludes the monorepo-only test/', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const files = pkg.files ?? [];
    assert.ok(files.includes('references/'), 'references/ (the methodology canon) must ship');
    assert.ok(files.every((f) => !/^test\/?$/.test(f)), 'the monorepo-only test/ dir must not ship in the tarball');
  });

  // Guard the REAL tarball, not just files[]: a regression that drops a payload entry (bin/install.mjs,
  // the canon, LICENSE…) or accidentally ships test/ would pass the files[] checks above but break the
  // published package. `npm pack --dry-run --json` reports exactly what would ship. If you intentionally
  // add or remove a shipped file, update EXPECTED_TARBALL below in the same change.
  it('npm pack ships exactly the expected payload (no missing canon, no test/ leak)', () => {
    const EXPECTED_TARBALL = [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'SKILL.md',
      'bin/install.mjs',
      'capability.json',
      'package.json', // npm always includes the manifest, even though files[] does not list it
      'references/methodology-slot.md',
      'references/planning.md',
    ].sort();
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
    const actual = JSON.parse(res.stdout)[0].files.map((f) => f.path).sort();
    assert.deepEqual(actual, EXPECTED_TARBALL, 'the published tarball drifted from the expected payload');
    assert.ok(!actual.some((p) => /(^|\/)test\//.test(p) || p === 'test'), 'no test/ file may ship in the tarball');
  });
});
