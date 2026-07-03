// grounding.test.mjs — the AD-038 facts assembler: slice exactness (byte-for-byte vs the source
// section), the plan heading policy (required-missing STOP, optional-absent OK, duplicate STOP),
// the writer-honesty --out guard (tracked / in-repo-not-ignored refusal), and the byte budget
// (AGY_MAX_PROMPT_BYTES − --reserve-bytes; loud tail-trim keeps the final wrapper prompt under
// the ceiling).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
