// composed-lines-ux.test.mjs — the L2 class guard over the kit's tool-COMPOSED user-facing lines.
// The verbatim-paste contract makes these lines the exact bytes a third-party user reads, so they
// must be user-grade: (a) alarm words only under a DETECTED abnormal condition; (b) machine tokens
// never inside a human sentence; (c) internal names only as a machine-line prefix/self-label or a
// runnable command/path. ONE designed exception (AD-092 D6): the ensures' LEADING outcome token —
// characterized, never swept. Completeness is enumerated FROM each closed vocabulary/branch set,
// and the rule's doc half (references/shared/deploy-tail.md) is bound below. Dev-only repo test.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { ENSURE_OPS, ENSURE_TOKENS, FAILURE_CAUSES } from '../tools/ensure-vocabulary.mjs';
import { composeFailure, ensureAutonomy, ensureGates, ensureIndex, ensureOrchestration, failedOutcome } from '../tools/ensure-ops.mjs';
import { main as ensureConfigsMain } from '../tools/ensure-configs.mjs';
import { ensureExecutor } from '../tools/ensure-executor.mjs';
import { EXECUTOR_VEHICLE_REL, executorTemplate, readExecutorPosture } from '../tools/cheap-agents-read.mjs';
import { VEHICLES_REL } from '../tools/vehicle-settings.mjs';
const [{ applyGitHooks, UPGRADE_ROUTE }, { hermeticGitEnv }] = await Promise.all(['../tools/git-hooks.mjs', '../tools/git-env.mjs'].map((path) => import(path)));
// Loaded against the pre-fix tree too (red-first): absent, the specs and scripts fixtures below are
// skipped and the completeness suite reds on the unwitnessed tokens.
const { ensureSpecs } = await import('../tools/ensure-specs.mjs').catch(() => ({}));
const { ensureScripts } = await import('../tools/distribution-files/index.mjs').catch(() => ({}));
// The KIT mirror's family manifest lays the S5 and S11 fixtures out in the kit folder.
import { readFamily } from '../references/scripts/family.mjs';
import { DEPLOYED_SCRIPTS } from '../tools/node-evidence.mjs';
import { SCRIPT_PRIORS } from '../tools/script-priors.mjs';
import { CONFIG_REL, KNOWN_PRIOR_README } from '../tools/orchestration-config.mjs';
import { PARITY, parityVerdict, unverifiableParity } from '../tools/refresh-parity.mjs';
import { REFRESH_LINES, SKIPPED_READONLY, driftSummary } from '../tools/setup-backends.mjs';
import { reconcileSettings } from '../tools/bridge-settings.mjs';
import { settingsPath } from '../tools/bridge-settings-read.mjs';
const { OUTCOME_LINES: TIER_LINES } = await import('../tools/tier-preview.mjs').catch(() => ({}));
const { OUTCOME_LINES: CHECKER_LINES } = await import('../tools/checker-gates.mjs').catch(() => ({}));
const { OUTCOME_LINES: CLOSE_LINES } = await import('../tools/session-close-check.mjs').catch(() => ({}));
import { planRecipe } from '../tools/recipes.mjs';
import { formatReport } from '../tools/hide-footprint.mjs';
import { NOTE_ROUTE } from '../tools/orchestration-readme.mjs';
// The scanner leaf (its own negative controls live in composed-lines-scan.test.mjs); it sits under
// scripts/testing/ — not test/ — so the coverage run sees its lines.
import { ALARM_WORDS, INTERNAL_NAMES, scannable } from '../../scripts/testing/composed-lines-scan.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
// The modules the project's hook loads (the docs-size, spec-schema and shared modules' deployed entries) at their
// bundled bodies in the kit folder, the one at manifest path `customPath` holding an edit of its own instead.
const [KEPT_CHECKER, KEPT_READER] = ['docs-size/check-docs-size.mjs', 'spec-schema/spec-schema.mjs'];
const projectWithScripts = (customPath, customBody) => {
  const dir = project();
  for (const { path, deployed, bundled: from } of DEPLOYED_SCRIPTS.filter(({ module }) => ['docs-size', 'spec-schema', 'shared'].includes(module))) {
    const body = readFileSync(join(KIT, from), 'utf8');
    mkdirSync(dirname(join(dir, deployed)), { recursive: true });
    writeFileSync(join(dir, deployed), path === customPath ? customBody ?? `${body}// mine\n` : body);
  }
  writeFileSync(join(dir, 'docs', 'ai', 'a.md'), '---\ntype: reference\nmaxLines: 20\n---\n\n# Fixture\n');
  return dir;
};
const projectWithRejectingChecker = () => {
  const dir = projectWithScripts(KEPT_CHECKER, '// rejects every navigator\nprocess.exit(1);\n');
  writeFileSync(join(dir, 'docs', 'ai', 'index.md'), 'found bytes\n');
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
const HF_REMOVED_OUTSIDE = ['docs/ai/', '# standalone local-dev agent skills (hide-footprint)'];
const getRemovedOutsideReport = (dry) => formatReport(hfResult({ action: 'updated', wrote: ['/docs/ai/'], added: [], removed: [], removedOutside: HF_REMOVED_OUTSIDE }), dry).split('\n');
fx('hide-footprint', 'removed-outside-apply', false, getRemovedOutsideReport(false));
fx('hide-footprint', 'removed-outside-dry-run', false, getRemovedOutsideReport(true));
describe('hide-footprint — removed outside report lines (spec:hide-footprint/S5)', () => {
  it('prints every removed line in order in both tenses', () => { for (const dry of [false, true]) assert.deepEqual(getRemovedOutsideReport(dry).map((line) => line.trimStart()).filter((line) => line.startsWith('[hide-footprint] ')), HF_REMOVED_OUTSIDE.map((line) => '[hide-footprint] ' + (dry ? 'would-remove=' : 'removed=') + line)); });
});

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
  writeFileSync(join(dir, CONFIG_REL), `${JSON.stringify({ _README: 'another note' }, null, 2)}\n`);
  ensureFx('orchestration-would-write-differing', ensureOrchestration({ cwd: dir, dryRun: true, deps: {} }));
  ensureFx('orchestration-differing-written', ensureOrchestration({ cwd: dir, deps: {} }));
  writeFileSync(join(dir, CONFIG_REL), '{}\n');
  ensureFx('orchestration-would-write-absent', ensureOrchestration({ cwd: dir, dryRun: true, deps: {} }));
  ensureFx('orchestration-absent-written', ensureOrchestration({ cwd: dir, deps: {} }));
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
// The scripts op: every line form of its rule through the real op on a plain or dry run, each fixture with the exact lines it witnesses (a failure's first line after its cause; a line may run on past a witness at a space); the store lines through real rotator runs in git-initialised trees, every spawn GIT_-stripped.
const runScripts = (dir, extra = {}) => ensureScripts({ cwd: dir, kitRoot: KIT, ...extra, deps: { git: () => ({ status: 128 }), ...extra.deps } });
const appearing = (body) => ({ link: (_tmp, dst) => { writeFileSync(dst, body); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } });
const [MINE, SHIPPED, EDITED] = ['// mine\n', ': matches a body an earlier release shipped — ', ': differs from every body this kit knows it shipped — '];
const [HOOK_CHANNEL, OWN_CHANNEL, WROTE, WOULD_WRITE] = ['the local hook file scripts/pre-commit.local, which the commit hook runs first', 'a script or suite of your own under its own name in scripts/, or a config the script reads', 'the commit hook runs the files written above, so they may stop the next commit', 'the commit hook runs the files named above, so writing them may stop the next commit'];
const [DEC, MONO] = ['---\ntype: decisions\nmaxLines: 200\n---\n\n# Decisions\n\n## AD-002 — second\n\nbody two\n', '---\ntype: archive\n---\n\n# Decisions archive\n\n## AD-001 — first\n\nbody one\n'], stripped = (dir) => ({ deps: { spawnSync: (cmd, args, options) => spawnSync(cmd, args, { ...options, env: hermeticGitEnv(process.env, dir) }) } });
// The Node-evidence refusal names the probes, whatever the layout: the one line form both ops share.
const NODE_EVIDENCE_FX = [['scripts-skipped-no-node-evidence', () => runScripts(project({ node: false })), 'scripts/: no Node evidence in this tree — probed package.json and the kit-seeded scripts/ files'],
  ['scripts-node-evidence-unverifiable', () => runScripts(project({ node: false }), { deps: { lstat: () => { throw eacces(); } } }), 'scripts/: whether Node runs here could not be read (EACCES on package.json), so nothing was written — resolve it by hand, then re-run']];
// The two git-hook re-read lines through the real leaf (an installer that exits 0 and writes no hook), each one line ending with the upgrade route.
for (const [variant, roles] of [['commit-guard'], ['hook-checks', ['rules', 'layout']]]) {
  const root = project(), env = hermeticGitEnv(process.env, root), errors = [];
  spawnSync('git', ['init', '-q', root], { env });
  applyGitHooks({ root, variant, copies: [], roles, runs: { argv: ['node', join(root, 'scripts', 'install-git-hooks.mjs')] } }, { env, spawn: () => ({ status: 0 }), error: (line) => errors.push(line) });
  fx('git-hooks', `${variant}-unarmed`, true, () => (assert.deepEqual(errors.map((line) => line.endsWith(` — ${UPGRADE_ROUTE}`)), [true], errors.join('\n')), errors));
}
const fxUnwitnessed = (table) => table.flatMap(([id, , ...lines]) => lines.filter((w) => !SURFACES.find((s) => s.id === id)?.lines.some((line) => w instanceof RegExp ? w.test(line) : line === w || line.startsWith(`${w} `))).map((w) => `${id}: ${w}`));
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
{
  const dir = projectWithScripts(KEPT_READER);
  const checkerOf = DEPLOYED_SCRIPTS.find(({ path }) => path === KEPT_CHECKER);
  const keptIndexFx = (id, cwd = projectWithRejectingChecker(), extra = {}) => ensureFx(`index-kept-${id}`, ensureIndex({ cwd, kitRoot: KIT, deps: {}, ...extra }));
  keptIndexFx('regenerated', dir);
  keptIndexFx('already-current', dir);
  keptIndexFx('customized-preserved');
  keptIndexFx('put-back', projectWithRejectingChecker(), { deps: {
    spawnSync: (cmd, args, options) => args[0] === join(KIT, checkerOf.bundled)
      ? { status: 3, stdout: '', stderr: 'the generator said nothing\n' } : spawnSync(cmd, args, options),
  } });
  keptIndexFx('write-refused', projectWithRejectingChecker(), { deps: { rename: () => { throw eacces('EACCES: permission denied, rename'); } } });
  const probeDir = projectWithRejectingChecker();
  keptIndexFx('probe-failed', probeDir, { deps: {
    spawnSync: (cmd, args, options) => args[0] === join(probeDir, checkerOf.deployed)
      ? { error: enoent(), status: null, stdout: '', stderr: '' } : spawnSync(cmd, args, options),
  } });
  keptIndexFx('dry-note', projectWithRejectingChecker(), { dryRun: true });
}

// The specs op: every line form of the part scripts' rule through the real op on a plain or dry run, each fixture with the exact lines it witnesses (a failure's first line after its cause; a line may run on past a witness at a space).
const [IF_WROTE, IF_WOULD, SPEC_STORE] = ['if a commit hook runs the files written above, they may stop the next commit', 'if a commit hook runs the files named above, writing them may stop the next commit', 'docs/ai/specs/index.md'];
const runSpecs = (dir, extra = {}) => ensureSpecs({ cwd: dir, kitRoot: KIT, deps: {}, ...extra });
const refusingAt = (at, writes = 0) => ({ writeFile: (path, body, options) => { if (++writes === at) throw eacces('EACCES: refused'); writeFileSync(path, body, options); } });
const badTemplateKit = tmp('clux-kit-');
mkdirSync(join(badTemplateKit, 'references', 'templates', 'specs'), { recursive: true });
symlinkSync(join(KIT, 'references', 'scripts'), join(badTemplateKit, 'references', 'scripts'));
writeFileSync(join(badTemplateKit, 'references', 'templates', 'specs', 'index.md'), 'owner: {{OWNER}}\n');
// The two specs line forms no layout changes: the Node-evidence refusal and the store template's.
const SPECS_LAYOUT_FREE_FX = [['specs-skipped-no-node-evidence', () => runSpecs(project({ node: false })), 'scripts/: no Node evidence in this tree — probed package.json and the kit-seeded scripts/ files'],
  ['specs-template-unreadable', () => runSpecs(project(), { kitRoot: badTemplateKit }), `${SPEC_STORE}: the bundled template carries a placeholder this kit cannot render — reinstall the kit`]];
// Every line form from trees laid out in the kit folder by the KIT mirror's manifest (revision 17): every
// scripts line opens with a deployed path under scripts/agent-workflow/, a prior is catalogued through deps.priors.
const KIT_FX = (() => {
  const KF = 'scripts/agent-workflow', at = (p) => `${KF}/${p}`, kb = (p) => readFileSync(join(KIT, 'references', 'scripts', ...p.split('/')));
  const deployed = readFamily(join(KIT, 'references', 'scripts')).filter((e) => e.role === 'deployed'), all = deployed.map((e) => e.path);
  const importsOf = (p, within) => [...kb(p).toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map(([, s]) => posix.join(posix.dirname(p), s)).filter((d) => within.includes(d));
  const order = (paths) => { const left = new Set(paths), out = []; while (left.size) { const next = [...left].sort().find((p) => importsOf(p, paths).every((d) => !left.has(d))); out.push(next); left.delete(next); } return out; };
  const own = deployed.filter((e) => e.path !== 'run.mjs' && e.module !== 'spec-schema' && e.module !== 'docs-size').map((e) => e.path);
  const [R, C] = ['spec-schema', 'docs-size'].map((m) => order(deployed.filter((e) => e.module === m).map((e) => e.path)));
  const reached = new Set([...R, ...C]);
  for (const p of reached) for (const d of importsOf(p, all)) reached.add(d);
  const CL = order([...reached].filter((p) => !R.includes(p) && !C.includes(p)));
  const [INST, ROT, CAPS, ISSUES, MD, PR] = ['git-hooks/install-git-hooks.mjs', 'archives/archive-decisions.mjs', 'archives/archive-caps.mjs', 'archives/archive-issues.mjs', 'shared/markdown-blocks.mjs', 'shared/project-root.mjs'];
  const OLD = (p) => `// an earlier ${p}\n`, priors = { priors: [...SCRIPT_PRIORS, ...[INST, MD, PR, R[0], C[0], CL[1]].map((file) => ({ file, digest: createHash('sha256').update(OLD(file)).digest('hex') }))] };
  const lay = (dir, paths, over) => { for (const p of new Set([...paths, ...Object.keys(over)])) if (over[p] !== null) { mkdirSync(join(dir, KF, posix.dirname(p)), { recursive: true }); writeFileSync(join(dir, KF, p), over[p] ?? kb(p)); } return dir; };
  const kitTree = (over = {}) => lay(project(), own, over);
  const specsKit = (over = {}, store = true, dir = lay(project(), [...CL, ...R, ...C, 'run.mjs'], over)) => { if (store) { mkdirSync(join(dir, 'docs', 'ai', 'specs')); writeFileSync(join(dir, SPEC_STORE), '---\nkind: index\n---\n'); } return dir; };
  const kitWithout = (p, kit = tmp('clux-kit-')) => { for (const sub of ['scripts', 'templates']) cpSync(join(KIT, 'references', sub), join(kit, 'references', sub), { recursive: true }); rmSync(join(kit, 'references', 'scripts', ...p.split('/'))); return kit; };
  const adrKit = (docs, over = {}) => { const dir = kitTree(over); assert.equal(spawnSync('git', ['init', '-q', dir], { env: hermeticGitEnv(process.env, dir) }).status, 0, 'git init, so the snapshot stays in the tree'); mkdirSync(join(dir, 'docs', 'ai', 'history')); for (const [rel, body] of Object.entries(docs)) writeFileSync(join(dir, 'docs', 'ai', rel), body); return dir; };
  const flatBody = (name) => { const root = join(KIT, 'test/fixtures/script-priors'), versions = readdirSync(root).filter((v) => readdirSync(join(root, v)).includes(`${name}.txt`)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); return readFileSync(join(root, versions.at(-1), `${name}.txt`)); };
  const moveRun = (flat = {}, command = true, inGit = false, deps = {}) => {
    const dir = lay(project(), [R[0], ...(command ? ['run.mjs'] : [])], {});
    for (const [name, body] of Object.entries({ 'spec-schema.mjs': kb(R[0]), ...flat })) writeFileSync(join(dir, 'scripts', name), body);
    const git = (cmd, args, options = {}) => { const result = spawnSync(cmd, args, { ...options, env: hermeticGitEnv(process.env, dir) }); if (args[0] === 'check-ignore') assert.equal(result.status, 1, 'the temp deployment is visible'); return result; };
    if (inGit) assert.equal(git('git', ['init', '-q', dir]).status, 0, 'git init for the move lines');
    return runScripts(dir, { deps: { ...stripped(dir).deps, ...(inGit ? { git } : {}), ...deps } });
  };
  const [refreshed, edited, rejected] = [kitTree({ [INST]: OLD(INST) }), kitTree({ [INST]: MINE, [CAPS]: MINE, [ISSUES]: null }), kitTree(Object.fromEntries(own.map((p) => [p, p === ROT ? MINE : null])))];
  const [NOTE, PARTWAY, specsDue] = ['^ADR store: \\[archive-decisions\\] docs/ai/index\\.md NOT regenerated — (?!.*(?:docs-size/|check-docs-size))', 'the writes stopped PARTWAY — the 1 file(s) named above were already written and are NOT rolled back', { [R[0]]: OLD(R[0]), [R[1]]: null, [C[0]]: MINE }];
  const CMD = 'node scripts/agent-workflow/run\\.mjs docs-size --write-index(?![\\w-])'; // the index note: no module path, the stable command
  const scripts = [['scripts-not-accepted-bare', (d = project()) => runScripts(d, stripped(d)), ...order(own.filter((p) => deployed.find((e) => e.path === p).seed)).map((p) => `${at(p)}: absent — placed from the bundled scripts`), `${KF}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`, IF_WROTE],
    ['scripts-would-refresh', () => runScripts(refreshed, { dryRun: true, deps: priors }), `${at(INST)}${SHIPPED}would be refreshed to the bundled one`, WOULD_WRITE, `ADR store: ${at(ROT)} --ensure-current would run after the writes, bringing the store current or writing nothing when it already is`],
    ['scripts-brought-current', (d = adrKit({ 'decisions.md': DEC, 'history/decisions-archive.md': MONO })) => runScripts(d, stripped(d)), 'ADR store: snapshot:', 'ADR store: brought-current: migrated, navigator written', new RegExp(`${NOTE}the index generator is not beside this script — .*\\bupgrade\\b.*${CMD}`)],
    ['scripts-refreshed', () => runScripts(refreshed, { deps: priors }), `${at(INST)}${SHIPPED}refreshed to the bundled one`, WROTE],
    ['scripts-already-present', () => runScripts(refreshed), `${KF}/: ${own.length} other kit scripts are already the bundled body — nothing written`],
    ['scripts-would-seed', () => runScripts(edited, { dryRun: true }), `${at(INST)}${EDITED}would be replaced by the bundled body; an edit meant to last goes in ${HOOK_CHANNEL}`, `${at(ISSUES)}: absent — would be placed from the bundled scripts`, WOULD_WRITE],
    ['scripts-seeded', () => runScripts(edited), `${at(INST)}${EDITED}replaced by the bundled body; an edit meant to last goes in ${HOOK_CHANNEL}`, `${at(CAPS)}${EDITED}replaced by the bundled body; an edit meant to last goes in ${OWN_CHANNEL}`, `${at(ISSUES)}: absent — placed from the bundled scripts`, WROTE],
    ['scripts-appeared', () => runScripts(kitTree({ [ISSUES]: null }), { deps: appearing(kb(ISSUES)) }), `${at(ISSUES)}: appeared while this run was placing it — the bundled body stands, nothing written`],
    ['scripts-appeared-race', () => runScripts(kitTree({ [ISSUES]: null }), { deps: appearing('// other\n') }), `${at(ISSUES)}: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled`, `${at(ISSUES)}: absent — not placed; its write was refused (above)`],
    ['scripts-write-refused', (renames = 0) => runScripts(kitTree({ [INST]: OLD(INST), [MD]: OLD(MD), [PR]: OLD(PR), [CAPS]: MINE, [ISSUES]: null }), { deps: { ...priors, rename: (from, to) => { if (++renames === 2) throw eacces('EACCES: refused'); renameSync(from, to); } } }), `${at(MD)}: EACCES: refused`, `${at(MD)}${SHIPPED}not refreshed; its write was refused (above)`,
      `${at(PR)}${SHIPPED}not refreshed; the run stopped before it`, `${at(CAPS)}${EDITED}not replaced; the run stopped before it; an edit meant to last goes in ${OWN_CHANNEL}`, `${at(ISSUES)}: absent — not placed; the run stopped before it`, WROTE, PARTWAY],
    ['scripts-index-regeneration-failed', (d = adrKit({ 'decisions.md': DEC }, { 'docs-size/check-docs-size.mjs': 'process.exit(1);\n' })) => runScripts(d, stripped(d)), 'ADR store: brought-current: navigator written', new RegExp(`${NOTE}index regeneration failed \\(exit 1\\) — (?!.*upgrade).*${CMD}`)],
    ['scripts-adr-store-not-current', (d = adrKit({ 'history/decisions-archive.md': MONO })) => runScripts(d, stripped(d)), `${at(ROT)} --ensure-current exited with code 1 — the ADR store was not confirmed current`, 'ADR store: [archive-decisions] docs/ai/decisions.md not found but a legacy monolith is present — a broken tree; restore docs/ai/decisions.md before migrating.'],
    ['scripts-not-accepted-dry', () => runScripts(rejected, { dryRun: true }), `${at(ROT)}${EDITED}would be replaced by the bundled body; an edit meant to last goes in ${OWN_CHANNEL}`, `${at(MD)}: absent — would be placed from the bundled scripts`, IF_WOULD],
    ['scripts-not-accepted', () => runScripts(rejected), `${KF}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`, IF_WROTE],
    ['scripts-wrong-node-kind', (d = project()) => (mkdirSync(join(d, 'scripts')), writeFileSync(join(d, KF), ''), runScripts(d)), `${KF}/: exists but is a regular file — nothing was read or written; resolve it by hand, then re-run`],
    ['scripts-wrong-node-kind-family', (d = project()) => (mkdirSync(join(d, KF, ROT), { recursive: true }), runScripts(d)), `${at(ROT)}: exists but is a directory — nothing was read or written; resolve it by hand, then re-run`],
    ['scripts-bundle-unreadable', () => runScripts(kitTree(), { kitRoot: kitWithout(ROT) }), `${at(ROT)}: the bundled script could not be read, so nothing was written — reinstall the kit.`],
    ['scripts-flat-removed', () => moveRun({ 'archive-caps.mjs': flatBody('archive-caps.mjs') }), "scripts/spec-schema.mjs: removed — the kit's scripts live in scripts/agent-workflow/"],
    ['scripts-flat-kept', () => moveRun({}, false), 'scripts/spec-schema.mjs: kept — scripts/agent-workflow/run.mjs is not placed yet'],
    ['scripts-flat-not-removed', () => moveRun({}, true, false, { unlink: (path) => { if (path === join(dirname(path), 'spec-schema.mjs')) throw eacces(); unlinkSync(path); } }), 'scripts/spec-schema.mjs: not removed (EACCES) — left for the next run'],
    ['scripts-flat-not-the-kits', () => moveRun({ 'spec-schema.mjs': MINE }), "scripts/spec-schema.mjs: differs from every body this kit knows it shipped — not the kit's, left as it stands; the kit's checks now run from scripts/agent-workflow/"],
    ['scripts-flat-suite', () => moveRun({ 'own.test.mjs': MINE }), "scripts/own.test.mjs: a suite of your own — the kit's hook runs no suite; add node --test scripts/own.test.mjs to scripts/pre-commit.local to keep it on every commit"],
    ['scripts-flat-grep', () => moveRun({}, true, true), 'other files naming an old path: git grep -n -F --untracked -e'],
    ['scripts-flat-boundary', () => moveRun({}, true, true), 'git grep lists tracked and untracked files git does not ignore; the hooks dir and ignored files are yours to check'],
    ['scripts-flat-no-work-tree', () => moveRun(), /git work tree/],
    ['scripts-flat-commit-together', () => moveRun({}, true, true), /(?=.*scripts\/agent-workflow\/)(?=.*\bone change\b)/],
    ...NODE_EVIDENCE_FX];
  const specs = [['specs-would-seed', () => runSpecs(specsKit(specsDue, false), { dryRun: true, deps: priors }), `${at(R[0])}${SHIPPED}would be refreshed to the bundled one`, `${at(R[1])}: absent — would be placed from the bundled scripts`,
    `${at(C[0])}${EDITED}would be replaced by the bundled body; an edit meant to last goes in ${OWN_CHANNEL}`, `${SPEC_STORE}: absent — would be created from the bundled template`, IF_WOULD],
    ['specs-seeded', () => runSpecs(specsKit(specsDue, false), { deps: priors }), `${at(R[0])}${SHIPPED}refreshed to the bundled one`, `${at(R[1])}: absent — placed from the bundled scripts`,
      `${at(C[0])}${EDITED}replaced by the bundled body; an edit meant to last goes in ${OWN_CHANNEL}`, `${SPEC_STORE}: created from the bundled template (today's date rendered)`, IF_WROTE],
    ['specs-already-present', () => runSpecs(specsKit()), `${at(R[0])}: already the bundled body — nothing written`, `${SPEC_STORE}: already present — preserved byte-for-byte, nothing written`],
    ['specs-would-refresh', () => runSpecs(specsKit({ [C[0]]: OLD(C[0]) }), { dryRun: true, deps: priors }), `${at(C[0])}${SHIPPED}would be refreshed to the bundled one`, IF_WOULD],
    ['specs-refreshed', () => runSpecs(specsKit({ [C[0]]: OLD(C[0]) }), { deps: priors }), `${at(C[0])}${SHIPPED}refreshed to the bundled one`, IF_WROTE],
    ['specs-appeared', () => runSpecs(specsKit({ [R[0]]: null }), { deps: appearing(kb(R[0])) }), `${at(R[0])}: appeared while this run was placing it — the bundled body stands, nothing written`],
    ['specs-store-stood', () => runSpecs(specsKit({}, false), { deps: appearing('---\nkind: index\n---\n') }), `${SPEC_STORE}: appeared while this run was seeding it — the existing file stands`],
    ['specs-write-refused', () => runSpecs(specsKit({ [CL[0]]: null, [CL[1]]: OLD(CL[1]), [R[0]]: OLD(R[0]), [R[1]]: null, [C[0]]: MINE }, false), { deps: { ...refusingAt(2), ...priors } }), `${at(CL[1])}: EACCES: refused`, `${at(CL[0])}: absent — placed from the bundled scripts`, `${at(CL[1])}${SHIPPED}not refreshed; its write was refused (above)`,
      `${at(R[0])}${SHIPPED}not refreshed; the run stopped before it`, `${at(R[1])}: absent — not placed; the run stopped before it`, `${at(C[0])}${EDITED}not replaced; the run stopped before it; an edit meant to last goes in ${OWN_CHANNEL}`, `${SPEC_STORE}: absent — not created`, IF_WROTE, PARTWAY],
    ['specs-write-refused-first', () => runSpecs(specsKit({ [R[0]]: MINE, [R[1]]: null }), { deps: refusingAt(1) }), `${at(R[0])}: EACCES: refused`, `${at(R[0])}${EDITED}not replaced; its write was refused (above); an edit meant to last goes in ${OWN_CHANNEL}`, `${at(R[1])}: absent — not placed; the run stopped before it`],
    ['specs-wrong-node-kind', (d = project()) => (mkdirSync(join(d, KF, R[0]), { recursive: true }), runSpecs(d)), `${at(R[0])}: exists but is a directory — nothing was read or written; resolve it by hand, then re-run`],
    ['specs-bundle-unreadable', () => runSpecs(project(), { kitRoot: kitWithout(R[0]) }), `${at(R[0])}: the bundled script could not be read, so nothing was written — reinstall the kit.`],
    ...SPECS_LAYOUT_FREE_FX];
  return { scripts, specs };
})();
if (ensureScripts) for (const [id, build] of KIT_FX.scripts) ensureFx(id, build(), ['scripts-index-regeneration-failed', 'scripts-flat-not-removed'].includes(id) || undefined);
if (ensureSpecs) for (const [id, build] of KIT_FX.specs) ensureFx(id, build());

{
  // The executor ensure: every token and its one cause through the real op on a temp project (the writer places the file on consent, never this ensure, so the placed file is written by hand).
  const dir = project();
  ensureFx('executor-not-placed', ensureExecutor({ cwd: dir, kitRoot: KIT, deps: {} }));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, EXECUTOR_VEHICLE_REL), 'a hand-edited executor body');
  ensureFx('executor-pending', ensureExecutor({ cwd: dir, kitRoot: KIT, deps: {} }));
  writeFileSync(join(dir, EXECUTOR_VEHICLE_REL), executorTemplate(readExecutorPosture(dir).posture).content);
  ensureFx('executor-already-current', ensureExecutor({ cwd: dir, kitRoot: KIT, deps: {} }));
  writeFileSync(join(dir, VEHICLES_REL), '{ not json');
  ensureFx('executor-vehicle-settings-unreadable', ensureExecutor({ cwd: dir, kitRoot: KIT, deps: {} }));
}

// The real ensure CLI, BOTH exits: the `  op: token` slots are the characterized exception; every
// OTHER stdout line — the banner, the details, the failure footer — joins the scanned surface, a
// failure's closed cause opening stripped after characterization.
const cliFx = (id, dir, abnormal, args = []) => {
  const r = ensureConfigsMain(['--reconcile', ...args, '--cwd', dir], { kitRoot: KIT });
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

const unwitnessed = (witnesses) => Object.entries(witnesses).flatMap(([phrase, ids]) => ids.filter((id) => !SURFACES.find((surface) => surface.id === id)?.lines.some((line) => line.includes(phrase))).map((id) => `${id}: a line carries "${phrase}"`));
describe('spec:docs-navigator/S5 the kept-checker index lines are user-grade', () => { it('each S5 fixture carries the line it witnesses', () => assert.deepEqual(unwitnessed({ "the project's own checker": ['index-kept-regenerated', 'index-kept-already-current', 'index-kept-customized-preserved', 'index-kept-write-refused', 'index-kept-probe-failed', 'index-kept-dry-note'], 'the navigator was put back byte for byte': ['index-kept-put-back'] }), [], 'each S5 fixture carries its witness')); });
describe('spec:orchestration-note/S5 the note lines are user-grade', () => {
  const [OVER, ROUTE] = ['written over a different one (every recipe you set is kept); ', NOTE_ROUTE];
  it('each S5 fixture carries the line it witnesses', () => assert.deepEqual(unwitnessed({ [`the current onboarding note would be ${OVER}${ROUTE}`]: ['orchestration-would-write-differing'], [`the current onboarding note was ${OVER}${ROUTE}`]: ['orchestration-differing-written'], 'the onboarding note is absent and would be written': ['orchestration-would-write-absent'], 'the onboarding note was absent and is now written': ['orchestration-absent-written'], 'the onboarding note is the current canonical': ['orchestration-already-current'], 'created from the canonical seed': ['orchestration-seeded'], 'refreshed to the current canonical': ['orchestration-note-refreshed'], 'would be refreshed': ['orchestration-would-refresh-note'] }), [], 'each S5 fixture carries its witness'));
});
describe('spec:distribution-files/S11 every line form of the specs and scripts ops is user-grade', () => {
  const KIT_READ = "the KIT mirror's family manifest reads (references/scripts/family.mjs), so the fixtures lay out the kit folder";
  it('each S11 fixture carries the line it witnesses', () => {
    assert.ok(KIT_FX, KIT_READ);
    assert.deepEqual([...fxUnwitnessed(KIT_FX.scripts), ...fxUnwitnessed(KIT_FX.specs)], [], 'each S11 fixture carries its witness');
  });
  it('every scripts placement line that names a path opens with a deployed path under scripts/agent-workflow/', () => {
    assert.ok(KIT_FX, KIT_READ);
    const lines = KIT_FX.scripts.filter(([id]) => !id.includes('node-evidence') && !id.startsWith('scripts-flat-')).flatMap(([id]) => (SURFACES.find((s) => s.id === id)?.lines ?? []).map((line) => [id, line]));
    assert.ok(lines.length > 0, 'the scripts fixtures were collected');
    assert.deepEqual(lines.filter(([, line]) => line.startsWith('scripts/') && !line.startsWith('scripts/agent-workflow/')).map(([id, line]) => `${id}: ${line}`), []);
  });
  it("no line of the scripts or specs op waits for the user's yes", () => assert.deepEqual([...KIT_FX.scripts, ...KIT_FX.specs].flatMap(([id]) => (SURFACES.find((s) => s.id === id)?.lines ?? []).filter((line) => line.includes("the user's yes")).map((line) => `${id}: ${line}`)), []));
});

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

const composeLines = (table, key, args) => () => {
  const compose = table?.[key] ?? (() => { throw new Error(`missing outcome composer: ${key}`); });
  const out = compose(...args);
  return Array.isArray(out) ? out : [out];
};

// ── the tier offer's outcome lines (the whole exported table, spec kit/tier/tier-offer) ─────
const TIER_ARGS = {
  entry: ['undecidable', 'config-absent'],
  declinedAt: ['4.0.0'], slotPresent: ['epic', 'review'],
  applyLine: ['node /kit/tools/tier-preview.mjs --cwd /project'],
  noCommand: [], nothingOffered: [], help: [],
  slotValue: ['task', 'author', 'solo', [{ candidate: 'delegated', reason: planRecipe('delegated', []).degradation[0].reason }]],
  tmpLeft: ['docs/plans/queue.md', '/project/docs/plans/queue.md.a1b2c3.tmp'],
  detectFailed: ['spawn EACCES'],
  refusal: ['write-failed', 'EACCES: permission denied, open /project/docs/ai/orchestration.json'],
  usage: ['unknown argument --bogus'],
};
const TIER_ABNORMAL = new Set(['noCommand', 'tmpLeft', 'detectFailed', 'refusal', 'usage']);
for (const [key, args] of Object.entries(TIER_ARGS)) if (key !== 'entry') fx('tier-preview', key, TIER_ABNORMAL.has(key), composeLines(TIER_LINES, key, args));
// An entry line `<id>: <word>[ — <detail>]` is characterized like the ensure slot: id self-label, closed word, detail scanned.
const TIER_ENTRY_RE = /^([a-z]+(?:-[a-z]+)+): (present|offered|declined|undecidable|applied|recorded)(?: — (.+))?$/;
for (const id of ['epic-task-slots', 'epic-store-seeded', 'named-queue-row-seed']) fx('tier-preview', `entry-${id}`, false, () => {
  const [, label, , detail] = composeLines(TIER_LINES, 'entry', [id, ...TIER_ARGS.entry])()[0].match(TIER_ENTRY_RE) ?? [];
  assert.equal(label, id, 'an entry line opens with its registry id');
  return [detail];
});

// ── the checker-gates verb's outcome lines (the whole exported table, spec kit/tier/checker-gates) ─────
const CHECKER_ARGS = {
  candidate: ['control-bytes', 'offered'],
  entry: [JSON.stringify({ id: 'plan-shape', title: 'Plans in flight keep the structural planning shape', cmd: 'node "/kit/tools/plan-shape-cli.mjs" --check --in-flight' })],
  disclosure: [], help: [], usage: ['unknown argument --bogus'], onlyNotOffered: [['nope'], ['plan-shape']],
  refusal: ['write-failed', 'EIO: i/o error, rename /project/docs/ai/gates.json.a1b2c3.tmp'],
};
const CHECKER_ABNORMAL = new Set(['usage', 'onlyNotOffered', 'refusal']);
for (const [key, args] of Object.entries(CHECKER_ARGS)) if (key !== 'candidate') fx('checker-gates', key, CHECKER_ABNORMAL.has(key), composeLines(CHECKER_LINES, key, args));
// A candidate line `<id>: <word>[ — <detail>]` is characterized like the tier entry: id self-label, closed word, detail scanned.
const CHECKER_CANDIDATE_RE = /^(control-bytes): (offered|declared|applied|not-applicable|id-taken|probe-unreadable|withheld)(?: — (.+))?$/;
for (const [word, detail, abnormal] of [['offered'], ['declared'], ['applied'], ['not-applicable', '.git is not a directory or a regular gitfile'],
  ['id-taken', 'npm run bytes', true], ['probe-unreadable', '.git: EACCES', true], ['withheld', 'the kit path cannot be rendered into a command: /kit"tools', true]]) {
  fx('checker-gates', `candidate-${word}`, Boolean(abnormal), () => {
    const [, label, , rest] = composeLines(CHECKER_LINES, 'candidate', ['control-bytes', word, detail])()[0].match(CHECKER_CANDIDATE_RE) ?? [];
    assert.equal(label, 'control-bytes', 'a candidate line opens with its candidate id');
    return [rest ?? ''];
  });
}

// ── the session-close checker's outcome lines (the whole exported table, spec kit/tier/session-rules) ─────
const CLOSE_STATES = ['no-deployment', 'handover-symlink', 'handover-not-regular', 'handover-unreadable', 'handover-absent',
  'section-absent', 'section-twice', 'label-absent', 'label-twice', 'label-order', 'label-empty'];
const CLOSE_ARGS = {
  accept: [], help: [], usage: ['unknown argument --bogus'], state: ['label-order'], labelState: ['label-empty', '**What is next, and why:**'],
};
const CLOSE_ABNORMAL = new Set(['usage', 'state', 'labelState']);
for (const [key, args] of Object.entries(CLOSE_ARGS)) if (key !== 'state') fx('session-close-check', key, CLOSE_ABNORMAL.has(key), composeLines(CLOSE_LINES, key, args));
// Every state name the checker prints through its one-name composer, each as its own line.
fx('session-close-check', 'state', true, () => CLOSE_STATES.flatMap((name) => composeLines(CLOSE_LINES, 'state', [name])()));

// ── the three L2 invariants over every collected fixture ─────────────────────────
describe('L2 (a) — alarm words render only under a detected abnormal condition', () => {
  for (const f of SURFACES.filter((s) => !s.abnormal)) {
    it(`${f.surface}/${f.id}`, () => {
      for (const line of typeof f.lines === 'function' ? f.lines() : f.lines) {
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
      for (const line of typeof f.lines === 'function' ? f.lines() : f.lines) {
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
      for (const line of typeof f.lines === 'function' ? f.lines() : f.lines) {
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
      assert.equal(CLI_RUNS[key].slots.length, ENSURE_OPS.length, key);
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
  it('every tier-preview outcome composer has a fixture, none printing a placeholder or an unrendered argument', () => {
    assert.deepEqual(Object.keys(TIER_LINES ?? {}).sort(), Object.keys(TIER_ARGS).sort());
    for (const [key, args] of Object.entries(TIER_ARGS)) {
      for (const line of composeLines(TIER_LINES, key, args)()) assert.doesNotMatch(line, /<kit>|<project>|undefined|\[object |\$\{/, key);
    }
  });
  it('every checker-gates outcome composer has a fixture, none printing a placeholder or an unrendered argument', () => {
    assert.deepEqual(Object.keys(CHECKER_LINES ?? {}).sort(), Object.keys(CHECKER_ARGS).sort());
    for (const [key, args] of Object.entries(CHECKER_ARGS)) {
      for (const line of composeLines(CHECKER_LINES, key, args)()) assert.doesNotMatch(line, /<kit>|<project>|undefined|\[object |\$\{/, key);
    }
  });
  it('every session-close-check outcome composer has a fixture, none printing a placeholder or an unrendered argument', () => {
    assert.deepEqual(Object.keys(CLOSE_LINES ?? {}).sort(), Object.keys(CLOSE_ARGS).sort());
    for (const [key, args] of Object.entries(CLOSE_ARGS)) {
      for (const line of composeLines(CLOSE_LINES, key, args)()) assert.doesNotMatch(line, /<kit>|<project>|undefined|\[object |\$\{/, key);
    }
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
