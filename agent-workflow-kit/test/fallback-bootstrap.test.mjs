// fallback-bootstrap.test.mjs — the kit's OWN deploy path, end to end: materializing
// references/templates/ into a project and running the finalizer its bootstrap prose documents
// produces a working entry point (the always-loaded navigator exists and the generator calls it
// fresh). Plus the per-exit prose-ORDER contract for upgrade.md and composition-handoff.md: the
// finalizer has to sit AFTER the last docs/ai mutation of its path, or it goes stale the moment the
// lens reconcile runs. Every command here is EXTRACTED from the prose, never re-typed — a deploy
// step that loses its finalizer line fails as the broken deployment it is.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(KIT_ROOT, 'references', 'templates');
const BOOTSTRAP_MD = readFileSync(join(KIT_ROOT, 'references', 'modes', 'bootstrap.md'), 'utf8');
const UPGRADE_MD = readFileSync(join(KIT_ROOT, 'references', 'modes', 'upgrade.md'), 'utf8');
const HANDOFF_MD = readFileSync(join(KIT_ROOT, 'references', 'shared', 'composition-handoff.md'), 'utf8');

const GENERATOR_RE = /node \$\{CLAUDE_SKILL_DIR\}\/(references\/scripts\/[A-Za-z0-9_.-]+) --ensure-index --root=<[a-z-]+>/;
const ONLY_INDEX_RE = /node \$\{CLAUDE_SKILL_DIR\}\/(tools\/[A-Za-z0-9_.-]+) --reconcile --only index --cwd <[a-z-]+>/;

const documented = (prose, pattern, what) => {
  const match = prose.match(pattern);
  assert.ok(match, `the prose must document the ${what} — without it the deploy leaves the entry point pointing at a file nothing writes`);
  return join(KIT_ROOT, match[1]);
};

const tempDirs = [];
const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-fallback-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// The fallback bootstrap's WRITE steps, as its prose orders them: the entry point at the root and
// every other template under docs/ai (adr-record.md is a skill-home authoring reference).
const materialize = (project) => {
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (entry === 'AGENTS.md' || entry === 'adr-record.md') continue;
    cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }
  return docsAi;
};

const runFinalizer = (project) =>
  execFileSync(process.execPath, [documented(BOOTSTRAP_MD, GENERATOR_RE, 'navigator finalizer'), '--ensure-index', `--root=${project}`], { encoding: 'utf8' });

const checkIndex = (project) =>
  execFileSync(process.execPath, [documented(BOOTSTRAP_MD, GENERATOR_RE, 'navigator finalizer'), '--check-index', `--root=${project}`], { encoding: 'utf8' });

const runLateRung = (project) =>
  execFileSync(process.execPath, [documented(UPGRADE_MD, ONLY_INDEX_RE, 'late --only index rung'), '--reconcile', '--only', 'index', '--cwd', project], { encoding: 'utf8' });

describe('kit fallback bootstrap — the deployed entry point actually works', () => {
  it('materializing the templates and running the documented finalizer produces a fresh navigator', () => {
    const project = makeProject();
    const docsAi = materialize(project);
    assert.equal(existsSync(join(docsAi, 'index.md')), false, 'no template ships the navigator — it is generated');

    assert.match(runFinalizer(project), /ensure-index: (regenerated|already-current)/);
    assert.ok(existsSync(join(docsAi, 'index.md')), 'the finalizer wrote the navigator');
    assert.match(checkIndex(project), /OK/);
  });

  it('a second finalizer run is idempotent — already-current, byte-identical', () => {
    const project = makeProject();
    const docsAi = materialize(project);
    runFinalizer(project);
    const first = readFileSync(join(docsAi, 'index.md'), 'utf8');

    assert.match(runFinalizer(project), /ensure-index: already-current/);
    assert.equal(readFileSync(join(docsAi, 'index.md'), 'utf8'), first);
  });

  // The behavioural half of the per-exit contract: something changed docs/ai AFTER the early ensure
  // (a lens refresh does exactly this), so the LATE rung is what leaves the deployment consistent.
  it('the late --only index rung repairs a navigator that went stale after the first run', () => {
    const project = makeProject();
    const docsAi = materialize(project);
    runFinalizer(project);

    writeFileSync(
      join(docsAi, 'late-arrival.md'),
      '---\ntype: state\nlastUpdated: 2026-08-15\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# late\n',
    );
    assert.throws(() => checkIndex(project), 'the navigator IS stale once a doc lands under it');

    assert.match(runLateRung(project), /index: regenerated/);
    assert.match(checkIndex(project), /OK/);
  });
});

// The prose ORDER is the contract the behavioural cases cannot see: a finalizer documented in the
// wrong place still runs, and still leaves a stale navigator behind.
describe('kit deploy prose — the finalizer sits after the LAST docs/ai mutation of each path', () => {
  const LENS_BLOCK = '**`lens` — agent-rules lens refresh.**';
  const LATE_RUNG = '**The LATE navigator finalizer';
  const EQUAL_HEAD_REPORT = '4. **Equal-head exit';
  const RESTAMP = '8. Re-stamp `docs/ai/.workflow-version`';
  const HANDOFF_LENS = '**Agent-rules lens + Communication refresh (runs in BOTH paths).**';

  it('upgrade.md: the equal-head exit runs the late rung AFTER the lens block and BEFORE its report', () => {
    const lens = UPGRADE_MD.indexOf(LENS_BLOCK);
    const late = UPGRADE_MD.indexOf(LATE_RUNG);
    const report = UPGRADE_MD.indexOf(EQUAL_HEAD_REPORT);
    assert.ok(lens > 0 && late > 0 && report > 0, 'the upgrade flow must carry all three anchors');
    assert.ok(lens < late, 'a finalizer documented BEFORE the lens reconcile goes stale the moment the lens writes');
    assert.ok(late < report, 'the report relays the LATE run, so the rung has to precede it');
  });

  it('upgrade.md: the migrated exit runs the late rung BEFORE the re-stamp', () => {
    const report = UPGRADE_MD.indexOf(EQUAL_HEAD_REPORT);
    const restamp = UPGRADE_MD.indexOf(RESTAMP);
    assert.ok(report > 0 && restamp > report, 'the step-8 stamp must still follow the equal-head exit');
    const rung = UPGRADE_MD.lastIndexOf('--only index', restamp);
    assert.ok(rung > report && rung < restamp, 'the migrations may have changed docs/ai — regenerate, THEN stamp');
  });

  // The rung's own cross-reference is part of the contract: prose that names the wrong step sends a
  // reader to a place the command is not, and the position assertions above would not notice.
  it('upgrade.md: the late-rung paragraph points the migrated path at the step it actually sits in', () => {
    const late = UPGRADE_MD.indexOf(LATE_RUNG);
    const paragraph = UPGRADE_MD.slice(late, UPGRADE_MD.indexOf('\n4. ', late));
    assert.match(paragraph, /END of step 7/, 'the migrated rerun is documented at the end of step 7');
    assert.equal(/runs again at step 8/.test(paragraph), false, 'and never claims to live in step 8');
  });

  it('composition-handoff.md: the delegated path finalizes AFTER the lens reconcile', () => {
    const lens = HANDOFF_MD.indexOf(HANDOFF_LENS);
    const finalizer = HANDOFF_MD.indexOf('--ensure-index');
    assert.ok(lens > 0 && finalizer > 0, 'the hand-off contract must carry both blocks');
    assert.ok(lens < finalizer, 'the delegated path regenerates after the root\'s last docs/ai mutation');
  });
});
