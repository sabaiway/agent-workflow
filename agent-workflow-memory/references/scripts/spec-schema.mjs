#!/usr/bin/env node
// spec-schema.mjs — the ONE reader that DEFINES a well-formed spec document under docs/ai/specs/.
//
// Pure text in, verdict out: readSpecDocument(text, rel) never touches the filesystem and imports
// nothing, so it seeds layout-free into any deployment. The navigator's collapse (check-docs-size.mjs)
// and the future spec-check read through THIS module — "malformed" has one definition, never two.
// `rel` is the path INSIDE docs/ai/specs/ (the store root navigator is `index.md`).
//
// SPEC_SCHEMA carries the frozen values; the engine canon (references/specs.md) is pinned against it.
// A refusal names exactly one rule id per defect, so a fixture corpus can be read rule by rule.

export const SPEC_SCHEMA = Object.freeze({
  storePrefix: 'docs/ai/specs/',
  navigatorFile: 'index.md',
  upLink: 'technical_specification.md',
  upLinkLine: '> Up: [technical_specification.md](../technical_specification.md)',
  type: 'spec',
  substrateKeys: Object.freeze(['type', 'lastUpdated', 'scope', 'staleAfter', 'owner', 'maxLines']),
  kinds: Object.freeze(['index', 'spec', 'part']),
  statuses: Object.freeze(['draft', 'live', 'retired']),
  transitions: Object.freeze([Object.freeze(['draft', 'live']), Object.freeze(['live', 'retired'])]),
  maxLines: Object.freeze({ index: 80, spec: 150, part: 150 }),
  fanOutMax: 30,
  slugPattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  emptyMarker: '*(empty)*',
  unboundMarker: 'unbound',
  titlePrefix: Object.freeze({ index: '# ', spec: '# Spec: ', part: '# Part: ' }),
  requiredSections: Object.freeze({
    index: Object.freeze(['## Children']),
    spec: Object.freeze(['## Contract', '## Scenarios', '## Out of scope', '## Module']),
    part: Object.freeze([]),
  }),
  optionalSections: Object.freeze({ spec: Object.freeze(['## Parts', '## Links']) }),
  rootOwnedKeys: Object.freeze(['status', 'revision']),
  rootOwnedSections: Object.freeze(['## Scenarios', '## Out of scope', '## Module', '## Parts']),
  scenarioGrammar: '- S<N> <name> :: <repo-relative test path> :: spec:<slug>/S<N>  |  - S<N> <name> :: unbound',
  rules: Object.freeze([
    'frontmatter', 'frontmatter-key', 'substrate-key', 'type', 'kind', 'maxlines', 'status', 'revision',
    'root-owns', 'slug', 'kind-path', 'root-uplink', 'title', 'section-missing', 'section-order',
    'section-forbidden', 'fence', 'children-link', 'children-duplicate', 'fan-out', 'scenario-line',
    'scenario-number', 'scenario-marker', 'scenario-path', 'out-of-scope', 'module-line', 'module-empty',
    'module-traversal', 'module-absolute', 'module-backslash', 'module-glob', 'module-mix', 'parts',
  ]),
});

// The descriptor check-docs-size.mjs joins to its ADR group: rows under `prefix` whose reader verdict
// is clean collapse into ONE navigator row linking `navPath`; a row with reader errors stays visible.
export const SPECS_COLLAPSE = Object.freeze({
  prefix: SPEC_SCHEMA.storePrefix,
  navPath: `${SPEC_SCHEMA.storePrefix}${SPEC_SCHEMA.navigatorFile}`,
  label: 'specs/',
  type: SPEC_SCHEMA.type,
});

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const FIELD_RE = /^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/;
const SLUG_RE = new RegExp(SPEC_SCHEMA.slugPattern);
const REVISION_RE = /^[1-9][0-9]*$/;
const CHILD_LINK_RE = /^- \[([^\]]+)\]\(\.\/([^/)]+)(\/index)?\.md\)$/;
const PART_LINK_RE = /^- \[([^\]]+)\]\(\.\/([^/)]+)\.md\)$/;
const SCENARIO_HEAD_RE = /^S([0-9]+) (.+)$/;
const GLOB_RE = /[*?[\]{}]/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const SEPARATOR = ' :: ';
const MD_SUFFIX = '.md';

const FORBIDDEN_SECTIONS = Object.freeze({
  index: SPEC_SCHEMA.rootOwnedSections,
  spec: Object.freeze(['## Children']),
  part: Object.freeze([...SPEC_SCHEMA.rootOwnedSections, '## Children']),
});

const KNOWN_KEYS = Object.freeze([...SPEC_SCHEMA.substrateKeys, 'kind', ...SPEC_SCHEMA.rootOwnedKeys]);

// The frontmatter is a closed key set: an unknown key, a repeated key or a line that is not
// `key: value` is a defect (`frontmatter-key`), never silently dropped or last-one-wins.
const parseFrontmatter = (text) => {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  const fields = {};
  const defects = [];
  for (const line of match[1].split('\n')) {
    const m = line.match(FIELD_RE);
    if (!m) defects.push(`"${line}" is not \`key: value\``);
    else if (!KNOWN_KEYS.includes(m[1])) defects.push(`unknown key ${m[1]}`);
    else if (m[1] in fields) defects.push(`duplicate key ${m[1]}`);
    else fields[m[1]] = m[2].trim();
  }
  return { fields, defects, body: text.slice(match[0].length) };
};

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// The body as { title, sections: [{ heading, lines }], preamble, fenced } — the title is the FIRST
// `# ` line, every `## ` line opens a section, the lines before the first section are the preamble.
// The reader parses NO markdown code: a fence line is recorded (the `fence` refusal) rather than
// modelled, so a spec carries no code sample and no line is ever ambiguous between code and structure.
const parseBody = (body) => {
  const sections = [];
  const preamble = [];
  const fenced = [];
  const state = { title: null, current: null };
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (FENCE_RE.test(line)) fenced.push(line);
    if (line.startsWith('## ')) {
      state.current = { heading: line, lines: [] };
      sections.push(state.current);
    } else if (state.title === null && line.startsWith('# ')) {
      state.title = line;
    } else {
      (state.current ? state.current.lines : preamble).push(line);
    }
  }
  return { title: state.title, sections, preamble, fenced };
};

// Lexical classification of a repo-relative path field — the same vocabulary for module roots and
// scenario bindings. Realpath/symlink containment needs the filesystem and is the checker's duty.
export const classifyPath = (path) => {
  if (path.trim() === '') return 'empty';
  if (path.includes('\\')) return 'backslash';
  if (path.startsWith('/') || WINDOWS_DRIVE_RE.test(path)) return 'absolute';
  if (path.split('/').includes('..')) return 'traversal';
  if (GLOB_RE.test(path)) return 'glob';
  return path.endsWith('/') ? 'dir' : 'file';
};

const MODULE_PATH_RULES = Object.freeze({
  empty: 'module-empty',
  backslash: 'module-backslash',
  absolute: 'module-absolute',
  traversal: 'module-traversal',
  glob: 'module-glob',
});

const bulletsOf = (lines) => lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
const contentOf = (lines) => lines.filter((line) => line.trim() !== '');

// The slug a document owns: the file stem for a flat file, the folder name for an index.md.
const describeRel = (rel) => {
  const segments = rel.split('/');
  const file = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const stem = file.endsWith(MD_SUFFIX) ? file.slice(0, -MD_SUFFIX.length) : file;
  const isIndexFile = file === SPEC_SCHEMA.navigatorFile;
  const slug = isIndexFile ? dirs[dirs.length - 1] ?? null : stem;
  const slugSegments = [...dirs, ...(isIndexFile ? [] : [stem])];
  return { dirs, stem, isIndexFile, slug, slugSegments, isStoreRoot: rel === SPEC_SCHEMA.navigatorFile };
};

const checkFrontmatter = (fields, kind, errors) => {
  const missing = SPEC_SCHEMA.substrateKeys.filter((key) => !(key in fields));
  if (missing.length > 0) errors.push({ rule: 'substrate-key', message: `frontmatter is missing ${missing.join(', ')}` });
  if ('type' in fields && fields.type !== SPEC_SCHEMA.type) errors.push({ rule: 'type', message: `type must be ${SPEC_SCHEMA.type}` });
  if ('maxLines' in fields && fields.maxLines !== String(SPEC_SCHEMA.maxLines[kind])) {
    errors.push({ rule: 'maxlines', message: `a ${kind} carries maxLines: ${SPEC_SCHEMA.maxLines[kind]}` });
  }
  if (kind === 'spec') {
    if (!SPEC_SCHEMA.statuses.includes(fields.status)) errors.push({ rule: 'status', message: `status must be one of ${SPEC_SCHEMA.statuses.join('|')}` });
    if (!REVISION_RE.test(fields.revision ?? '')) errors.push({ rule: 'revision', message: 'revision must be an integer >= 1' });
  } else {
    const carried = SPEC_SCHEMA.rootOwnedKeys.filter((key) => key in fields);
    if (carried.length > 0) errors.push({ rule: 'root-owns', message: `a ${kind} never carries ${carried.join(', ')} — the contract root owns them` });
  }
};

const checkPath = (rel, kind, errors) => {
  const at = describeRel(rel);
  const badSegment = at.slugSegments.find((segment) => !SLUG_RE.test(segment));
  if (badSegment !== undefined) errors.push({ rule: 'slug', message: `"${badSegment}" is not a slug (${SPEC_SCHEMA.slugPattern})` });
  if (kind === 'index' && !at.isIndexFile) errors.push({ rule: 'kind-path', message: 'a kind: index document is an index.md' });
  if (kind === 'part' && (at.isIndexFile || at.dirs.length === 0)) errors.push({ rule: 'kind-path', message: 'a kind: part document is a <name>.md beside a promoted root, never an index.md or a store-root file' });
  if (kind === 'spec' && at.isIndexFile && at.slug === null) errors.push({ rule: 'kind-path', message: 'the store root is the navigator, never a contract root' });
  return at;
};

const checkSections = (parsed, kind, errors) => {
  const headings = parsed.sections.map((section) => section.heading);
  const prefix = SPEC_SCHEMA.titlePrefix[kind];
  if (parsed.title === null || !parsed.title.startsWith(prefix) || parsed.title.slice(prefix.length).trim() === '') {
    errors.push({ rule: 'title', message: `the first heading is \`${prefix}<title>\`` });
  }
  const required = SPEC_SCHEMA.requiredSections[kind];
  const missing = required.filter((heading) => !headings.includes(heading));
  if (missing.length > 0) errors.push({ rule: 'section-missing', message: `missing ${missing.join(', ')}` });
  const ordered = [...required, ...(SPEC_SCHEMA.optionalSections[kind] ?? [])];
  const positions = ordered.filter((heading) => headings.includes(heading)).map((heading) => headings.indexOf(heading));
  if (missing.length === 0 && positions.some((position, i) => i > 0 && position < positions[i - 1])) {
    errors.push({ rule: 'section-order', message: `sections run ${ordered.join(', ')}` });
  }
  const forbidden = FORBIDDEN_SECTIONS[kind].filter((heading) => headings.includes(heading));
  if (forbidden.length > 0) errors.push({ rule: 'section-forbidden', message: `a ${kind} never carries ${forbidden.join(', ')}` });
};

const sectionLines = (parsed, heading) => parsed.sections.find((section) => section.heading === heading)?.lines ?? null;

const checkChildren = (parsed, errors) => {
  const lines = sectionLines(parsed, '## Children');
  if (lines === null) return;
  const targets = [];
  for (const line of contentOf(lines)) {
    const m = line.match(CHILD_LINK_RE);
    if (!m || !SLUG_RE.test(m[2])) {
      errors.push({ rule: 'children-link', message: `"${line}" is not \`- [name](./<child>.md)\` or \`- [name](./<child>/index.md)\`` });
      return;
    }
    targets.push(m[2]);
  }
  const duplicate = targets.find((target, i) => targets.indexOf(target) !== i);
  if (duplicate !== undefined) errors.push({ rule: 'children-duplicate', message: `child "${duplicate}" is listed twice` });
  if (targets.length > SPEC_SCHEMA.fanOutMax) errors.push({ rule: 'fan-out', message: `${targets.length} children > ${SPEC_SCHEMA.fanOutMax} — subdivide along slice boundaries` });
};

const parseScenario = (line) => {
  if (!line.startsWith('- ')) return null;
  const fields = line.slice(2).split(SEPARATOR);
  const head = fields[0].match(SCENARIO_HEAD_RE);
  if (!head) return null;
  const base = { n: Number(head[1]), name: head[2] };
  if (fields.length === 2 && fields[1] === SPEC_SCHEMA.unboundMarker) return { ...base, bound: false };
  if (fields.length === 3) return { ...base, bound: true, path: fields[1], marker: fields[2] };
  return null;
};

const checkScenarios = (parsed, slug, status, errors, warnings) => {
  const lines = sectionLines(parsed, '## Scenarios');
  if (lines === null) return;
  const scenarios = [];
  for (const line of contentOf(lines)) {
    const scenario = parseScenario(line);
    if (scenario === null) {
      errors.push({ rule: 'scenario-line', message: `"${line}" does not match \`${SPEC_SCHEMA.scenarioGrammar}\`` });
      return;
    }
    scenarios.push(scenario);
  }
  const gap = scenarios.findIndex((scenario, i) => scenario.n !== i + 1);
  if (gap !== -1) errors.push({ rule: 'scenario-number', message: `scenario ${gap + 1} is numbered S${scenarios[gap].n} — N runs contiguously from 1` });
  for (const scenario of scenarios) {
    if (!scenario.bound) {
      if (status === 'live') warnings.push({ rule: 'unbound', message: `S${scenario.n} is unbound on a live spec` });
      continue;
    }
    const expected = `spec:${slug}/S${scenario.n}`;
    if (scenario.marker !== expected) errors.push({ rule: 'scenario-marker', message: `S${scenario.n} marker "${scenario.marker}" must be "${expected}"` });
    if (classifyPath(scenario.path) !== 'file') errors.push({ rule: 'scenario-path', message: `S${scenario.n} test path "${scenario.path}" is not a repo-relative file` });
  }
};

const checkOutOfScope = (parsed, errors) => {
  const lines = sectionLines(parsed, '## Out of scope');
  if (lines === null) return;
  const content = contentOf(lines);
  if (bulletsOf(content).length === 0 && !(content.length === 1 && content[0] === SPEC_SCHEMA.emptyMarker)) {
    errors.push({ rule: 'out-of-scope', message: `at least one \`- \` bullet, or exactly \`${SPEC_SCHEMA.emptyMarker}\`` });
  }
};

const checkModule = (parsed, status, errors) => {
  const lines = sectionLines(parsed, '## Module');
  if (lines === null) return;
  const content = contentOf(lines);
  const paths = bulletsOf(content);
  if (paths.length === 0) {
    if (!(status === 'retired' && content.length === 1 && content[0] === SPEC_SCHEMA.emptyMarker)) {
      errors.push({ rule: 'module-empty', message: `a module root is required (\`${SPEC_SCHEMA.emptyMarker}\` only on a retired spec)` });
    }
    return;
  }
  const prose = content.find((line) => !line.startsWith('- '));
  if (prose !== undefined) {
    errors.push({ rule: 'module-line', message: `"${prose}" — every ## Module line is a \`- <path>\` bullet` });
    return;
  }
  const kinds = paths.map(classifyPath);
  const offending = kinds.map((kind, i) => (kind in MODULE_PATH_RULES ? { rule: MODULE_PATH_RULES[kind], path: paths[i] } : null)).filter(Boolean);
  if (offending.length > 0) {
    for (const { rule, path } of offending) errors.push({ rule, message: `module path "${path}" refused` });
    return;
  }
  const dirs = kinds.filter((kind) => kind === 'dir').length;
  if (!(dirs === 1 && paths.length === 1) && dirs !== 0) {
    errors.push({ rule: 'module-mix', message: 'the module is ONE `dir/` root OR a literal file list' });
  }
};

const checkParts = (parsed, at, errors) => {
  const lines = sectionLines(parsed, '## Parts');
  if (lines === null) return;
  if (!at.isIndexFile) {
    errors.push({ rule: 'parts', message: 'only a promoted root (<slug>/index.md) carries ## Parts' });
    return;
  }
  const names = [];
  for (const line of contentOf(lines)) {
    const m = line.match(PART_LINK_RE);
    if (!m || !SLUG_RE.test(m[2])) {
      errors.push({ rule: 'parts', message: `"${line}" is not \`- [name](./<part>.md)\`` });
      return;
    }
    names.push(m[2]);
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) errors.push({ rule: 'parts', message: `part "${duplicate}" is listed twice` });
};

// The verdict: { kind, status, revision, errors: [{ rule, message }], warnings: [{ rule, message }] }.
// Errors are collected past the first defect wherever later checks stay meaningful; a missing
// frontmatter or an unknown kind ends the read, because no shape can be judged without them.
export const readSpecDocument = (text, rel) => {
  const errors = [];
  const warnings = [];
  const verdict = (kind, status, revision) => ({ kind, status, revision, errors, warnings });
  const front = parseFrontmatter(text.replace(/\r\n/g, '\n'));
  if (front === null) {
    errors.push({ rule: 'frontmatter', message: 'missing YAML frontmatter' });
    return verdict(null, null, null);
  }
  const { fields, defects, body } = front;
  const kind = fields.kind;
  if (!SPEC_SCHEMA.kinds.includes(kind)) {
    errors.push({ rule: 'kind', message: `kind must be one of ${SPEC_SCHEMA.kinds.join('|')}` });
    return verdict(null, null, null);
  }
  if (defects.length > 0) errors.push({ rule: 'frontmatter-key', message: defects.join('; ') });
  checkFrontmatter(fields, kind, errors);
  const at = checkPath(rel, kind, errors);
  const parsed = parseBody(body);
  if (parsed.fenced.length > 0) errors.push({ rule: 'fence', message: `"${parsed.fenced[0]}" — a spec document carries no code fence` });
  checkSections(parsed, kind, errors);
  if (kind === 'index') {
    checkChildren(parsed, errors);
    if (at.isStoreRoot && !parsed.preamble.includes(SPEC_SCHEMA.upLinkLine)) {
      errors.push({ rule: 'root-uplink', message: `the store root carries the line \`${SPEC_SCHEMA.upLinkLine}\` before its first section` });
    }
  }
  if (kind === 'spec') {
    checkScenarios(parsed, at.slug, fields.status, errors, warnings);
    checkOutOfScope(parsed, errors);
    checkModule(parsed, fields.status, errors);
    checkParts(parsed, at, errors);
  }
  const status = kind === 'spec' ? fields.status ?? null : null;
  const revision = kind === 'spec' && REVISION_RE.test(fields.revision ?? '') ? Number(fields.revision) : null;
  return verdict(kind, status, revision);
};
