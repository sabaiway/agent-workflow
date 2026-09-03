import { describe, it } from 'node:test';
import { expect } from './_expect-shim.mjs';

// Dynamic import: the suite LOADS without the module (red-proof observes it failing pre-fix).
const reader = await import('./spec-schema.mjs').catch(() => ({}));
const { readSpecDocument, classifyPath, SPEC_SCHEMA, SPECS_COLLAPSE } = reader;

// Inline fixtures ONLY — this suite runs inside a deployed project's scripts/ where no corpus exists.
// The repo-only corpus (engine test/fixtures/specs) is the durable record; this is the unit pin.

const frontmatter = (fields) =>
  `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n`;

const SUBSTRATE = { type: 'spec', lastUpdated: '2026-08-23', scope: 'permanent', staleAfter: '90d', owner: 'none' };
const UPLINK_LINE = '> Up: [technical_specification.md](../technical_specification.md)';

const specDoc = ({ fields = {}, drop = [], title = '# Spec: Login', scenarios, outOfScope = '- Password reset', module = '- src/login/', extra = '' } = {}) => {
  const all = { ...SUBSTRATE, maxLines: '150', kind: 'spec', status: 'draft', revision: '1', ...fields };
  for (const key of drop) delete all[key];
  const lines = scenarios ?? ['- S1 happy path :: test/login.test.mjs :: spec:login/S1', '- S2 lockout :: unbound'];
  return `${frontmatter(all)}\n${title}\n\n## Contract\n\nAccepts a credential pair.\n\n## Scenarios\n\n${lines.join('\n')}\n\n## Out of scope\n\n${outOfScope}\n\n## Module\n\n${module}\n${extra}`;
};

const indexDoc = ({ fields = {}, children = ['- [login](./login.md)', '- [billing](./billing/index.md)'], preamble = '', title = '# Auth' } = {}) =>
  `${frontmatter({ ...SUBSTRATE, maxLines: '80', kind: 'index', ...fields })}\n${title}\n${preamble}\n## Children\n\n${children.join('\n')}\n`;

const partDoc = ({ fields = {}, title = '# Part: Sessions', extra = '' } = {}) =>
  `${frontmatter({ ...SUBSTRATE, maxLines: '150', kind: 'part', ...fields })}\n${title}\n\nSession details.\n${extra}`;

const rulesOf = (verdict) => verdict.errors.map((e) => e.rule);
const refuses = (text, rel, rule) => {
  const verdict = readSpecDocument(text, rel);
  expect(rulesOf(verdict)).toEqual([rule]);
};
const withContract = (contract) => specDoc().replace('Accepts a credential pair.', contract);
const openListErrors = (contract, rel = 'login.md') => readSpecDocument(withContract(contract), rel).errors;

describe('readSpecDocument — accept', () => {
  it('a flat draft spec reads clean with kind/status/revision', () => {
    const verdict = readSpecDocument(specDoc(), 'login.md');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([]);
    expect({ kind: verdict.kind, status: verdict.status, revision: verdict.revision }).toEqual({ kind: 'spec', status: 'draft', revision: 1 });
  });

  it('a promoted root under <slug>/index.md with ## Parts and ## Links reads clean', () => {
    const text = specDoc({ extra: '\n## Parts\n\n- [sessions](./sessions.md)\n\n## Links\n\n- [[AD-112]]\n' });
    expect(readSpecDocument(text, 'auth/login/index.md').errors).toEqual([]);
  });

  it('a domain index, the store root (with the up-link) and a part read clean', () => {
    expect(readSpecDocument(indexDoc(), 'auth/index.md').errors).toEqual([]);
    const root = indexDoc({ preamble: `\n${UPLINK_LINE}\n`, children: [] });
    const rootVerdict = readSpecDocument(root, 'index.md');
    expect(rootVerdict.errors).toEqual([]);
    expect(rootVerdict.kind).toBe('index');
    expect(readSpecDocument(partDoc(), 'auth/login/sessions.md').errors).toEqual([]);
  });

  it('a retired spec may carry *(empty)* as its module; a live spec with an unbound scenario WARNS, never refuses', () => {
    const retired = specDoc({ fields: { status: 'retired' }, module: '*(empty)*', scenarios: ['- S1 gone :: unbound'] });
    expect(readSpecDocument(retired, 'login.md').errors).toEqual([]);
    const live = readSpecDocument(specDoc({ fields: { status: 'live', revision: '3' } }), 'login.md');
    expect(live.errors).toEqual([]);
    expect(live.warnings.map((w) => w.rule)).toEqual(['unbound']);
  });

  it('CRLF line endings read identically', () => {
    expect(readSpecDocument(specDoc().replace(/\n/g, '\r\n'), 'login.md').errors).toEqual([]);
  });

  it('*(empty)* is a legal Out of scope; a file-list module is legal', () => {
    const text = specDoc({ outOfScope: '*(empty)*', module: '- src/a.mjs\n- src/b.mjs' });
    expect(readSpecDocument(text, 'login.md').errors).toEqual([]);
  });
});

describe('readSpecDocument — refuse, exactly one rule per defect', () => {
  it('frontmatter / substrate-key / type / kind / maxlines', () => {
    refuses('# Spec: Login\n', 'login.md', 'frontmatter');
    refuses(specDoc({ drop: ['owner'] }), 'login.md', 'substrate-key');
    refuses(specDoc({ fields: { type: 'reference' } }), 'login.md', 'type');
    refuses(specDoc({ fields: { kind: 'feature' } }), 'login.md', 'kind');
    refuses(specDoc({ drop: ['kind'] }), 'login.md', 'kind');
    refuses(specDoc({ fields: { maxLines: '400' } }), 'login.md', 'maxlines');
  });

  it('status / revision / root-owns', () => {
    refuses(specDoc({ fields: { status: 'approved' } }), 'login.md', 'status');
    refuses(specDoc({ drop: ['status'] }), 'login.md', 'status');
    refuses(specDoc({ fields: { revision: '0' } }), 'login.md', 'revision');
    refuses(specDoc({ fields: { revision: '1.5' } }), 'login.md', 'revision');
    refuses(indexDoc({ fields: { status: 'draft' } }), 'auth/index.md', 'root-owns');
    refuses(partDoc({ fields: { revision: '2' } }), 'auth/login/sessions.md', 'root-owns');
  });

  it('slug / kind-path / root-uplink', () => {
    refuses(specDoc({ scenarios: ['- S1 x :: unbound'] }), 'Login_Page.md', 'slug');
    refuses(indexDoc(), 'auth/Auth Stuff/index.md', 'slug');
    refuses(indexDoc(), 'auth/overview.md', 'kind-path');
    refuses(partDoc(), 'auth/login/index.md', 'kind-path');
    refuses(specDoc({ scenarios: ['- S1 x :: unbound'] }), 'index.md', 'kind-path');
    refuses(indexDoc({ children: [] }), 'index.md', 'root-uplink');
  });

  it('title / section-missing / section-order / section-forbidden', () => {
    refuses(specDoc({ title: '# Login' }), 'login.md', 'title');
    refuses(specDoc({ title: '# Spec:   ' }), 'login.md', 'title');
    refuses(partDoc({ title: '# Sessions' }), 'auth/login/sessions.md', 'title');
    refuses(specDoc().replace('## Out of scope', '## Out-of-scope'), 'login.md', 'section-missing');
    refuses(specDoc().replace('## Contract\n\nAccepts a credential pair.\n\n', '').concat('\n## Contract\n\nlate\n'), 'login.md', 'section-order');
    refuses(indexDoc().concat('\n## Module\n\n- src/\n'), 'auth/index.md', 'section-forbidden');
    refuses(partDoc({ extra: '\n## Scenarios\n\n- S1 x :: unbound\n' }), 'auth/login/sessions.md', 'section-forbidden');
  });

  it('children-link / children-duplicate / fan-out', () => {
    refuses(indexDoc({ children: ['- login'] }), 'auth/index.md', 'children-link');
    refuses(indexDoc({ children: ['- [login](../login.md)'] }), 'auth/index.md', 'children-link');
    refuses(indexDoc({ children: ['- [login](./login.md)', '- [login again](./login.md)'] }), 'auth/index.md', 'children-duplicate');
    const many = Array.from({ length: SPEC_SCHEMA.fanOutMax + 1 }, (_, i) => `- [c${i}](./c${i}.md)`);
    refuses(indexDoc({ children: many }), 'auth/index.md', 'fan-out');
    expect(readSpecDocument(indexDoc({ children: many.slice(0, SPEC_SCHEMA.fanOutMax) }), 'auth/index.md').errors).toEqual([]);
  });

  it('scenario-line / scenario-number / scenario-marker / scenario-path', () => {
    refuses(specDoc({ scenarios: ['- S1 no binding'] }), 'login.md', 'scenario-line');
    refuses(specDoc({ scenarios: ['S1 happy :: unbound'] }), 'login.md', 'scenario-line');
    refuses(specDoc({ scenarios: ['- S1 a :: unbound', '- S3 b :: unbound'] }), 'login.md', 'scenario-number');
    refuses(specDoc({ scenarios: ['- S2 a :: unbound'] }), 'login.md', 'scenario-number');
    refuses(specDoc({ scenarios: ['- S1 a :: test/login.test.mjs :: spec:login/S2'] }), 'login.md', 'scenario-marker');
    refuses(specDoc({ scenarios: ['- S1 a :: test/login.test.mjs :: spec:signup/S1'] }), 'login.md', 'scenario-marker');
    refuses(specDoc({ scenarios: ['- S1 a :: ../test/login.test.mjs :: spec:login/S1'] }), 'login.md', 'scenario-path');
    refuses(specDoc({ scenarios: ['- S1 a :: /abs/login.test.mjs :: spec:login/S1'] }), 'login.md', 'scenario-path');
  });

  it('scenarios-empty / no empty-marker escape', () => {
    refuses(specDoc({ scenarios: [] }), 'login.md', 'scenarios-empty');
    refuses(specDoc({ scenarios: ['*(empty)*'] }), 'login.md', 'scenario-line');
    for (const status of SPEC_SCHEMA.statuses) {
      expect(readSpecDocument(specDoc({ scenarios: ['- S1 x :: unbound'], fields: { status } }), 'login.md').errors).toEqual([]);
    }
  });

  it('out-of-scope / module-empty / module-* path refusals / module-mix / parts', () => {
    refuses(specDoc({ outOfScope: '' }), 'login.md', 'out-of-scope');
    refuses(specDoc({ outOfScope: 'nothing excluded' }), 'login.md', 'out-of-scope');
    refuses(specDoc({ outOfScope: '- ' }), 'login.md', 'out-of-scope');
    refuses(specDoc({ module: '' }), 'login.md', 'module-empty');
    refuses(specDoc({ module: '*(empty)*' }), 'login.md', 'module-empty');
    refuses(specDoc({ module: '- ../src/' }), 'login.md', 'module-traversal');
    refuses(specDoc({ module: '- /src/login/' }), 'login.md', 'module-absolute');
    refuses(specDoc({ module: '- C:/src/login/' }), 'login.md', 'module-absolute');
    refuses(specDoc({ module: '- src\\login\\' }), 'login.md', 'module-backslash');
    refuses(specDoc({ module: '- src/**/*.mjs' }), 'login.md', 'module-glob');
    refuses(specDoc({ module: '- src/login/\n- src/login/a.mjs' }), 'login.md', 'module-mix');
    refuses(specDoc({ module: '- src/login/\n- src/signup/' }), 'login.md', 'module-mix');
    refuses(specDoc({ extra: '\n## Parts\n\n- [sessions](./sessions.md)\n' }), 'login.md', 'parts');
    refuses(specDoc({ extra: '\n## Parts\n\n- sessions\n' }), 'auth/login/index.md', 'parts');
    refuses(specDoc({ extra: '\n## Parts\n\n- [a](./a.md)\n- [b](./a.md)\n' }), 'auth/login/index.md', 'parts');
  });

  it('frontmatter-key: an unknown key, a duplicate key and a malformed line each refuse; an absent type is substrate-key ALONE', () => {
    refuses(specDoc({ fields: { priority: 'high' } }), 'login.md', 'frontmatter-key');
    refuses(specDoc().replace('owner: none\n', 'owner: none\nowner: none\n'), 'login.md', 'frontmatter-key');
    refuses(specDoc().replace('owner: none\n', 'owner: none\n- a list item\n'), 'login.md', 'frontmatter-key');
    refuses(specDoc({ drop: ['type'] }), 'login.md', 'substrate-key');
  });

  it('a part at the store root (no folder) is kind-path; a blank binding path is scenario-path; a blank module bullet is module-empty', () => {
    refuses(partDoc(), 'orphan.md', 'kind-path');
    refuses(specDoc({ scenarios: ['- S1 a ::  :: spec:login/S1'] }), 'login.md', 'scenario-path');
    refuses(specDoc({ module: '- ' }), 'login.md', 'module-empty');
  });

  it('module-line: prose beside a module bullet refuses; root-uplink needs the exact markdown link, not a mention', () => {
    refuses(specDoc({ module: 'the root is\n- src/login/' }), 'login.md', 'module-line');
    refuses(indexDoc({ preamble: '\nSee technical_specification.md for the top spec.\n', children: [] }), 'index.md', 'root-uplink');
    expect(readSpecDocument(indexDoc({ preamble: `\n${UPLINK_LINE}\n`, children: [] }), 'index.md').errors).toEqual([]);
  });

  it('the reader parses no markdown code: a fence line refuses `fence`; the up-link is a whole exact line, so an inline span or a trailing note is root-uplink', () => {
    refuses(indexDoc({ preamble: `\n${UPLINK_LINE}\n\n\`\`\`\n${UPLINK_LINE}\n\`\`\`\n`, children: [] }), 'index.md', 'fence');
    refuses(partDoc({ extra: '\n~~~js\nconst sample = 1;\n~~~\n' }), 'auth/login/sessions.md', 'fence');
    refuses(indexDoc({ preamble: `\nWrite \`\`${UPLINK_LINE}\`\` here.\n`, children: [] }), 'index.md', 'root-uplink');
    refuses(indexDoc({ preamble: `\n${UPLINK_LINE} — the top spec\n`, children: [] }), 'index.md', 'root-uplink');
  });

  it('a frontmatter defect ENDS the read with frontmatter-key alone (a malformed kind line is not a missing kind)', () => {
    refuses(specDoc().replace('kind: spec\n', 'kind spec\n'), 'login.md', 'frontmatter-key');
    refuses(specDoc({ fields: { priority: 'high', kind: 'feature' } }), 'login.md', 'frontmatter-key');
  });

  it('the title precedes every section; prose-only Module is module-line; a blank Module on a retired spec is module-empty', () => {
    refuses(specDoc().replace('# Spec: Login\n', '## Surprise\n\nx\n\n# Spec: Login\n'), 'login.md', 'title');
    refuses(specDoc({ module: 'the root is src' }), 'login.md', 'module-line');
    refuses(specDoc({ fields: { status: 'retired' }, module: '' }), 'login.md', 'module-empty');
  });

  it('every rule id a refusal names is declared in SPEC_SCHEMA.rules', () => {
    for (const rule of ['frontmatter', 'frontmatter-key', 'fence', 'kind', 'module-mix', 'module-line', 'scenario-path', 'parts', 'root-uplink']) {
      expect(SPEC_SCHEMA.rules.includes(rule)).toBe(true);
    }
    expect(new Set(SPEC_SCHEMA.rules).size).toBe(SPEC_SCHEMA.rules.length);
  });
});

describe('readSpecDocument — the structure verdict (additive, slice 2a)', () => {
  const structureOf = (text, rel) => readSpecDocument(text, rel).structure;
  const BOTH_SCENARIOS = [
    { ordinal: 1, binding: { file: 'test/login.test.mjs', marker: 'spec:login/S1' } },
    { ordinal: 2, binding: null },
  ];

  it('a flat spec extracts scenarios (bound + unbound) and its one dir/ module root', () => {
    expect(structureOf(specDoc(), 'login.md')).toEqual({
      scenarios: BOTH_SCENARIOS,
      children: [],
      parts: [],
      module: { form: 'root', paths: ['src/login/'] },
    });
  });

  it('a promoted root extracts parts and a fileSet module; ## Links stays free prose, never extracted', () => {
    const text = specDoc({ module: '- src/a.mjs\n- src/b.mjs', extra: '\n## Parts\n\n- [sessions](./sessions.md)\n\n## Links\n\n- [[AD-112]]\n' });
    expect(structureOf(text, 'auth/login/index.md')).toEqual({
      scenarios: BOTH_SCENARIOS,
      children: [],
      parts: [{ name: 'sessions', target: './sessions.md' }],
      module: { form: 'fileSet', paths: ['src/a.mjs', 'src/b.mjs'] },
    });
  });

  it('an index extracts children with VERBATIM targets — ./x.md and ./x/index.md stay distinct strings', () => {
    expect(structureOf(indexDoc(), 'auth/index.md')).toEqual({
      scenarios: [],
      children: [{ name: 'login', target: './login.md' }, { name: 'billing', target: './billing/index.md' }],
      parts: [],
      module: null,
    });
  });

  it('a part extracts the empty structure; a retired *(empty)* module extracts null on a CLEAN document', () => {
    expect(structureOf(partDoc(), 'auth/login/sessions.md')).toEqual({ scenarios: [], children: [], parts: [], module: null });
    const retired = specDoc({ fields: { status: 'retired' }, module: '*(empty)*', scenarios: ['- S1 gone :: unbound'] });
    expect(structureOf(retired, 'login.md').module).toBeNull();
  });

  it('EVERY early refusal reads structure null: missing frontmatter, a frontmatter defect, an unknown or absent kind', () => {
    expect(structureOf('# Spec: Login\n', 'login.md')).toBeNull();
    expect(structureOf(specDoc({ fields: { priority: 'high' } }), 'login.md')).toBeNull();
    expect(structureOf(specDoc({ fields: { kind: 'feature' } }), 'login.md')).toBeNull();
    expect(structureOf(specDoc({ drop: ['kind'] }), 'login.md')).toBeNull();
  });

  it('a grammar-malformed scenario/child/part line is simply ABSENT — valid lines before and after it extract', () => {
    const s = structureOf(specDoc({ scenarios: ['- S1 a :: unbound', '- S2 broken', '- S3 c :: unbound'] }), 'login.md');
    expect(s.scenarios).toEqual([{ ordinal: 1, binding: null }, { ordinal: 3, binding: null }]);
    const c = structureOf(indexDoc({ children: ['- [a](./a.md)', '- broken', '- [b](./b/index.md)'] }), 'auth/index.md');
    expect(c.children).toEqual([{ name: 'a', target: './a.md' }, { name: 'b', target: './b/index.md' }]);
    const p = structureOf(specDoc({ extra: '\n## Parts\n\n- [a](./a.md)\n- broken\n- [b](./b.md)\n' }), 'auth/login/index.md');
    expect(p.parts).toEqual([{ name: 'a', target: './a.md' }, { name: 'b', target: './b.md' }]);
  });

  it('the module is a CONJUNCTION — prose, a refused path, a dir/file mix each extract null; a rule-refused scenario line still extracts verbatim', () => {
    for (const module of ['the root is\n- src/login/', '- ../src/', '- src/login/\n- src/login/a.mjs']) {
      expect(structureOf(specDoc({ module }), 'login.md').module).toBeNull();
    }
    const v = readSpecDocument(specDoc({ scenarios: ['- S1 a :: test/a.mjs :: spec:login/S2'] }), 'login.md');
    expect(v.errors.map((e) => e.rule)).toEqual(['scenario-marker']);
    expect(v.structure.scenarios).toEqual([{ ordinal: 1, binding: { file: 'test/a.mjs', marker: 'spec:login/S2' } }]);
  });
});

describe('readSpecDocument — open-list clauses', () => {
  const refusal = 'the clause "an anchor path reported modified, untracked…" is an open list — add a closing form to it such as "only if …; everything else …"';
  const open = '- an anchor path reported modified, untracked or ignored is the named refusal `anchor-dirty`';
  const closed = '- an anchor path is accepted only if `ls-files -v` lists it with tag `H` and `status` is silent — everything else, a path reported modified, untracked or ignored, is the named refusal `anchor-dirty`';

  it('refuses the measured clause with the exact message; verb alone, form alone and an in-clause closure pass', () => {
    expect(openListErrors(open)).toEqual([{ rule: 'open-list', message: refusal }]);
    for (const text of [closed, '- refuse one case', '- alpha, beta or gamma']) expect(openListErrors(text)).toEqual([]);
  });

  it('joins continuation lines, collapses whitespace and keeps an indented bullet in its top-level bullet', () => {
    for (const text of ['- refuse alpha,\n   beta   or ignored', '- refuse alpha,\n  - beta or ignored']) expect(rulesOf(readSpecDocument(withContract(text), 'login.md'))).toEqual(['open-list']);
  });

  it('ends a bullet at a blank, the next top-level bullet or every ATX heading; Contract prose is ignored', () => {
    for (const tail of ['\n\nEverything else closes', '\n- Everything else closes', ...Array.from({ length: 6 }, (_, i) => `\n${'#'.repeat(i + 1)} Everything else closes`)]) {
      expect(rulesOf(readSpecDocument(withContract('- refuse alpha, beta or gamma' + tail), 'login.md'))).toEqual(['open-list']);
    }
    expect(openListErrors('refuse alpha, beta or gamma')).toEqual([]);
  });

  it('ends a bullet at indented and tab-separated ATX headings', () => {
    for (const tail of ['\n   ## Everything else closes', '\n#\tEverything else closes']) expect(rulesOf(readSpecDocument(withContract('- refuse alpha, beta or gamma' + tail), 'login.md'))).toEqual(['open-list']);
  });

  it('starts a new empty top-level bullet before following prose', () => {
    for (const tail of ['\n- \nEverything else closes', '\n-\nonly if closes']) expect(rulesOf(readSpecDocument(withContract('- refuse alpha, beta or gamma' + tail), 'login.md'))).toEqual(['open-list']);
  });

  it('judges an open list in every Contract section', () => {
    const duplicate = specDoc().replace('## Scenarios', '## Contract\n\n- refuse alpha, beta or gamma\n\n## Scenarios');
    expect(rulesOf(readSpecDocument(duplicate, 'login.md')).includes('open-list')).toBe(true);
  });

  it('splits clauses at punctuation plus markdown tails, but not inside backtick spans', () => {
    for (const tail of ['.** ', '.` ', '.) ', '.] ', '; ']) expect(rulesOf(readSpecDocument(withContract(`- refuse alpha, beta or gamma${tail}Everything else closes`), 'login.md'))).toEqual(['open-list']);
    for (const text of ['- refuse `alpha. beta`, gamma or delta', '- refuse `alpha; beta`, gamma or delta', '- refuse `alpha. beta, gamma or delta']) expect(rulesOf(readSpecDocument(withContract(text), 'login.md'))).toEqual(['open-list']);
    expect(openListErrors('- refuse alpha``. beta, gamma or delta')).toEqual([]);
  });

  it('keeps span content in judgement, and a closure in a neighbouring clause cannot lift a refusal', () => {
    expect(rulesOf(readSpecDocument(withContract('- `refuse` alpha, beta or gamma'), 'login.md'))).toEqual(['open-list']);
    expect(openListErrors('- refuse alpha, beta or gamma with `everything else`')).toEqual([]);
    expect(rulesOf(readSpecDocument(withContract('- refuse alpha, beta or gamma. Everything else closes'), 'login.md'))).toEqual(['open-list']);
  });

  it('matches verbs, forms and closure tokens with the frozen case and boundary rules', () => {
    for (const verb of ['refuse', 'refuses', 'refused', 'refusal', 'refusals', 'REFUSE', 'REFUSAL']) expect(rulesOf(readSpecDocument(withContract(`- ${verb} alpha, beta or gamma`), 'login.md'))).toEqual(['open-list']);
    for (const text of ['- Refuse alpha, beta or gamma', '- refuse alpha, beta and gamma']) expect(openListErrors(text)).toEqual([]);
    expect(rulesOf(readSpecDocument(withContract('- refuse alpha · beta'), 'login.md'))).toEqual(['open-list']);
    for (const token of SPEC_SCHEMA.openList.closureTokens) expect(openListErrors(`- ${token.toUpperCase()}: refuse alpha, beta or gamma`)).toEqual([]);
    for (const text of ['- refuse alpha, beta or gamma — none of these', '- refuse alpha, beta or gamma — closed-key', '- refuse alpha, beta or gamma — READ-ONLY', '- refuse alpha, beta or gamma — if only this', '- refuse alpha, beta or gamma — not only this']) expect(rulesOf(readSpecDocument(withContract(text), 'login.md'))).toEqual(['open-list']);
    expect(openListErrors('- refuse alpha, beta or gamma — ONLY this')).toEqual([]);
  });

  it('judges every part bullet, never an index, and freezes every schema list and inner pair', () => {
    expect(rulesOf(readSpecDocument(partDoc({ extra: `\n${open}\n` }), 'auth/login/sessions.md'))).toEqual(['open-list']);
    expect(readSpecDocument(indexDoc({ children: [], preamble: `\n${open}\n` }), 'auth/index.md').errors).toEqual([]);
    expect(SPEC_SCHEMA.openList).toEqual({ checkVerbs: ['refuse', 'refusal', 'REFUSE', 'REFUSAL'], enumerationForms: [[',', ' or '], [' · ']], closureTokens: ['only if', 'only when', 'the only', 'everything else', 'anything else', 'nothing else', 'every other', 'any other', 'otherwise', 'exactly', 'one of', 'closed'], emphaticToken: 'ONLY' });
    expect([SPEC_SCHEMA.openList, SPEC_SCHEMA.openList.checkVerbs, SPEC_SCHEMA.openList.enumerationForms, ...SPEC_SCHEMA.openList.enumerationForms, SPEC_SCHEMA.openList.closureTokens].every(Object.isFrozen)).toBe(true);
  });
});

describe('classifyPath + the frozen constants', () => {
  it('classifies the lexical path forms', () => {
    expect(['src/', 'src/a.mjs', '../x', '/x', 'C:/x', 'a\\b', 'src/*.mjs'].map(classifyPath)).toEqual([
      'dir', 'file', 'traversal', 'absolute', 'absolute', 'backslash', 'glob',
    ]);
  });

  it('SPEC_SCHEMA carries the frozen numbers and SPECS_COLLAPSE joins the store root', () => {
    expect(SPEC_SCHEMA.fanOutMax).toBe(30);
    expect(SPEC_SCHEMA.maxLines).toEqual({ index: 80, spec: 150, part: 150 });
    expect(SPEC_SCHEMA.statuses).toEqual(['draft', 'live', 'retired']);
    expect(SPEC_SCHEMA.kinds).toEqual(['index', 'spec', 'part']);
    expect(Object.isFrozen(SPEC_SCHEMA)).toBe(true);
    expect(SPECS_COLLAPSE).toEqual({ prefix: 'docs/ai/specs/', navPath: 'docs/ai/specs/index.md', label: 'specs/', type: 'spec' });
  });
});
