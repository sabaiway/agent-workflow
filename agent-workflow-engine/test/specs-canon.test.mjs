import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The spec-layer canon (references/specs.md) is pinned against the deployed reader's SPEC_SCHEMA —
// the frozen values live in ONE place and the canon must name every one of them — and the repo-only
// fixture corpus is read through that reader: every accept case clean, every refuse case exactly
// its one rule. The rendered templates (the store-root navigator + the authoring reference) must read
// clean too. Reads across the monorepo (memory canon scripts + templates), like lens-mirror does.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAMILY_ROOT = join(ROOT, '..');
const MEMORY = join(FAMILY_ROOT, 'agent-workflow-memory');
const CORPUS = join(ROOT, 'test', 'fixtures', 'specs');
// Dynamic import: the suite LOADS without the canon/reader (red-proof observes it failing pre-fix).
const reader = await import(join(MEMORY, 'references', 'scripts', 'spec-schema.mjs')).catch(() => ({}));
const { readSpecDocument, SPEC_SCHEMA } = reader;
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const canon = readOr(join(ROOT, 'references', 'specs.md'));
const flat = canon.replace(/\s+/g, ' ');

const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const rulesOf = (file, base) => readSpecDocument(readFileSync(file, 'utf8'), relative(base, file).split('\\').join('/')).errors.map((e) => e.rule);
const render = (template) => template.replace(/\{\{DATE\}\}/g, '2026-08-23');

describe('specs.md — the canon carries the frozen schema the reader enforces', () => {
  it('names every status, kind, cap and threshold from SPEC_SCHEMA (no second source of the numbers)', () => {
    for (const status of SPEC_SCHEMA.statuses) assert.match(flat, new RegExp(`\`${status}\``), `status ${status}`);
    for (const kind of SPEC_SCHEMA.kinds) {
      // each "Shape per kind" bullet names ITS kind's cap — per kind, never a shared sentence
      assert.match(flat, new RegExp(`\\*\\*\`${kind}\`\\*\\* — frontmatter:[^*]*\\(\\+ \`maxLines: ${SPEC_SCHEMA.maxLines[kind]}\`\\)`), `the ${kind} shape carries maxLines: ${SPEC_SCHEMA.maxLines[kind]}`);
    }
    assert.match(flat, new RegExp(`at most ${SPEC_SCHEMA.fanOutMax} immediate children`));
    assert.match(flat, new RegExp(`over its own \`maxLines: ${SPEC_SCHEMA.maxLines.spec}\``), 'promotion trigger = the spec cap');
    assert.ok(canon.includes(`\`${SPEC_SCHEMA.slugPattern}\``), 'the slug pattern verbatim');
    const forms = SPEC_SCHEMA.scenarioGrammar.split('  |  ');
    assert.equal(forms.length, 2, 'sanity: the grammar names the bound and the unbound form');
    for (const form of forms) assert.ok(canon.includes(`\`${form}\``), `the scenario form ${form} verbatim`);
    assert.ok(canon.includes(`\`${SPEC_SCHEMA.emptyMarker}\``), 'the empty marker');
    assert.ok(canon.includes(SPEC_SCHEMA.upLink), 'the store-root up-link target');
  });

  it('states the forward-only transitions, root-owns, the module grammar, the advisory unbound warning', () => {
    for (const [from, to] of SPEC_SCHEMA.transitions) assert.match(flat, new RegExp(`${from} -> ${to}`), `transition ${from} -> ${to}`);
    assert.match(flat, /never backwards/);
    assert.match(flat, /ride ONLY on `kind: spec`/, 'root-owns');
    assert.match(flat, /ONE `dir\/` root OR a literal file list/);
    assert.match(flat, /an advisory warning, never a refusal/);
    assert.match(flat, /at least one non-blank bullet, or exactly `\*\(empty\)\*`/);
    assert.match(flat, /\| `out-of-scope` \| no non-blank bullet and not exactly `\*\(empty\)\*` \|/);
  });

  it('carries the complete precedence table (feature spec vs page spec) and the honest enforcement altitude', () => {
    assert.match(flat, /\| present \| present \| the feature spec;/);
    assert.match(flat, /\| absent \| present \| the page spec, as an ADOPTION SHIM/);
    assert.match(flat, /\| present \| absent \| the feature spec \|/);
    assert.match(flat, /REVIEW-level canon defaults/, 'D8 enforcement altitude');
    assert.match(flat, /## Retroactive coverage/, 'D7 onboarding path');
    assert.match(flat, /1500 ms for both hook runs over a valid 1000-spec/, 'the D-scale budget');
  });

  it('lists every reader rule id in its refusals table — and no rule the reader does not issue', () => {
    const table = canon.split('## Refusals')[1]?.split('\n## ')[0] ?? '';
    const listed = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(listed, [...SPEC_SCHEMA.rules], 'the table rows ARE the rule list, in order');
  });

  it('non-vacuity: stripping a frozen value from an in-memory copy goes red (injected)', () => {
    for (const token of ['`retired`', '`*(empty)*`', 'never backwards']) {
      assert.ok(canon.includes(token), `sanity: the canon carries ${token}`);
      assert.ok(!canon.split(token).join('REDACTED').includes(token), `the check must go RED when ${token} is removed`);
    }
  });
});

describe('the fixture corpus read through the reader', () => {
  const acceptCases = readdirSync(join(CORPUS, 'accept'));
  const refuseRules = readdirSync(join(CORPUS, 'refuse'));

  it('every accept case reads clean (at least one per kind; >= 7 cases)', () => {
    assert.ok(acceptCases.length >= 7, `${acceptCases.length} accept cases`);
    const kinds = new Set();
    for (const caseName of acceptCases) {
      const base = join(CORPUS, 'accept', caseName);
      for (const file of walk(base)) {
        const verdict = readSpecDocument(readFileSync(file, 'utf8'), relative(base, file).split('\\').join('/'));
        assert.deepEqual(verdict.errors, [], `accept/${caseName}/${relative(base, file)} reads clean`);
        kinds.add(verdict.kind);
      }
    }
    assert.deepEqual([...kinds].sort(), [...SPEC_SCHEMA.kinds].sort(), 'every kind has an accept fixture');
  });

  it('every refuse fixture yields EXACTLY its folder rule; every reader rule has a fixture; no unknown folder', () => {
    assert.ok(refuseRules.length >= 20, `${refuseRules.length} refuse rules`);
    assert.deepEqual(refuseRules.filter((rule) => !SPEC_SCHEMA.rules.includes(rule)), [], 'no refuse folder outside the rule list');
    assert.deepEqual(SPEC_SCHEMA.rules.filter((rule) => !refuseRules.includes(rule)), [], 'every rule has a refuse folder');
    for (const rule of refuseRules) {
      for (const caseName of readdirSync(join(CORPUS, 'refuse', rule))) {
        const base = join(CORPUS, 'refuse', rule, caseName);
        for (const file of walk(base)) assert.deepEqual(rulesOf(file, base), [rule], `refuse/${rule}/${caseName}/${relative(base, file)}`);
      }
    }
  });

  it('the live-unbound accept case WARNS (advisory), the CRLF case reads like its LF twin', () => {
    const live = readSpecDocument(readFileSync(join(CORPUS, 'accept', 'live-unbound-warns', 'login.md'), 'utf8'), 'login.md');
    assert.deepEqual(live.warnings.map((w) => w.rule), ['unbound']);
    const crlf = readFileSync(join(CORPUS, 'accept', 'crlf', 'login.md'), 'utf8');
    assert.ok(crlf.includes('\r\n'), 'sanity: the CRLF fixture really carries CRLF');
    assert.deepEqual(readSpecDocument(crlf, 'login.md'), readSpecDocument(crlf.replace(/\r\n/g, '\n'), 'login.md'));
  });
});

describe('the shipped templates read clean through the reader', () => {
  it('the store-root navigator template (rendered) is a clean kind: index at the store root', () => {
    const text = render(readOr(join(MEMORY, 'references', 'templates', 'specs', 'index.md')));
    const verdict = readSpecDocument(text, 'index.md');
    assert.deepEqual(verdict.errors, []);
    assert.equal(verdict.kind, 'index');
  });

  it('the authoring reference SPEC_TEMPLATE.md (rendered) is a clean draft spec with one bound + one unbound scenario', () => {
    const text = render(readOr(join(MEMORY, 'references', 'templates', 'SPEC_TEMPLATE.md')));
    const verdict = readSpecDocument(text, 'example-feature.md');
    assert.deepEqual(verdict.errors, []);
    assert.deepEqual({ kind: verdict.kind, status: verdict.status, revision: verdict.revision }, { kind: 'spec', status: 'draft', revision: 1 });
    assert.match(text, /:: spec:example-feature\/S1$/m, 'a bound scenario');
    assert.match(text, /:: unbound$/m, 'an unbound scenario');
  });
});
