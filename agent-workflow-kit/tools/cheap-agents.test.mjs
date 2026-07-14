import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_DIR,
  WORKFLOW_STAMP,
  EXPECTED_WORKFLOW_VERSION,
  BUNDLED_AGENTS_DIR,
  readBundledAgents,
  writeCheapAgents,
  parseArgs,
  main,
  CHEAP_AGENTS_STAMP,
  CHEAP_AGENTS_SYMLINK,
} from './cheap-agents.mjs';

const tempDirs = [];
const makeProject = ({ stamp = EXPECTED_WORKFLOW_VERSION } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cheap-agents-'));
  tempDirs.push(dir);
  if (stamp !== null) {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_STAMP), `${stamp}\n`);
  }
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const BUNDLE = readBundledAgents();
const EXPECTED_VEHICLES = ['changelog-skeleton.md', 'gate-triage.md', 'mechanical-sweep.md'];

// ── the bundled vehicles: content pins (haiku/low, bounded read-only tools) ────────────

describe('bundled cheap-lane vehicles — frontmatter pins', () => {
  it('ships exactly the three documented vehicles', () => {
    assert.deepEqual(BUNDLE.map((t) => t.name), EXPECTED_VEHICLES);
  });

  const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
  for (const template of BUNDLE) {
    it(`${template.name}: model haiku, effort low, read-only tools, name matches file, non-trivial prompt`, () => {
      const fm = template.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      assert.ok(fm, 'has YAML frontmatter');
      const [, frontmatter, body] = fm;
      assert.match(frontmatter, /^model: haiku$/m, 'the vehicle is pinned to the cheap model');
      assert.match(frontmatter, /^effort: low$/m, 'the vehicle is pinned to low effort');
      const name = frontmatter.match(/^name: (\S+)$/m);
      assert.equal(`${name?.[1]}.md`, template.name, 'frontmatter name matches the filename');
      const tools = frontmatter.match(/^tools: (.+)$/m);
      assert.ok(tools, 'declares a bounded tools list');
      const toolList = tools[1].split(',').map((t) => t.trim());
      for (const tool of toolList) {
        assert.ok(READ_ONLY_TOOLS.has(tool), `${tool} must be one of the bounded read-only tools (Read/Grep/Glob)`);
      }
      assert.ok(body.trim().length > 200, 'carries a substantive task-scoped prompt');
      assert.match(frontmatter, /^description: .{40,}/m, 'carries a routing description');
    });
  }

  // The read-prompt-economy honesty line (AD-055 Part II, reconciled by council B9) — CONTENT, not
  // just placement: the vehicle grants NO Bash (consistent with `tools: Read, Grep, Glob`), so a
  // missing Grep/Glob falls back to the READ tool (never a shelled-out command); only IF a harness
  // routes reads through Bash does the plain-single + read-lane guidance apply. This reconciles the
  // "never run commands" rule with the Bash-fallback note codex B9 flagged as self-contradictory.
  it('every vehicle carries the reconciled read-lane honesty line (no Bash grant → Read fallback → conditional read-lane)', () => {
    for (const template of BUNDLE) {
      assert.match(template.content, /no `Bash`/u, `${template.name} states the vehicle grants no Bash`);
      assert.match(template.content, /fall back to the `Read` tool/u, `${template.name} directs the missing-Grep/Glob fallback to the Read tool`);
      assert.match(template.content, /plain single read-only command/u, `${template.name} pins plain single reads for a harness-forced Bash read`);
      assert.match(template.content, /never `node -e`/u, `${template.name} bans node -e`);
      assert.match(template.content, /read-lane/u, `${template.name} names the read-lane mechanism`);
    }
  });
});

// ── the writer: velocity discipline ────────────────────────────────────────────────────

describe('writeCheapAgents — preview-then-mutate', () => {
  it('dry-run (the default) previews the placement and writes NOTHING', () => {
    const project = makeProject();
    const result = writeCheapAgents({ cwd: project, dryRun: true });
    assert.equal(result.wrote, false);
    assert.deepEqual(result.plan.map((p) => p.action), ['place', 'place', 'place']);
    assert.ok(!existsSync(join(project, AGENTS_DIR)), 'no directory created on dry-run');
  });

  it('apply places exactly the bundled set, byte-identical', () => {
    const project = makeProject();
    const result = writeCheapAgents({ cwd: project, dryRun: false });
    assert.equal(result.wrote, true);
    assert.deepEqual(readdirSync(join(project, AGENTS_DIR)).sort(), EXPECTED_VEHICLES);
    for (const template of BUNDLE) {
      assert.equal(readFileSync(join(project, AGENTS_DIR, template.name), 'utf8'), template.content);
    }
  });

  it('a re-run is idempotent: everything already current, nothing rewritten', () => {
    const project = makeProject();
    writeCheapAgents({ cwd: project, dryRun: false });
    const writes = [];
    const again = writeCheapAgents(
      { cwd: project, dryRun: false },
      { writeFile: (path, content) => writes.push(path) },
    );
    assert.equal(again.wrote, false);
    assert.deepEqual(again.plan.map((p) => p.action), ['already-current', 'already-current', 'already-current']);
    assert.deepEqual(writes, [], 'no write call on an already-current set');
  });

  it('NEVER overwrites a diverged existing file — customization reported with its path, others still place', () => {
    const project = makeProject();
    mkdirSync(join(project, AGENTS_DIR), { recursive: true });
    const customized = '---\nname: gate-triage\nmodel: opus\n---\nmy own prompt\n';
    writeFileSync(join(project, AGENTS_DIR, 'gate-triage.md'), customized);
    const result = writeCheapAgents({ cwd: project, dryRun: false });
    const byName = Object.fromEntries(result.plan.map((p) => [p.name, p.action]));
    assert.equal(byName['gate-triage.md'], 'customized-preserved');
    assert.equal(byName['mechanical-sweep.md'], 'place');
    assert.equal(readFileSync(join(project, AGENTS_DIR, 'gate-triage.md'), 'utf8'), customized, 'the customization is untouched');
    const out = [];
    const code = main(['--apply', '--cwd', project], { log: (l) => out.push(l), errlog: (l) => out.push(l) });
    assert.equal(code, 0, 'a preserved customization is a report, not an error');
    assert.match(out.join('\n'), /gate-triage\.md: customized — preserved/);
  });

  it('writes ONLY under .claude/agents/ — never settings*.json (capture every write)', () => {
    const project = makeProject();
    const writes = [];
    writeCheapAgents(
      { cwd: project, dryRun: false },
      { writeFile: (path, content) => writes.push(String(path).replace(/\\/g, '/')) },
    );
    assert.equal(writes.length, EXPECTED_VEHICLES.length);
    for (const path of writes) {
      assert.ok(path.includes(`/${AGENTS_DIR}/`), `write outside ${AGENTS_DIR}: ${path}`);
      assert.ok(!path.includes('settings'), `must never touch settings files: ${path}`);
    }
  });
});

describe('writeCheapAgents — preconditions (STOPs)', () => {
  it('apply without a current deployment stamp → STOP (dry-run still previews)', () => {
    const project = makeProject({ stamp: null });
    assert.doesNotThrow(() => writeCheapAgents({ cwd: project, dryRun: true }));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_STAMP);
  });

  it('a wrong-lineage stamp → STOP on apply', () => {
    const project = makeProject({ stamp: '9.9.9' });
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_STAMP);
  });

  it('a symlinked .claude → STOP (both modes — a dry-run never promises what apply refuses)', () => {
    const project = makeProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'cheap-agents-elsewhere-'));
    tempDirs.push(elsewhere);
    symlinkSync(elsewhere, join(project, '.claude'));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: true }), (e) => e.code === CHEAP_AGENTS_SYMLINK);
  });

  it('a symlinked target file → STOP, never written through', () => {
    const project = makeProject();
    mkdirSync(join(project, AGENTS_DIR), { recursive: true });
    const elsewhere = join(project, 'elsewhere.md');
    writeFileSync(elsewhere, 'x');
    symlinkSync(elsewhere, join(project, AGENTS_DIR, 'mechanical-sweep.md'));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_SYMLINK);
  });

  it('an empty bundle dir → loud BUNDLE stop (an incomplete kit install is never a silent no-op)', () => {
    const emptyBundle = mkdtempSync(join(tmpdir(), 'cheap-agents-bundle-'));
    tempDirs.push(emptyBundle);
    assert.throws(() => writeCheapAgents({ cwd: makeProject(), dryRun: true }, { bundleDir: emptyBundle }), /no bundled agent templates/);
  });
});

describe('parseArgs / main', () => {
  it('--dry-run is the default; --dry-run with --apply is a usage error', () => {
    assert.equal(parseArgs([]).dryRun, true);
    assert.equal(parseArgs(['--apply']).dryRun, false);
    assert.throws(() => parseArgs(['--dry-run', '--apply']), (e) => e.exitCode === 2);
    assert.throws(() => parseArgs(['--frobnicate']), (e) => e.exitCode === 2);
  });

  it('main dry-run on a fresh project → exit 0 with a would-place preview', () => {
    const project = makeProject();
    const out = [];
    const code = main(['--cwd', project], { log: (l) => out.push(l) });
    assert.equal(code, 0);
    assert.match(out.join('\n'), /DRY RUN/);
    assert.match(out.join('\n'), /mechanical-sweep\.md: would place/);
  });
});
