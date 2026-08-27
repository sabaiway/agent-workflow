// End-to-end acceptance: a standalone substrate bootstrap into a fresh project.
//
// The unit suites cover each module in isolation (the stamp state machine, the atomic
// writer, the hook installer). This drives the documented bootstrap WRITE steps end to end
// over a real temp project + a real git checkout, then asserts the deployed artifact set:
// docs/ai + entry point exist, the pre-commit hook is installed, the deployment-lineage
// stamp is .memory-version (the lineage head) ONLY, and the methodology slot ships empty.
//
// Standalone here means substrate-only: nothing fills the slot, so it stays empty and no
// second (composition-root) stamp appears. The composition path is covered separately.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeStampAtomic, LINEAGE_HEAD } from './stamp-takeover.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(SKILL_ROOT, 'references', 'templates');
const ENFORCEMENT = join(SKILL_ROOT, 'references', 'scripts');

// The empty delimited slots the substrate ships in its entry point. Hard-coded (not imported
// from the composition root) so this substrate test stays self-contained and dependency-free.
const SLOT_START = '<!-- workflow:methodology:start -->';
const SLOT_END = '<!-- workflow:methodology:end -->';
const ORCH_START = '<!-- workflow:orchestration:start -->';
const ORCH_END = '<!-- workflow:orchestration:end -->';
const AUT_START = '<!-- workflow:autonomy:start -->';
const AUT_END = '<!-- workflow:autonomy:end -->';
// The deployed AGENTS.md line budget the composition root fills ALL THREE pointers inside (D-CAP).
// A representative single-line fragment per slot models what the composition root injects.
const AGENTS_MD_CAP = 100;
// The templates that never enter docs/ai: the entry point (placed at the root) and the two skill-home
// authoring references — a stray adr-record.md under adr/ fails the store integrity guard, and a stray
// SPEC_TEMPLATE.md would be a docs/ai file the cap-validator reads and the spec reader never sees.
const SKILL_HOME_ONLY = new Set(['AGENTS.md', 'adr-record.md', 'SPEC_TEMPLATE.md']);
const READER_PAIR = ['spec-schema.mjs', 'spec-schema.test.mjs'];
const CHECKER_PAIR = ['check-docs-size.mjs', 'check-docs-size.test.mjs'];
const VALID_SPEC = '---\ntype: spec\nlastUpdated: 2026-08-23\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: 150\nkind: spec\nstatus: draft\nrevision: 1\n---\n\n# Spec: login\n\n## Contract\n\nc\n\n## Scenarios\n\n- S1 a :: test/login.test.mjs :: spec:login/S1\n\n## Out of scope\n\n- b\n\n## Module\n\n- src/login/\n';
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const extractPair = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  return a !== -1 && b !== -1 && b > a ? text.slice(a + start.length, b) : null;
};

const tempDirs = [];
const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-bootstrap-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true }); });

// Mirrors the bootstrap WRITE steps: entry point at the root (+ tool alias symlink), every
// other template under docs/ai, enforcement scripts copied in, the hook installed against a
// real checkout, and the lineage head stamped atomically. Returns the docs/ai dir.
const bootstrap = (project) => {
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  symlinkSync('AGENTS.md', join(project, 'CLAUDE.md'));

  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (SKILL_HOME_ONLY.has(entry)) continue;
    cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }

  const projectScripts = join(project, 'scripts');
  mkdirSync(projectScripts, { recursive: true });
  cpSync(ENFORCEMENT, projectScripts, { recursive: true });

  // The hook installer resolves its target from its OWN location, so run the copied-in copy
  // (project/scripts/...) to install into project/.git/hooks — exactly as the procedure does.
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync(process.execPath, [join(projectScripts, 'install-git-hooks.mjs')], { cwd: project, stdio: 'pipe' });

  return docsAi;
};

describe('standalone substrate bootstrap (end-to-end, real temp project)', () => {
  it('deploys docs/ai + entry point and installs the pre-commit hook', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(project, 'AGENTS.md')), 'entry point exists');
    assert.ok(existsSync(docsAi), 'docs/ai exists');
    assert.ok(existsSync(join(docsAi, 'agent_rules.md')), 'a representative docs/ai file landed');

    const hook = join(project, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(hook), 'pre-commit hook installed');
    assert.match(readFileSync(hook, 'utf8'), /install-git-hooks\.mjs/, 'hook carries the installer marker');
  });

  // The one-file-per-ADR store seeds a HOT window (decisions.md) + the seed navigator
  // (docs/ai/adr/log.md) but NOT the adr-record.md authoring reference; a fresh bootstrap must pass
  // archive-decisions.mjs --check on first commit (the seed navigator == the generator over the seed).
  it('seeds the ADR store (decisions.md + adr/log.md, no stray adr-record.md) and --check is green', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(docsAi, 'decisions.md')), 'the HOT ADR window is seeded');
    assert.ok(existsSync(join(docsAi, 'adr', 'log.md')), 'the seed ADR navigator is deployed under adr/');
    assert.ok(!existsSync(join(docsAi, 'adr-record.md')), 'the authoring reference is NOT deployed (skill-home only)');
    assert.ok(!existsSync(join(docsAi, 'adr', 'adr-record.md')), 'the authoring reference is NOT placed in the adr/ store');

    // The deployed rotator (project/scripts/) resolves its root from its own location → the project.
    const check = execFileSync(process.execPath, [join(project, 'scripts', 'archive-decisions.mjs'), '--check'], { cwd: project, encoding: 'utf8' });
    assert.match(check, /OK — HOT within cap, store integrity intact, navigator fresh/, 'fresh-bootstrap --check is green');
  });

  // The spec layer (spec layer 1a): the store root navigator deploys, the authoring reference does NOT
  // (the PAGE_TEMPLATE prose-only exclusion bug is not repeated — this pins the copy loop), the
  // regenerated docs/ai navigator collapses the store into ONE counted row, and the REAL installed
  // pre-commit hook (the deployed checker + --check-index + the deployed test suite) exits 0 over a
  // seeded valid spec — the hook path a deployed project actually runs.
  it('deploys docs/ai/specs/index.md, never SPEC_TEMPLATE.md; ONE specs/ navigator row; the installed hook exits 0 over a seeded spec', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    assert.ok(existsSync(join(docsAi, 'specs', 'index.md')), 'the store root navigator is deployed');
    assert.ok(!existsSync(join(docsAi, 'SPEC_TEMPLATE.md')), 'the authoring reference is NOT deployed (skill-home only)');
    assert.ok(!existsSync(join(docsAi, 'specs', 'SPEC_TEMPLATE.md')), 'nor placed in the store');
    writeFileSync(join(docsAi, 'specs', 'login.md'), VALID_SPEC);
    const checker = join(project, 'scripts', 'check-docs-size.mjs');
    execFileSync(process.execPath, [checker, '--write-index', `--root=${project}`], { cwd: project, stdio: 'pipe' });
    const navigator = readFileSync(join(docsAi, 'index.md'), 'utf8');
    const specsRows = navigator.split('\n').filter((line) => line.includes('](./specs/index.md)'));
    assert.equal(specsRows.length, 1, 'exactly one specs/ row');
    assert.match(specsRows[0], /\| 1 specs \| 0 parts · 1 indexes \|/, 'the row carries live counts');
    assert.ok(!navigator.includes('specs/login.md'), 'the spec itself is collapsed, not listed');
    execFileSync('bash', [join(project, '.git', 'hooks', 'pre-commit')], { cwd: project, stdio: 'pipe' });
  });

  it('stamps .memory-version (lineage head) ONLY — no second stamp', async () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    await writeStampAtomic(join(docsAi, '.memory-version'), LINEAGE_HEAD);

    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD);
    assert.ok(!existsSync(join(docsAi, '.workflow-version')), 'no composition-root stamp in a standalone bootstrap');
  });

  it('ships ALL THREE pointer slots present-but-empty (methodology + orchestration + autonomy)', () => {
    const project = makeProject();
    bootstrap(project);

    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    for (const [label, start, end] of [['methodology', SLOT_START, SLOT_END], ['orchestration', ORCH_START, ORCH_END], ['autonomy', AUT_START, AUT_END]]) {
      const slot = extractPair(entry, start, end);
      assert.notEqual(slot, null, `an ordered ${label} marker pair is present`);
      assert.equal(slot.trim(), '', `the ${label} slot is empty as shipped`);
    }
  });

  it('seeds docs/ai/orchestration.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'orchestration.json');
    assert.ok(existsSync(seeded), 'the orchestration.json config is seeded into docs/ai');
    assert.equal(readFileSync(seeded, 'utf8'), readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'), 'the seeded config is byte-identical to the template');
    // strict JSON valid + the conservative all-solo default the maintainer chose.
    const config = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof config._README, 'string', 'an onboarding _README is present');
    assert.equal(config['plan-authoring'].review, 'solo', 'default review recipe is solo');
  });

  it('seeds docs/ai/gates.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'gates.json');
    assert.ok(existsSync(seeded), 'the gates.json declaration is seeded into docs/ai');
    assert.equal(readFileSync(seeded, 'utf8'), readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'), 'the seeded declaration is byte-identical to the template');
    // strict JSON valid + the conservative empty-list default (a project declares its own gates).
    const declaration = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof declaration._README, 'string', 'an onboarding _README is present');
    assert.deepEqual(declaration.gates, [], 'ships an empty gates list');
  });

  // The stamp-independent upgrade "ensure" for gates.json (SKILL.md upgrade step 2): the same
  // create-if-missing / preserve-byte-for-byte contract as orchestration.json — an authored gate
  // matrix is never clobbered, a deleted declaration is re-seeded.
  it('the upgrade ensure preserves an edited gates.json and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'gates.json');
    const ensureGates = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'gates.json'), dest);
    };

    // A user declares their own gate matrix.
    const authored = '{ "gates": [{ "id": "unit-tests", "title": "Unit tests", "cmd": "node --test" }] }\n';
    writeFileSync(dest, authored);
    ensureGates(); // an equal-head upgrade re-runs the ensure
    assert.equal(readFileSync(dest, 'utf8'), authored, 'an authored declaration is preserved byte-for-byte');

    // A missing declaration is re-seeded.
    rmSync(dest);
    ensureGates();
    assert.ok(existsSync(dest), 'a missing declaration is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'));
  });

  // The stamp-independent enforcement-script ensure (SKILL.md upgrade step 2,
  // review-bootstrap-r01-major-01):
  // a deployment older than the ADR-cascade feature gains the archive-decisions pair on an
  // equal-head upgrade — copy-if-missing from references/scripts, never overwrite an existing
  // file. Modeled the way the documented prose performs it (the ensureConfig idiom).
  it('the upgrade ensure adds a MISSING archive-decisions pair and preserves an existing one', () => {
    const project = makeProject();
    bootstrap(project);
    const projectScripts = join(project, 'scripts');
    const pair = ['archive-decisions.mjs', 'archive-decisions.test.mjs'];
    // Simulate a PRE-cascade deployment: the pair is absent from the deployed scripts/.
    for (const name of pair) rmSync(join(projectScripts, name));
    const ensureEnforcementPair = () => {
      for (const name of pair) {
        if (!existsSync(join(projectScripts, name))) cpSync(join(ENFORCEMENT, name), join(projectScripts, name));
      }
    };
    ensureEnforcementPair();
    for (const name of pair) {
      assert.equal(readFileSync(join(projectScripts, name), 'utf8'), readFileSync(join(ENFORCEMENT, name), 'utf8'), `${name} seeded byte-identical from references/scripts`);
    }
    // An existing (possibly older) file is preserved — drift repair is a migration's job.
    writeFileSync(join(projectScripts, 'archive-decisions.mjs'), '// locally pinned older copy\n');
    ensureEnforcementPair();
    assert.match(readFileSync(join(projectScripts, 'archive-decisions.mjs'), 'utf8'), /locally pinned/, 'never overwritten');
  });

  // The spec-layer ensure (SKILL.md upgrade step 2), modeled the way the prose performs it: only where there is
  // Node evidence (a package.json OR a deployed kit script); the reader pair copy-if-missing; the store root
  // create-only, date rendered, ONLY behind BOTH pairs as REGULAR files byte-equal to the bundle (the hook runs
  // the DEPLOYED checker). No catalog: a differing pair is reported.
  it('the upgrade ensure seeds a MISSING reader pair, and the store root ONLY behind bundle-equal reader + checker pairs', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const scripts = join(project, 'scripts');
    const root = join(docsAi, 'specs', 'index.md');
    const checker = join(scripts, 'check-docs-size.mjs');
    for (const name of READER_PAIR) rmSync(join(scripts, name)); // a pre-spec deployment: no reader, no store
    // ...and, for the FIRST probe only, every OTHER Node witness the evidence rule reads — a deployed
    // kit script is evidence enough, so "no package.json" alone no longer makes a No-Node tree.
    const SEED_SET = readdirSync(ENFORCEMENT).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.startsWith('_'));
    const WITNESSES = SEED_SET.filter((name) => !READER_PAIR.includes(name));
    for (const name of WITNESSES) rmSync(join(scripts, name), { force: true });
    rmSync(join(docsAi, 'specs'), { recursive: true });
    // Presence is probed WITHOUT following links: a dangling symlink is present (and not a regular file).
    const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
    const regular = (p) => present(p) && lstatSync(p).isFile();
    const regularAndEqual = (name) => regular(join(scripts, name)) && readFileSync(join(scripts, name)).equals(readFileSync(join(ENFORCEMENT, name)));
    const nodeEvidence = () => regular(join(project, 'package.json')) || SEED_SET.some((name) => regular(join(scripts, name)));
    const ensureSpecLayer = () => {
      if (!nodeEvidence()) return 'skipped-no-node-evidence';
      if ([...READER_PAIR, ...CHECKER_PAIR].map((name) => join(scripts, name)).concat(root).some((p) => present(p) && !regular(p))) return 'reported';
      for (const name of READER_PAIR) if (!present(join(scripts, name))) cpSync(join(ENFORCEMENT, name), join(scripts, name));
      if (![...READER_PAIR, ...CHECKER_PAIR].every(regularAndEqual)) return 'reported';
      if (present(root)) return 'already-present';
      mkdirSync(dirname(root), { recursive: true });
      writeFileSync(root, readFileSync(join(TEMPLATES, 'specs', 'index.md'), 'utf8').replaceAll('{{DATE}}', '2026-08-23'));
      return 'seeded';
    };
    assert.equal(ensureSpecLayer(), 'skipped-no-node-evidence', 'no Node evidence: nothing written');
    cpSync(join(ENFORCEMENT, 'archive-caps.mjs'), join(scripts, 'archive-caps.mjs'));
    assert.notEqual(ensureSpecLayer(), 'skipped-no-node-evidence', 'ONE deployed kit script (a witness the old package.json probe never saw) is evidence enough');
    rmSync(join(scripts, 'archive-caps.mjs'));
    for (const name of READER_PAIR) rmSync(join(scripts, name), { force: true }); // the witness run seeded the reader pair — back to the pre-spec state
    assert.equal(present(join(scripts, READER_PAIR[0])), false);
    // Put the deployed checker pair (and the ADR rotator the hook runs) back: every later step below
    // exercises the bundle-equality gate, which needs the pair on disk exactly as bootstrap left it.
    for (const name of WITNESSES) cpSync(join(ENFORCEMENT, name), join(scripts, name));
    writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n');
    symlinkSync(join(project, 'nowhere'), join(scripts, READER_PAIR[0]));
    assert.equal(ensureSpecLayer(), 'reported', 'a DANGLING symlink where the reader belongs: nothing is written through it');
    assert.equal(present(join(project, 'nowhere')), false, 'the link target was never created');
    rmSync(join(scripts, READER_PAIR[0]));
    writeFileSync(checker, '// locally edited checker\n');
    assert.equal(ensureSpecLayer(), 'reported', 'an edited checker: the reader pair lands, the store root does not');
    for (const name of READER_PAIR) assert.ok(regularAndEqual(name), `${name} seeded byte-identical`);
    assert.match(readFileSync(checker, 'utf8'), /locally edited/, 'never overwritten');
    assert.equal(existsSync(join(docsAi, 'specs')), false, 'no store root behind an edited checker');
    rmSync(checker);
    symlinkSync(join(ENFORCEMENT, 'check-docs-size.mjs'), checker);
    assert.equal(ensureSpecLayer(), 'reported', 'a symlink to the bundled body is not a regular file');
    rmSync(checker);
    cpSync(join(ENFORCEMENT, 'check-docs-size.mjs'), checker);
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(join(project, 'nowhere'), root);
    assert.equal(ensureSpecLayer(), 'reported', 'a DANGLING symlink where the store root belongs: nothing is written through it');
    assert.equal(present(join(project, 'nowhere')), false);
    rmSync(root);
    assert.equal(ensureSpecLayer(), 'seeded', 'a bundle-equal checker: the store root lands');
    assert.equal(readFileSync(root, 'utf8').includes('{{'), false, 'the date placeholder is rendered');
    writeFileSync(join(docsAi, 'specs', 'login.md'), VALID_SPEC);
    execFileSync(process.execPath, [checker, '--write-index', `--root=${project}`], { cwd: project, stdio: 'pipe' });
    execFileSync('bash', [join(project, '.git', 'hooks', 'pre-commit')], { cwd: project, stdio: 'pipe' });
    writeFileSync(root, '# mine\n');
    assert.equal(ensureSpecLayer(), 'already-present', 'an existing root is never rewritten');
    assert.equal(readFileSync(root, 'utf8'), '# mine\n');
  });

  // The stamp-independent upgrade "ensure" (SKILL.md upgrade step 2): create-if-missing /
  // preserve-if-edited. Modeled here the way the documented prose performs it — so an equal-head
  // re-run never clobbers a user's edited config, and a deleted one is re-seeded.
  it('the upgrade ensure preserves an edited config and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'orchestration.json');
    const ensureConfig = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'orchestration.json'), dest);
    };

    // A user edits the deployed config.
    writeFileSync(dest, '{ "plan-authoring": { "review": "council" } }\n');
    ensureConfig(); // an equal-head upgrade re-runs the ensure
    assert.match(readFileSync(dest, 'utf8'), /council/, 'an edited config is preserved (never clobbered)');

    // A missing config is re-seeded.
    rmSync(dest);
    ensureConfig();
    assert.ok(existsSync(dest), 'a missing config is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'));
  });

  it('stays STRICTLY under the cap when the composition root fills ALL THREE pointer slots (D-CAP headroom)', () => {
    const project = makeProject();
    bootstrap(project);
    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.ok(lineCount(entry) <= AGENTS_MD_CAP, `shipped (empty) AGENTS.md is ${lineCount(entry)} lines (cap ${AGENTS_MD_CAP})`);
    // Fill each one-line pointer the way the composition root does (replace the empty body), then re-count.
    const fill = (text, start, end, body) => {
      const a = text.indexOf(start);
      const b = text.indexOf(end);
      return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
    };
    let filled = fill(entry, SLOT_START, SLOT_END, '> methodology pointer (one line)');
    filled = fill(filled, ORCH_START, ORCH_END, '> orchestration recipes pointer (one line)');
    filled = fill(filled, AUT_START, AUT_END, '> autonomy policy pointer (one line)');
    // STRICT (< cap): the third pair once landed the triple-fill exactly AT 100 — only a
    // genuinely-trimmed template passes, so the headroom trim can never silently regress.
    assert.ok(lineCount(filled) < AGENTS_MD_CAP, `triple-filled AGENTS.md is ${lineCount(filled)} lines — must stay STRICTLY under the cap ${AGENTS_MD_CAP}`);
  });
});

// The navigator is the one always-loaded file no template ships. These drive the finalizer the
// PROSE documents — extracted from SKILL.md, never re-typed here — so a deploy step that loses its
// finalizer line fails as a broken deployment rather than as an out-of-date test.
const SKILL_MD = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8');
const FINALIZER_RE = /node \$\{CLAUDE_SKILL_DIR\}\/(references\/scripts\/[A-Za-z0-9_.-]+) --ensure-index --root=<[a-z-]+>/;
const UPGRADE_HEADING = '### Mode: upgrade';
const EQUAL_HEAD_ANCHOR = '**Then**, if the stamp **equals** the head';
const RESTAMP_ANCHOR = '7. **Re-stamp**';

const documentedFinalizer = (prose) => {
  const match = prose.match(FINALIZER_RE);
  assert.ok(match, 'the bootstrap prose must document the navigator finalizer command — a deploy with no finalizer line leaves the entry point pointing at a file nothing writes');
  return join(SKILL_ROOT, match[1]);
};

const runFinalizer = (project) =>
  execFileSync(process.execPath, [documentedFinalizer(SKILL_MD), '--ensure-index', `--root=${project}`], { encoding: 'utf8' });

describe('standalone bootstrap — the navigator the entry point declares always-loaded', () => {
  it('the documented finalizer materializes docs/ai/index.md, and the generator agrees it is fresh', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    assert.equal(existsSync(join(docsAi, 'index.md')), false, 'no template ships the navigator — it is generated');

    const out = runFinalizer(project);
    assert.match(out, /ensure-index: (regenerated|already-current)/);
    assert.ok(existsSync(join(docsAi, 'index.md')), 'the finalizer wrote the navigator');
    execFileSync(process.execPath, [documentedFinalizer(SKILL_MD), '--check-index', `--root=${project}`], { stdio: 'pipe' });
  });

  // The No-Node lane is a REAL branch, not a comment: no project scripts, no hook, no package.json —
  // the generator runs from the SKILL HOME, which is exactly why the fill step covers such a target.
  it('a No-Node target gets its navigator from the skill-home generator alone', () => {
    const project = makeProject();
    cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
    const docsAi = join(project, 'docs', 'ai');
    mkdirSync(docsAi, { recursive: true });
    for (const entry of readdirSync(TEMPLATES)) {
      if (SKILL_HOME_ONLY.has(entry)) continue;
      cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
    }
    assert.equal(existsSync(join(project, 'scripts')), false, 'the No-Node lane copies no enforcement scripts');
    assert.equal(existsSync(join(project, 'package.json')), false, 'and has no Node project at all');

    runFinalizer(project);
    assert.ok(existsSync(join(docsAi, 'index.md')), 'the navigator landed without a single project-side script');
    execFileSync(process.execPath, [documentedFinalizer(SKILL_MD), '--check-index', `--root=${project}`], { stdio: 'pipe' });
  });

  it('the upgrade flow documents the spec-layer ensure (reader pair if missing; store root only behind bundle-equal pairs) BEFORE the navigator ensure', () => {
    const upgrade = SKILL_MD.slice(SKILL_MD.indexOf(UPGRADE_HEADING));
    const specLayer = upgrade.indexOf('ensure the SPEC LAYER');
    const navigator = upgrade.indexOf('ensure the NAVIGATOR');
    assert.ok(specLayer > 0 && specLayer < navigator && navigator < upgrade.indexOf(EQUAL_HEAD_ANCHOR), 'spec layer -> navigator -> equal-head exit');
    const block = upgrade.slice(specLayer, navigator);
    for (const token of [...READER_PAIR, ...CHECKER_PAIR, 'regular files', 'dangling', 'byte-equal', 'index.md` **if missing**', 'date filled', 'Node evidence', 'never overwrites a deployed script']) assert.ok(block.includes(token), token);
  });

  it('the upgrade flow documents the finalizer at BOTH positions the deploy needs it', () => {
    const upgrade = SKILL_MD.slice(SKILL_MD.indexOf(UPGRADE_HEADING));
    const equalHead = upgrade.indexOf(EQUAL_HEAD_ANCHOR);
    const restamp = upgrade.indexOf(RESTAMP_ANCHOR);
    assert.ok(equalHead > 0 && restamp > equalHead, 'the upgrade flow must still carry both anchors, in order');

    const positions = [...upgrade.matchAll(/--ensure-index/g)].map((m) => m.index);
    assert.ok(positions.some((at) => at < equalHead), 'a deployment already at the head must gain the navigator too — the finalizer runs BEFORE the equal-head short-circuit');
    assert.ok(positions.some((at) => at > equalHead && at < restamp), 'the migrations may change docs/ai — the finalizer runs again AFTER them and BEFORE the re-stamp');
  });
});
