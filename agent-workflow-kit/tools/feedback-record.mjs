// Feedback-record grammar and pure judgments. Governing contract:
// docs/ai/specs/kit/feedback-triage.md.

const REFUSAL_NAMES = Object.freeze({
  title: 'title', source: 'source', head: 'head', table: 'table', rowCells: 'row-cells',
  claimId: 'claim-id', anchorGrammar: 'anchor-grammar', anchorPath: 'anchor-path',
  verdict: 'verdict', disposition: 'disposition', anchorAbsent: 'anchor-absent',
  anchorUnreadable: 'anchor-unreadable', anchorLine: 'anchor-line',
});
export const VERDICTS = Object.freeze(['confirmed', 'corrected', 'refuted', 'works-as-designed']);
export const REFUSALS = Object.freeze(Object.values(REFUSAL_NAMES));

const TITLE_PREFIX = '# Feedback: ';
const SOURCE_PREFIX = 'Source: ';
const HEAD_PREFIX = 'Head: ';
const CLAIMS_HEADING = '## Claims';
const NOTES_HEADING = '## Notes';
const TABLE_HEADER = '| # | Claim | Evidence | Verdict | Disposition |';
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const ANCHOR = /^`([^`,\s]+):([1-9][0-9]*)(?:-([1-9][0-9]*))?`$/u;
const ROW_ID = '[A-Z0-9][A-Z0-9-]*';
const QUEUE = new RegExp(`^queue (${ROW_ID})$`, 'u');
const ALREADY_QUEUED = new RegExp(`^already-queued (${ROW_ID})$`, 'u');
const REASONED_DISPOSITION = /^(?:declined|folded): (.+)$/u;
const LINE_JOINER = '\n';

const makeRefusal = (name, line, message) => ({ name, line, message });
const getLineNumber = (lines, index) => Math.min(index + 1, Math.max(lines.length, 1));
const findNextContent = (lines, start) => {
  const index = lines.findIndex((line, offset) => offset >= start && line.trim() !== '');
  return index === -1 ? lines.length : index;
};
const makeFatalResult = (record, name, line, message) => ({
  ...record, claims: [], refusals: [makeRefusal(name, line, message)],
});

const splitCells = (line) => {
  if (!line.startsWith('|') || !line.endsWith('|')) return null;
  const body = line.slice(1, -1);
  const parsed = Array.from(body).reduce((state, byte, index) => {
    if (state.skip) state.skip = false;
    else if (byte === '\\' && body[index + 1] === '|') { state.cell += '|'; state.skip = true; }
    else if (byte === '|') { state.cells.push(state.cell.trim()); state.cell = ''; }
    else state.cell += byte;
    return state;
  }, { cells: [], cell: '', skip: false });
  return [...parsed.cells, parsed.cell.trim()];
};

const parsesDelimiter = (line) => {
  const cells = splitCells(line);
  return cells?.length === 5 && cells.every((cell) => /^-{3,}$/u.test(cell));
};

const RECORD_STATES = Object.freeze([
  { name: REFUSAL_NAMES.title, fixed: true, accepts: (line) => line.startsWith(TITLE_PREFIX) && line.slice(TITLE_PREFIX.length).trim() !== '', assigns: (record, line) => { record.title = line.slice(TITLE_PREFIX.length); }, message: `line 1 must be ${TITLE_PREFIX}<title>` },
  { name: REFUSAL_NAMES.source, accepts: (line) => line.startsWith(SOURCE_PREFIX) && line.slice(SOURCE_PREFIX.length).trim() !== '', assigns: (record, line) => { record.source = line.slice(SOURCE_PREFIX.length); }, message: `expected ${SOURCE_PREFIX}<one line>` },
  { name: REFUSAL_NAMES.head, accepts: (line) => line.startsWith(HEAD_PREFIX) && OBJECT_ID.test(line.slice(HEAD_PREFIX.length)), assigns: (record, line) => { record.head = line.slice(HEAD_PREFIX.length); }, message: `expected ${HEAD_PREFIX}<object id>` },
  { name: REFUSAL_NAMES.table, accepts: (line) => line === CLAIMS_HEADING, assigns: () => {}, message: `expected ${CLAIMS_HEADING}` },
  { name: REFUSAL_NAMES.table, accepts: (line) => line === TABLE_HEADER, assigns: () => {}, message: `expected ${TABLE_HEADER}` },
  { name: REFUSAL_NAMES.table, accepts: parsesDelimiter, assigns: () => {}, message: 'expected a five-cell table delimiter' },
]);

const hasUnsafePath = (path) =>
  path.startsWith('/') || path.includes('\\') || path.split('/').includes('..');

const parseAnchors = (value, line) => {
  const tokens = value.split(/,\s*/u);
  if (tokens.length === 0 || tokens.some((token) => token === '')) {
    return { refusal: makeRefusal(REFUSAL_NAMES.anchorGrammar, line, 'Evidence must name one or more backticked anchors') };
  }
  const anchors = [];
  for (const token of tokens) {
    const match = ANCHOR.exec(token);
    if (!match || match[1].includes('|')) {
      return { refusal: makeRefusal(REFUSAL_NAMES.anchorGrammar, line, `invalid anchor grammar: ${token}`) };
    }
    const [, path, startText, endText] = match;
    if (hasUnsafePath(path)) {
      return { refusal: makeRefusal(REFUSAL_NAMES.anchorPath, line, `anchor path is not repository-relative: ${path}`) };
    }
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (start > end) {
      return { refusal: makeRefusal(REFUSAL_NAMES.anchorGrammar, line, `anchor range starts after it ends: ${token}`) };
    }
    anchors.push({ path, start, end, line });
  }
  return { anchors };
};

const parsesDisposition = (value) =>
  QUEUE.test(value) || ALREADY_QUEUED.test(value) || REASONED_DISPOSITION.test(value);

const parseClaim = (lineText, line, expectedId) => {
  const cells = splitCells(lineText);
  if (cells?.length !== 5) {
    return { refusal: makeRefusal(REFUSAL_NAMES.rowCells, line, 'claim row must contain exactly five cells') };
  }
  const [idText, claim, evidence, verdict, disposition] = cells;
  if (idText !== String(expectedId)) {
    return { refusal: makeRefusal(REFUSAL_NAMES.claimId, line, `claim id must be ${expectedId}, got ${idText || '(empty)'}`) };
  }
  const parsedAnchors = parseAnchors(evidence, line);
  if (parsedAnchors.refusal) return parsedAnchors;
  if (!VERDICTS.includes(verdict)) {
    return { refusal: makeRefusal(REFUSAL_NAMES.verdict, line, `unknown verdict: ${verdict || '(empty)'}`) };
  }
  if (!parsesDisposition(disposition)) {
    return { refusal: makeRefusal(REFUSAL_NAMES.disposition, line, `invalid disposition: ${disposition || '(empty)'}`) };
  }
  return {
    claim: { id: expectedId, claim, anchors: parsedAnchors.anchors, verdict, disposition, line },
  };
};

export const parseRecord = (text) => {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/u, ''));
  const record = { head: null, title: null, source: null, claims: [], refusals: [] };
  const structure = RECORD_STATES.reduce((state, spec) => {
    if (state.refusal !== null) return state;
    const index = spec.fixed ? 0 : findNextContent(lines, state.index + 1);
    const line = lines[index] ?? '';
    if (!spec.accepts(line)) return { index, refusal: makeRefusal(spec.name, getLineNumber(lines, index), spec.message) };
    spec.assigns(record, line);
    return { index, refusal: null };
  }, { index: -1, refusal: null });
  if (structure.refusal !== null) {
    return makeFatalResult(record, structure.refusal.name, structure.refusal.line, structure.refusal.message);
  }
  const delimiterIndex = structure.index;
  const table = lines.slice(delimiterIndex + 1).reduce((state, lineText, offset) => {
    const line = delimiterIndex + offset + 2;
    if (state.notes || state.fatal !== null) return state;
    if (state.done) {
      if (lineText.trim() === '') return state;
      if (lineText === NOTES_HEADING) return { ...state, notes: true };
      return {
        ...state,
        fatal: makeRefusal(
          REFUSAL_NAMES.table,
          line,
          `the claims table ended at line ${state.endedLine}; only ${NOTES_HEADING} or the end of the record may follow`,
        ),
      };
    }
    if (lineText === NOTES_HEADING) return { ...state, done: true, notes: true };
    if (lineText.trim() === '') return { ...state, done: true, endedLine: line };
    const parsed = parseClaim(lineText, delimiterIndex + offset + 2, state.expectedId);
    return {
      expectedId: state.expectedId + 1,
      done: false,
      notes: false,
      endedLine: null,
      fatal: null,
      claims: parsed.claim ? [...state.claims, parsed.claim] : state.claims,
      refusals: parsed.refusal ? [...state.refusals, parsed.refusal] : state.refusals,
    };
  }, { expectedId: 1, done: false, notes: false, endedLine: null, fatal: null, claims: [], refusals: [] });
  if (table.fatal !== null) {
    return makeFatalResult(record, table.fatal.name, table.fatal.line, table.fatal.message);
  }
  if (table.claims.length === 0 && table.refusals.length === 0) {
    return makeFatalResult(record, REFUSAL_NAMES.table, delimiterIndex + 1, 'the claims table carries no row');
  }
  record.claims = table.claims;
  record.refusals = table.refusals;
  return record;
};

export const judgeAnchors = (claims, facts) => {
  const findings = [];
  for (const claim of claims) {
    for (const anchor of claim.anchors) {
      const fact = Object.hasOwn(facts, anchor.path) ? facts[anchor.path] : { kind: 'absent' };
      if (fact.kind === 'absent' || fact.kind === 'other') {
        findings.push({ name: REFUSAL_NAMES.anchorAbsent, line: anchor.line, path: anchor.path, message: `anchor is absent or not a regular file: ${anchor.path}` });
      } else if (fact.kind === 'unreadable') {
        findings.push({ name: REFUSAL_NAMES.anchorUnreadable, line: anchor.line, path: anchor.path, message: `anchor cannot be read: ${anchor.path} (${fact.reason ?? 'unknown reason'})` });
      } else if (anchor.end > fact.lines) {
        findings.push({ name: REFUSAL_NAMES.anchorLine, line: anchor.line, path: anchor.path, message: `anchor line ${anchor.end} exceeds ${fact.lines} lines in ${anchor.path}` });
      }
    }
  }
  return findings;
};

const rendersAnchor = (anchor) => `${anchor.path}:${anchor.start}${anchor.end === anchor.start ? '' : `-${anchor.end}`}`;

const makeRange = (start, end) => ({
  [Symbol.iterator]: () => {
    const state = { next: start };
    return {
      next: () => state.next > end
        ? { done: true }
        : { done: false, value: state.next++ },
    };
  },
});

export const renderExcerpts = (anchors, texts, budget) => {
  const rendered = [];
  const state = { bytes: 0 };
  const sources = new Map();
  for (const anchor of anchors) {
    if (!sources.has(anchor.path)) {
      const text = Object.hasOwn(texts, anchor.path) ? texts[anchor.path] : '';
      sources.set(anchor.path, String(text ?? '').split(LINE_JOINER));
    }
    const sourceLines = sources.get(anchor.path);
    for (const number of makeRange(anchor.start, anchor.end)) {
      const line = `${anchor.path}:${number}: ${sourceLines[number - 1] ?? ''}`;
      state.bytes += Buffer.byteLength(line, 'utf8') + (rendered.length === 0 ? 0 : Buffer.byteLength(LINE_JOINER));
      rendered.push(line);
      if (state.bytes > budget) return rendered.join(LINE_JOINER);
    }
  }
  return rendered.join(LINE_JOINER);
};

export const renderRows = (record, { date, recordPath }) => {
  const ids = [];
  for (const claim of record.claims) {
    const id = QUEUE.exec(claim.disposition)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => {
    const claims = record.claims.filter((claim) => QUEUE.exec(claim.disposition)?.[1] === id);
    return [
      `- [ ] ${id}: ${claims[0].claim} (${date})`,
      ...claims.map((claim) => `  - ${claim.claim}; verdict ${claim.verdict}; evidence ${claim.anchors.map(rendersAnchor).join(', ')}`),
      `  - record: ${recordPath}`,
      `  - head: ${record.head}`,
    ].join('\n');
  });
};

export const ratchetLine = (gateCmd, newRows) => {
  const match = /(?:^|\s)--max-rows\s+([0-9]+)(?=\s|$)/u.exec(String(gateCmd));
  if (!match) return 'ratchet: queue-audit --max-rows is absent from the gate command';
  const current = Number(match[1]);
  return `ratchet: queue-audit --max-rows ${current} \u2192 ${current + newRows.length}`;
};
