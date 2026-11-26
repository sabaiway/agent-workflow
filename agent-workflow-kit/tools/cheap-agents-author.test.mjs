import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENTS_DIR, CLAUDE_DIR, BUNDLED_AGENTS_DIR, CHEAP_AGENTS_BUNDLE, EXPECTED_WORKFLOW_VERSION,
  WORKFLOW_STAMP, preflightCheapAgents, readBundledAgents, writeCheapAgents,
} from './cheap-agents.mjs';

const read = await import('./cheap-agents-read.mjs').catch(() => ({}));
const absent = () => { throw new Error('absent: surveyAuthorVehicle'); };
const surveyAuthorVehicle = read.surveyAuthorVehicle ?? absent;
const AUTHOR_VEHICLE_REL = read.AUTHOR_VEHICLE_REL;
const AUTHOR = 'author.md';
const REL = `${AGENTS_DIR}/${AUTHOR}`;
const TEMPLATE = '---\nname: author\nmodel: opus\neffort: high\ntools: Read, Grep, Glob, Write, Edit\n---\nBundled body\n';
const roots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-agents-author-'));
  roots.push(root);
  return root;
};
const makeProject = () => {
  const root = makeRoot();
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  return root;
};
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const makeBundle = () => {
  const bundleDir = makeRoot();
  writeFileSync(join(bundleDir, AUTHOR), TEMPLATE);
  return bundleDir;
};
const place = (root, content) => {
  mkdirSync(join(root, AGENTS_DIR), { recursive: true });
  writeFileSync(join(root, REL), content);
};
const assertSurvey = (root, deps, state, reason) => {
  const answer = surveyAuthorVehicle(root, deps);
  assert.equal(AUTHOR_VEHICLE_REL, '.claude/agents/author.md');
  assert.equal(answer.rel, AUTHOR_VEHICLE_REL);
  assert.notEqual(answer.state, 'customized');
  assert.equal(answer.state, state);
  assert.doesNotMatch(answer.reason ?? '', /\/agent-workflow-kit|--apply/u);
  if (reason instanceof RegExp) assert.match(answer.reason, reason);
  else assert.equal(answer.reason, reason);
};

describe('the author survey and placement (spec:carriers/S29)', () => {
  it('judges missing, placed, stale and widened regular bytes by the bundled body and the five tools', () => {
    const root = makeProject();
    const deps = { bundleDir: makeBundle() };
    assertSurvey(root, deps, 'missing', null);
    const cases = [
      [TEMPLATE, 'placed', null],
      [TEMPLATE.replace('Bundled body', 'Other body'), 'stale', /differs from the body the kit writes/u],
      [TEMPLATE.replace('Read, Grep, Glob, Write, Edit', 'Read, Grep'), 'stale', /differs from the body the kit writes/u],
      ['---\ntools: Write, Edit\n---\nOther body\n', 'stale', /differs from the body the kit writes/u],
      [TEMPLATE.replace('Write, Edit', 'Write, Bash'), 'widened', /Bash/u],
      [TEMPLATE.replace('Write, Edit', 'Write, WebFetch'), 'widened', /WebFetch/u],
      [TEMPLATE.replace(/^tools:.*\n/mu, ''), 'widened', /tools/u],
      [TEMPLATE.replace(/^tools:.*$/mu, 'tools:'), 'widened', /tools/u],
      [TEMPLATE.replace(/^tools:.*$/mu, 'tools: Read\ntools: Grep'), 'widened', /tools/u],
      ['---\nname: author\n---\ntools: Read\n', 'widened', /tools/u],
      ['', 'widened', /tools/u],
    ];
    for (const [content, state, reason] of cases) {
      place(root, content);
      assertSurvey(root, deps, state, reason);
    }
  });

  it('unusable targets and ancestors carry the read core refusal or the read error, never throw', () => {
    const bundleDir = makeBundle();
    for (const rel of [REL, CLAUDE_DIR, AGENTS_DIR]) {
      for (const kind of ['symlink', 'non-regular']) {
        const root = makeProject();
        const target = join(root, rel);
        mkdirSync(dirname(target), { recursive: true });
        if (kind === 'symlink') symlinkSync(makeRoot(), target);
        else if (rel === REL) mkdirSync(target);
        else writeFileSync(target, 'not a directory\n');
        const deps = { bundleDir };
        const { reason } = read.surveyVehicle(root, { stem: 'author', template: 'author' }, deps);
        assert.match(reason, /refusing to (?:touch it|write through it)/u);
        assert.ok(reason.includes(rel), reason);
        assertSurvey(root, deps, 'unusable', reason);
      }
    }
    const root = makeProject();
    place(root, TEMPLATE);
    const reason = 'EACCES: permission denied';
    const deps = { bundleDir, readFile: (path, ...rest) => {
      if (path === join(root, REL)) throw Object.assign(new Error(reason), { code: 'EACCES' });
      return readFileSync(path, ...rest);
    } };
    assertSurvey(root, deps, 'unusable', reason);
  });

  it('a bundle without author returns unusable with the core refusal and preflight and apply refuse without writing', () => {
    const root = makeProject();
    const bundleDir = makeRoot();
    for (const { name, content } of readBundledAgents()) {
      if (name !== AUTHOR) writeFileSync(join(bundleDir, name), content);
    }
    const deps = { bundleDir };
    const { reason } = read.surveyVehicle(root, { stem: 'author', template: 'author' }, deps);
    assert.match(reason, /author\.md.*missing from the bundle/u);
    assertSurvey(root, deps, 'unusable', reason);
    const before = readdirSync(root, { recursive: true }).sort();
    const refusal = { code: CHEAP_AGENTS_BUNDLE, message: /author\.md/u };
    assert.throws(() => preflightCheapAgents({ cwd: root }, deps), refusal);
    assert.throws(() => writeCheapAgents({ cwd: root, dryRun: false }, deps), refusal);
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
    assert.equal(readFileSync(join(root, WORKFLOW_STAMP), 'utf8'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  });

  it('plain apply places author in an accepted component with bundled bytes and a second run writes nothing', () => {
    const root = makeProject();
    const cheap = readBundledAgents().find(({ name }) => name === 'gate-triage.md');
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    writeFileSync(join(root, AGENTS_DIR, cheap.name), cheap.content);
    const result = writeCheapAgents({ cwd: root, dryRun: false });
    assert.equal(result.accepted, true);
    assert.equal(result.plan.find(({ name }) => name === AUTHOR)?.action, 'place');
    assert.equal(readFileSync(join(root, REL), 'utf8'), readFileSync(join(BUNDLED_AGENTS_DIR, AUTHOR), 'utf8'));
    const writes = [];
    const again = writeCheapAgents({ cwd: root, dryRun: false }, { writeFile: (...args) => writes.push(args) });
    assert.deepEqual([again.wrote, again.plan.find(({ name }) => name === AUTHOR)?.action, writes], [false, 'already-current', []]);
  });
});
