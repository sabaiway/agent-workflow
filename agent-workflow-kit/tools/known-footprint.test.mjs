import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KIT_OWN_PATHS,
  KNOWN_FOOTPRINT,
  FOOTPRINT_STOP,
  normalizeSlashes,
  isDirPattern,
  isGlobPattern,
  patternToProbe,
  expandGlob,
  matchesKnownGlob,
} from './known-footprint.mjs';

// An ENOENT-typed error, matching the shape Node's fs throws.
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
const fileStat = { isFile: () => true };
const dirStat = { isFile: () => false };

// The probe form of an anchored pattern, for subsumption/coverage reasoning (strip leading "/").
const probeOf = (pattern) => normalizeSlashes(pattern).replace(/^\//, '');
// A pattern's "scope" — the path-prefix it ignores. A glob's scope is its parent directory.
const scopeOf = (pattern) => {
  const probe = probeOf(pattern);
  if (isGlobPattern(pattern)) return `${probe.slice(0, probe.lastIndexOf('/') + 1)}`; // e.g. ".github/"
  return probe;
};
// Does `pattern` (as a gitignore rule) cover the concrete repo-relative `path`?
const covers = (pattern, path) => {
  const scope = scopeOf(pattern);
  return scope.endsWith('/') ? path === scope.slice(0, -1) || path.startsWith(scope) : path === scope;
};

// ── (a) shape + type enum ───────────────────────────────────────────────────────

describe('KNOWN_FOOTPRINT shape', () => {
  it('every entry is well-shaped with type ∈ {dir,file}', () => {
    for (const e of KNOWN_FOOTPRINT) {
      assert.equal(typeof e.pattern, 'string', `pattern is a string`);
      assert.equal(typeof e.owner, 'string', `${e.pattern}: owner is a string`);
      assert.ok(e.type === 'dir' || e.type === 'file', `${e.pattern}: type is dir|file`);
      assert.equal(typeof e.falsePositiveRisk, 'boolean', `${e.pattern}: falsePositiveRisk is boolean`);
      assert.equal(typeof e.note, 'string', `${e.pattern}: note is a string`);
      if ('glob' in e) assert.equal(e.glob, true, `${e.pattern}: glob, when present, is true`);
    }
  });

  it('a dir entry ends with "/", a file entry does not (glob excepted)', () => {
    for (const e of KNOWN_FOOTPRINT) {
      if (isGlobPattern(e.pattern)) continue;
      assert.equal(isDirPattern(e.pattern), e.type === 'dir', `${e.pattern}: trailing slash matches type`);
    }
  });
});

// ── (b) uniqueness ────────────────────────────────────────────────────────────────

describe('uniqueness', () => {
  it('KIT_OWN_PATHS has no duplicate patterns', () => {
    assert.equal(new Set(KIT_OWN_PATHS).size, KIT_OWN_PATHS.length);
  });
  it('KNOWN_FOOTPRINT has no duplicate patterns', () => {
    const pats = KNOWN_FOOTPRINT.map((e) => e.pattern);
    assert.equal(new Set(pats).size, pats.length);
  });
});

// ── (c) anchoring ─────────────────────────────────────────────────────────────────

describe('anchoring', () => {
  const allPatterns = [...KIT_OWN_PATHS, ...KNOWN_FOOTPRINT.map((e) => e.pattern)];
  it('every pattern is anchored (starts with "/") and has no traversal', () => {
    for (const p of allPatterns) {
      assert.ok(p.startsWith('/'), `${p}: anchored`);
      assert.ok(!normalizeSlashes(p).split('/').includes('..'), `${p}: no ".."`);
    }
  });
  it('a bare trailing "*" appears ONLY on a glob:true entry', () => {
    for (const p of KIT_OWN_PATHS) assert.ok(!p.includes('*'), `KIT_OWN ${p}: no wildcard`);
    for (const e of KNOWN_FOOTPRINT) {
      if (e.pattern.includes('*')) assert.equal(e.glob, true, `${e.pattern}: wildcard ⇒ glob:true`);
    }
    const globs = KNOWN_FOOTPRINT.filter((e) => e.glob);
    assert.deepEqual(globs.map((e) => e.pattern), ['/.github/copilot-*'], 'exactly one reviewed glob');
  });
});

// ── (d) disjoint registries ───────────────────────────────────────────────────────

describe('disjointness', () => {
  it('KIT_OWN_PATHS ∩ KNOWN_FOOTPRINT == ∅', () => {
    const own = new Set(KIT_OWN_PATHS);
    for (const e of KNOWN_FOOTPRINT) assert.ok(!own.has(e.pattern), `${e.pattern}: not in both`);
  });
});

// ── (e) no prefix/subsumption between non-glob patterns (glob exempt) ──────────────

describe('no subsumption', () => {
  it('no non-glob pattern is an ancestor of another across both arrays', () => {
    const all = [...KIT_OWN_PATHS, ...KNOWN_FOOTPRINT.map((e) => e.pattern)].filter((p) => !isGlobPattern(p));
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        // a subsumes b iff a is a directory pattern and b sits under it.
        if (isDirPattern(a)) {
          assert.ok(!probeOf(b).startsWith(probeOf(a)), `${a} subsumes ${b} — remove the redundant child`);
        }
      }
    }
  });
});

// ── (f) external set must NOT reach the kit's own .claude/settings.json ────────────

describe('external set excludes .claude/settings.json', () => {
  it('no KNOWN_FOOTPRINT pattern covers .claude/settings.json (KIT_OWN carries it, hidden-only)', () => {
    for (const e of KNOWN_FOOTPRINT) {
      assert.ok(!covers(e.pattern, '.claude/settings.json'), `${e.pattern}: must not cover .claude/settings.json`);
    }
    // sanity: KIT_OWN intentionally DOES carry it.
    assert.ok(KIT_OWN_PATHS.includes('/.claude/settings.json'));
  });
});

// ── (g) frozen snapshot + count sentinel ──────────────────────────────────────────

describe('frozen snapshot', () => {
  it('KIT_OWN_PATHS matches the frozen expected set + count', () => {
    const expected = [
      '/AGENTS.md',
      '/CLAUDE.md',
      '/docs/ai/',
      '/scripts/_expect-shim.mjs',
      '/scripts/archive-changelog.mjs',
      '/scripts/archive-changelog.test.mjs',
      '/scripts/archive-decisions.mjs',
      '/scripts/archive-decisions.test.mjs',
      '/scripts/archive-issues.mjs',
      '/scripts/archive-issues.test.mjs',
      '/scripts/check-docs-size.mjs',
      '/scripts/check-docs-size.test.mjs',
      '/scripts/install-git-hooks.mjs',
      '/docs/plans/',
      '/.claude/settings.local.json',
      '/.claude/settings.json',
    ];
    assert.equal(KIT_OWN_PATHS.length, 16, 'KIT_OWN_PATHS count sentinel — edit deliberately');
    assert.deepEqual(KIT_OWN_PATHS, expected);
  });

  it('KNOWN_FOOTPRINT matches the frozen expected pattern set + count', () => {
    const expected = [
      '/.claude/skills/',
      '/.claude/agents/',
      '/.claude/hooks/',
      '/.cursor/rules/',
      '/.cursorrules',
      '/.codeium/',
      '/.windsurf/',
      '/.windsurfrules',
      '/GEMINI.md',
      '/.antigravity.md',
      '/.github/copilot-*',
      '/.aider.conf.yml',
      '/.aider.chat.history.md',
      '/.aider.input.history',
      '/.continue/',
    ];
    assert.equal(KNOWN_FOOTPRINT.length, 15, 'KNOWN_FOOTPRINT count sentinel — edit deliberately');
    assert.deepEqual(KNOWN_FOOTPRINT.map((e) => e.pattern), expected);
  });
});

// ── (h) patternToProbe + expandGlob ───────────────────────────────────────────────

describe('patternToProbe', () => {
  it('strips the leading "/" and round-trips a file', () => {
    assert.equal(patternToProbe('/AGENTS.md'), 'AGENTS.md');
    assert.equal(patternToProbe('/.cursorrules'), '.cursorrules');
  });
  it('preserves a trailing "/" for a dir', () => {
    assert.equal(patternToProbe('/docs/ai/'), 'docs/ai/');
    assert.equal(patternToProbe('/.claude/skills/'), '.claude/skills/');
  });
  it('normalizes Windows back-slashes', () => {
    assert.equal(patternToProbe('\\docs\\ai\\'), 'docs/ai/');
  });
  it('STOPs on a glob pattern (must expandGlob first)', () => {
    assert.throws(() => patternToProbe('/.github/copilot-*'), (e) => e.code === FOOTPRINT_STOP);
  });
  it('STOPs on traversal', () => {
    assert.throws(() => patternToProbe('/x/../y'), (e) => e.code === FOOTPRINT_STOP);
  });
  it('STOPs on an unanchored pattern', () => {
    assert.throws(() => patternToProbe('AGENTS.md'), (e) => e.code === FOOTPRINT_STOP);
  });
});

describe('expandGlob', () => {
  const dir = '/repo';
  const entries = {
    '/repo/.github': ['copilot-instructions.md', 'copilot-setup-steps.yml', 'copilot-agents', 'workflows', 'README.md'],
  };
  const kinds = {
    '/repo/.github/copilot-instructions.md': fileStat,
    '/repo/.github/copilot-setup-steps.yml': fileStat,
    '/repo/.github/copilot-agents': dirStat, // matches the glob but is a directory → excluded
    '/repo/.github/workflows': dirStat,
    '/repo/.github/README.md': fileStat,
  };
  const readdir = (p) => {
    if (p in entries) return entries[p];
    throw enoent();
  };
  const stat = (p) => {
    if (p in kinds) return kinds[p];
    throw enoent();
  };

  it('matches only the concrete present FILES under the parent (dirs + non-matches excluded)', () => {
    assert.deepEqual(expandGlob('/.github/copilot-*', { dir, readdir, stat }), [
      '/.github/copilot-instructions.md',
      '/.github/copilot-setup-steps.yml',
    ]);
  });
  it('an absent parent dir → no candidates', () => {
    assert.deepEqual(expandGlob('/.github/copilot-*', { dir: '/empty', readdir, stat }), []);
  });
  it('a non-ENOENT readdir error → STOP (never a silent drop)', () => {
    const boom = () => { throw eacces(); };
    assert.throws(() => expandGlob('/.github/copilot-*', { dir, readdir: boom, stat }), (e) => e.code === FOOTPRINT_STOP);
  });
  it('STOPs when called on a non-glob pattern', () => {
    assert.throws(() => expandGlob('/AGENTS.md', { dir, readdir, stat }), (e) => e.code === FOOTPRINT_STOP);
  });
});

// ── small pure helpers ────────────────────────────────────────────────────────────

describe('source hygiene', () => {
  it('the shipped hidden-mode tools contain no NUL bytes (text-safe; never classified binary)', () => {
    for (const f of ['known-footprint.mjs', 'hide-footprint.mjs']) {
      const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8');
      assert.ok(!src.includes('\u0000'), `${f} must not contain a NUL byte`);
    }
  });
});

describe('matchesKnownGlob', () => {
  it('recognizes a concrete child of a glob:true entry', () => {
    assert.equal(matchesKnownGlob('/.github/copilot-instructions.md'), true);
    assert.equal(matchesKnownGlob('/.github/copilot-setup-steps.yml'), true);
  });
  it('rejects a non-matching sibling, a nested path, and a non-glob registry pattern', () => {
    assert.equal(matchesKnownGlob('/.github/dependabot.yml'), false, 'sibling not matching the glob');
    assert.equal(matchesKnownGlob('/.github/copilot/extra.md'), false, 'one directory level only');
    assert.equal(matchesKnownGlob('/AGENTS.md'), false, 'a registry pattern is not a glob child');
  });
});

describe('pure helpers', () => {
  it('normalizeSlashes converts back-slashes', () => assert.equal(normalizeSlashes('a\\b\\c'), 'a/b/c'));
  it('isDirPattern keys on a trailing slash', () => {
    assert.equal(isDirPattern('/docs/ai/'), true);
    assert.equal(isDirPattern('/AGENTS.md'), false);
  });
  it('isGlobPattern detects a wildcard', () => {
    assert.equal(isGlobPattern('/.github/copilot-*'), true);
    assert.equal(isGlobPattern('/AGENTS.md'), false);
  });
});
