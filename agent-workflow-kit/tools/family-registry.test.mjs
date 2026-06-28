import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAMILY_MEMBERS,
  classifyMember,
  surveyFamily,
  surveyProject,
  buildEnvelope,
  DISPLAY_NAMES,
  MEMORY_ORCH_TEMPLATE_REL,
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  OK,
  UNKNOWN,
} from './family-registry.mjs';
import { VALID, INVALID, UNSUPPORTED } from './manifest/validate.mjs';
import { START_MARKER } from './hide-footprint.mjs';
import { ORCHESTRATION_FRAGMENT_REL, PROCEDURES_FRAGMENT_REL } from './engine-source.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

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
  const fragmentStat = ({ orch = 'file', proc = 'file' }) => (p) => {
    const s = String(p);
    if (s.endsWith(ORCHESTRATION_FRAGMENT_REL)) return orch;
    if (s.endsWith(PROCEDURES_FRAGMENT_REL)) return proc;
    return 'dir';
  };
  const caveatsOf = (rows) => rows.find((r) => r.kind === 'methodology-engine').caveats ?? [];

  it('a current engine WITH BOTH fragments readable carries NO caveat', () => {
    const rows = surveyFamily(engineDeps({ statType: fragmentStat({}), readFileSync: () => '> a bounded fragment' }));
    const engine = rows.find((r) => r.kind === 'methodology-engine');
    assert.equal(engine.manifestState, OK);
    assert.equal(engine.caveats, undefined, 'no caveats when both live fragments are present + readable');
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

  it('an engine MISSING BOTH fragments surfaces BOTH caveats (neither overwrites the other)', () => {
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.1.0' }),
      statType: fragmentStat({ orch: null, proc: null }),
    }));
    const caveats = caveatsOf(rows);
    assert.equal(caveats.length, 2, 'both missing fragments are reported');
    assert.ok(caveats.some((c) => /recipes pointer/i.test(c)));
    assert.ok(caveats.some((c) => /activity-procedures|procedures canon/i.test(c)));
  });

  it('a broken engine whose fragments are DIRECTORIES is NOT a false "ok"', () => {
    const rows = surveyFamily(engineDeps({ statType: () => 'dir' })); // every fragment path is a dir
    assert.equal(caveatsOf(rows).length, 2, 'non-file fragments are caveated');
  });

  it('a fragment PRESENT but UNREADABLE is NOT a false "ok" (mirrors the consumer STOP)', () => {
    const rows = surveyFamily(engineDeps({
      statType: fragmentStat({}), // both present as files
      readFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); // but unreadable
      },
    }));
    assert.equal(caveatsOf(rows).length, 2, 'unreadable fragments are caveated, not reported clean');
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

  it('an UNCHECKABLE probe (EACCES) makes NO false "missing" claim (caveat skipped)', () => {
    const rows = surveyFamily(memoryDeps(EACCES));
    assert.equal(memoryRow(rows).caveats, undefined, 'a non-ENOENT probe error must not assert absence');
  });

  it('a not-installed memory gets no caveat (the probe only runs for an ok install)', () => {
    const rows = surveyFamily({ stat: ENOENT, getenv: {}, home: '/home/test' });
    assert.equal(memoryRow(rows).caveats, undefined);
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

  it('installed[] carries member/display/version/state (+ notes only when present), state from the public set', () => {
    const env = buildEnvelope(fam);
    assert.equal(env.installed.length, fam.length);
    for (const e of env.installed) {
      assert.deepEqual(Object.keys(e).filter((k) => k !== 'notes').sort(), ['display', 'member', 'state', 'version'].sort());
      assert.ok(PUBLIC_STATES.has(e.state), `state "${e.state}" must be a public token`);
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

  it('the project block exposes member/display/version stamps — NEVER the internal stamp filename', () => {
    const project = {
      dir: '/p',
      deployed: true,
      docsAiPresent: true,
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
    for (const s of env.project.deployStamps) {
      assert.deepEqual(Object.keys(s).sort(), ['display', 'member', 'version'].sort());
      assert.equal('file' in s, false, 'the internal stamp filename must never appear');
    }
  });

  it('leaks NO internal field name or stamp filename anywhere in the serialized envelope', () => {
    const project = {
      dir: '/p', deployed: true, docsAiPresent: true, hiddenFence: true,
      stamps: [{ name: 'agent-workflow-kit', file: 'docs/ai/.workflow-version', version: '1.3.0' }],
    };
    const blob = JSON.stringify(buildEnvelope(fam, project));
    for (const leak of ['manifestState', 'hiddenFence', '.workflow-version', '.memory-version', 'foreign', 'not-installed']) {
      assert.ok(!blob.includes(leak), `envelope leaks internal term "${leak}"`);
    }
  });

  it('DISPLAY_NAMES covers every family member', () => {
    for (const m of FAMILY_MEMBERS) assert.ok(DISPLAY_NAMES[m.name], `no display label for ${m.name}`);
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
