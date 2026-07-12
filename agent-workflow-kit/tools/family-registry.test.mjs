import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  FAMILY_MEMBERS,
  classifyMember,
  surveyFamily,
  surveyProject,
  buildEnvelope,
  DISPLAY_NAMES,
  MEMORY_ORCH_TEMPLATE_REL,
  surveyVisibility,
  surveyRecipes,
  surveyAttribution,
  surveyVelocity,
  surveyGateHook,
  surveyCheapAgents,
  surveySettings,
  surveyBridges,
  parseArgs,
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  OK,
  UNKNOWN,
} from './family-registry.mjs';
import { VALID, INVALID, UNSUPPORTED } from './manifest/validate.mjs';
import { INTERNAL_RENDER_FORBIDDEN } from './labels.mjs';
import { START_MARKER } from './hide-footprint.mjs';
import { ORCHESTRATION_FRAGMENT_REL, PROCEDURES_FRAGMENT_REL, AUTONOMY_FRAGMENT_REL, LENS_FRAGMENT_REL, LENS_PRIORS_REL } from './engine-source.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..'); // agent-workflow-kit/tools → repo root

// Build classifyMember deps that present the marker, with an injectable validate/readVersion.
// The marker probe is STAT-FIRST (existsSync swallows EACCES), so the marker presence is modeled via
// the injected `stat` (isFile → present; throw ENOENT → absent; throw EACCES → unknown).
const installedDeps = ({ report, version = '9.9.9', home = '/home/test' }) => ({
  stat: () => ({ isFile: () => true }),
  getenv: {},
  home,
  validate: () => report,
  readVersion: () => ({ version }),
});
const ENOENT = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const EACCES = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };

const KIT = FAMILY_MEMBERS.find((m) => m.name === 'agent-workflow-kit');

// ── classifyMember ───────────────────────────────────────────────────────────────

describe('classifyMember', () => {
  it('marks an absent marker as not-installed (no skillDir, no version)', () => {
    const r = classifyMember(KIT, { stat: ENOENT, getenv: {}, home: '/home/test' });
    assert.equal(r.manifestState, NOT_INSTALLED);
    assert.equal(r.installed, false);
    assert.equal(r.skillDir, null);
    assert.equal(r.version, null);
  });

  it('classifies a valid matching manifest as ok and reports the authoritative version', () => {
    const r = classifyMember(KIT, installedDeps({
      report: { result: VALID, name: 'agent-workflow-kit', kind: 'composition-root', available: true },
      version: '1.12.0',
    }));
    assert.equal(r.manifestState, OK);
    assert.equal(r.installed, true);
    assert.equal(r.version, '1.12.0');
    assert.match(r.skillDir, /\.claude\/skills\/agent-workflow-kit$/);
  });

  it('classifies a wrong name/kind as foreign (never ours, never removed by uninstall)', () => {
    const r = classifyMember(KIT, installedDeps({
      report: { result: VALID, name: 'something-else', kind: 'composition-root', available: true },
    }));
    assert.equal(r.manifestState, FOREIGN);
    assert.equal(r.version, null); // version only for ok
  });

  it('classifies available:false as a stub', () => {
    const r = classifyMember(KIT, installedDeps({
      report: { result: VALID, name: 'agent-workflow-kit', kind: 'composition-root', available: false },
    }));
    assert.equal(r.manifestState, STUB);
  });

  it('maps validator INVALID → invalid-manifest and UNSUPPORTED → unsupported-schema', () => {
    assert.equal(classifyMember(KIT, installedDeps({ report: { result: INVALID } })).manifestState, INVALID_MANIFEST);
    assert.equal(classifyMember(KIT, installedDeps({ report: { result: UNSUPPORTED } })).manifestState, UNSUPPORTED_SCHEMA);
  });

  it('surfaces an EACCES marker probe as "unknown" — never masked as not-installed (stat-first)', () => {
    // statSync THROWS EACCES (existsSync would have swallowed it into a false → 'absent' → a silent
    // failure). The stat-first probe surfaces it as 'unknown'.
    const r = classifyMember(KIT, { stat: EACCES, getenv: {}, home: '/home/test' });
    assert.equal(r.manifestState, UNKNOWN);
    assert.equal(r.installed, false); // not removed — ownership could not be verified
  });

  it('resolves the skill dir from the env override when set (resolveDir reuse)', () => {
    const r = classifyMember(KIT, {
      stat: () => ({ isFile: () => true }),
      getenv: { AGENT_WORKFLOW_KIT_DIR: '/custom/kit' },
      home: '/home/test',
      validate: () => ({ result: VALID, name: 'agent-workflow-kit', kind: 'composition-root', available: true }),
      readVersion: () => ({ version: '1.12.0' }),
    });
    assert.equal(r.skillDir, '/custom/kit');
  });
});

describe('surveyFamily', () => {
  it('returns one row per member; all not-installed when no markers present', () => {
    const rows = surveyFamily({ stat: ENOENT, getenv: {}, home: '/home/test' });
    assert.equal(rows.length, FAMILY_MEMBERS.length);
    assert.ok(rows.every((r) => r.manifestState === NOT_INSTALLED));
  });

  // Only the engine member validates as ok (its name+kind match); the others go FOREIGN under this
  // shared validate stub — so only the engine row is eligible for the orchestration-fragment caveat.
  const engineValidate = (dir) =>
    String(dir).includes('agent-workflow-engine')
      ? { result: VALID, name: 'agent-workflow-engine', kind: 'methodology-engine', available: true }
      : { result: VALID, name: 'x', kind: 'x', available: true };

  // The caveats mirror the consumers: each reads a live engine fragment (readEngineFragment) — the
  // recipes pointer (orchestration-slot.md, engine >= 1.2.0) AND the activity-procedures canon
  // (procedures.md, engine >= 1.3.0). An absent / non-file / unreadable fragment surfaces as a DISTINCT
  // caveat in `row.caveats` (an array, so missing BOTH surfaces BOTH); a current readable
  // fragment never gets one. Helpers below model each fragment's on-disk state independently.
  const engineDeps = (over) => ({
    exists: () => true, // SKILL.md marker present (classifyMember)
    stat: () => ({ isFile: () => true }),
    getenv: {},
    home: '/home/test',
    validate: engineValidate,
    readVersion: () => ({ version: '1.3.0' }),
    ...over,
  });
  // statType where each fragment is independently a readable file ('file') or absent (null); the engine
  // dir + everything else is a 'dir'. readFileSync returns content for a present fragment.
  // Pin the mock to the AUTHORITATIVE engine-source constants (mirrors engine-source.test.mjs), so a
  // fragment-path rename follows here instead of silently passing against the old basename.
  const fragmentStat = ({ orch = 'file', aut = 'file', proc = 'file', lens = 'file', lensPriors = 'file' }) => (p) => {
    const s = String(p);
    if (s.endsWith(ORCHESTRATION_FRAGMENT_REL)) return orch;
    if (s.endsWith(AUTONOMY_FRAGMENT_REL)) return aut;
    if (s.endsWith(PROCEDURES_FRAGMENT_REL)) return proc;
    if (s.endsWith(LENS_PRIORS_REL)) return lensPriors;
    if (s.endsWith(LENS_FRAGMENT_REL)) return lens;
    return 'dir';
  };
  const caveatsOf = (rows) => rows.find((r) => r.kind === 'methodology-engine').caveats ?? [];

  it('a current engine WITH every live-read fragment readable carries NO caveat', () => {
    const rows = surveyFamily(engineDeps({ statType: fragmentStat({}), readFileSync: () => '> a bounded fragment' }));
    const engine = rows.find((r) => r.kind === 'methodology-engine');
    assert.equal(engine.manifestState, OK);
    assert.equal(engine.caveats, undefined, 'no caveats when every live fragment is present + readable');
  });

  it('an OK engine MISSING the orchestration fragment gets the recipes caveat (only)', () => {
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.2.0' }),
      statType: fragmentStat({ orch: null }), // recipes fragment ABSENT, procedures present
      readFileSync: () => '> a bounded fragment',
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /recipes pointer/i);
  });

  it('an OK engine MISSING the autonomy fragment gets the autonomy caveat (only) — the reconcile would soft-skip it', () => {
    // The realistic post-release case: every published engine predates references/autonomy-slot.md
    // until the AD-044 Plan-4 release — status must caveat what the chained reconcile soft-skips.
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.14.1' }),
      statType: fragmentStat({ aut: null }), // autonomy fragment ABSENT, everything else present
      readFileSync: () => '> a bounded fragment',
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /autonomy pointer/i);
  });

  it('an OK engine MISSING the procedures canon gets the activity-procedures caveat (only)', () => {
    // The realistic post-release case: an engine at 1.2.0 ships the recipes pointer but not procedures.md.
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.2.0' }),
      statType: fragmentStat({ proc: null }), // procedures canon ABSENT, recipes present
      readFileSync: () => '> a bounded fragment',
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /activity-procedures|procedures canon/i);
  });

  it('an OK pre-1.13.0 engine MISSING the agent-rules lens canon gets the lens caveat (only)', () => {
    // The realistic post-release case: an engine at 1.12.0 ships recipes + procedures but no lens pair.
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.12.0' }),
      statType: fragmentStat({ lens: null, lensPriors: null }),
      readFileSync: () => '> a bounded fragment',
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /agent-rules lens/i);
  });

  it('a lens FRAGMENT present with the PRIOR STORE missing still gets the lens caveat (the reconcile needs the PAIR)', () => {
    const rows = surveyFamily(engineDeps({
      statType: fragmentStat({ lensPriors: null }),
      readFileSync: () => '> a bounded fragment',
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 1, 'a half-shipped lens pair must not report healthy');
    assert.match(caveats[0], /agent-rules lens/i);
  });

  it('an engine MISSING every fragment surfaces EVERY caveat (none overwrites another)', () => {
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.1.0' }),
      statType: fragmentStat({ orch: null, aut: null, proc: null, lens: null }),
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 4, 'every missing fragment is reported');
    assert.ok(caveats.some((c) => /recipes pointer/i.test(c)));
    assert.ok(caveats.some((c) => /autonomy pointer/i.test(c)));
    assert.ok(caveats.some((c) => /activity-procedures|procedures canon/i.test(c)));
    assert.ok(caveats.some((c) => /agent-rules lens/i.test(c)));
  });

  it('a broken engine whose fragments are DIRECTORIES is NOT a false "ok"', () => {
    const rows = surveyFamily(engineDeps({ statType: () => 'dir' })); // every fragment path is a dir
    assert.equal(caveatsOf(rows).length, 4, 'non-file fragments are caveated');
  });

  it('a fragment PRESENT but UNREADABLE is NOT a false "ok" (mirrors the consumer STOP)', () => {
    const rows = surveyFamily(engineDeps({
      statType: fragmentStat({}), // all present as files
      readFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); // but unreadable
      },
    }));
    assert.equal(caveatsOf(rows).length, 4, 'unreadable fragments are caveated, not reported clean');
  });
});

// ── surveyProject ────────────────────────────────────────────────────────────────

describe('surveyProject', () => {
  const projectDeps = ({ files }) => ({
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p) || Object.keys(files).some((k) => k === p),
    readFile: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
  });

  it('reports deployed + stamps + docs/ai + hidden fence', () => {
    const dir = '/proj';
    const files = {
      [join(dir, 'docs/ai/.workflow-version')]: '1.3.0\n',
      [join(dir, 'docs/ai/.memory-version')]: '1.1.1\n',
      [join(dir, 'docs', 'ai')]: '',
      [join(dir, '.git', 'info', 'exclude')]: `# user rule\n${START_MARKER}\n/AGENTS.md\n`,
    };
    const r = surveyProject(dir, projectDeps({ files }));
    assert.equal(r.deployed, true);
    assert.equal(r.docsAiPresent, true);
    assert.equal(r.hiddenFence, true);
    assert.deepEqual(
      r.stamps.map((s) => [s.name, s.version]),
      [['agent-workflow-kit', '1.3.0'], ['agent-workflow-memory', '1.1.1']],
    );
  });

  it('reports not-deployed when there is no docs/ai and no stamp', () => {
    const r = surveyProject('/empty', projectDeps({ files: {} }));
    assert.equal(r.deployed, false);
    assert.equal(r.hiddenFence, false);
    assert.ok(r.stamps.every((s) => s.version === null));
    assert.equal(r.adrLayout, 'none', 'no ADR substrate → none');
  });

  it('the ADR-layout probe never throws — an exists() error degrades to none (read-only invariant)', () => {
    const r = surveyProject('/proj', { exists: () => { throw new Error('EACCES'); } });
    assert.equal(r.adrLayout, 'none', 'a failing fs probe degrades to none, never crashes the status read');
  });

  it('reports the ADR-store layout: old (monolith present) / migrated (adr/ present) / none (AD-051)', () => {
    const dir = '/proj';
    const old = surveyProject(dir, projectDeps({ files: { [join(dir, 'docs/ai/history/decisions-archive.md')]: '' } }));
    assert.equal(old.adrLayout, 'old', 'a retired decisions-archive monolith → old (needs migration)');
    const migrated = surveyProject(dir, projectDeps({ files: { [join(dir, 'docs/ai/adr')]: '' } }));
    assert.equal(migrated.adrLayout, 'migrated', 'the one-file-per-ADR adr/ store, no monolith → migrated');
    // A monolith present WINS over an adr/ dir (a half-migrated tree still needs the migration to finish).
    const half = surveyProject(dir, projectDeps({ files: { [join(dir, 'docs/ai/history/decisions-archive-early.md')]: '', [join(dir, 'docs/ai/adr')]: '' } }));
    assert.equal(half.adrLayout, 'old', 'a monolith still on disk keeps the layout old even beside adr/');
  });
});

// ── surveyFamily: the memory offline caveat (Step 2.2) ─────────────────────────────

describe('surveyFamily — memory offline caveat (orchestration template probe)', () => {
  // Only the memory member validates as ok here; the others go FOREIGN — so only the memory row is
  // eligible for the orchestration-template caveat. The template probe keys on deps.exists/stat.
  const memoryValidate = (dir) =>
    String(dir).includes('agent-workflow-memory')
      ? { result: VALID, name: 'agent-workflow-memory', kind: 'memory-substrate', available: true }
      : { result: VALID, name: 'x', kind: 'x', available: true };
  const endsWithTemplate = (p) => String(p).endsWith(MEMORY_ORCH_TEMPLATE_REL);
  // STAT-FIRST marker probe → presence is modeled via `stat`. Default: every path is a present file.
  // Overrides make ONLY the template path absent (ENOENT) / uncheckable (EACCES) while SKILL.md markers
  // stay present, so the memory member still classifies OK and only the template probe varies.
  const memoryDeps = (templateStat) => ({
    stat: (p) => (endsWithTemplate(p) && templateStat ? templateStat() : { isFile: () => true }),
    getenv: {},
    home: '/home/test',
    validate: memoryValidate,
    readVersion: () => ({ version: '1.0.0' }),
  });
  const memoryRow = (rows) => rows.find((r) => r.kind === 'memory-substrate');

  it('an OK memory MISSING the orchestration template gets the offline caveat (refresh + restart)', () => {
    const rows = surveyFamily(memoryDeps(ENOENT));
    const caveats = memoryRow(rows).caveats ?? [];
    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /orchestration template/i);
    assert.match(caveats[0], /@latest init/, 'names the refresh command');
    assert.match(caveats[0], /restart/i, 'tells the user to restart the session');
    assert.ok(!/seed/i.test(caveats[0]), 'makes NO orchestration.json seeding-outcome claim');
  });

  it('an OK memory WITH the template carries NO caveat', () => {
    const rows = surveyFamily(memoryDeps(null));
    assert.equal(memoryRow(rows).caveats, undefined);
  });

  it('an OK memory MISSING the autonomy template gets its own offline caveat — inform, never gate (AD-044 Plan 4)', () => {
    // The Plan-3 decision holds: detectMemory never gates on the autonomy seed; the registry
    // caveat is the discovery mechanism instead (the recommendations advisor surfaces it).
    const deps = {
      stat: (p) => {
        if (String(p).endsWith('references/templates/autonomy.json')) return ENOENT();
        return { isFile: () => true };
      },
      getenv: {},
      home: '/home/test',
      validate: memoryValidate,
      readVersion: () => ({ version: '1.0.0' }),
    };
    const rows = surveyFamily(deps);
    const caveats = memoryRow(rows).caveats ?? [];
    assert.equal(caveats.length, 1, 'exactly the autonomy-template caveat');
    assert.match(caveats[0], /autonomy/i, 'names the missing autonomy template');
    assert.match(caveats[0], /@latest init/, 'names the refresh command');
    assert.ok(!/seed/i.test(caveats[0]), 'makes NO autonomy.json seeding-outcome claim');
  });

  it('an UNCHECKABLE probe (EACCES) makes NO false "missing" claim (caveat skipped)', () => {
    const rows = surveyFamily(memoryDeps(EACCES));
    assert.equal(memoryRow(rows).caveats, undefined, 'a non-ENOENT probe error must not assert absence');
  });

  it('a not-installed memory gets no caveat (the probe only runs for an ok install)', () => {
    const rows = surveyFamily({ stat: ENOENT, getenv: {}, home: '/home/test' });
    assert.equal(memoryRow(rows).caveats, undefined);
  });

  it('an UNCHECKABLE probe is never counted "checked, current" — freshness degrades to unknown (INV-B)', () => {
    const env = buildEnvelope(surveyFamily(memoryDeps(EACCES)));
    assert.equal(env.installed.find((e) => e.member === 'agent-workflow-memory').refresh.freshness, 'unknown');
    // …while a verified template keeps the checked-current claim.
    const ok = buildEnvelope(surveyFamily(memoryDeps(null)));
    assert.equal(ok.installed.find((e) => e.member === 'agent-workflow-memory').refresh.freshness, 'current');
  });
});

// ── surveyFamily: the bridge freshness probe (INV-A / INV-B) ────────────────────────

describe('surveyFamily — bridge freshness probe (placed vs kit-bundled mirror)', () => {
  // Only the codex bridge validates as ok here; every other member goes FOREIGN — so only the codex
  // row is eligible for the probe. The bundled side is modeled via deps.readFile against the
  // resolved `<bundleRoot>/<name>/capability.json` path (both sides stay local files).
  const bridgeValidate = (dir) =>
    String(dir).includes('codex-cli-bridge')
      ? { result: VALID, name: 'codex-cli-bridge', kind: 'execution-backend', available: true }
      : { result: VALID, name: 'x', kind: 'x', available: true };
  const bundlePath = join('codex-cli-bridge', 'capability.json');
  const bridgeDeps = ({ placed = '2.0.0', bundled = '2.1.0' } = {}) => ({
    stat: () => ({ isFile: () => true }),
    getenv: {},
    home: '/home/test',
    validate: bridgeValidate,
    readVersion: () => ({ version: placed }),
    readFile: (p) => {
      if (!String(p).endsWith(bundlePath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (bundled === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return typeof bundled === 'string' && bundled.startsWith('{') ? bundled : JSON.stringify({ version: bundled });
    },
  });
  const codexEnvelope = (deps) =>
    buildEnvelope(surveyFamily(deps)).installed.find((e) => e.member === 'codex-cli-bridge');

  it('INV-A: a placed bridge OLDER than the bundled mirror is behind — caveat + runnable per-kind recommend', () => {
    const e = codexEnvelope(bridgeDeps({ placed: '2.0.0', bundled: '2.1.0' }));
    assert.deepEqual(e.refresh, { behind: true, recommend: '/agent-workflow-kit setup', freshness: 'behind' });
    assert.equal(e.notes.length, 1);
    assert.match(e.notes[0], /older than the copy bundled with this kit/);
    assert.match(e.notes[0], /v2\.0\.0/);
    assert.match(e.notes[0], /v2\.1\.0/);
    assert.match(e.notes[0], /\/agent-workflow-kit setup/, 'the caveat names the runnable recovery');
    assert.ok(!/npx /.test(e.refresh.recommend), 'a bridge recommend is never an npx composition (npm is null)');
  });

  it('a placed bridge EQUAL to the bundled mirror is checked-current — no caveat, no behind', () => {
    const e = codexEnvelope(bridgeDeps({ placed: '2.1.0', bundled: '2.1.0' }));
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'current' });
    assert.equal(e.notes, undefined);
  });

  it('a placed bridge NEWER than the bundled mirror is NOT behind (the status axis never flags a downgrade)', () => {
    const e = codexEnvelope(bridgeDeps({ placed: '2.2.0', bundled: '2.1.0' }));
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'current' });
    assert.equal(e.notes, undefined);
  });

  it('INV-B: an unreadable PLACED version → unknown note, no crash, no behind AND no current claim; recovery = setup (it re-places from the intact bundle)', () => {
    const e = codexEnvelope(bridgeDeps({ placed: null, bundled: '2.1.0' }));
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'unknown' });
    assert.equal(e.notes.length, 1);
    assert.match(e.notes[0], /couldn't compare/);
    assert.match(e.notes[0], /installed copy has no readable version/);
    assert.match(e.notes[0], /\/agent-workflow-kit setup/, 'setup can repair an unreadable INSTALLED copy');
    assert.ok(!/npx /.test(e.notes[0]), 'no kit-refresh detour when the bundle itself is intact');
  });

  it('INV-B: an unreadable BUNDLED mirror → unknown note whose recovery is a KIT refresh (setup would re-copy the same broken bundle)', () => {
    const e = codexEnvelope(bridgeDeps({ placed: '2.1.0', bundled: null }));
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'unknown' });
    assert.match(e.notes[0], /bundled copy has no readable version/);
    assert.match(e.notes[0], /npx @sabaiway\/agent-workflow-kit@latest init/, 'the broken side is the bundle — refresh the kit first');
  });

  it('INV-B: a MALFORMED bundled manifest degrades to unknown, never a throw', () => {
    const e = codexEnvelope(bridgeDeps({ placed: '2.1.0', bundled: '{ not json' }));
    assert.equal(e.refresh.freshness, 'unknown');
  });

  it('a non-OK (foreign) bridge is out of the probe scope — not-checked, no caveat', () => {
    // With the shared FOREIGN-everything validate, the codex row never reaches OK → no probe runs.
    const e = codexEnvelope({ ...bridgeDeps({}), validate: () => ({ result: VALID, name: 'x', kind: 'x', available: true }) });
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'not-checked' });
    assert.equal(e.notes, undefined);
  });

  it('the DEFAULT bundle root resolves the real in-repo mirror (no injection → reads bridges/<name>/capability.json)', () => {
    // Feed the probe the REAL bundled version as the placed version: the comparison must run against
    // the in-repo bundle via the default root and conclude checked-current (version-agnostic).
    const realBundled = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'agent-workflow-kit', 'bridges', 'codex-cli-bridge', 'capability.json'), 'utf8'),
    ).version;
    const e = codexEnvelope({
      stat: () => ({ isFile: () => true }),
      getenv: {},
      home: '/home/test',
      validate: bridgeValidate,
      readVersion: () => ({ version: realBundled }),
    });
    assert.equal(e.refresh.freshness, 'current');
  });

  it('a version read that THROWS (present-but-unreadable SKILL.md, EACCES after validate) never crashes — placed-side unknown', () => {
    // The real readAuthoritativeVersion throws on an existing-but-unreadable SKILL.md: stat needs no
    // read permission, readFileSync does. The survey must degrade to the placed-side unknown note
    // (INV-B), never crash the read-only status.
    const e = codexEnvelope({ ...bridgeDeps({}), readVersion: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    assert.deepEqual(e.refresh, { behind: false, recommend: null, freshness: 'unknown' });
    assert.match(e.notes[0], /installed copy has no readable version/);
    assert.match(e.notes[0], /\/agent-workflow-kit setup/);
  });
});

// ── the bridge freshness probe, end-to-end: REAL validator + REAL files (no mocks) ────────────────
// Round-2 council regression: the unit fixtures above inject validate/readVersion; this block runs the
// probe through the real validateManifest + readAuthoritativeVersion over real temp files (the
// acceptance-fixture shape: the in-repo bundled bridge copied and downgraded), so the mocked pair can
// never drift from what the real validator accepts.

describe('surveyFamily — bridge freshness probe against the REAL validator + real files', () => {
  const bundledSrc = resolve(REPO_ROOT, 'agent-workflow-kit', 'bridges', 'codex-cli-bridge');

  it('a real placed copy downgraded below the real bundled mirror classifies OK and reads behind', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'awf-freshness-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const placedDir = join(tmp, 'codex-cli-bridge');
    cpSync(bundledSrc, placedDir, { recursive: true });
    const bundledVersion = JSON.parse(readFileSync(join(bundledSrc, 'capability.json'), 'utf8')).version;
    for (const f of ['capability.json', 'SKILL.md']) {
      const p = join(placedDir, f);
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll(bundledVersion, '0.0.1'));
    }
    // Default validate / readVersion / stat / readFile — only the placed dir is pointed at the fixture.
    const rows = surveyFamily({ getenv: { CODEX_CLI_BRIDGE_DIR: placedDir }, home: '/nonexistent-home' });
    const codex = rows.find((r) => r.name === 'codex-cli-bridge');
    assert.equal(codex.manifestState, OK, 'the downgraded real copy still passes the REAL validator');
    assert.equal(codex.version, '0.0.1');
    const e = buildEnvelope(rows).installed.find((x) => x.member === 'codex-cli-bridge');
    assert.deepEqual(e.refresh, { behind: true, recommend: '/agent-workflow-kit setup', freshness: 'behind' });
    assert.match(e.notes[0], new RegExp(`older than the copy bundled with this kit \\(v${bundledVersion.replaceAll('.', '\\.')}\\)`));
  });
});

// ── buildEnvelope: the no-leak --json contract (Step 2.1 / shape-drift guard 2.5) ───

describe('buildEnvelope — no-leak --json envelope', () => {
  const fam = [
    { name: 'agent-workflow-kit', kind: 'composition-root', installed: true, manifestState: OK, version: '1.16.0' },
    { name: 'agent-workflow-memory', kind: 'memory-substrate', installed: true, manifestState: OK, version: '1.0.0', caveats: ['memory note'] },
    { name: 'agent-workflow-engine', kind: 'methodology-engine', installed: false, manifestState: NOT_INSTALLED, version: null },
    { name: 'codex-cli-bridge', kind: 'execution-backend', installed: true, manifestState: FOREIGN, version: null },
    { name: 'antigravity-cli-bridge', kind: 'execution-backend', installed: false, manifestState: UNKNOWN, version: null },
  ];
  const PUBLIC_STATES = new Set(['installed', 'absent', 'other-tool', 'placeholder', 'invalid', 'unsupported', 'uncheckable']);

  it('exposes deploymentHead from the ONE kit constant (no third literal copy)', () => {
    assert.equal(buildEnvelope(fam).deploymentHead, EXPECTED_WORKFLOW_VERSION);
  });

  it('installed[] carries member/display/version/state (+ notes only when present, refresh always), state from the public set', () => {
    const env = buildEnvelope(fam);
    assert.equal(env.installed.length, fam.length);
    for (const e of env.installed) {
      // INV-1 (additive): the ONLY new key is `refresh` (always present) — the allowlist filter admits
      // it alongside the optional `notes`; every other field stays byte/shape-pinned.
      assert.deepEqual(Object.keys(e).filter((k) => k !== 'notes' && k !== 'refresh').sort(), ['display', 'member', 'state', 'version'].sort());
      assert.ok(PUBLIC_STATES.has(e.state), `state "${e.state}" must be a public token`);
      assert.deepEqual(Object.keys(e.refresh).sort(), ['behind', 'freshness', 'recommend'], 'refresh is { behind, recommend, freshness }');
    }
    const mem = env.installed.find((e) => e.member === 'agent-workflow-memory');
    assert.deepEqual(mem.notes, ['memory note']);
    assert.equal(mem.display, 'memory');
    const eng = env.installed.find((e) => e.member === 'agent-workflow-engine');
    assert.equal(eng.version, null);
    assert.equal(eng.state, 'absent');
    assert.equal(eng.notes, undefined, 'no notes key when there are no caveats');
    assert.equal(env.installed.find((e) => e.member === 'codex-cli-bridge').state, 'other-tool', 'foreign maps to a user-safe token, never the literal "foreign"');
  });

  it('INV-2: refresh is derived structurally — behind only for a CORE member carrying a caveat; recommend from FAMILY_MEMBERS.npm, never parsed', () => {
    const env = buildEnvelope(fam); // memory has a caveat; engine has none in this fixture
    const refreshOf = (member) => env.installed.find((e) => e.member === member).refresh;
    // memory: refreshable core + caveat → behind, command composed from its npm package
    assert.deepEqual(refreshOf('agent-workflow-memory'), { behind: true, recommend: 'npx @sabaiway/agent-workflow-memory@latest init', freshness: 'behind' });
    // engine: refreshable core but NOT installed here → nothing to check → not behind, not-checked
    assert.deepEqual(refreshOf('agent-workflow-engine'), { behind: false, recommend: null, freshness: 'not-checked' });
    // kit: composition-root (npm NON-null) → no freshness probe on this surface (two-axes doctrine)
    assert.deepEqual(refreshOf('agent-workflow-kit'), { behind: false, recommend: null, freshness: 'not-checked' });
    // bridges: execution-backend without a probe field (non-OK here) → not behind, not-checked
    assert.deepEqual(refreshOf('codex-cli-bridge'), { behind: false, recommend: null, freshness: 'not-checked' });
  });

  it('INV-2: a behind ENGINE (caveat present) derives behind + its own npm recommend command', () => {
    const withEngineCaveat = fam.map((m) =>
      m.kind === 'methodology-engine' ? { ...m, manifestState: OK, version: '1.1.0', caveats: ['engine present but does not ship the activity-procedures canon'] } : m,
    );
    const eng = buildEnvelope(withEngineCaveat).installed.find((e) => e.member === 'agent-workflow-engine');
    assert.deepEqual(eng.refresh, { behind: true, recommend: 'npx @sabaiway/agent-workflow-engine@latest init', freshness: 'behind' });
  });

  it('INV-2: a behind BRIDGE (probe row field) derives behind + the per-kind setup recommend — never npx', () => {
    const withBridgeProbe = fam.map((m) =>
      m.name === 'codex-cli-bridge'
        ? { ...m, manifestState: OK, version: '2.0.0', caveats: ['bridge note'], freshness: 'behind' }
        : m,
    );
    const codex = buildEnvelope(withBridgeProbe).installed.find((e) => e.member === 'codex-cli-bridge');
    assert.deepEqual(codex.refresh, { behind: true, recommend: '/agent-workflow-kit setup', freshness: 'behind' });
  });

  it('the project block exposes member/display/version stamps + adrLayout — NEVER the internal stamp filename', () => {
    const project = {
      dir: '/p',
      deployed: true,
      docsAiPresent: true,
      adrLayout: 'old',
      hiddenFence: true,
      stamps: [
        { name: 'agent-workflow-kit', file: 'docs/ai/.workflow-version', version: '1.3.0' },
        { name: 'agent-workflow-memory', file: 'docs/ai/.memory-version', version: '1.0.0' },
      ],
    };
    const env = buildEnvelope(fam, project);
    assert.equal(env.project.dir, '/p');
    assert.equal(env.project.deployed, true);
    assert.equal(env.project.docsAi, true);
    assert.equal(env.project.adrLayout, 'old', 'the ADR-store layout is a user-safe token on the envelope');
    for (const s of env.project.deployStamps) {
      assert.deepEqual(Object.keys(s).sort(), ['display', 'member', 'version'].sort());
      assert.equal('file' in s, false, 'the internal stamp filename must never appear');
    }
  });

  it('INV-4: the SERIALIZED envelope leaks NO INTERNAL_RENDER_FORBIDDEN term (notes, refresh.recommend, settings error, bridge states)', () => {
    const project = {
      dir: '/p', deployed: true, docsAiPresent: true, hiddenFence: true,
      stamps: [{ name: 'agent-workflow-kit', file: 'docs/ai/.workflow-version', version: '1.3.0' }],
    };
    const extras = {
      // a bridge whose readiness AND wrapper state are the PUBLIC 'unknown' — it must survive the scan.
      bridges: [{ member: 'antigravity-cli-bridge', display: 'antigravity-bridge', readiness: 'unknown', wrappers: [{ cmd: 'agy-review', state: 'unknown' }, { cmd: 'agy-run', state: 'unknown' }] }],
      visibility: { state: 'hidden' },
      settings: { recipes: { error: 'docs/ai/orchestration.json: bad' }, attribution: { effective: false }, velocity: { defaultMode: null } },
    };
    const blob = JSON.stringify(buildEnvelope(fam, project, extras)); // fam's memory row carries a caveat → refresh.recommend
    for (const leak of INTERNAL_RENDER_FORBIDDEN) {
      assert.ok(!blob.includes(leak), `envelope leaks internal term "${leak}"`);
    }
    // the EXCLUDED public token 'unknown' (a bridge state) MUST pass — it is both internal + public.
    assert.ok(blob.includes('"state":"unknown"'), 'a public bridge wrappers[].state="unknown" must survive the no-leak scan');
    // refresh.recommend IS in the serialized blob (so the scan genuinely covers it).
    assert.ok(blob.includes('npx @sabaiway/agent-workflow-memory@latest init'), 'refresh.recommend is part of the scanned envelope');
  });

  it('DISPLAY_NAMES covers every family member', () => {
    for (const m of FAMILY_MEMBERS) assert.ok(DISPLAY_NAMES[m.name], `no display label for ${m.name}`);
  });
});

// ── the settings survey (Phase 3) ──────────────────────────────────────────────────

// A canned git runner for inferVisibility: controls ls-files (tracked) + check-ignore (ignored).
const fakeGit = ({ tracked = false, ignored = false, error = false }) => (args) => {
  const sub = args[0];
  if (sub === 'ls-files') {
    if (error) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
    return { status: 0, stdout: tracked ? 'AGENTS.md\0' : '', stderr: '' };
  }
  if (sub === 'check-ignore') return ignored ? { status: 0, stdout: '.git/info/exclude:1:/AGENTS.md\tAGENTS.md\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};
const STAT_ENOENT = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

describe('surveyVisibility — three honest states via inferVisibility (never the hiddenFence bit)', () => {
  it('a tracked anchor → visible', () => {
    assert.equal(surveyVisibility('/p', { git: fakeGit({ tracked: true }), stat: STAT_ENOENT, env: {} }).state, 'visible');
  });
  it('untracked AND ignored → hidden', () => {
    assert.equal(surveyVisibility('/p', { git: fakeGit({ ignored: true }), stat: STAT_ENOENT, env: {} }).state, 'hidden');
  });
  it('untracked AND not ignored → unclear (the ambiguous case, in user-safe words)', () => {
    assert.equal(surveyVisibility('/p', { git: fakeGit({}), stat: STAT_ENOENT, env: {} }).state, 'unclear');
  });
  it('a git/probe error → a localized error field (never a crash), no marker term leaked', () => {
    const r = surveyVisibility('/p', { git: fakeGit({ error: true }), stat: STAT_ENOENT, env: {} });
    assert.ok(r.error, 'a localized error field is present');
    assert.ok(!/fence|marker|hiddenFence/i.test(JSON.stringify(r)), 'no internal marker term leaks');
  });
});

// A path-aware fs for the velocity-profile readSettingsFile (project vs local .claude/settings.*).
const settingsFs = ({ project, local }) => ({
  lstat: (p) => {
    const s = String(p);
    if (s.endsWith('settings.local.json')) { if (local === undefined) return STAT_ENOENT(); return { isFile: () => true }; }
    if (s.endsWith('settings.json')) { if (project === undefined) return STAT_ENOENT(); return { isFile: () => true }; }
    return STAT_ENOENT();
  },
  readFile: (p) => {
    const s = String(p);
    if (s.endsWith('settings.local.json')) return local;
    if (s.endsWith('settings.json')) return project;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
});

describe('surveyRecipes — engine-free effective recipe per slot', () => {
  const detect = (codex, agy) => () => [{ name: 'codex-cli-bridge', readiness: codex }, { name: 'antigravity-cli-bridge', readiness: agy }];

  it('a config entry drives the slot (execute=delegated when codex ready), source=config', () => {
    const r = surveyRecipes('/p', {
      detect: detect(READY, NEEDS_SKILL),
      lstat: () => ({}),
      readFile: () => JSON.stringify({ 'plan-execution': { execute: 'delegated' } }),
    });
    assert.equal(r.configSource, 'docs/ai/orchestration.json');
    assert.equal(r.activities['plan-execution'].execute.recipe, 'delegated');
    assert.equal(r.activities['plan-execution'].execute.source, 'config');
  });

  it('absent config → computed defaults (review→reviewed when a backend is ready)', () => {
    const r = surveyRecipes('/p', { detect: detect(READY, NEEDS_SKILL), lstat: STAT_ENOENT, readFile: () => '' });
    assert.equal(r.configSource, 'none');
    assert.equal(r.activities['plan-authoring'].review.recipe, 'reviewed');
    assert.equal(r.activities['plan-authoring'].review.source, 'default');
  });

  it('malformed orchestration.json → a localized error field (never a crash)', () => {
    const r = surveyRecipes('/p', { detect: detect(READY, READY), lstat: () => ({}), readFile: () => '{ not json' });
    assert.ok(r.error);
    assert.match(r.error, /orchestration\.json/);
  });

  it('a detector failure floors recipes at solo BUT surfaces detectError (no silent failure)', () => {
    const r = surveyRecipes('/p', {
      detect: () => { throw new Error('corrupt bridge manifest'); },
      lstat: STAT_ENOENT,
      readFile: () => '',
    });
    assert.equal(r.activities['plan-authoring'].review.recipe, 'solo', 'floors at solo when detection is unavailable');
    assert.ok(r.detectError, 'the detection failure is surfaced, never swallowed');
    assert.match(r.detectError, /corrupt bridge/);
  });
});

describe('surveyAttribution — includeCoAuthoredBy precedence (local > project)', () => {
  it('local overrides project when it sets the key', () => {
    const r = surveyAttribution('/p', settingsFs({ project: '{"includeCoAuthoredBy":true}', local: '{"includeCoAuthoredBy":false}' }));
    assert.deepEqual(r, { project: true, local: false, effective: false });
  });
  it('project value used when local does NOT set the key', () => {
    const r = surveyAttribution('/p', settingsFs({ project: '{"includeCoAuthoredBy":true}', local: '{}' }));
    assert.equal(r.effective, true);
    assert.equal(r.local, null);
  });
  it('malformed settings.json → a localized error field', () => {
    const r = surveyAttribution('/p', settingsFs({ project: '{ bad', local: undefined }));
    assert.ok(r.error);
    assert.match(r.error, /settings\.json/);
  });
});

describe('surveyVelocity — effective defaultMode + allow counts', () => {
  it('reports effective defaultMode (local>project) and per-source allow counts', () => {
    const r = surveyVelocity('/p', settingsFs({
      project: JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }),
      local: JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(cat:*)', 'Bash(grep:*)'] } }),
    }));
    assert.equal(r.defaultMode, 'acceptEdits');
    assert.deepEqual(r.allowEntries, { project: 1, local: 2 });
  });
  it('malformed settings.local.json → a localized error field', () => {
    const r = surveyVelocity('/p', settingsFs({ project: '{}', local: '{ bad' }));
    assert.ok(r.error);
    assert.match(r.error, /settings\.local\.json/);
  });
});

describe('surveyGateHook — wired (either settings file) / file placed / declaration present', () => {
  const HOOK_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"';
  const wired = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_CMD, timeout: 30 }] }] } });
  // Layer a gates.json over the settings fs (the declaredGates probe reads it via loadDeclaration).
  const withGates = (fs, declaration) => ({
    ...fs,
    lstat: (p) => (String(p).endsWith('gates.json') && declaration !== undefined ? { isFile: () => true } : fs.lstat(p)),
    readFile: (p) => (String(p).endsWith('gates.json') && declaration !== undefined ? declaration : fs.readFile(p)),
  });

  it('reports wired from the LOCAL settings file too, plus the file/declaration probes', () => {
    const r = surveyGateHook('/p', {
      ...settingsFs({ project: '{}', local: wired }),
      exists: (p) => String(p).endsWith('agent-workflow-gates.mjs') || String(p).endsWith('gates.json'),
    });
    assert.deepEqual(r, { wired: true, filePlaced: true, declarationPresent: true, declaredGates: 0 });
  });

  it('nothing wired / placed / declared → all-false + zero declared (an honest zero, never an error)', () => {
    const r = surveyGateHook('/p', { ...settingsFs({ project: undefined, local: undefined }), exists: () => false });
    assert.deepEqual(r, { wired: false, filePlaced: false, declarationPresent: false, declaredGates: 0 });
  });

  it('declaredGates counts a NON-EMPTY declaration (the hook rung keys on entries, not file presence)', () => {
    const declaration = JSON.stringify({ gates: [
      { id: 'tests', title: 'Tests', cmd: 'npm test' },
      { id: 'lint', title: 'Lint', cmd: 'npm run lint' },
    ] });
    const r = surveyGateHook('/p', {
      ...withGates(settingsFs({ project: undefined, local: undefined }), declaration),
      exists: (p) => String(p).endsWith('gates.json'),
    });
    assert.deepEqual(r, { wired: false, filePlaced: false, declarationPresent: true, declaredGates: 2 });
  });

  it('the seeded-EMPTY declaration reads as zero declared (a fresh bootstrap must not fire the hook rung)', () => {
    const r = surveyGateHook('/p', {
      ...withGates(settingsFs({ project: undefined, local: undefined }), JSON.stringify({ gates: [] })),
      exists: (p) => String(p).endsWith('gates.json'),
    });
    assert.equal(r.declaredGates, 0);
    assert.equal(r.declarationPresent, true, 'present-but-empty: the file exists, zero gates declared');
  });

  it('a MALFORMED gates.json → declaredGates null + the localized error PRESERVED (never a swallowed reason)', () => {
    const r = surveyGateHook('/p', {
      ...withGates(settingsFs({ project: undefined, local: undefined }), '{ not json'),
      exists: (p) => String(p).endsWith('gates.json'),
    });
    assert.equal(r.declaredGates, null);
    assert.ok(r.declarationError, 'the validation error is carried, not dropped');
    assert.match(r.declarationError, /gates\.json/, 'the error names the file');
    assert.equal(r.wired, false, 'the rest of the area still reports');
  });

  it('malformed settings.json → a localized error field', () => {
    const r = surveyGateHook('/p', { ...settingsFs({ project: '{ bad', local: undefined }), exists: () => false });
    assert.ok(r.error);
    assert.match(r.error, /settings\.json/);
  });
});

describe('surveyCheapAgents — the kit-placed .claude/agents/ vehicles (placed vs bundled)', () => {
  const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  // A hermetic bundle + project fs: bundle templates under /bundle, project files under .claude/agents/.
  const vehicleFs = ({ bundle, project = {} }) => ({
    bundleDir: '/bundle',
    readdir: () => Object.keys(bundle),
    readFile: (p) => {
      const s = String(p);
      const name = s.split('/').pop();
      if (s.startsWith('/bundle')) return bundle[name];
      if (Object.prototype.hasOwnProperty.call(project, name)) return project[name];
      throw ENOENT();
    },
    lstat: (p) => {
      const s = String(p);
      const name = s.split('/').pop();
      if (s.includes('.claude/agents') && Object.prototype.hasOwnProperty.call(project, name)) {
        return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
      }
      throw ENOENT();
    },
  });

  it('none placed → placed=0 with the bundle count (the welcome-mat agents rung keys on zero placed)', () => {
    const r = surveyCheapAgents('/p', vehicleFs({ bundle: { 'sweep.md': 'S', 'triage.md': 'T' } }));
    assert.deepEqual(r, { bundled: 2, placed: 0 });
  });

  it('an identical AND a customized copy both count as placed (a customization is present, never "absent")', () => {
    const r = surveyCheapAgents('/p', vehicleFs({
      bundle: { 'sweep.md': 'S', 'triage.md': 'T' },
      project: { 'sweep.md': 'S', 'triage.md': 'customized' },
    }));
    assert.deepEqual(r, { bundled: 2, placed: 2 });
  });

  it('an unreadable bundle → a localized error field (never a crash, never a false zero)', () => {
    const r = surveyCheapAgents('/p', { bundleDir: '/bundle', readdir: () => { throw new Error('EACCES'); } });
    assert.ok(r.error, 'a localized error field is present');
  });
});

describe('surveySettings — the five per-area surveys, each independently localized-on-error', () => {
  it('returns exactly the five areas (agents included)', () => {
    const s = surveySettings('/p', {
      ...settingsFs({ project: undefined, local: undefined }),
      exists: () => false,
      bundleDir: '/bundle',
      readdir: () => { throw new Error('EACCES'); },
    });
    assert.deepEqual(Object.keys(s).sort(), ['agents', 'attribution', 'hook', 'recipes', 'velocity']);
  });
});

describe('surveyBridges — host wrapper PATH presence + readiness, NO model claim', () => {
  const detect = () => [{ name: 'codex-cli-bridge', readiness: READY }, { name: 'antigravity-cli-bridge', readiness: NEEDS_SKILL }];
  const findOnPath = (cmd) => ({ bin: cmd, state: cmd === 'codex-exec' ? 'present' : 'missing', path: null });

  it('probes wrapperCmds directly (not detect-backends wrappers[]) + reports readiness', () => {
    const bridges = surveyBridges({ detect, findOnPath });
    assert.equal(bridges.length, 2);
    const codex = bridges.find((b) => b.member === 'codex-cli-bridge');
    assert.equal(codex.readiness, READY);
    assert.deepEqual(codex.wrappers, [{ cmd: 'codex-exec', state: 'present' }, { cmd: 'codex-review', state: 'missing' }]);
  });

  it('preserves findOnPath "unknown" (cannot confirm) — never flattened to a false "missing"', () => {
    const bridges = surveyBridges({ detect, findOnPath: (cmd) => ({ bin: cmd, state: 'unknown', path: null }) });
    assert.ok(bridges.every((b) => b.wrappers.every((w) => w.state === 'unknown')), 'unknown stays distinct from missing');
  });

  it('NEVER claims a default model (negative drift-guard)', () => {
    assert.ok(!/"model"/i.test(JSON.stringify(surveyBridges({ detect, findOnPath }))), 'bridges must not invent a model field');
  });

  it('a detector failure floors readiness to "unknown" (never a crash)', () => {
    const bridges = surveyBridges({ detect: () => { throw new Error('corrupt'); }, findOnPath });
    assert.ok(bridges.every((b) => b.readiness === 'unknown'));
  });
});

describe('buildEnvelope — Phase-3 extras merge without breaking the Phase-2 shape', () => {
  const fam = [{ name: 'agent-workflow-kit', kind: 'composition-root', installed: true, manifestState: OK, version: '1.16.0' }];
  const project = { dir: '/p', deployed: true, docsAiPresent: true, hiddenFence: true, stamps: [] };

  it('top-level bridges + project.visibility + project.settings; no internal leak', () => {
    const extras = {
      bridges: [{ member: 'codex-cli-bridge', display: 'codex-bridge', readiness: 'ready', wrappers: [{ cmd: 'codex-exec', state: 'present' }] }],
      visibility: { state: 'hidden' },
      settings: { recipes: { configSource: 'none', activities: {} }, attribution: { effective: false }, velocity: { defaultMode: null } },
    };
    const env = buildEnvelope(fam, project, extras);
    assert.deepEqual(env.bridges, extras.bridges);
    assert.equal(env.project.visibility.state, 'hidden');
    assert.ok(env.project.settings.recipes);
    const blob = JSON.stringify(env);
    for (const leak of ['hiddenFence', 'manifestState', '"model"']) assert.ok(!blob.includes(leak), `leaks ${leak}`);
  });

  it('omits the Phase-3 keys when no extras are passed (Phase-2 shape preserved)', () => {
    const env = buildEnvelope(fam, project);
    assert.equal('bridges' in env, false);
    assert.equal('visibility' in env.project, false);
    assert.equal('settings' in env.project, false);
  });
});

// ── the CLI parse contract (Plan §4.5 — loud reject, no silent failure) ─────────────────────────────

describe('parseArgs — loud reject (no more silent ignore)', () => {
  it('accepts a --dir value and returns it', () => {
    assert.deepEqual(parseArgs(['--dir', '/p']), { dir: '/p' });
  });
  it('accepts the known/format flags without throwing (dir undefined)', () => {
    assert.deepEqual(parseArgs([]), { dir: undefined });
    assert.deepEqual(parseArgs(['--json']), { dir: undefined });
    assert.deepEqual(parseArgs(['--format=ansi', '--dir', '/p']), { dir: '/p' });
  });
  it('rejects an unknown flag loudly (was silently ignored before)', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown argument: --bogus/);
  });
  it('rejects --dir with no value (last token)', () => {
    assert.throws(() => parseArgs(['--dir']), /--dir needs a value/);
  });
  it('rejects --dir whose next token is a flag, not a value', () => {
    assert.throws(() => parseArgs(['--dir', '--json']), /--dir needs a value/);
  });
  it('rejects a REPEATED/trailing --dir with no value (not just the first occurrence)', () => {
    assert.throws(() => parseArgs(['--dir', '/p', '--dir']), /--dir needs a value/);
  });
  it('a repeated --dir with a value is last-wins (both validated)', () => {
    assert.deepEqual(parseArgs(['--dir', '/p', '--dir', '/q']), { dir: '/q' });
  });
  it('does not mistake the --dir VALUE for an unknown flag', () => {
    assert.deepEqual(parseArgs(['--dir', '/weird-path', '--json']), { dir: '/weird-path' });
  });
});

// ── drift-guard: FAMILY_MEMBERS ⟷ the 5 in-repo capability.json (the AD-008 lockstep pattern) ──────

describe('FAMILY_MEMBERS drift-guard', () => {
  const readManifest = (memberName) =>
    JSON.parse(readFileSync(resolve(REPO_ROOT, memberName, 'capability.json'), 'utf8'));

  // deduped roles[].cmd, in first-seen order (mirrors detect-backends' wrapperCmds derivation).
  const dedupedCmds = (manifest) => {
    const seen = new Set();
    const out = [];
    for (const role of Object.values(manifest.roles ?? {})) {
      if (role && typeof role.cmd === 'string' && !seen.has(role.cmd)) {
        seen.add(role.cmd);
        out.push(role.cmd);
      }
    }
    return out;
  };

  it('has exactly the five family members and no release skills', () => {
    assert.equal(FAMILY_MEMBERS.length, 5);
    const names = FAMILY_MEMBERS.map((m) => m.name);
    assert.ok(!names.includes('release-engineering'));
    assert.ok(!names.includes('release-marketing'));
  });

  for (const member of FAMILY_MEMBERS) {
    it(`${member.name}: name/kind/detect.installed/deployed/npm/wrapperCmds match the in-repo manifest`, () => {
      const m = readManifest(member.name);
      assert.equal(m.name, member.name);
      assert.equal(m.kind, member.kind);

      assert.equal(m.detect.installed.env, member.installed.env);
      assert.equal(m.detect.installed.default, member.installed.default);
      assert.equal(m.detect.installed.file, member.installed.file);

      if (member.deployed) assert.equal(m.detect.deployed.file, member.deployed.file);
      else assert.equal(m.detect?.deployed ?? null, null);

      if (member.npm) assert.equal(m.install.npm, member.npm);
      else assert.equal(m.install?.npm ?? null, null);

      assert.deepEqual(dedupedCmds(m), member.wrapperCmds);
    });
  }
});
