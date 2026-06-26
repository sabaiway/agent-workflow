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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..'); // agent-workflow-kit/tools → repo root

// Build classifyMember deps that present the marker, with an injectable validate/readVersion.
const installedDeps = ({ report, version = '9.9.9', home = '/home/test' }) => ({
  exists: () => true,
  stat: () => ({ isFile: () => true }),
  getenv: {},
  home,
  validate: () => report,
  readVersion: () => ({ version }),
});

const KIT = FAMILY_MEMBERS.find((m) => m.name === 'agent-workflow-kit');

// ── classifyMember ───────────────────────────────────────────────────────────────

describe('classifyMember', () => {
  it('marks an absent marker as not-installed (no skillDir, no version)', () => {
    const r = classifyMember(KIT, { exists: () => false, getenv: {}, home: '/home/test' });
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

  it('surfaces an EACCES marker probe as "unknown" — never masked as not-installed', () => {
    const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const r = classifyMember(KIT, { exists: eacces, getenv: {}, home: '/home/test' });
    assert.equal(r.manifestState, UNKNOWN);
    assert.equal(r.installed, false); // not removed — ownership could not be verified
  });

  it('resolves the skill dir from the env override when set (resolveDir reuse)', () => {
    const r = classifyMember(KIT, {
      exists: () => true,
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
    const rows = surveyFamily({ exists: () => false, getenv: {}, home: '/home/test' });
    assert.equal(rows.length, FAMILY_MEMBERS.length);
    assert.ok(rows.every((r) => r.manifestState === NOT_INSTALLED));
  });

  // Only the engine member validates as ok (its name+kind match); the others go FOREIGN under this
  // shared validate stub — so only the engine row is eligible for the orchestration-fragment caveat.
  const engineValidate = (dir) =>
    String(dir).includes('agent-workflow-engine')
      ? { result: VALID, name: 'agent-workflow-engine', kind: 'methodology-engine', available: true }
      : { result: VALID, name: 'x', kind: 'x', available: true };

  // The caveat mirrors the reconcile: it reads the orchestration fragment (readEngineFragment), so an
  // absent / non-file / unreadable fragment all surface; a current readable fragment does not.
  const engineDeps = (over) => ({
    exists: () => true, // SKILL.md marker present (classifyMember)
    stat: () => ({ isFile: () => true }),
    getenv: {},
    home: '/home/test',
    validate: engineValidate,
    readVersion: () => ({ version: '1.2.0' }),
    ...over,
  });

  it('an OK engine MISSING the orchestration fragment gets a plain caveat', () => {
    const rows = surveyFamily(engineDeps({
      readVersion: () => ({ version: '1.1.0' }),
      statType: (p) => (String(p).endsWith('orchestration-slot.md') ? null : 'dir'), // fragment ABSENT
    }));
    const engine = rows.find((r) => r.kind === 'methodology-engine');
    assert.equal(engine.manifestState, OK);
    assert.ok(engine.caveat, 'an engine without the recipes fragment carries a caveat');
    assert.match(engine.caveat, /recipes pointer|too old|incomplete/i);
  });

  it('a current engine WITH a readable orchestration fragment carries NO caveat', () => {
    const rows = surveyFamily(engineDeps({
      statType: (p) => (String(p).endsWith('orchestration-slot.md') ? 'file' : 'dir'),
      readFileSync: () => '> orchestration recipes pointer', // present + readable
    }));
    const engine = rows.find((r) => r.kind === 'methodology-engine');
    assert.equal(engine.manifestState, OK);
    assert.ok(!engine.caveat);
  });

  it('a broken engine whose orchestration "fragment" is a DIRECTORY is NOT a false "ok"', () => {
    const rows = surveyFamily(engineDeps({
      statType: () => 'dir', // orchestration path is a directory, not a file
    }));
    assert.ok(rows.find((r) => r.kind === 'methodology-engine').caveat, 'a non-file fragment is caveated');
  });

  it('a current engine whose orchestration fragment is PRESENT but UNREADABLE is NOT a false "ok"', () => {
    const rows = surveyFamily(engineDeps({
      statType: (p) => (String(p).endsWith('orchestration-slot.md') ? 'file' : 'dir'), // present as a file
      readFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); // but unreadable
      },
    }));
    const engine = rows.find((r) => r.kind === 'methodology-engine');
    assert.ok(engine.caveat, 'an unreadable fragment is caveated (mirrors the reconcile STOP), not reported clean');
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
