// composed-lines-ux.test.mjs — the L2 class guard over the kit's tool-COMPOSED user-facing lines.
// The verbatim-paste contract makes these lines the exact bytes a third-party user reads, so they
// must be user-grade: (a) alarm words only under a DETECTED abnormal condition; (b) machine tokens
// never inside a human sentence; (c) internal names only as a machine-line prefix/self-label or a
// runnable command/path. ONE designed exception (AD-092 D6): the ensures' LEADING outcome token —
// characterized, never swept. Completeness is enumerated FROM each closed vocabulary/branch set,
// and the rule's doc half (references/shared/deploy-tail.md) is bound below. Dev-only repo test.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENSURE_TOKENS, FAILURE_CAUSES } from '../tools/ensure-vocabulary.mjs';
import {
  composeFailure, ensureAutonomy, ensureGates, ensureIndex, ensureOrchestration, ensureScripts, failedOutcome,
} from '../tools/ensure-ops.mjs';
import { main as ensureConfigsMain } from '../tools/ensure-configs.mjs';
import { CONFIG_REL, KNOWN_PRIOR_README } from '../tools/orchestration-config.mjs';
import { PARITY, parityVerdict, unverifiableParity } from '../tools/refresh-parity.mjs';
import { REFRESH_LINES, SKIPPED_READONLY, driftSummary } from '../tools/setup-backends.mjs';
import { reconcileSettings } from '../tools/bridge-settings.mjs';
import { settingsPath } from '../tools/bridge-settings-read.mjs';
import { OUTCOME_LINES } from '../tools/lens-region.mjs';
import { formatReport } from '../tools/hide-footprint.mjs';
import { readEngineFragment } from '../tools/engine-source.mjs';
// The scanner leaf (its own negative controls live in composed-lines-scan.test.mjs); it sits under
// scripts/testing/ — not test/ — so the coverage run sees its lines.
import { ALARM_WORDS, INTERNAL_NAMES, scannable } from '../../scripts/testing/composed-lines-scan.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = join(KIT, '..', 'agent-workflow-engine');

// Machine tokens: NEVER inside a human sentence, normal or abnormal (the token slot is stripped
// before scanning — that slot is the designed exception, characterized below). Scanned members are
// the HYPHENATED forms — the vocabulary's own token shape. A bare-word member that doubles as
// ordinary English (`seeded`, `failed`, `drifted`) cannot be told from prose mechanically; those
// words ride invariant (a) where they alarm, and the slot characterization where they are tokens.
const MACHINE_TOKENS = [...new Set([...ENSURE_TOKENS, ...FAILURE_CAUSES, ...Object.values(PARITY), SKIPPED_READONLY])]
  .filter((token) => token.includes('-'));

// ── fixture collection ───────────────────────────────────────────────────────────
const SURFACES = [];
const fx = (surface, id, abnormal, lines) => SURFACES.push({ surface, id, abnormal, lines });

const teardowns = [];
after(() => { for (const t of teardowns) t(); });
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  teardowns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const project = ({ node = true } = {}) => {
  const dir = tmp('clux-');
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
  return dir;
};

// ── hide-footprint report lines (every action + every optional section) ──────────
const hfResult = (over = {}) => ({
  excludeFile: '/repo/.git/info/exclude', action: 'created', visibility: 'hidden',
  wrote: [], asks: [], needsUntrack: [], dropped: [], verify: [], global: { action: 'none' }, ...over,
});
for (const action of ['created', 'updated', 'noop', 'unhidden']) {
  fx('hide-footprint', `report-${action}`, false, formatReport(hfResult({ action, wrote: ['/AGENTS.md'], added: ['/AGENTS.md'], removed: [] }), false).split('\n'));
}
fx('hide-footprint', 'delta-mixed', false, formatReport(hfResult({ wrote: ['/AGENTS.md'], added: ['/AGENTS.md'], removed: ['/OLD-THING.md'] }), false).split('\n'));
fx('hide-footprint', 'delta-unchanged', false, formatReport(hfResult({ action: 'noop', wrote: ['/AGENTS.md'], added: [], removed: [] }), false).split('\n'));
fx('hide-footprint', 'dry-run-header', false, formatReport(hfResult(), true).split('\n'));
fx('hide-footprint', 'visible', false, formatReport(hfResult({ visibility: 'visible', anchor: '/AGENTS.md', action: 'noop' }), false).split('\n'));
fx('hide-footprint', 'ambiguous', true, formatReport(hfResult({ ambiguous: true, anchor: '/AGENTS.md', action: 'noop' }), false).split('\n'));
fx('hide-footprint', 'asks-untrack-dropped-global-kept', true, formatReport(hfResult({
  wrote: ['/.claude/settings.json', '/AGENTS.md'],
  asks: [{ path: '/GEMINI.md', reason: 'present but its name is generic (Gemini CLI) — confirm before hiding', owner: 'Gemini CLI' }],
  needsUntrack: [{ path: '/.claude/settings.json', command: 'git rm --cached -- .claude/settings.json' }],
  dropped: ['/docs/plans/'],
  global: { action: 'kept', source: '/home/u/.gitignore_global', removedLines: ['# header', '/AGENTS.md'] },
}), false).split('\n'));
fx('hide-footprint', 'global-removed', true, formatReport(hfResult({
  wrote: ['/AGENTS.md'],
  global: { action: 'removed', source: '/home/u/.gitignore_global', removedLines: ['/AGENTS.md'] },
}), false).split('\n'));

// ── ensure outcome lines (every token, every cause, through the real ops) ────────
const witnessedTokens = new Set();
const witnessedCauses = new Set();
const ensureFx = (id, outcome, abnormal = outcome.failed) => {
  assert.ok(ENSURE_TOKENS.includes(outcome.token), `${id}: token "${outcome.token}" is in the closed vocabulary`);
  witnessedTokens.add(outcome.token);
  let lines = outcome.lines;
  if (outcome.token === 'failed') {
    const cause = lines[0].split(' — ')[0];
    assert.ok(FAILURE_CAUSES.includes(cause), `${id}: the failure line opens with a closed cause word (got "${cause}")`);
    witnessedCauses.add(cause);
    lines = [lines[0].slice(`${cause} — `.length), ...lines.slice(1)];
  }
  fx('ensure', id, abnormal, lines);
};
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const eacces = (msg = 'EACCES: permission denied') => Object.assign(new Error(msg), { code: 'EACCES' });

{
  const dir = project();
  ensureFx('orchestration-seeded', ensureOrchestration({ cwd: dir, deps: {} }));
  ensureFx('orchestration-already-current', ensureOrchestration({ cwd: dir, deps: {} }));
}
{
  const dir = project();
  const prior = () => writeFileSync(join(dir, CONFIG_REL), `${JSON.stringify({ _README: KNOWN_PRIOR_README[0] }, null, 2)}\n`);
  prior();
  ensureFx('orchestration-would-refresh-note', ensureOrchestration({ cwd: dir, dryRun: true, deps: {} }));
  ensureFx('orchestration-note-refreshed', ensureOrchestration({ cwd: dir, deps: {} }));
  writeFileSync(join(dir, CONFIG_REL), `${JSON.stringify({ _README: 'my own note' }, null, 2)}\n`);
  ensureFx('orchestration-customized-preserved', ensureOrchestration({ cwd: dir, deps: {} }));
  writeFileSync(join(dir, CONFIG_REL), '{ not json');
  ensureFx('orchestration-malformed-preserved', ensureOrchestration({ cwd: dir, deps: {} }));
}
{
  const dir = project();
  ensureFx('orchestration-would-seed', ensureOrchestration({ cwd: dir, dryRun: true, deps: {} }));
  symlinkSync(join(dir, 'package.json'), join(dir, CONFIG_REL));
  ensureFx('orchestration-wrong-node-kind', ensureOrchestration({ cwd: dir, deps: {} }));
}
{
  // The create-only race, both arms (the ensure-ops.test.mjs deps dance): the config vanishing
  // around the seed is the race-unresolved cause.
  const dir = project();
  const fileStat = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
  let linked = false;
  let rechecked = false;
  ensureFx('orchestration-race-unresolved', ensureOrchestration({
    cwd: dir,
    deps: {
      link: () => { linked = true; throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
      lstat: (p) => {
        if (!p.endsWith('orchestration.json')) return statSync(p);
        if (linked && !rechecked) { rechecked = true; return fileStat; }
        throw enoent();
      },
    },
  }));
}
ensureFx('unexpected-error-catch-all', failedOutcome('orchestration', new Error('boom')));
{
  const dir = project();
  ensureFx('gates-would-seed', ensureGates({ cwd: dir, kitRoot: KIT, dryRun: true, deps: {} }));
  ensureFx('gates-seeded', ensureGates({ cwd: dir, kitRoot: KIT, deps: {} }));
  ensureFx('gates-already-present', ensureGates({ cwd: dir, kitRoot: KIT, deps: {} }));
  ensureFx('gates-template-unreadable', ensureGates({ cwd: project(), kitRoot: tmp('clux-empty-'), deps: {} }));
  ensureFx('autonomy-seeded', ensureAutonomy({ cwd: dir, kitRoot: KIT, deps: {} }));
}
{
  const dir = project();
  ensureFx('scripts-would-seed', ensureScripts({ cwd: dir, kitRoot: KIT, dryRun: true, deps: {} }));
  ensureFx('scripts-seeded', ensureScripts({ cwd: dir, kitRoot: KIT, deps: {} }));
  ensureFx('scripts-already-present', ensureScripts({ cwd: dir, kitRoot: KIT, deps: {} }));
  ensureFx('scripts-adr-layout-unverifiable', ensureScripts({ cwd: dir, kitRoot: KIT, deps: { statPath: () => { throw eacces(); } } }));
  const wrongKindDir = project();
  mkdirSync(join(wrongKindDir, 'scripts', 'archive-decisions.mjs'), { recursive: true });
  ensureFx('scripts-wrong-node-kind', ensureScripts({ cwd: wrongKindDir, kitRoot: KIT, deps: {} }));
}
ensureFx('scripts-skipped-no-node', ensureScripts({ cwd: project({ node: false }), kitRoot: KIT, deps: {} }));
{
  const dir = project();
  mkdirSync(join(dir, 'docs', 'ai', 'history'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md'), '# old monolith\n');
  ensureFx('scripts-old-adr-layout', ensureScripts({ cwd: dir, kitRoot: KIT, deps: {} }), true);
}
{
  // A bundle readable for file 1 and missing file 2 → the op stops PARTWAY and says so.
  const partialKit = tmp('clux-partial-');
  mkdirSync(join(partialKit, 'references', 'scripts'), { recursive: true });
  writeFileSync(join(partialKit, 'references', 'scripts', 'archive-decisions.mjs'), '// bundled\n');
  ensureFx('scripts-bundle-unreadable-partway', ensureScripts({ cwd: project(), kitRoot: partialKit, deps: {} }));
}
{
  const dir = project();
  ensureFx('scripts-write-refused', ensureScripts({ cwd: dir, kitRoot: KIT, deps: { link: () => { throw eacces(); } } }));
}
{
  // The navigator ensure drives a SEPARATE process, so its causes split by how far that process
  // got — every one witnessed through the real op, never a hand-composed line.
  const dir = project();
  const indexFx = (id, deps, dryRun = false) => ensureFx(id, ensureIndex({ cwd: project(), kitRoot: KIT, dryRun, deps }));
  ensureFx('index-would-regenerate', ensureIndex({ cwd: dir, kitRoot: KIT, dryRun: true, deps: {} }));
  ensureFx('index-regenerated', ensureIndex({ cwd: dir, kitRoot: KIT, deps: {} }));
  ensureFx('index-already-current', ensureIndex({ cwd: dir, kitRoot: KIT, deps: {} }));
  indexFx('index-generator-unlaunchable', { spawnSync: () => ({ error: enoent(), status: null, stdout: '', stderr: '' }) });
  indexFx('index-generator-failed', { spawnSync: () => ({ status: 3, stdout: '', stderr: 'the generator said nothing\n' }) });
  indexFx('index-probe-failed', { spawnSync: () => ({ status: 7, stdout: '', stderr: 'neither answer\n' }) }, true);
  indexFx('index-stale-after-write', {
    spawnSync: (_cmd, args) => (args.some((a) => a === '--ensure-index')
      ? { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' }
      // The probe's CANONICAL stale answer — the op matches the sentence, not the words.
      : { status: 1, stdout: '', stderr: '[check-docs-size] FAIL: docs/ai/index.md is stale (out of sync with source frontmatter).\n' }),
  });
}

// The real ensure CLI, BOTH exits: the `  op: token` slots are the characterized exception; every
// OTHER stdout line — the banner, the details, the failure footer — joins the scanned surface, a
// failure's closed cause opening stripped after characterization.
const cliFx = (id, dir, abnormal) => {
  const r = ensureConfigsMain(['--reconcile', '--cwd', dir], { kitRoot: KIT });
  const slots = [];
  const lines = [];
  for (const line of r.stdout.split('\n')) {
    const slot = line.match(/^  ([a-z]+): ([a-z-]+)$/);
    if (slot) { slots.push(slot); continue; }
    if (line.trim() === '') continue;
    lines.push(line.replace(new RegExp(`^(\\s*)(?:${FAILURE_CAUSES.join('|')}) — `), '$1'));
  }
  fx('ensure-cli', id, abnormal, lines);
  return { result: r, slots };
};
const CLI_RUNS = { success: cliFx('success-run', project(), false) };
{
  const dir = project();
  symlinkSync(join(dir, 'package.json'), join(dir, 'docs', 'ai', 'gates.json'));
  CLI_RUNS.failure = cliFx('failure-run', dir, true);
}

// ── the placed-bridge refresh lines (every REFRESH_LINES key + every parity verdict) ─
const witnessedRefresh = new Set();
const witnessedParity = new Set();
const refreshFx = (id, key, abnormal, ...args) => {
  witnessedRefresh.add(key);
  fx('refresh', id, abnormal, REFRESH_LINES[key](...args).split('\n'));
};
const emptyScan = { drifted: [], unreadable: [], absent: [], conflicts: [], modes: new Map() };
const emptyWrappers = { drifted: [], conflicts: [], unverifiable: [] };
const verdictOf = (scan, wrappers) => {
  const verdict = parityVerdict({ scan: { ...emptyScan, ...scan }, wrappers: { ...emptyWrappers, ...wrappers } });
  witnessedParity.add(verdict.state);
  return verdict;
};
refreshFx('unsupported', 'unsupported', true, 'codex-cli-bridge', 'POSIX .sh wrappers — run setup under WSL (Claude Code reads the kit natively on Windows)');
refreshFx('kept-newer', 'kept-newer', true, 'codex-cli-bridge', 'placed bridge is v2.4.0 but this kit bundles the older v2.3.0 — refusing to downgrade; update the kit first: npx @sabaiway/agent-workflow-kit@latest init');
refreshFx('not-placed', 'not-placed', false, 'antigravity-cli-bridge');
refreshFx('failed', 'failed', true, 'codex-cli-bridge', 'skill dir is non-empty but has no SKILL.md — refusing to overwrite unknown files: /home/u/.claude/skills/codex-cli-bridge');
refreshFx('failed-readonly', 'failed-readonly', true, 'codex-cli-bridge', '[agent-workflow-kit] EROFS: read-only file system');
refreshFx('skipped-readonly-clean', SKIPPED_READONLY, true, 'codex-cli-bridge', '2.3.0', verdictOf({}, {}));
refreshFx('skipped-readonly-drifted', SKIPPED_READONLY, true, 'codex-cli-bridge', '2.3.0', verdictOf(
  { drifted: ['setup/codex-exec.sh'], absent: ['setup/README.md'], conflicts: ['setup/x (a symlink is in the way)'], unreadable: ['setup/y.md'] },
  { drifted: ['wrapper codex-exec (not linked)'] },
));
refreshFx('skipped-readonly-unverifiable', SKIPPED_READONLY, true, 'codex-cli-bridge', null, (() => {
  const verdict = unverifiableParity('the bundle/placed comparison (EACCES)');
  witnessedParity.add(verdict.state);
  return verdict;
})());
refreshFx('already-current', 'already-current', false, 'codex-cli-bridge', ' (v2.3.0)', null);
refreshFx('already-current-drift', 'already-current', true, 'codex-cli-bridge', ' (v2.3.0)', driftSummary({ drifted: ['setup/codex-exec.sh'], unreadable: ['setup/README.md'], absent: [], conflicts: [], modes: new Map() }));
refreshFx('refreshed', 'refreshed', false, 'codex-cli-bridge', ' (v2.3.0 → v2.4.0)');

// ── the bridge-settings reconcile lines (every branch of its outcome set) ────────
const witnessedReconcile = new Set();
const SYNTH_SETTINGS = [
  { key: 'AW_GUARD_KNOB', kind: 'boolean', default: '0', effect: 'a test knob' },
  { key: 'AW_OLD_KNOB', kind: 'boolean', default: '0', effect: 'an old knob', retired: 'the wrappers no longer read it.' },
];
const settingsFx = (id, abnormal, { text, unusable = false } = {}) => {
  const home = tmp('clux-home-');
  const ctx = {
    home,
    getenv: {},
    readFile: (p, enc) => (String(p).endsWith('capability.json')
      ? JSON.stringify({ version: '9.9.9', settings: String(p).includes('antigravity') ? SYNTH_SETTINGS : [] })
      : readFileSync(p, enc)),
  };
  const path = settingsPath(ctx);
  if (unusable) mkdirSync(path, { recursive: true });
  else if (text !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const result = reconcileSettings(ctx);
  witnessedReconcile.add(result.outcome);
  fx('bridge-settings', id, abnormal, result.lines);
};
settingsFx('absent', false, {});
settingsFx('unusable', true, { unusable: true });
settingsFx('flagged-unknown', true, { text: 'MYSTERY=1\n' });
settingsFx('flagged-retired', true, { text: 'AW_OLD_KNOB=1\n' });
settingsFx('duplicates', true, { text: 'AW_GUARD_KNOB=1\nAW_GUARD_KNOB=0\n' });
settingsFx('ok', false, { text: 'AW_GUARD_KNOB=1\n' });

// ── the lens-region outcome lines (the whole exported table) ─────────────────────
// The engine STOP fixtures are the REAL thrown errors: the missing-file branch via a real engine
// dir with an absent required rel, and the unreadable branch via an injected read failure — never
// a hand-cleaned message.
const caughtEngineErr = (deps) => {
  try { readEngineFragment(ENGINE_DIR, deps); } catch (err) { return err; }
  throw new Error('expected readEngineFragment to throw');
};
const LENS_ARGS = {
  targetAbsent: ['docs/ai/agent_rules.md'],
  commsNoRegion: ['docs/ai/agent_rules.md'],
  lensNoRegion: ['docs/ai/agent_rules.md'],
  commsCapRefused: ['docs/ai/agent_rules.md', 152, 150],
  lensCapRefused: ['docs/ai/agent_rules.md', 152, 150],
  templateCanonStop: [],
  errorDetail: ['EACCES: permission denied, open /x'],
  engineStop: [caughtEngineErr({ rel: 'references/no-such-engine-file.md' })],
  commsCurrent: [], commsCustom: [], capSkipNote: [], commsRefreshed: [],
  engineTooOld: [], lensCurrent: [], lensCustom: [], lensRefreshed: [],
};
const LENS_ABNORMAL = new Set(['commsNoRegion', 'commsCapRefused', 'templateCanonStop', 'errorDetail', 'lensNoRegion', 'engineTooOld', 'engineStop', 'lensCapRefused']);
for (const [key, args] of Object.entries(LENS_ARGS)) {
  const out = OUTCOME_LINES[key](...args);
  fx('lens-region', key, LENS_ABNORMAL.has(key), Array.isArray(out) ? out : [out]);
}
fx('lens-region', 'engineStop-unreadable', true, OUTCOME_LINES.engineStop(
  caughtEngineErr({ readFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } }),
));

// ── the three L2 invariants over every collected fixture ─────────────────────────
describe('L2 (a) — alarm words render only under a detected abnormal condition', () => {
  for (const f of SURFACES.filter((s) => !s.abnormal)) {
    it(`${f.surface}/${f.id}`, () => {
      for (const line of f.lines) {
        for (const word of ALARM_WORDS) {
          assert.doesNotMatch(line, new RegExp(`\\b${word}\\b`, 'i'), `${f.surface}/${f.id}: ${line}`);
        }
      }
    });
  }
});

describe('L2 (b) — machine tokens never ride inside a human sentence', () => {
  for (const f of SURFACES) {
    it(`${f.surface}/${f.id}`, () => {
      for (const line of f.lines) {
        const text = scannable(line);
        for (const token of MACHINE_TOKENS) {
          assert.doesNotMatch(text, new RegExp(`\\b${token}\\b`), `${f.surface}/${f.id}: ${line}`);
        }
      }
    });
  }
});

describe('L2 (c) — internal names only as a machine-line prefix/self-label or a runnable command', () => {
  for (const f of SURFACES) {
    it(`${f.surface}/${f.id}`, () => {
      for (const line of f.lines) {
        const text = scannable(line);
        for (const name of INTERNAL_NAMES) {
          assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`, 'i'), `${f.surface}/${f.id}: ${line}`);
        }
      }
    });
  }
});

// ── the designed exception, characterized (never swept) ──────────────────────────
describe('the ensure token slot — the AD-092 D6 closed-vocabulary exception', () => {
  it('every failure cause composes as `cause — detail` through the one door', () => {
    for (const cause of FAILURE_CAUSES) {
      const outcome = composeFailure('gates', cause, 'a detail sentence');
      assert.equal(outcome.token, 'failed');
      assert.ok(outcome.lines[0].startsWith(`${cause} — `), cause);
    }
  });

  it('the real ensure CLI renders `  op: token` slots from the closed vocabulary — success AND failure exits', () => {
    assert.equal(CLI_RUNS.success.result.code, 0, CLI_RUNS.success.result.stderr);
    assert.equal(CLI_RUNS.failure.result.code, 1, 'a wrong-node-kind gates declaration fails the run');
    for (const key of ['success', 'failure']) {
      assert.equal(CLI_RUNS[key].slots.length, 5, key);
      for (const slot of CLI_RUNS[key].slots) assert.ok(ENSURE_TOKENS.includes(slot[2]), `${key}: ${slot[0]}`);
    }
    assert.match(CLI_RUNS.failure.result.stdout, /did NOT complete/, 'the failure footer rides the failure exit');
  });
});

// ── completeness: every closed vocabulary/branch set is witnessed ────────────────
describe('completeness — enumerated from the closed sets, not sampled', () => {
  it('every ensure outcome token has a fixture', () => {
    assert.deepEqual([...witnessedTokens].sort(), [...ENSURE_TOKENS].sort());
  });
  it('every ensure failure cause was produced by a real op', () => {
    assert.deepEqual([...witnessedCauses].sort(), [...FAILURE_CAUSES].sort());
  });
  it('every refresh outcome line composer has a fixture', () => {
    assert.deepEqual([...witnessedRefresh].sort(), Object.keys(REFRESH_LINES).sort());
  });
  it('every parity verdict state has a fixture', () => {
    assert.deepEqual([...witnessedParity].sort(), Object.values(PARITY).sort());
  });
  it('every bridge-settings reconcile branch has a fixture', () => {
    assert.deepEqual([...witnessedReconcile].sort(), ['absent', 'duplicates', 'flagged', 'ok', 'unusable']);
  });
  it('every lens-region outcome composer has a fixture', () => {
    assert.deepEqual(Object.keys(OUTCOME_LINES).sort(), Object.keys(LENS_ARGS).sort());
  });
});

// ── the doc half: deploy-tail.md carries the rule this file checks ───────────────
describe('the rule doc is bound to its checker (references/shared/deploy-tail.md)', () => {
  const doc = readFileSync(join(KIT, 'references', 'shared', 'deploy-tail.md'), 'utf8');

  it('carries the L2 rule tokens', () => {
    for (const token of [
      'user-grade', 'machine-line channel', '[run-gates] status=', 'references/modes/gates.md',
      'detected abnormal condition', 'LEADING outcome token', 'verbatim',
    ]) {
      assert.ok(doc.includes(token), `deploy-tail.md carries "${token}"`);
    }
  });

  it('names every alarm word this guard scans', () => {
    for (const word of ALARM_WORDS) {
      assert.ok(doc.includes(`\`${word}\``), `deploy-tail.md names \`${word}\``);
    }
  });
});
