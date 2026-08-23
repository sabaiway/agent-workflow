// ensure-specs.test.mjs — the spec-layer ensure as its STATE TABLE: every cell of (reader pair ×
// checker pair × store root) the op classifies, the ONE conjunction each write admits through, the
// single run token by precedence, and every fail-closed arm writing nothing (or saying exactly what
// it had already written). Real temp projects; the fixture bytes are the shipped prior bodies.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WRITE_TOKENS } from './ensure-vocabulary.mjs';

const { ensureSpecs, decideWrites } = await import('./ensure-specs.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const READER = ['spec-schema.mjs', 'spec-schema.test.mjs'];
const CHECKER = ['check-docs-size.mjs', 'check-docs-size.test.mjs'];
const STORE = 'docs/ai/specs/index.md';
const TODAY = '2026-08-23';
const CUSTOM = '// my own body\n';

const bundle = (name) => readFileSync(join(BUNDLE, name), 'utf8');
// The 4.5.1..4.5.4 checker body + the 4.0.0..4.5.4 test body — both shipped priors.
const prior = (name) => readFileSync(join(FIXTURES, name === CHECKER[0] ? '4.5.1' : '4.0.0', `${name}.txt`), 'utf8');

// deploy(dir, table) materializes one row of the state table: each script current | prior | custom |
// absent | wrong-kind, the store root present | absent | wrong-kind.
const place = (dir, name, state) => {
  const path = join(dir, 'scripts', name);
  if (state === 'absent') return;
  if (state === 'wrong-kind') return mkdirSync(path, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(path, state === 'current' ? bundle(name) : state === 'prior' ? prior(name) : CUSTOM);
};
const withProject = (table, fn, { node = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-specs-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    READER.forEach((name, i) => place(dir, name, table.reader?.[i] ?? 'absent'));
    CHECKER.forEach((name, i) => place(dir, name, table.checker?.[i] ?? 'absent'));
    if (table.store === 'present') {
      mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, STORE), '---\nkind: index\n---\n# mine\n');
    }
    if (table.store === 'wrong-kind') mkdirSync(join(dir, STORE), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const run = (dir, extra = {}) => ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY }, ...extra });
const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null);
const snapshot = (dir) => {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full), entry.isFile() ? readFileSync(full, 'utf8') : `<${entry.name}>`);
    }
  };
  walk(dir);
  return out;
};
const allCurrent = (dir) => {
  for (const name of [...READER, ...CHECKER]) assert.equal(read(dir, `scripts/${name}`), bundle(name), `${name} is the bundled body`);
};
const storeSeeded = (dir) => {
  const body = read(dir, STORE);
  assert.ok(body, 'the store root exists');
  assert.match(body, /^kind: index$/m);
  assert.equal(body.includes('{{'), false, 'every placeholder rendered');
  assert.match(body, new RegExp(`^lastUpdated: ${TODAY}$`, 'm'));
};

// ── the table: one row per cell class, the token and the tree after ───────────────────────────────
const ROWS = [
  { label: 'everything absent (a pre-spec deployment with no checker at all)', table: {}, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
  { label: 'everything current + store present (a converged tree)', table: { reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' }, token: 'already-present', after: (dir, before) => assert.deepEqual(snapshot(dir), before) },
  { label: 'pairs current, store absent (only the root is missing)', table: { reader: ['current', 'current'], checker: ['current', 'current'] }, token: 'seeded', after: storeSeeded },
  { label: 'reader current, checker on a shipped prior, store present', table: { reader: ['current', 'current'], checker: ['prior', 'prior'], store: 'present' }, token: 'refreshed', after: allCurrent },
  { label: 'reader absent, checker on a shipped prior (the 4.5.4 deployment)', table: { checker: ['prior', 'prior'] }, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
  { label: 'checker .mjs absent beside a current test', table: { reader: ['current', 'current'], checker: ['absent', 'current'] }, token: 'seeded', after: (dir) => { allCurrent(dir); storeSeeded(dir); } },
];
// The withheld cells: a custom file preserves itself and withholds every write that depends on it.
// The token still follows the ONE precedence — a seed that was admitted (nothing depends on it) is
// `seeded`; only a run that wrote nothing behind a custom file is `customized-preserved`.
const WITHHELD_ROWS = [
  { label: 'a custom checker .mjs beside a prior test: the pair is preserved, the prior test is NOT refreshed, no store root', table: { reader: ['current', 'current'], checker: ['custom', 'prior'] }, token: 'customized-preserved', seeded: [], leftAsIs: ['scripts/check-docs-size.test.mjs'] },
  { label: 'a custom reader .mjs: the checker refresh and the store wait', table: { reader: ['custom', 'current'], checker: ['prior', 'prior'] }, token: 'customized-preserved', seeded: [], leftAsIs: ['scripts/check-docs-size.mjs', 'scripts/check-docs-size.test.mjs'] },
  { label: 'a custom reader test beside an absent reader .mjs: the .mjs is still seeded (create-only), so the token is seeded', table: { reader: ['absent', 'custom'], checker: ['absent', 'prior'] }, token: 'seeded', seeded: ['scripts/spec-schema.mjs'], leftAsIs: ['scripts/check-docs-size.test.mjs'], notCopied: ['scripts/check-docs-size.mjs'] },
  { label: 'a custom checker beside a store root that already exists: both preserved, the root line says present, not withheld', table: { reader: ['current', 'current'], checker: ['custom', 'current'], store: 'present' }, token: 'customized-preserved', seeded: [], leftAsIs: [] },
];

describe('the state table — admitted writes and the run token', () => {
  for (const row of ROWS) {
    it(row.label, () => {
      withProject(row.table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir);
        assert.equal(r.token, row.token, r.lines.join('\n'));
        assert.equal(r.failed, false);
        row.after(dir, before);
        const again = run(dir);
        assert.equal(again.token, 'already-present', 'a re-run converges and claims nothing');
      });
    });
  }

  for (const row of WITHHELD_ROWS) {
    it(row.label, () => {
      withProject(row.table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir);
        assert.equal(r.token, row.token, r.lines.join('\n'));
        assert.equal(r.failed, false);
        // Everything but the admitted seeds is byte-identical: the custom body, the prior checker
        // that was NOT refreshed behind it, and no store root at all.
        const after = snapshot(dir);
        for (const [rel, bytes] of before) assert.equal(after.get(rel), bytes, `${rel} preserved`);
        assert.deepEqual([...after.keys()].filter((rel) => !before.has(rel)).sort(), row.seeded, 'exactly the admitted seeds landed');
        for (const rel of row.seeded) assert.equal(after.get(rel), bundle(rel.split('/').pop()), `${rel} is the bundled body`);
        const storePresent = row.table.store === 'present';
        assert.equal(existsSync(join(dir, STORE)), storePresent, 'no store root is seeded behind a withheld checker');
        const text = r.lines.join('\n');
        assert.match(text, /preserved verbatim/);
        assert.equal(/not seeded/.test(text), !storePresent, 'the root line says withheld only when the root is absent');
        assert.equal(/already present — preserved/.test(text), storePresent);
        // The lines describe what HAPPENED: a prior file the withhold left alone is never called
        // refreshed, an absent file it left alone is never called copied.
        for (const rel of row.leftAsIs) assert.match(text, new RegExp(`^${rel}: matches a body an earlier release shipped — left as is`, 'm'));
        for (const rel of row.notCopied ?? []) assert.match(text, new RegExp(`^${rel}: absent — not copied this run`, 'm'));
        assert.equal(/refreshed to the bundled one/.test(text), false, 'no line claims a refresh that did not happen');
        assert.equal(r.lines.filter((l) => /: copied from the bundled scripts/.test(l)).length, row.seeded.length);
      });
    });
  }

  it('the pure decision: a reader on a shipped prior (a future catalog row) withholds like a custom one', () => {
    const d = decideWrites({
      reader: [{ state: 'prior' }, { state: 'current' }],
      checker: [{ state: 'prior' }, { state: 'prior' }],
      store: { state: 'absent' },
    });
    assert.deepEqual(d, { writes: [], withheld: true });
  });
});

describe('--dry-run — only would-* tokens, a byte-identical tree', () => {
  const DRY = [
    [{}, 'would-seed'],
    [{ reader: ['current', 'current'], checker: ['prior', 'prior'], store: 'present' }, 'would-refresh'],
    [{ reader: ['current', 'current'], checker: ['custom', 'prior'] }, 'customized-preserved'],
    [{ reader: ['absent', 'custom'], checker: ['prior', 'prior'] }, 'would-seed'],
    [{ reader: ['current', 'current'], checker: ['current', 'current'], store: 'present' }, 'already-present'],
  ];
  for (const [table, token] of DRY) {
    it(`${JSON.stringify(table)} -> ${token}`, () => {
      withProject(table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir, { dryRun: true });
        assert.equal(r.token, token, r.lines.join('\n'));
        assert.equal(WRITE_TOKENS.includes(r.token), false);
        assert.deepEqual(snapshot(dir), before);
        assert.doesNotMatch(r.lines.join('\n'), /— (copied|refreshed|created) /, 'no line claims a write');
        if (token === 'would-seed' && table.checker) {
          assert.match(r.lines.join('\n'), /spec-schema\.mjs: absent — would be copied/);
          assert.match(r.lines.join('\n'), /check-docs-size\.mjs: matches a body an earlier release shipped — left as is/, 'a withheld refresh is not promised');
        }
      });
    });
  }
});

describe('the create-only race — a file that appears under the seed is re-proven before anything depends on it', () => {
  const appearing = (name, bytes) => ({
    today: TODAY,
    link: (from, to) => {
      if (!String(to).endsWith(name)) return linkSync(from, to);
      writeFileSync(to, bytes);
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    },
  });

  it('a reader that appears with the bundled body stands, and the dependent writes proceed', () => {
    withProject({ checker: ['prior', 'prior'] }, (dir) => {
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: appearing('spec-schema.mjs', bundle('spec-schema.mjs')) });
      assert.equal(r.token, 'seeded', r.lines.join('\n'));
      assert.match(r.lines.join('\n'), /spec-schema\.mjs: appeared while this run was seeding it — the bundled body stands/);
      allCurrent(dir);
      storeSeeded(dir);
    });
  });

  it('a reader that appears with OTHER bytes is race-unresolved: the checker is left alone, no store root, nothing claimed', () => {
    withProject({ checker: ['prior', 'prior'] }, (dir) => {
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: appearing('spec-schema.mjs', CUSTOM) });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^race-unresolved — scripts\/spec-schema\.mjs: appeared while this run was seeding it and does not carry the bundled body/);
      assert.equal(read(dir, 'scripts/spec-schema.mjs'), CUSTOM, 'the appeared file is never overwritten');
      assert.equal(read(dir, 'scripts/check-docs-size.mjs'), prior('check-docs-size.mjs'), 'the checker refresh did not run behind it');
      assert.equal(existsSync(join(dir, STORE)), false);
      assert.match(r.lines.join('\n'), /check-docs-size\.mjs: matches a body an earlier release shipped — left as is; the run stopped before it/);
      assert.doesNotMatch(r.lines.join('\n'), /— (copied|refreshed|created) /, 'no line claims a write that did not happen');
    });
  });
});

describe('fail-closed arms', () => {
  it('a project with no package.json is a stated skip', () => {
    withProject({}, (dir) => {
      const r = run(dir);
      assert.equal(r.token, 'skipped-no-node');
      assert.equal(existsSync(join(dir, 'scripts')), false);
    }, { node: false });
  });

  for (const [label, table, rel] of [
    ['a DIRECTORY where the reader belongs', { reader: ['wrong-kind', 'absent'] }, 'scripts/spec-schema.mjs'],
    ['a DIRECTORY where the checker test belongs', { checker: ['prior', 'wrong-kind'] }, 'scripts/check-docs-size.test.mjs'],
    ['a DIRECTORY where the store root belongs', { reader: ['current', 'current'], checker: ['current', 'current'], store: 'wrong-kind' }, STORE],
  ]) {
    it(`${label} fails loudly, naming the kind, and writes nothing`, () => {
      withProject(table, (dir) => {
        const before = snapshot(dir);
        const r = run(dir);
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], new RegExp(`^wrong-node-kind — ${rel.replace(/[.]/g, '\\.')}: exists but is a directory`));
        assert.deepEqual(snapshot(dir), before);
      });
    });
  }

  it('a SYMLINKED store root is refused before any read', () => {
    withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
      mkdirSync(join(dir, 'docs', 'ai', 'specs'), { recursive: true });
      symlinkSync(join(dir, 'package.json'), join(dir, STORE));
      const r = run(dir);
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
    });
  });

  it('an unreadable bundled script fails closed and writes nothing', () => {
    withProject({}, (dir) => {
      const r = run(dir, { kitRoot: mkdtempSync(join(tmpdir(), 'ensure-specs-empty-')) });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^bundle-unreadable — scripts\/spec-schema\.mjs: /);
      assert.equal(existsSync(join(dir, 'scripts')), false);
    });
  });

  it('an unreadable DEPLOYED script throws (the CLI catch-all names it) and writes nothing', () => {
    withProject({ reader: ['current', 'current'], checker: ['prior', 'prior'] }, (dir) => {
      const before = snapshot(dir);
      const deps = { today: TODAY, readFile: (p, enc) => { if (String(p).endsWith('scripts/check-docs-size.mjs') && !String(p).startsWith(KIT_ROOT)) throw new Error('EACCES: deployed'); return readFileSync(p, enc); } };
      assert.throws(() => ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps }), /EACCES: deployed/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  // The store template is read and rendered BEFORE the first write: a kit whose template is missing
  // or carries a placeholder this op cannot render fails as template-unreadable with no script written.
  for (const [label, setup] of [
    ['missing', () => {}],
    ['carrying an unknown placeholder', (tpl) => writeFileSync(tpl, '---\nlastUpdated: {{DATE}}\nowner: {{OWNER}}\n---\n')],
  ]) {
    it(`a bundled store template ${label} is template-unreadable, and nothing is written`, () => {
      withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
        const kit = mkdtempSync(join(tmpdir(), 'ensure-specs-kit-'));
        mkdirSync(join(kit, 'references', 'templates', 'specs'), { recursive: true });
        for (const name of [...READER, ...CHECKER]) {
          mkdirSync(join(kit, 'references', 'scripts'), { recursive: true });
          writeFileSync(join(kit, 'references', 'scripts', name), bundle(name));
        }
        setup(join(kit, 'references', 'templates', 'specs', 'index.md'));
        const before = snapshot(dir);
        const r = run(dir, { kitRoot: kit });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^template-unreadable — docs\/ai\/specs\/index\.md: /);
        assert.deepEqual(snapshot(dir), before);
        assert.doesNotMatch(r.lines.join('\n'), /— (copied|refreshed|created) /, 'no line claims a write that did not happen');
      });
    });
  }

  it('a write refused partway keeps the lines it had, names what landed, and the re-run converges', () => {
    withProject({ checker: ['prior', 'prior'] }, (dir) => {
      let links = 0;
      const deps = { today: TODAY, link: (from, to) => { if (links++ === 0) return linkSync(from, to); throw Object.assign(new Error('EPERM: refused'), { code: 'EPERM' }); } };
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^write-refused — scripts\/spec-schema\.test\.mjs: /);
      assert.equal(read(dir, 'scripts/spec-schema.mjs'), bundle('spec-schema.mjs'), 'the first seed really landed');
      assert.equal(read(dir, 'scripts/check-docs-size.mjs'), prior('check-docs-size.mjs'), 'the checker was not touched after the stop');
      assert.match(r.lines.join('\n'), /stopped PARTWAY — the 1 file\(s\) named above/);
      assert.match(r.lines.join('\n'), /spec-schema\.mjs: copied from the bundled scripts/, 'the landed seed is named');
      assert.match(r.lines.join('\n'), /check-docs-size\.mjs: matches a body an earlier release shipped — left as is; the run stopped before it/);
      assert.match(r.lines.join('\n'), /index\.md: absent — not created; the run stopped before it/);
      const again = run(dir);
      assert.equal(again.token, 'seeded', again.lines.join('\n'));
      allCurrent(dir);
      storeSeeded(dir);
    });
  });

  it('a refresh refused by the atomic core is write-refused with nothing else claimed', () => {
    withProject({ reader: ['current', 'current'], checker: ['prior', 'prior'], store: 'present' }, (dir) => {
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps: { today: TODAY, rename: () => { throw new Error('EROFS: read-only'); } } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^write-refused — scripts\/check-docs-size\.mjs: EROFS/);
      assert.equal(read(dir, 'scripts/check-docs-size.mjs'), prior('check-docs-size.mjs'));
      assert.doesNotMatch(r.lines.join('\n'), /PARTWAY/);
    });
  });

  it('a file that appears under the seed stands, and a temp file the cleanup could not remove is named', () => {
    withProject({ reader: ['current', 'current'], checker: ['current', 'current'] }, (dir) => {
      const deps = {
        today: TODAY,
        link: (from, to) => { writeFileSync(to, '# theirs\n'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
        rm: () => { throw new Error('EBUSY'); },
      };
      const r = ensureSpecs({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'already-present', r.lines.join('\n'));
      assert.equal(read(dir, STORE), '# theirs\n');
      assert.match(r.lines.join('\n'), /appeared while this run was seeding it/);
      assert.match(r.lines.join('\n'), /temp file could not be removed/);
    });
  });
});
