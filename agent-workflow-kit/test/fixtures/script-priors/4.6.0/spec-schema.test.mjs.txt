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
