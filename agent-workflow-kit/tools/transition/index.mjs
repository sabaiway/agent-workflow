#!/usr/bin/env node
// The lineage 5.0.0 transition: once per deployment, after upgrade step 3 wrote the kit block and the
// rules themes, it removes the kit's old copies from AGENTS.md and docs/ai/agent_rules.md, found by the
// kit's old landmarks, which live only here and in the migration note. While a replacement is missing it
// refuses with nothing written. Never asks; main returns and never exits. Dependency-free, Node >= 22.
// Contract: docs/ai/specs/kit/transition/.

import { join, resolve } from 'node:path';
import { tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { writeContainedFileAtomic } from '../atomic-write.mjs';
import { isDirectRun } from '../direct-run.mjs';
import { probeRegularFileNoFollow, readRegularFileNoFollow } from '../fs-read-nofollow.mjs';
import { findKitBlock, SKIP_PREFIX } from '../inject-methodology.mjs';

const LF = '\n';
const BOM = '﻿';
const AGENTS_REL = 'AGENTS.md';
const RULES_REL = 'docs/ai/agent_rules.md';
const LENS_REL = 'docs/ai/rules/lens.md';
const USAGE = 'usage: transition/index.mjs --cwd <project>';
const UPGRADE_AGAIN = 'run the upgrade again: its step 3 writes the kit block or names its malformed lines';
const ENGINE_REFRESH = 'run npx @sabaiway/agent-workflow-engine@latest init, then run the upgrade again';

// The kit's old landmarks (lineage below 5.0.0): three pointer pairs, the Memory Map row of each rules
// theme and the line-cap footer in AGENTS.md; the title words of three sections in the rules file.
const POINTERS = ['methodology', 'orchestration', 'autonomy'];
const MARKER_RE = new RegExp(`^<!-- workflow:(${POINTERS.join('|')}):(start|end) -->$`, 'u');
const THEME_ROW_RE = /^\| \[`docs\/ai\/rules\/effective\/([^`/\s]+)\.md`\]\(\.\/docs\/ai\/rules\/effective\/\1\.md\) \|/u;
const FOOTER = '**Rule:** This file stays CONCISE (≤100 lines). Details go to `docs/ai/`. Never bloat this file.';
const TITLES = ['Communication (user-facing messages)', 'Story sessions', 'Planning, review & process-fidelity'];
const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*)$/u;
const NUMBER_PREFIX_RE = /^[0-9.]+ +/u;

const REFUSAL = Symbol('transition.refusal');
const shown = (text) => text.replace(/[\u0000-\u001f\u007f]/gu, ' ');
const refuse = (name, detail) => {
  throw Object.assign(new Error(`${name}: ${shown(detail)}`), { [REFUSAL]: true });
};

// ── reading: the no-follow read, then the tokenizer's one definition of fences and headings ─────────

const readProjectFile = (cwd, rel, io) => {
  const read = readRegularFileNoFollow(join(cwd, rel), io);
  if (read.outcome === 'absent') return null;
  if (read.outcome === 'ok') {
    const bom = read.content.startsWith(BOM) ? BOM : '';
    return { rel, bom, text: read.content.slice(bom.length) };
  }
  if (read.className === 'symlink') {
    refuse('file-symlink', `${rel} is a symbolic link; replace the link with a regular file holding its text, then run the upgrade again`);
  }
  const what = read.outcome === 'foreign' ? `is a ${read.className}` : `could not be read (${read.code})`;
  return refuse('file-unreadable', `${rel} ${what}; make it a readable regular file, then run the upgrade again`);
};

// parse(file) → the file with its lines (each with its own ending), their contents, the opaque lines
// (frontmatter and fenced, never judged) and the heading lines by index with their levels.
const parse = (file) => {
  let tokens;
  try {
    tokens = tokenizeMarkdown(file.text, file.rel);
  } catch (err) {
    if (err.exitCode === undefined) throw err;
    refuse('file-unparseable', `${err.message} — close the fence or separate the leading --- block, then run the upgrade again`);
  }
  const { frontLines } = tokens;
  const pieces = file.text === '' ? [] : file.text.split(/(?<=\n)/u);
  const opaque = new Set([...Array(frontLines).keys(), ...[...tokens.fencedLines].map((at) => at + frontLines)]);
  const headings = new Map(tokens.headings.map(({ index, level }) => [index + frontLines, level]));
  const contents = pieces.map((piece) => piece.replace(/\n$/u, '').replace(/\r$/u, ''));
  return { ...file, pieces, contents, opaque, headings };
};

// ── the first step: nothing is removed while the replacement is not there ──────────────────────────

const firstStep = (agents, cwd, io) => {
  if (agents === null) {
    refuse('replacement-missing', 'no AGENTS.md; create AGENTS.md, then run the upgrade again: its step 3 writes the kit block');
  }
  const block = findKitBlock(agents.text);
  if (block.state === 'absent') refuse('replacement-missing', `no kit block in AGENTS.md; ${UPGRADE_AGAIN}`);
  if (block.state !== 'ok') refuse('replacement-missing', `a malformed kit block in AGENTS.md; ${UPGRADE_AGAIN}`);
  if (agents.contents.slice(block.start - 1, block.end).some((line) => line.startsWith(SKIP_PREFIX))) {
    refuse('replacement-missing', `a skipped engine text in the kit block; ${ENGINE_REFRESH}`);
  }
  if (probeRegularFileNoFollow(join(cwd, LENS_REL), io).outcome !== 'ok') {
    refuse('replacement-missing', `no ${LENS_REL}; ${ENGINE_REFRESH}`);
  }
  return block;
};

// ── the removals: spans { from, to, what } of 0-based line indexes, both ends included ─────────────

const covers = (spans, at) => spans.some((span) => at >= span.from && at <= span.to);

// One run of AGENTS.md lines [from, to): the pointer pairs first, then the theme rows and the footer on
// the lines no pair removed. Nothing pairs across a run's edge.
const agentsRunSpans = (doc, from, to) => {
  const judged = (at) => at >= from && at < to && !doc.opaque.has(at);
  const open = Object.fromEntries(POINTERS.map((name) => [name, []]));
  const pairs = [];
  for (let at = from; at < to; at += 1) {
    const marker = judged(at) && MARKER_RE.exec(doc.contents[at].trim());
    if (!marker) continue;
    const [, name, edge] = marker;
    if (edge === 'start') open[name].push(at);
    else if (open[name].length > 0) pairs.push({ from: open[name].pop(), to: at, what: `the ${name} pointer and its text` });
  }
  const spans = pairs.filter((pair) => !pairs.some((other) => other !== pair && other.from <= pair.from && other.to >= pair.to));
  const free = (at) => judged(at) && !covers(pairs, at);
  for (let at = from; at < to; at += 1) {
    if (!free(at)) continue;
    const row = THEME_ROW_RE.exec(doc.contents[at]);
    if (row) spans.push({ from: at, to: at, what: `the Memory Map row of docs/ai/rules/effective/${row[1]}.md` });
    else if (doc.contents[at].trim() === FOOTER) {
      const placed = free(at - 1) && free(at - 2) && doc.contents[at - 1].trim() === '' && doc.contents[at - 2].trim() === '---';
      spans.push({ from: placed ? at - 2 : at, to: at, what: 'the line-cap footer' });
    }
  }
  return spans;
};

const agentsSpans = (doc, block) => [
  ...agentsRunSpans(doc, 0, block.start - 1),
  ...agentsRunSpans(doc, block.end, doc.pieces.length),
];

// The rules file: a heading whose title, its number prefix taken off, opens with kit title words opens a
// section that runs to the next heading of the same or a higher level or a --- line, outside fences.
const rulesSpans = (doc) => {
  const ends = (at, level) => !doc.opaque.has(at) && (doc.contents[at].trim() === '---' || doc.headings.get(at) <= level);
  const spans = [];
  for (const [at, level] of doc.headings) {
    if (covers(spans, at)) continue;
    const title = HEADING_RE.exec(doc.contents[at].trimEnd())[1].replace(NUMBER_PREFIX_RE, '');
    if (!TITLES.some((words) => title.startsWith(words))) continue;
    let to = at + 1;
    while (to < doc.pieces.length && !ends(to, level)) to += 1;
    spans.push({ from: at, to: to - 1, what: `the section ${shown(title)}` });
  }
  return spans;
};

// The output stays a text the tokenizer accepts: a --- line the removals would bring to the top of a
// file that did not open with one goes with the removed span directly above it.
const keepParseable = (doc, found) => {
  const spans = found.map((span) => ({ ...span })).sort((a, b) => a.from - b.from);
  if (doc.contents[0]?.trim() === '---') return spans;
  for (;;) {
    let first = 0;
    while (first < doc.pieces.length && covers(spans, first)) first += 1;
    if (first === 0 || first === doc.pieces.length || doc.contents[first].trim() !== '---') return spans;
    spans.find((span) => span.to === first - 1).to = first;
  }
};

const removedText = (doc, spans) => doc.bom + doc.pieces.filter((_, at) => !covers(spans, at)).join('');

const reportLines = (doc, rel, spans) => {
  if (doc === null) return [`unchanged: ${rel}: absent`];
  if (spans.length === 0) return [`unchanged: ${rel}: nothing of the old layout found`];
  return spans.map(({ from, to, what }) =>
    `removed: ${rel}: ${what} (${from === to ? `line ${from + 1}` : `lines ${from + 1}-${to + 1}`})`);
};

// ── the command ──────────────────────────────────────────────────────────────────────────────────

// main(argv, deps) → { code, stdout, stderr }; deps is the bag of fs primitives the read and write
// guards take (readRegularFileNoFollow's io, writeContainedFileAtomic's deps).
export const main = async (argv, deps = {}) => {
  const stdout = [];
  const stderr = [];
  const text = (lines) => (lines.length > 0 ? `${lines.join(LF)}${LF}` : '');
  const result = (code) => ({ code, stdout: text(stdout), stderr: text(stderr) });
  if (argv.length !== 2 || argv[0] !== '--cwd' || argv[1] === '' || argv[1].startsWith('--')) {
    stderr.push(USAGE);
    return result(2);
  }
  const cwd = resolve(argv[1]);
  try {
    const agentsFile = readProjectFile(cwd, AGENTS_REL, deps);
    const rulesFile = readProjectFile(cwd, RULES_REL, deps);
    const agents = agentsFile && parse(agentsFile);
    const rules = rulesFile && parse(rulesFile);
    const block = firstStep(agents, cwd, deps);
    const judged = [
      { rel: AGENTS_REL, doc: agents, spans: keepParseable(agents, agentsSpans(agents, block)) },
      { rel: RULES_REL, doc: rules, spans: rules === null ? [] : keepParseable(rules, rulesSpans(rules)) },
    ];
    const written = [];
    for (const { rel, doc, spans } of judged) {
      if (spans.length === 0) continue;
      try {
        writeContainedFileAtomic(cwd, join(cwd, rel), removedText(doc, spans), deps, { label: rel });
      } catch (err) {
        refuse('write-failed', `${rel}: ${err?.message ?? err} — already written: ${written.join(', ') || 'none'}, with no rollback; make it writable, then run the upgrade again`);
      }
      written.push(rel);
    }
    for (const { rel, doc, spans } of judged) stdout.push(...reportLines(doc, rel, spans));
    return result(0);
  } catch (err) {
    if (!err[REFUSAL]) throw err;
    stderr.push(err.message);
    return result(1);
  }
};

if (isDirectRun(import.meta.url)) {
  const { code, stdout, stderr } = await main(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
