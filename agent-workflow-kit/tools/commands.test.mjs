import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMANDS,
  GROUP_ORDER,
  routeInvocation,
  formatHelp,
  buildJson,
  kindOf,
  commandFor,
  READ_ONLY,
  WRITER,
  GUARDED,
  PROJECT_EXEC,
  KINDS,
  UNKNOWN_INVOCATION_MODE,
  BARE_INVOCATION_MODE,
} from './commands.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(HERE, '..', 'SKILL.md');
const MODES_DIR = join(HERE, '..', 'references', 'modes');

// ── (a) drift-guard: COMMANDS keys ⟷ the `### Mode:` headers in SKILL.md (the ONE authoritative
//        surface). The headers are clean (no [backend]/<activity> placeholders), and the bare-default
//        mode header is literally `### Mode: bootstrap`, so the comparison is a plain set equality. ──

describe('commands catalog — drift-guard vs SKILL.md ### Mode: headers', () => {
  const skillModes = () =>
    readFileSync(SKILL_MD, 'utf8')
      .split('\n')
      .map((l) => l.match(/^### Mode:\s+(\S+)\s*$/))
      .filter(Boolean)
      .map((m) => m[1]);

  it('every documented mode has a catalog entry and vice-versa (no drift)', () => {
    const fromSkill = [...skillModes()].sort();
    const fromCatalog = COMMANDS.map((c) => c.key).sort();
    assert.deepEqual(fromCatalog, fromSkill, 'catalog keys must equal the SKILL.md ### Mode: headers');
  });

  it('catalog keys are unique', () => {
    const keys = COMMANDS.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  // The progressive-disclosure split: every catalog mode has its body in references/modes/<key>.md
  // and every mode file is a catalog mode — a missing mode file (a routed mode with no procedure)
  // or an orphan file (an unreachable procedure) both go red.
  it('catalog keys ⟷ references/modes/*.md filenames (set equality, no drift)', () => {
    const fromFiles = readdirSync(MODES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    const fromCatalog = COMMANDS.map((c) => c.key).sort();
    assert.deepEqual(fromFiles, fromCatalog, 'references/modes/ files must equal the catalog keys');
  });

  // A catalog entry alone is NOT runnable — routeInvocation only maps token→mode; the agent runs the
  // mode by following its mode file's `Run node …` dispatch line. For the writer modes that own a
  // tool, header presence ≠ runnable: pin that the mode file actually carries the runnable command.
  it('the set-recipe mode file carries the runnable node …/tools/set-recipe.mjs dispatch line', () => {
    const section = readFileSync(join(MODES_DIR, 'set-recipe.md'), 'utf8');
    assert.match(section, /node \$\{CLAUDE_SKILL_DIR\}\/tools\/set-recipe\.mjs/, 'the mode file must carry the runnable dispatch line');
    assert.match(section, /--write/, 'the mode file documents the --write apply flag');
    assert.match(section, /never commits/i, 'the mode file states the writer never commits');
  });

  // F08a (AD-040): the standing-consent advisory at the --write success moment — wording-only in
  // the mode file, the set-recipe.mjs tool echo untouched. Pin its stable tokens.
  it('the set-recipe mode file carries the standing-consent advisory (hand-adds, quota honesty, solo-silent)', () => {
    const section = readFileSync(join(MODES_DIR, 'set-recipe.md'), 'utf8');
    assert.match(section, /settings\.local\.json/, 'the advisory names the hand-edited local settings file');
    assert.match(section, /spends subscription quota without a per-run prompt/, 'the advisory states the quota honesty plainly');
    assert.match(section, /INCLUDING quoting/, 'the advisory pins the byte-form/quoting rule');
    assert.match(section, /solo recipe gets NO advisory/i, 'solo recipes stay advisory-free');
  });
});

// ── (b) routing — known tokens → their mode; garbage → help (never a writer/guarded mode); the
//        bare/empty invocation → bootstrap (the documented exception). ───────────────────────────────

describe('routeInvocation — known tokens map to their mode', () => {
  for (const c of COMMANDS) {
    if (c.key === BARE_INVOCATION_MODE) continue; // bootstrap is the bare default, not a token
    it(`"${c.key}" → ${c.key}`, () => {
      assert.equal(routeInvocation(c.key), c.key);
    });
  }

  it('ignores trailing args (only the first token is significant)', () => {
    assert.equal(routeInvocation('upgrade --force later'), 'upgrade');
    assert.equal(routeInvocation('procedures plan-authoring'), 'procedures');
  });

  it('accepts the FULL slash invocation, not just the bare token — every catalog invocation routes to its key', () => {
    for (const c of COMMANDS) {
      assert.equal(routeInvocation(c.invocation), c.key, `${c.invocation} must route to ${c.key}`);
    }
    // extra args after a full slash invocation still resolve to the mode
    assert.equal(routeInvocation('/agent-workflow-kit procedures plan-execution'), 'procedures');
  });
});

describe('routeInvocation — the bare/empty invocation maps to bootstrap (the ONE acknowledged exception)', () => {
  for (const bare of [undefined, null, '', '   ', '\t', '/agent-workflow-kit']) {
    it(`${JSON.stringify(bare)} → bootstrap`, () => {
      assert.equal(routeInvocation(bare), BARE_INVOCATION_MODE);
    });
  }
});

describe('routeInvocation — safety invariant: NO unrecognized/garbage token reaches a writer/guarded mode', () => {
  const garbage = [
    'frobnicate', 'init', 'deploy', 'commit', 'push', 'publish', 'rm', '--force',
    'UPGRADE', 'Status', 'bootstrap', 'help me', '../upgrade', 'setup; rm -rf', '42', 'a b c',
  ];
  for (const tok of garbage) {
    it(`"${tok}" → help (read-only)`, () => {
      const mode = routeInvocation(tok);
      assert.equal(mode, UNKNOWN_INVOCATION_MODE);
      assert.equal(kindOf(mode), READ_ONLY, 'the unknown-invocation target must be read-only');
    });
  }

  it('the ONLY way to reach a writer/guarded/project-exec mode is a known token or the bare exception', () => {
    // Sweep every catalog token + a pile of garbage: an acts-on-the-system result (writer/guarded)
    // OR a runs-project-commands result (project-exec) is only ever the bare bootstrap exception or
    // an exact known token — never a garbage token.
    const actsOnSystem = (mode) => kindOf(mode) === WRITER || kindOf(mode) === GUARDED || kindOf(mode) === PROJECT_EXEC;
    const knownTokens = new Set(COMMANDS.filter((c) => c.key !== BARE_INVOCATION_MODE).map((c) => c.key));
    for (const tok of [...garbage, 'xyzzy', 'STATUS', '']) {
      const mode = routeInvocation(tok);
      if (actsOnSystem(mode)) {
        assert.ok(
          mode === BARE_INVOCATION_MODE || knownTokens.has(tok),
          `garbage token "${tok}" must never resolve to a writer/guarded/project-exec mode (got ${mode})`,
        );
      }
    }
  });

  it('the gates mode is tagged project-exec — never read-only (it runs the project\'s own commands)', () => {
    assert.equal(kindOf('gates'), PROJECT_EXEC);
    assert.match(formatHelp(), /\[runs project cmds\]/, 'help renders the honest tag');
  });
});

// ── (c) every entry is well-formed: a valid kind, a non-trivial plain-language oneLine, a known group,
//        and no leaked internal terminology. ─────────────────────────────────────────────────────────

describe('commands catalog — well-formed entries', () => {
  // Terms the SKILL.md "never leak kit internals" Gotcha forbids in user-facing text (incl. slot /
  // fragment / inject / reconcile / anchor / marker), plus the registry/stamp internals.
  const INTERNAL_TERMS = /\b(reconcile|inject|slot|fragment|anchor|marker|fence|manifestState|hiddenFence|capability\.json|stamp|\.workflow-version|\.memory-version)\b/i;

  for (const c of COMMANDS) {
    it(`${c.key}: valid kind, group, and a non-trivial leak-free oneLine`, () => {
      assert.ok(KINDS.has(c.kind), `kind "${c.kind}" must be one of read-only/writer/guarded`);
      assert.ok(GROUP_ORDER.includes(c.group), `group "${c.group}" must be a known group`);
      assert.ok(typeof c.oneLine === 'string' && c.oneLine.trim().length >= 20, 'oneLine must be substantive');
      assert.ok(!INTERNAL_TERMS.test(c.oneLine), `oneLine leaks an internal term: ${c.oneLine}`);
      assert.ok(c.invocation.startsWith('/agent-workflow-kit'), 'invocation must be the slash form');
    });
  }

  it('exactly one writer is reachable without a token (bootstrap)', () => {
    const tokenlessWriters = COMMANDS.filter((c) => c.kind === WRITER && c.key === BARE_INVOCATION_MODE);
    assert.equal(tokenlessWriters.length, 1);
    assert.equal(kindOf(BARE_INVOCATION_MODE), WRITER);
  });

  it('the catalog is deep-frozen (array AND entries immutable)', () => {
    assert.ok(Object.isFrozen(COMMANDS), 'COMMANDS array must be frozen');
    assert.ok(COMMANDS.every((c) => Object.isFrozen(c)), 'every catalog entry must be frozen');
    // ESM is strict mode → mutating a frozen entry throws rather than silently no-op'ing.
    assert.throws(() => {
      COMMANDS[0].kind = 'hacked';
    }, TypeError);
  });
});

// ── the Tune tail — the opt-in accelerator funnel (F10a) ─────────────────────────────────────────────
// NOT a new catalog key / mode: the frozen CATALOG + GROUP_ORDER stay, the router SKILL.md is
// untouched — the funnel is a rendered tail after the groups, mirroring the bootstrap block.

describe('formatHelp — the Tune tail (opt-in accelerators)', () => {
  it('renders the tail AFTER the catalog groups with the four accelerator entries', () => {
    const out = formatHelp();
    const at = out.indexOf('Tune — opt-in accelerators');
    assert.notEqual(at, -1, 'the Tune tail must render');
    const lastGroup = out.lastIndexOf(GROUP_ORDER[GROUP_ORDER.length - 1]);
    assert.ok(at > lastGroup, 'the tail renders after the last catalog group');
    const tail = out.slice(at);
    for (const token of ['velocity', 'agents', 'gates', 'hook', 'set-recipe']) {
      assert.ok(tail.includes(token), `the Tune tail lists ${token}`);
    }
    assert.match(tail, /nothing runs without your yes/, 'the tail states the consent posture');
  });

  it('the gates one-liner names the separate consent-gated seeder (the kind contract stays honest)', () => {
    const one = commandFor('gates').oneLine;
    assert.match(one, /consent-gated/, 'the one-liner must name the consent-gated seeding helper');
    assert.match(one, /preview/i, 'the one-liner states preview-first');
    // AD-048: --record mints a gate-run record, so the honest claim is writes-nothing-BY-DEFAULT.
    assert.match(one, /[Ww]rites nothing by default/, 'the one-liner keeps the writes-nothing-by-default honesty');
    assert.equal(kindOf('gates'), PROJECT_EXEC, 'the kind stays PROJECT_EXEC — no re-kind');
  });
});

// ── render: formatHelp + buildJson surface every command ─────────────────────────────────────────────

describe('formatHelp / buildJson', () => {
  it('formatHelp lists every command invocation under its group', () => {
    const out = formatHelp();
    for (const c of COMMANDS) assert.ok(out.includes(c.invocation), `help omits ${c.invocation}`);
    for (const g of GROUP_ORDER) assert.ok(out.includes(g), `help omits group ${g}`);
  });

  it('buildJson is a stable flat catalog + routing anchors', () => {
    const j = buildJson();
    assert.equal(j.skill, 'agent-workflow-kit');
    assert.equal(j.unknownInvocationMode, UNKNOWN_INVOCATION_MODE);
    assert.equal(j.bareInvocationMode, BARE_INVOCATION_MODE);
    assert.equal(j.commands.length, COMMANDS.length);
    assert.deepEqual(Object.keys(j.commands[0]).sort(), ['group', 'invocation', 'key', 'kind', 'oneLine'].sort());
  });
});
