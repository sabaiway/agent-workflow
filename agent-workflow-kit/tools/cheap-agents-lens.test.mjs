import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const agents = await import('./cheap-agents-read.mjs');
const { lensVehicleSpec, deriveLensTemplate } = await import('./review-roster-resolve.mjs');
const { BUNDLED_LENS_TEMPLATES } = await import('./review-roster.mjs');

const PROJECT = '/virtual/project';
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const stat = (kind = 'file') => ({
  isSymbolicLink: () => kind === 'symlink',
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
});
const survey = (member, existing, kind = 'file') => agents.surveyVehicle(PROJECT, lensVehicleSpec(member), {
  lstat: (path) => {
    if (String(path).endsWith('.claude') || String(path).endsWith('.claude/agents')) throw missing();
    if (existing === null) throw missing();
    return stat(kind);
  },
  readFile: (path, encoding) => {
    if (String(path).includes('/references/agents/')) return readFileSync(path, encoding);
    return existing;
  },
  readdir: () => readdirSync(agents.BUNDLED_AGENTS_DIR),
});

describe('parameterized lens vehicle survey (spec:review-roster/S4)', () => {
  it('recognizes placed, customized and missing lens vehicles', () => {
    const bundled = readFileSync(join(agents.BUNDLED_AGENTS_DIR, 'review-lens.md'), 'utf8');
    assert.deepEqual(survey('review-lens', bundled), {
      state: 'placed', reason: null, rel: '.claude/agents/review-lens.md',
      model: 'sonnet', effort: 'high',
    });
    assert.deepEqual(
      survey('review-lens', '---\nname: review-lens\nmodel: opus\neffort: high\ntools: [Read, Grep]\n---\ncustom\n'),
      { state: 'customized', reason: null, rel: '.claude/agents/review-lens.md', model: 'opus', effort: 'high' },
    );
    assert.equal(survey('review-lens', null).state, 'missing');
  });

  it('refuses unsafe or ambiguous lens frontmatter', () => {
    for (const body of [
      '---\nname: review-lens\nmodel: opus\neffort: high\n---\nbody\n',
      '---\nname: review-lens\nmodel: opus\neffort: high\ntools: Read, Bash\n---\nbody\n',
      '---\nname: review-lens\nmodel: opus\neffort: high\ntools: Read\ntools: Grep\n---\nbody\n',
      '---\nname: other\nmodel: opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel:\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: [review-lens]\nmodel: opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: "[review-lens]"\nmodel: opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: [opus]\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: opus\neffort: {level: high}\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: |\n  opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: "opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: \'opus"\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: "review-lens\nmodel: opus\neffort: high\ntools: Read\n---\nbody\n',
      '---\nname: review-lens\nmodel: opus\neffort: high"\ntools: Read\n---\nbody\n',
    ]) assert.equal(survey('review-lens', body).state, 'unusable', body);
    assert.equal(
      survey('review-lens', '---\nname: "review-lens" # quoted\nmodel: opus\neffort: high\ntools: [Read, Grep]\n---\nbody\n').state,
      'customized',
    );
    assert.equal(survey('review-lens', 'x', 'symlink').state, 'unusable');
  });

  it('tells a non-scalar model or effort from an empty one in the refusal', () => {
    const reasonOf = (body) => survey('review-lens', body).reason;
    assert.equal(reasonOf('---\nname: review-lens\nmodel: "opus\neffort: high\ntools: Read\n---\nbody\n'), 'model: is not a scalar');
    assert.equal(reasonOf('---\nname: review-lens\nmodel: opus\neffort: [high]\ntools: Read\n---\nbody\n'), 'effort: is not a scalar');
    assert.equal(reasonOf('---\nname: review-lens\nmodel:\neffort: high\ntools: Read\n---\nbody\n'), 'model: is empty');
    assert.equal(reasonOf('---\nname: review-lens\nmodel: opus\neffort: ""\ntools: Read\n---\nbody\n'), 'effort: is empty');
  });

  it('surveys a derived vehicle against the derived bundled bytes', () => {
    const base = readFileSync(join(agents.BUNDLED_AGENTS_DIR, 'review-lens.md'), 'utf8');
    const spec = lensVehicleSpec('review-lens:opus:high');
    const bytes = deriveLensTemplate(base, spec);
    const result = survey('review-lens:opus:high', bytes);
    assert.deepEqual(result, {
      state: 'placed', reason: null, rel: '.claude/agents/review-lens-opus-high.md',
      model: 'opus', effort: 'high',
    });
  });

  it('a bare stem with no bundled template is missing with the HAND-APPLY reason, or customized when hand-written', () => {
    assert.deepEqual(survey('my-review-lens', null), {
      state: 'missing', reason: 'no bundled template to derive it from', rel: '.claude/agents/my-review-lens.md',
    });
    assert.deepEqual(
      survey('my-review-lens', '---\nname: my-review-lens\nmodel: opus\neffort: high\ntools: Read\n---\nbody\n'),
      { state: 'customized', reason: null, rel: '.claude/agents/my-review-lens.md', model: 'opus', effort: 'high' },
    );
  });

  it('every bundled lens template exists in the bundle and surveys as a placed read-only lens (drift guard)', () => {
    assert.ok(BUNDLED_LENS_TEMPLATES.length > 0);
    for (const template of BUNDLED_LENS_TEMPLATES) {
      const bytes = readFileSync(join(agents.BUNDLED_AGENTS_DIR, `${template}.md`), 'utf8');
      assert.equal(survey(template, bytes).state, 'placed', template);
    }
  });

  it('keeps the executor survey as one parameterized survey call', () => {
    const result = agents.surveyExecutorVehicle(PROJECT, {
      lstat: () => { throw missing(); },
      readdir: () => ['executor.md'],
      readFile: (path, encoding) => readFileSync(path, encoding),
    });
    assert.deepEqual(result, { state: 'missing', reason: null, rel: '.claude/agents/executor.md' });
  });
});
