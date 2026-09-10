import { checkEpic, judgeAltitude, EPIC_SECTIONS, findCitation } from './epic-shape.mjs';
import { getLineCount } from './plan-shape.mjs';

export const BRIEF_GUARD = 'Judge intent, value, boundaries, ownership and story order. A finding that names a mechanism, a file line or an implementation choice is below this tier\'s altitude and is NOT counted.';
const QUESTIONS = Object.freeze([
  'Intent: Is the intended change clear?',
  'Value: Is the value worth the work?',
  'Boundaries: Are the non-goals and acceptance boundaries clear?',
  'Ownership: Does each story have distinct, declared ownership?',
  'Story order: Do the dependencies express the required order?',
]);
const BRIEF_PREFIX = '# Epic review: ';
const FIRST_LINE = 1;
const ENTRY_START = /^(?:[-*]|\d+\.)(?:[ \t]|$)/;
const INDENTED_LINE = /^[ \t]+\S/;
const CR_END = /\r$/;
const CITATION_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
const SPAN_CONTENT = 2;
const CITATION_GAP = ' ';
const ERROR = 'error';
const makeEntry = (entry) => ({ ...entry, text: entry.lines.join('\n') });

export const renderBrief = (text, path) => {
  const { findings, epic } = checkEpic(text, path);
  if (findings.length) return { findings, brief: null };
  const sections = EPIC_SECTIONS.map((heading) => epic.sections.find((section) => section.heading === heading).text).join('');
  const separator = sections.endsWith('\n') ? '\n' : '\n\n';
  return `${BRIEF_PREFIX}${epic.id} (${epic.state})\n\n${BRIEF_GUARD}\n\n${sections}${separator}${QUESTIONS.join('\n')}\n`;
};

export const readEntries = (text) => {
  const source = String(text ?? '');
  const lines = source.split('\n').slice(0, getLineCount(source));
  const read = lines.reduce((state, raw, index) => {
    const line = index + FIRST_LINE;
    if (ENTRY_START.test(raw.replace(CR_END, ''))) {
      return { ...state, entries: state.current ? [...state.entries, makeEntry(state.current)] : state.entries,
        current: { line, lines: [raw] } };
    }
    if (state.current && (raw.trim() === '' || INDENTED_LINE.test(raw))) {
      return { ...state, current: { ...state.current, lines: [...state.current.lines, raw] } };
    }
    return { current: null, entries: state.current ? [...state.entries, makeEntry(state.current)] : state.entries,
      outside: raw.trim() === '' ? state.outside : [...state.outside, { line, text: raw }] };
  }, { entries: [], outside: [], current: null });
  return { entries: read.current ? [...read.entries, makeEntry(read.current)] : read.entries, outside: read.outside };
};

const findCitationRange = (text) => {
  const citation = findCitation(text);
  if (!citation) return null;
  const span = [...text.matchAll(CITATION_SPAN)].find((match) => match.index < citation.index && match.index + match[0].length > citation.end);
  if (!span) return citation;
  return span[SPAN_CONTENT] === citation.text ? { index: span.index, end: span.index + span[0].length } : null;
};
const judgeEntry = (entry) => {
  const citation = findCitationRange(entry.text);
  const remainder = citation ? entry.text.slice(0, citation.index) + CITATION_GAP + entry.text.slice(citation.end) : entry.text;
  const lines = remainder.split('\n').map((line, index) => ({
    ...judgeAltitude(index === 0 ? line.replace(ENTRY_START, '') : line), reasonLine: entry.line + index,
  }));
  const violation = lines.find((line) => line.below) ?? { ...judgeAltitude(remainder), reasonLine: entry.line };
  return violation.below ? { ...entry, form: violation.form, reasonLine: violation.reasonLine,
    reason: `${violation.form} is below concept altitude` } : null;
};

export const foldFindings = (text) => {
  const { entries, outside } = readEntries(text);
  const judged = entries.map((entry) => ({ entry, discarded: judgeEntry(entry) }));
  const kept = judged.filter((item) => !item.discarded).map((item) => item.entry);
  const discarded = judged.filter((item) => item.discarded).map((item) => item.discarded);
  const findings = entries.length ? [] : [{ line: FIRST_LINE, code: 'empty-findings', severity: ERROR, message: 'the findings file contains no entries' }];
  return { ok: findings.length === 0, findings, kept, discarded, outside,
    counts: { kept: kept.length, discarded: discarded.length, outside: outside.length } };
};
