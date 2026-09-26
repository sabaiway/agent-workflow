// session-entries.test.mjs — the session-close-rules gap entry (docs/ai/specs/kit/tier/session-rules/,
// part session-gaps): it reports and never offers, and it judges each region by the reconcile's own
// pure judgement. Red first: the registry is imported dynamically; every fixture is built in its cell.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLensBody, reconcileCommsText, reconcileStoryText, renderComms, renderStory, replaceLensRegion } from '../lens-region.mjs';
import { RULES_REGIONS, buildInsertPreview, extractRegionBy, frontmatterMaxLines, readTemplateSpan } from '../rules-regions.mjs';
import { makeProject, readinessOf, runOffer } from '../tier-preview.test/harness.test.mjs';

const loaded = await import('../profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const MODULE = join(TOOLS, 'profile-gaps.mjs');
const TEMPLATE = join(TOOLS, '..', 'references', 'templates', 'agent_rules.md');
const PURITY_TEST = join(TOOLS, '..', 'test', 'read-graph-purity.test.mjs');
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const ID = 'session-close-rules';
const RULES = 'docs/ai/agent_rules.md';
const LF = String.fromCharCode(10);
const INVALID_UTF8 = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
const [COMMS, STORY] = RULES_REGIONS;
const TEMPLATE_TEXT = readFileSync(TEMPLATE, 'utf8');
const CUSTOM = { communication: 'My own communication rules.', 'story-sessions': 'My own session rules.' };
const JUDGEMENTS = { communication: reconcileCommsText, 'story-sessions': reconcileStoryText };
const RENDERS = { communication: renderComms, 'story-sessions': renderStory };
const REASON_OF = { refreshed: 'region-prior', custom: 'region-customized' };

const entryOf = () => {
  const entry = (loaded.PROFILE_GAPS ?? []).find(({ id }) => id === ID);
  assert.ok(entry, `the registry carries ${ID}`);
  return entry;
};
const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });
// Real reads through deps, each path recorded; an override maps a path to bytes or to a thrown code.
const observedDeps = (overrides = {}) => {
  const paths = [];
  const touch = (name) => () => { throw new Error(`the detector called ${name}`); };
  const deps = {
    lstatSync: (path) => { paths.push(path); return lstatSync(path); },
    readFileSync: (path, ...rest) => {
      paths.push(path);
      const override = overrides[path];
      if (override?.code) throw fsError(override.code);
      return override === undefined ? readFileSync(path, ...rest) : override;
    },
    detect: touch('detect'), surveyVehicle: touch('surveyVehicle'), writeFile: touch('writeFile'), rename: touch('rename'),
  };
  return { deps, paths };
};
const detectIn = (rules, overrides = (root) => ({})) => {
  const { root } = makeProject({ files: { [RULES]: rules } });
  const { deps, paths } = observedDeps(overrides(root));
  const result = entryOf().detect({ root, deps });
  assert.ok(!(result instanceof Promise), 'detect answers synchronously');
  return { root, result, paths };
};
const undecidable = (reason) => ({ verdict: 'undecidable', reason });

// Text builders over the bundled template: a region replaced by a body at the file's own number,
// removed, or doubled at the end of the file.
const withBody = (text, region, body) => {
  const found = extractRegionBy(text, region.headingRe);
  return replaceLensRegion(text, found, RENDERS[region.id](body, found.number));
};
const withCustom = (text, region) => {
  const found = extractRegionBy(text, region.headingRe);
  const heading = text.split(LF)[found.start];
  return replaceLensRegion(text, found, [heading, CUSTOM[region.id]].join(LF));
};
const without = (text, region) => {
  const { start, end } = extractRegionBy(text, region.headingRe);
  const lines = text.split(LF);
  return [...lines.slice(0, start), ...lines.slice(end)].join(LF);
};
const doubled = (text, region) => {
  const { start, end } = extractRegionBy(text, region.headingRe);
  return [text, ...text.split(LF).slice(start, end)].join(LF);
};
const canonOf = (region) => normalizeLensBody(readTemplateSpan(TEMPLATE_TEXT, region.headingRe).span);
const expectedFor = (text, region) => {
  const { status } = JUDGEMENTS[region.id](text, canonOf(region), region.priors);
  return status === 'current' ? { verdict: 'present' } : undecidable(REASON_OF[status]);
};

describe('spec:session-rules/S11 the session-close-rules detector reports and never offers', () => {
  it('answers template when the bundled template cannot be read or carries a doubled heading', () => {
    assert.deepEqual(detectIn(TEMPLATE_TEXT, () => ({ [TEMPLATE]: { code: 'EACCES' } })).result, undecidable('template'));
    const twice = doubled(TEMPLATE_TEXT, STORY);
    assert.deepEqual(detectIn(TEMPLATE_TEXT, () => ({ [TEMPLATE]: twice })).result, undecidable('template'));
  });

  for (const [reason, name, rules, overrides] of [
    ['file-absent', 'no rules file', null],
    ['file-symlink', 'a symlinked rules file', { kind: 'symlink', text: TEMPLATE_TEXT }],
    ['file-unreadable', 'a directory at the rules path', { kind: 'directory' }],
    ['file-unreadable', 'rules bytes that are not UTF-8', INVALID_UTF8],
    ['file-unreadable', 'a failed read', TEMPLATE_TEXT, (root) => ({ [resolve(root, RULES)]: { code: 'EIO' } })],
  ]) {
    it(`answers ${reason} by the story detector's name for ${name}`, () => {
      assert.deepEqual(detectIn(rules, overrides).result, undecidable(reason));
    });
  }

  for (const [name, build] of [
    ['a doubled Communication heading', () => doubled(TEMPLATE_TEXT, COMMS)],
    ['a doubled Story sessions heading', () => doubled(TEMPLATE_TEXT, STORY)],
    ['Communication on a prior with the Story sessions heading doubled', () => doubled(withBody(TEMPLATE_TEXT, COMMS, COMMS.priors[0]), STORY)],
  ]) {
    it(`answers heading-twice for ${name}`, () => {
      assert.deepEqual(detectIn(build()).result, undecidable('heading-twice'));
    });
  }

  for (const [reason, name, build] of [
    ['communication-absent', 'no Communication region', () => without(TEMPLATE_TEXT, COMMS)],
    ['communication-absent', 'neither region', () => without(without(TEMPLATE_TEXT, STORY), COMMS)],
    ['story-sessions-absent', 'no Story sessions region', () => without(TEMPLATE_TEXT, STORY)],
    ['region-prior', 'Communication on its oldest prior', () => withBody(TEMPLATE_TEXT, COMMS, COMMS.priors[0])],
    ['region-customized', 'a custom Communication body', () => withCustom(TEMPLATE_TEXT, COMMS)],
    ['region-prior', 'Story sessions on its prior', () => withBody(TEMPLATE_TEXT, STORY, STORY.priors[0])],
    ['region-customized', 'a custom Story sessions body', () => withCustom(TEMPLATE_TEXT, STORY)],
    ['region-customized', 'a custom Communication beside a Story sessions prior', () => withBody(withCustom(TEMPLATE_TEXT, COMMS), STORY, STORY.priors[0])],
    ['region-prior', 'a Communication prior beside a custom Story sessions', () => withCustom(withBody(TEMPLATE_TEXT, COMMS, COMMS.priors[0]), STORY)],
  ]) {
    it(`answers ${reason} for ${name}, Communication judged first`, () => {
      assert.deepEqual(detectIn(build()).result, undecidable(reason));
    });
  }

  it('answers present, and nothing else, when both regions are current', () => {
    const { result, root, paths } = detectIn(TEMPLATE_TEXT);
    assert.deepEqual(result, { verdict: 'present' });
    assert.ok(paths.includes(resolve(root, RULES)), 'the rules file is read through deps');
    assert.ok(paths.includes(TEMPLATE), 'the bundled template is read through deps');
  });

  it('applies the rules-insert preview line, the empty answer in the no-command cell', () => {
    const { root } = makeProject();
    assert.equal(entryOf().apply(root), buildInsertPreview(root));
    const { root: backtick } = makeProject({ name: `pro${String.fromCharCode(96)}ject` });
    assert.equal(entryOf().apply(backtick), '');
  });

  it('is never offered by the tier step, so its apply line never prints', async () => {
    for (const [rules, line] of [
      [TEMPLATE_TEXT, `${ID}: present`],
      [withCustom(TEMPLATE_TEXT, COMMS), `${ID}: undecidable — region-customized`],
    ]) {
      const { root } = makeProject({ files: { [RULES]: rules } });
      const run = await runOffer(root, [], readinessOf());
      assert.equal(run.code, 0, run.stderr);
      const at = run.lines.indexOf(line);
      assert.ok(at >= 0, run.stdout);
      assert.ok(!(run.lines[at + 1] ?? '').startsWith('  apply:'), run.stdout);
    }
  });
});

describe('spec:session-rules/S12 the detector and the lens step agree', () => {
  for (const [region, other] of [[COMMS, STORY], [STORY, COMMS]]) {
    it(`agrees with the pure judgement for every ${region.id} body while ${other.id} is current`, () => {
      const bodies = [
        ['the canon', TEMPLATE_TEXT],
        ...region.priors.map((prior, index) => [`prior ${index}`, withBody(TEMPLATE_TEXT, region, prior)]),
        ['a custom body', withCustom(TEMPLATE_TEXT, region)],
      ];
      assert.ok(region.priors.length > 0, `${region.id} carries a prior`);
      for (const [name, text] of bodies) {
        assert.deepEqual(detectIn(text).result, expectedFor(text, region), name);
      }
    });
  }

  it('answers region-prior for a prior whose refresh the file cap would refuse, which it does not judge', () => {
    const text = withBody(TEMPLATE_TEXT.replace('maxLines: 150', 'maxLines: 10'), COMMS, COMMS.priors[0]);
    assert.ok(frontmatterMaxLines(text) < text.split(LF).length, 'the fixture is over its own cap');
    assert.deepEqual(detectIn(text).result, undecidable('region-prior'));
  });
});

describe('the import closure of the gap registry', () => {
  it('imports the lens-region judgements and reaches no write module', () => {
    const listed = readFileSync(PURITY_TEST, 'utf8').match(WRITE_MODULES_RE);
    assert.ok(listed, 'read-graph-purity.test.mjs declares WRITE_MODULES');
    const writers = [...listed[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(writers.includes('atomic-write.mjs'), 'the write-module list is not vacuous');
    const seen = new Set();
    const queue = [MODULE];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) queue.push(resolve(dirname(file), match[1]));
    }
    const names = [...seen].map((file) => relative(TOOLS, file));
    assert.ok(names.includes('lens-region.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
  });
});
