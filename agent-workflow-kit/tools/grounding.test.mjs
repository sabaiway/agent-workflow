// grounding.test.mjs — the AD-038 facts assembler: slice exactness (byte-for-byte vs the source
// section), the plan heading policy (required-missing STOP, optional-absent OK, duplicate STOP),
// the writer-honesty --out guard (tracked / in-repo-not-ignored refusal), and the byte budget
// (AGY_MAX_PROMPT_BYTES − --reserve-bytes; loud tail-trim keeps the final wrapper prompt under
// the ceiling).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, sliceSection, trimToBudget, DEFAULT_MAX_PROMPT_BYTES } from './grounding.mjs';

const CONSTRAINTS_SECTION = [
  '## 🚫 Hard Constraints',
  '',
  '| Rule | Enforcement |',
  '|------|-------------|',
  '| No attribution | scan |',
  '| Ask before commit | process |',
  '',
].join('\n');

const AGENTS_MD = `# Project\n\nintro prose\n\n${CONSTRAINTS_SECTION}\n## Quick Commands\n\nnone\n`;

const PLAN_MD = [
  '# Plan: sample',
  '',
  '## Context',
  '',
  'why',
  '',
  '## Approach',
  '',
  'the shape. **What we are NOT doing:** X, Y.',
  '',
  '## Decisions (locked)',
  '',
  '- fixture is normative',
  '',
  '## Phase 1: work',
  '',
  'steps',
  '',
  '## Verification',
  '',
  '1. gates green',
  '',
].join('\n');

const makeDir = ({ agents = AGENTS_MD, plan = PLAN_MD } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'grounding-'));
  if (agents != null) writeFileSync(join(root, 'AGENTS.md'), agents);
  if (plan != null) writeFileSync(join(root, 'plan.md'), plan);
  return root;
};

const run = (root, argv, env = {}) => main(argv, { cwd: root, env });

describe('grounding --constraints — exactly-one-match slice, byte-for-byte', () => {
  it('stdout equals the AGENTS.md Hard-Constraints section verbatim', () => {
    const root = makeDir();
    const r = run(root, ['--constraints']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, CONSTRAINTS_SECTION, 'the slice is the section, byte-for-byte');
  });

  it('no Hard-Constraints heading → loud STOP (exit 1), nothing emitted', () => {
    const root = makeDir({ agents: '# Project\n\n## Quick Commands\n\nnone\n' });
    const r = run(root, ['--constraints']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /required section .* not found/);
    assert.equal(r.stdout, '');
  });

  it('two Hard-Constraints headings → STOP (never guess which)', () => {
    const root = makeDir({ agents: `${AGENTS_MD}\n## 🚫 Hard Constraints\n\nsecond copy\n` });
    const r = run(root, ['--constraints']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /appears 2 times/);
  });

  it('missing root AGENTS.md → loud STOP', () => {
    const root = makeDir({ agents: null });
    const r = run(root, ['--constraints']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /AGENTS\.md .* unreadable/);
  });
});

describe('grounding --plan — the canonical §7 heading policy', () => {
  it('extracts Approach + Decisions (locked) + Verification, whole and verbatim', () => {
    const root = makeDir();
    const r = run(root, ['--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^## Approach\n/m);
    assert.match(r.stdout, /What we are NOT doing:\*\* X, Y\./, 'the NOT-doing text rides inside Approach');
    assert.match(r.stdout, /^## Decisions \(locked\)\n/m);
    assert.match(r.stdout, /fixture is normative/);
    assert.match(r.stdout, /^## Verification\n/m);
    assert.match(r.stdout, /gates green/);
    assert.doesNotMatch(r.stdout, /## Phase 1/, 'phase bodies are not decision-bearing — not extracted');
    assert.doesNotMatch(r.stdout, /## Context/, 'context is not extracted');
  });

  it('optional Decisions (locked) absent → OK, the other two still extracted', () => {
    const root = makeDir({ plan: PLAN_MD.replace('## Decisions (locked)\n\n- fixture is normative\n\n', '') });
    const r = run(root, ['--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^## Approach\n/m);
    assert.match(r.stdout, /^## Verification\n/m);
    assert.doesNotMatch(r.stdout, /Decisions \(locked\)/);
  });

  it('--plan outside the work tree → loud STOP, nothing read into the payload (review-grounding-r04-major-01: the tier auto-allows this tool)', () => {
    const root = makeDir();
    const outside = makeDir({ plan: PLAN_MD });
    const r = run(root, ['--plan', join(outside, 'plan.md')]);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /resolves outside the git work tree/);
    assert.equal(r.stdout, '', 'no outside-tree content reaches stdout');
  });

  it('required section missing (no Verification) → STOP', () => {
    const root = makeDir({ plan: PLAN_MD.replace('## Verification', '## Checks') });
    const r = run(root, ['--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /required section "## Verification" not found/);
  });

  it('duplicate heading (two Approach) → STOP even though it is required-present', () => {
    const root = makeDir({ plan: `${PLAN_MD}\n## Approach\n\nsecond\n` });
    const r = run(root, ['--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"## Approach" appears 2 times/);
  });

  it('--constraints and --plan compose (constraints first, then the plan sections)', () => {
    const root = makeDir();
    const r = run(root, ['--constraints', '--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.indexOf('Hard Constraints') < r.stdout.indexOf('## Approach'));
  });
});

// ── (f) --autonomy — the computed effective-policy block (AD-044 Plan 3) ─────────────────────
describe('grounding --autonomy — effective policy from the git-top docs/ai/autonomy.json', () => {
  const POLICY = `${JSON.stringify({ 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'sandbox' } }, null, 2)}\n`;
  // The policy fixture dir is a REAL git repo (gitTop resolution is the contract under test) —
  // a marker fixture is not needed: the autonomy block never reads AGENTS.md.
  const makePolicyRepo = ({ policy = POLICY } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'grounding-autonomy-'));
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(root, 'AGENTS.md'), AGENTS_MD);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    if (policy != null) writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), policy);
    mkdirSync(join(root, 'sub', 'dir'), { recursive: true });
    return root;
  };

  const FILE_BACKED_BLOCK = [
    '## Autonomy policy — docs/ai/autonomy.json',
    '',
    'red-lines — commit:ask push:ask publish:ask network:deny credentials:deny fs_outside_repo:deny',
    'activities — plan-authoring:sandbox plan-execution:sandbox',
    '',
  ].join('\n');

  it('present policy → the byte-stable effective block, sourced from the policy file (exit 0)', () => {
    const root = makePolicyRepo();
    const r = run(root, ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, FILE_BACKED_BLOCK, 'the FULL effective policy, byte-stable, with the file-backed source line');
  });

  it('absent policy → the computed-defaults block with the stated absent-source line (exit 0 — defaults ARE the policy)', () => {
    const root = makeDir(); // no git repo, no policy file — gitTop falls back to cwd
    const r = run(root, ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^## Autonomy policy — docs\/ai\/autonomy\.json absent; the computed defaults ARE the effective policy\n/, 'the source line states the absence');
    assert.match(r.stdout, /red-lines — commit:ask push:ask publish:ask network:deny credentials:deny fs_outside_repo:deny/);
    assert.match(r.stdout, /activities — plan-authoring:prompt plan-execution:prompt/, 'absent activities floor at prompt');
  });

  it('the SPARSE defaults-equivalent seed renders the computed-defaults heading — never a declared policy (codex, Segment B)', () => {
    const root = makePolicyRepo({ policy: '{ "_README": "note" }' });
    const r = run(root, ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /present but defaults-equivalent \(the sparse seed\); the computed defaults ARE the effective policy/);
  });

  it('malformed policy JSON → fail-closed STOP (exit 1), nothing emitted', () => {
    const root = makePolicyRepo({ policy: '{ nope' });
    const r = run(root, ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /autonomy\.json: malformed JSON/);
    assert.equal(r.stdout, '');
  });

  it('schema-invalid policy (bad value) → fail-closed STOP (exit 1), never silent defaults', () => {
    const root = makePolicyRepo({ policy: '{ "redlines": { "commit": "maybe" } }\n' });
    const r = run(root, ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid value "maybe"/);
  });

  it('subdir cwd in a policy-carrying repo → the FILE-BACKED block (gitTop resolution), never silent defaults', () => {
    const root = makePolicyRepo();
    const r = run(join(root, 'sub', 'dir'), ['--autonomy']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, FILE_BACKED_BLOCK, 'a subdir cwd still reads the git-top policy (sandbox, not the prompt defaults)');
  });

  it('--autonomy alone satisfies "nothing to assemble"; compose order is constraints → autonomy → plan', () => {
    const root = makePolicyRepo();
    writeFileSync(join(root, 'plan.md'), PLAN_MD);
    const alone = run(root, ['--autonomy']);
    assert.equal(alone.code, 0, alone.stderr);
    const composed = run(root, ['--constraints', '--autonomy', '--plan', 'plan.md']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(composed.code, 0, composed.stderr);
    const atConstraints = composed.stdout.indexOf('Hard Constraints');
    const atAutonomy = composed.stdout.indexOf('## Autonomy policy');
    const atPlan = composed.stdout.indexOf('## Approach');
    assert.ok(atConstraints !== -1 && atAutonomy !== -1 && atPlan !== -1, 'all three sections present');
    assert.ok(atConstraints < atAutonomy && atAutonomy < atPlan, 'constraints → autonomy → plan');
  });
});

describe('grounding --out — scratch-only writer honesty', () => {
  const makeRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'grounding-repo-'));
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(root, 'AGENTS.md'), AGENTS_MD);
    writeFileSync(join(root, 'tracked.md'), 'tracked\n');
    writeFileSync(join(root, '.gitignore'), 'scratch/\n');
    mkdirSync(join(root, 'scratch'));
    g('add', '-A');
    g('commit', '-qm', 'base');
    return root;
  };

  it('refuses a TRACKED path', () => {
    const root = makeRepo();
    const r = run(root, ['--constraints', '--out', 'tracked.md']);
    const untouched = readFileSync(join(root, 'tracked.md'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refuses a TRACKED path/);
    assert.equal(untouched, 'tracked\n', 'the tracked file is untouched');
  });

  it('refuses an in-repo path that is not gitignored (it would move the review fingerprint)', () => {
    const root = makeRepo();
    const r = run(root, ['--constraints', '--out', 'facts.md']);
    const created = existsSync(join(root, 'facts.md'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not gitignored/);
    assert.equal(created, false);
  });

  it('refuses a SYMLINK destination — even a gitignored one routing onto a tracked file', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = makeRepo();
    symlinkSync(join(root, 'tracked.md'), join(root, 'scratch', 'link.md'));
    const r = run(root, ['--constraints', '--out', 'scratch/link.md']);
    const untouched = readFileSync(join(root, 'tracked.md'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refuses a symlink destination/);
    assert.equal(untouched, 'tracked\n', 'the symlink target is untouched');
  });

  it('resolves a SYMLINKED parent dir to its real path — an out-of-repo alias of the repo is still checked', async () => {
    const { symlinkSync, mkdtempSync: mkTmp } = await import('node:fs');
    const root = makeRepo();
    const outside = mkTmp(join(tmpdir(), 'grounding-alias-'));
    // An out-of-repo symlinked dir pointing INTO the repo root: lexically outside, really inside.
    symlinkSync(root, join(outside, 'repo-alias'));
    const r = run(root, ['--constraints', '--out', join(outside, 'repo-alias', 'facts.md')]);
    const created = existsSync(join(root, 'facts.md'));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the real destination is in-repo and not ignored — refused');
    assert.match(r.stderr, /not gitignored/);
    assert.equal(created, false);
  });

  it('accepts a gitignored in-repo path and an out-of-repo scratch path', () => {
    const root = makeRepo();
    const rIgnored = run(root, ['--constraints', '--out', 'scratch/facts.md']);
    assert.equal(rIgnored.code, 0, rIgnored.stderr);
    assert.equal(readFileSync(join(root, 'scratch', 'facts.md'), 'utf8'), CONSTRAINTS_SECTION);
    assert.match(rIgnored.stdout, /--facts @scratch\/facts\.md/, 'the report shows the copy-paste form');

    const outside = mkdtempSync(join(tmpdir(), 'grounding-out-'));
    const rOutside = run(root, ['--constraints', '--out', join(outside, 'facts.md')]);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(rOutside.code, 0, rOutside.stderr);
  });
});

describe('grounding --out — outside-repo scratch is TEMP-ONLY (review-grounding-r08-blocker-01: the tier auto-allows this writer)', () => {
  it('an outside-repo non-temp destination (a home-dir file) is refused loudly BEFORE any write; a temp one writes', () => {
    const root = makeDir();
    const underTemp = mkdtempSync(join(tmpdir(), 'grounding-temp-ok-'));
    // The refusal fires before any write, so the target only needs an EXISTING parent — the real
    // home dir is the exact victim class the blocker names (~/.bashrc).
    const target = join(homedir(), `grounding-victim-${process.pid}.txt`);
    const refused = run(root, ['--constraints', '--out', target]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not under a system temp root/);
    assert.equal(existsSync(target), false, 'nothing is written outside the temp surface');
    const ok = run(root, ['--constraints', '--out', join(underTemp, 'facts.md')]);
    rmSync(underTemp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(ok.code, 0, ok.stderr);
  });
});

describe('grounding — coverage of the defensive arms', () => {
  it('an --out leaf whose lstat fails (EACCES via an unreadable parent) refuses fail-closed', () => {
    const root = makeDir();
    const locked = join(root, 'locked');
    mkdirSync(locked);
    spawnSync('chmod', ['000', locked], { encoding: 'utf8' });
    const r = run(root, ['--constraints', '--out', join(locked, 'facts.md')]);
    spawnSync('chmod', ['700', locked], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot inspect the destination|parent directory does not exist/);
  });

  it('a nonexistent TMPDIR temp root is silently skipped by the temp-root derivation (realpath catch)', () => {
    const root = makeDir();
    const underTemp = mkdtempSync(join(tmpdir(), 'grounding-badtmpdir-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = '/no-such-temp-root-xyz';
    const r = run(root, ['--constraints', '--out', join(underTemp, 'facts.md')]);
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(underTemp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `${r.stderr} (os.tmpdir() still qualifies the destination)`);
  });

  it('--plan pointing at a MISSING file is a loud unreadable STOP (the realpath arm)', () => {
    const root = makeDir();
    const r = run(root, ['--plan', join(root, 'no-such-plan.md')]);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unreadable/);
  });

  it('a LOST create-only race (EEXIST at write time) is a loud refusal (the wx arm)', () => {
    const root = makeDir();
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    writeFileSync(join(root, '.gitignore'), 'facts-*.md\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const eexist = () => { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; };
    const r = main(['--constraints', '--out', join(root, 'facts-race.md')], { cwd: root, writeFile: eexist });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /lost the create-only race/);
    // Any NON-EEXIST write failure rethrows loudly (never a silent skip).
    const eacces = () => { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; };
    const r2 = main(['--constraints', '--out', join(root, 'facts-race2.md')], { cwd: root, writeFile: eacces });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /EACCES/);
  });
});

describe('grounding --out — an in-repo destination is CREATE-ONLY (review-grounding-r10-major-01: the .env clobber class)', () => {
  it('an EXISTING gitignored in-repo file refuses; a fresh gitignored path writes; temp overwrites fine', () => {
    const root = makeDir();
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    writeFileSync(join(root, '.gitignore'), '.env\nfacts-*.md\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const refused = run(root, ['--constraints', '--out', join(root, '.env')]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /refuses to OVERWRITE an existing in-repo file/);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SECRET=1\n', 'the project file is untouched');
    const fresh = run(root, ['--constraints', '--out', join(root, 'facts-a.md')]);
    assert.equal(fresh.code, 0, fresh.stderr);
    const tempDir = mkdtempSync(join(tmpdir(), 'grounding-rewrite-'));
    const tempOut = join(tempDir, 'facts.md');
    assert.equal(run(root, ['--constraints', '--out', tempOut]).code, 0);
    assert.equal(run(root, ['--constraints', '--out', tempOut]).code, 0, 'temp scratch stays rewritable');
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});

describe('grounding --out — an existing non-regular leaf refuses (review-grounding-r09-major-01: the write would hang on a FIFO)', () => {
  it('a FIFO under the temp surface is refused FAST, before any write', () => {
    const root = makeDir();
    const dir = mkdtempSync(join(tmpdir(), 'grounding-fifo-'));
    const fifo = join(dir, 'facts.md');
    const mk = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const started = Date.now();
    const r = run(root, ['--constraints', '--out', fifo]);
    const elapsed = Date.now() - started;
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /non-regular destination/);
    assert.ok(elapsed < 2000, `returned fast (${elapsed}ms) — the FIFO write never started`);
  });
});

describe('grounding --out — the segment-safe outside test (Issue-004 class, review-grounding-r05-major-01)', () => {
  it('an in-repo gitignored file literally named "..facts" is IN-repo (the ignored check runs) and writes fine', () => {
    const root = makeDir();
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    writeFileSync(join(root, '.gitignore'), '..facts\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const ok = run(root, ['--constraints', '--out', join(root, '..facts')]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(existsSync(join(root, '..facts')), true, 'the gitignored ..-named scratch writes');
    // The same name NOT gitignored → the in-repo refusal fires (before the fix it was misread as
    // outside the tree and BYPASSED both refusals).
    rmSync(join(root, '..facts'));
    writeFileSync(join(root, '.gitignore'), 'other\n');
    g('add', '-A');
    g('commit', '-qm', 'unignore');
    const refused = run(root, ['--constraints', '--out', join(root, '..facts')]);
    rmSync(root, { recursive: true, force: true });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not gitignored/, 'the in-repo refusal reaches a ..-named path');
  });
});

describe('grounding — byte budget (AGY_MAX_PROMPT_BYTES − --reserve-bytes)', () => {
  it('a within-budget payload is emitted untrimmed', () => {
    const root = makeDir();
    const r = run(root, ['--constraints']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.stderr, '');
    assert.doesNotMatch(r.stdout, /TRIMMED/);
  });

  it('overflow is trimmed tail-first with a loud in-band marker + stderr report', () => {
    const big = `## 🚫 Hard Constraints\n\n${'x'.repeat(4000)}\n`;
    const root = makeDir({ agents: `# P\n\n${big}` });
    const r = run(root, ['--constraints'], { AGY_MAX_PROMPT_BYTES: '1000' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= 1000, 'output fits the budget');
    assert.match(r.stdout, /TRIMMED/, 'the cut is marked in-band');
    assert.match(r.stderr, /dropped \d+ tail bytes/, 'the trim is reported loudly');
  });

  it('--reserve-bytes shrinks the budget so the FINAL wrapper prompt stays under the ceiling', () => {
    const ceiling = 2000;
    const reserve = 1500; // the artifact share agy-review will add around the facts
    const big = `## 🚫 Hard Constraints\n\n${'y'.repeat(4000)}\n`;
    const root = makeDir({ agents: `# P\n\n${big}` });
    const r = run(root, ['--constraints', '--reserve-bytes', String(reserve)], { AGY_MAX_PROMPT_BYTES: String(ceiling) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    const factsBytes = Buffer.byteLength(r.stdout, 'utf8');
    assert.ok(factsBytes <= ceiling - reserve, `facts (${factsBytes}) fit the reserved budget`);
    assert.ok(factsBytes + reserve <= ceiling, 'facts + artifact share stays under the wrapper ceiling');
  });

  it('mirrors the wrapper AGY_MAX_PROMPT_BYTES validation (only tighten; argv ceiling; integer)', () => {
    const root = makeDir();
    const tooBig = run(root, ['--constraints'], { AGY_MAX_PROMPT_BYTES: '999999' });
    assert.equal(tooBig.code, 2);
    assert.match(tooBig.stderr, /single-argv ceiling/);
    const notInt = run(root, ['--constraints'], { AGY_MAX_PROMPT_BYTES: 'lots' });
    assert.equal(notInt.code, 2);
    const noRoom = run(root, ['--constraints', '--reserve-bytes', String(DEFAULT_MAX_PROMPT_BYTES)]);
    rmSync(root, { recursive: true, force: true });
    assert.equal(noRoom.code, 2);
    assert.match(noRoom.stderr, /leaves no budget/);
  });
});

describe('grounding CLI — byte-exact stdout (no console.log newline, no exit-truncation)', () => {
  it('piped stdout equals the section byte-for-byte — no extra trailing newline', async () => {
    const { spawnSync: spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname: dn, join: jn } = await import('node:path');
    const SCRIPT = jn(dn(fileURLToPath(import.meta.url)), 'grounding.mjs');
    const root = makeDir();
    const r = spawn(process.execPath, [SCRIPT, '--constraints'], { cwd: root, encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, CONSTRAINTS_SECTION, 'CLI stdout is the section, byte-for-byte (payload already ends with \\n)');
  });
});

describe('grounding — usage errors', () => {
  it('no inputs → usage (exit 2); unknown flag → usage', () => {
    const root = makeDir();
    assert.equal(run(root, []).code, 2);
    assert.match(run(root, []).stderr, /nothing to assemble/);
    assert.equal(run(root, ['--bogus']).code, 2);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('grounding — pure helpers', () => {
  it('sliceSection is verbatim (keeps inner blank lines, normalizes only the trailing run)', () => {
    const doc = '## A\n\nline1\n\nline2\n\n\n## B\nx\n';
    assert.equal(sliceSection(doc, '## A'), '## A\n\nline1\n\nline2\n');
  });

  it('trimToBudget is a no-op within budget and marks an over-budget cut', () => {
    assert.deepEqual(trimToBudget('short', 100), { text: 'short', trimmedBytes: 0 });
    const { text, trimmedBytes } = trimToBudget('z'.repeat(500), 300);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 300);
    assert.ok(trimmedBytes > 0);
    assert.match(text, /TRIMMED/);
  });

  it('trimToBudget holds the HARD ceiling even when the budget is smaller than the trim marker', () => {
    for (const budget of [1, 10, 40, 80]) {
      const { text } = trimToBudget('z'.repeat(500), budget);
      assert.ok(
        Buffer.byteLength(text, 'utf8') <= budget,
        `budget ${budget}: output ${Buffer.byteLength(text, 'utf8')} bytes must never exceed it`,
      );
    }
  });
});
