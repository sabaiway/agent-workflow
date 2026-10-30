import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
const REPO = join(HERE, '..', '..');
const KIT_SCRIPTS = join(HERE, '..', 'references', 'scripts');
const MEMORY_SCRIPTS = join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'scripts');

// Every file of a tree, recursively, as POSIX paths relative to its root (the sync's own walk exclusions).
const walkFiles = (root, rel = '') =>
  readdirSync(join(root, rel), { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
    .flatMap((entry) => {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walkFiles(root, child);
      return entry.isFile() ? [child] : [];
    })
    .sort();

const execBits = (path) => statSync(path).mode & 0o111;

describe('reference-scripts mirror — kit fallback copies stay byte-identical to the memory canon', () => {
  it('the kit mirror holds exactly the canon tree, each file byte- and exec-bit-identical (spec:script-family/S5)', () => {
    const canon = walkFiles(MEMORY_SCRIPTS);
    assert.ok(canon.includes('family.json'), `the canon is not the nested family tree (no family.json): ${canon.join(' ')}`);
    assert.deepEqual(walkFiles(KIT_SCRIPTS), canon, 'references/scripts tree drifted between memory and the kit mirror — re-sync the kit copy');
    for (const rel of canon) {
      const [memoryPath, kitPath] = [join(MEMORY_SCRIPTS, rel), join(KIT_SCRIPTS, rel)];
      assert.ok(readFileSync(memoryPath).equals(readFileSync(kitPath)), `references/scripts/${rel} bytes drifted between memory and the kit mirror`);
      assert.equal(execBits(kitPath), execBits(memoryPath), `references/scripts/${rel} exec bit drifted between memory and the kit mirror`);
    }
  });

  it('the mirror includes the ADR-store enforcement pair (reverse pin — a deleted pair must not pass silently)', () => {
    const files = walkFiles(MEMORY_SCRIPTS);
    for (const required of ['archives/archive-decisions.mjs', 'archives/archive-decisions.test.mjs']) {
      assert.ok(files.includes(required), `references/scripts must ship ${required}`);
    }
  });

  // memory's own --ensure-current suite ships in neither package, so it also runs here against the kit copy: the
  // copy's lines execute under the gate's coverage, not only by byte equality.
  it("memory's own archive-decisions-ensure suite passes against the kit copy", () => {
    const suite = join(HERE, '..', '..', 'agent-workflow-memory', 'scripts', 'archive-decisions-ensure.test.mjs');
    const env = { ...process.env, AW_ARCHIVE_DECISIONS: join(KIT_SCRIPTS, 'archives', 'index.mjs') };
    delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it skips every test and exits 0
    // Node 22 picks tap for a piped stdout, spec only for a TTY: name the reporter the asserts read.
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', suite], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const info = String.fromCodePoint(0x2139); // the spec reporter's summary mark, kept out of the source as a code point
    assert.match(r.stdout, new RegExp(`^${info} pass [1-9][0-9]*$`, 'm'), r.stdout);
    assert.match(r.stdout, new RegExp(`^${info} fail 0$`, 'm'), r.stdout);
  });
});

// The .mjs files outside both trees: the kit, memory but its canon, the engine and this repository's scripts/.
const TREES = [MEMORY_SCRIPTS, KIT_SCRIPTS].map((tree) => resolve(tree));
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'docs']);
const outsideFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || TREES.includes(resolve(full))) return [];
    if (entry.isDirectory()) return outsideFiles(full);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [full] : [];
  });

// Static import and re-export clauses, side-effect imports and literal dynamic imports; a spawned CLI is no import.
const SPECIFIER_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\(\s*(['"])([^'"\n]+)\1\s*[,)]/g,
];

describe('spec:script-family/S11 imports from outside the trees name a module index', () => {
  it('every import of a tree file names its module index.mjs and no runtime file outside imports test-support/', () => {
    const crossings = [];
    const offenders = [];
    for (const file of ['agent-workflow-kit', 'agent-workflow-memory', 'agent-workflow-engine', 'scripts'].flatMap((root) => outsideFiles(join(REPO, root)))) {
      const text = readFileSync(file, 'utf8');
      const specifiers = SPECIFIER_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[2])).filter((s) => s.startsWith('.'));
      for (const specifier of new Set(specifiers)) {
        const target = resolve(dirname(file), specifier);
        const tree = TREES.find((root) => target.startsWith(root + sep));
        if (!tree) continue;
        const parts = relative(tree, target).split(sep);
        const where = `${relative(REPO, file)} -> ${specifier}`;
        crossings.push(where);
        const door = parts.length === 1 || (parts.length === 2 && parts[1] === 'index.mjs');
        if (!door) offenders.push(`${where} (not a module index)`);
        if (parts[0] === 'test-support' && !file.endsWith('.test.mjs')) offenders.push(`${where} (a runtime file imports test-support/)`);
      }
    }
    assert.ok(crossings.length > 0, 'no import from outside reaches either tree — the scan is vacuous');
    assert.deepEqual(offenders, [], `imports from outside the trees must name a module's index.mjs:\n${offenders.join('\n')}`);
  });
});
