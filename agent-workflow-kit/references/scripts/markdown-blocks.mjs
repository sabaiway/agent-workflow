#!/usr/bin/env node
// The ONE block model the archivers read through.
//
// Every archiver used to scan `text.split('\n')` itself and test regexes against raw lines. That is
// one defect with many faces: a heading inside a fenced sample counts as real content, an unclosed
// fence hides the rest of the file, CRLF and trailing spaces break strict matches, and each archiver
// is wrong in its own way because each was fixed against only the inputs its author imagined. This
// module makes that one place instead of three.
//
// It is deliberately SMALL. It models exactly what the archivers must not get wrong:
//   - frontmatter as the leading block, CRLF-safe
//   - fenced regions (``` / ~~~), with an unclosed fence at EOF a LOUD error
//   - ATX headings, emitted only OUTSIDE fences, matched on a trailing-whitespace-free view
//   - which lines are fenced, so a caller can find a paragraph break without bisecting a fence
//
// It deliberately does NOT model: inline syntax, setext headings, indented code blocks, lists,
// blockquotes, HTML, tables, or nesting. Anything ambiguous REFUSES rather than guesses — fail-closed
// is the product, so "refuse" is a correct answer everywhere "parse" is hard.
//
// Line content is returned BYTE-EXACT. Normalisation applies only to the view used for matching, so
// re-emitting a block reproduces the file. Dependency-free, Node >= 22. No side effects on import.

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/;
// Up to three leading spaces, then a run of at least three backticks or tildes (CommonMark).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Indented 1-3 spaces is STILL a heading in CommonMark. Emitting it matters: a consumer's unit
// grammar is anchored at column 0, so the token exists, fails that grammar, and is refused — where
// dropping it here would silently glue it into the block above. The separator is spaces OR tabs
// (CommonMark): a tab-separated heading must become a token for the same reason.
const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const BACKTICK = '`';

// The matching view of a line: trailing whitespace and any CR are invisible in rendered markdown, so
// they must not decide whether something is a heading. A file written on Windows parses identically.
const toMatchable = (line) => line.replace(/\s+$/, '');

// A fence closes only on a bare run of the SAME marker, at least as long as the opener. An info
// string ("```markdown") opens; a trailing info string never closes.
const closesFence = (matchable, open) => {
  const match = FENCE_RE.exec(matchable);
  if (!match) return false;
  const [, marker, info] = match;
  return marker[0] === open.char && marker.length >= open.length && info.trim() === '';
};

// A BACKTICK fence may not carry a backtick in its info string — otherwise a line of inline code
// (```a``` used inline) would open a fence and swallow every heading after it. Tilde fences have no
// such restriction, which is exactly why CommonMark distinguishes them.
const opensFence = (matchable) => {
  const match = FENCE_RE.exec(matchable);
  if (!match) return null;
  const [, marker, info] = match;
  if (marker[0] === BACKTICK && info.includes(BACKTICK)) return null;
  return { char: marker[0], length: marker.length };
};

// Split a document into { frontmatter, lines, headings, fencedLines }.
//
//   frontmatter   the leading `---` block, byte-exact and possibly ''
//   frontLines    how many lines it occupies (so a caller can report 1-based file lines)
//   lines         the body, byte-exact, exactly as `split('\n')` would give
//   headings      [{ index, level, text, raw }] for every ATX heading OUTSIDE a fence
//   fencedLines   Set of body-line indexes inside a fence, fence markers included
//
// `label` names the source in refusals; pass the repo-relative path.
export const tokenizeMarkdown = (text, label = 'document') => {
  const frontMatch = FRONTMATTER_RE.exec(text);
  // A leading `---` is ambiguous: real frontmatter, or a thematic break whose next `---` is an entry
  // separator — in which case everything between them would be swallowed and its headings hidden.
  // REFUSE rather than pick, because both guesses are silently wrong in opposite directions: demoting
  // real frontmatter (a YAML comment starts with `#`) leaves it in the body to be re-emitted twice,
  // and promoting a thematic break hides content. The caller fixes it by making the file unambiguous.
  if (frontMatch) {
    const suspectAt = frontMatch[1]
      .split('\n')
      .findIndex((line) => ATX_HEADING_RE.test(toMatchable(line)) || FENCE_RE.test(toMatchable(line)));
    if (suspectAt !== -1) {
      throw fail(
        1,
        `${label}:${suspectAt + 1}: the leading \`---\` block contains "${frontMatch[1].split('\n')[suspectAt]}", ` +
          'so it is either frontmatter holding a heading or fence, or a thematic break whose closing `---` ' +
          'belongs to the body — and the two are indistinguishable here. Separate them: keep frontmatter ' +
          'free of `#` and fence lines, or put a blank line and prose before the first `---`.',
      );
    }
  }
  const frontmatter = frontMatch ? frontMatch[1] : '';
  const frontLines = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  const lines = text.slice(frontmatter.length).split('\n');

  const headings = [];
  const fencedLines = new Set();
  let open = null;

  for (let index = 0; index < lines.length; index += 1) {
    const matchable = toMatchable(lines[index]);

    if (open) {
      fencedLines.add(index);
      if (closesFence(matchable, open)) open = null;
      continue;
    }

    const fence = opensFence(matchable);
    if (fence) {
      open = { ...fence, index };
      fencedLines.add(index);
      continue;
    }

    const heading = ATX_HEADING_RE.exec(matchable);
    if (heading) {
      headings.push({ index, level: heading[1].length, text: matchable, raw: lines[index] });
    }
  }

  if (open) {
    // Left open, the remainder of the file silently stops being scanned: every later heading
    // disappears and its text ends up inside whichever block precedes it, where a compressor that
    // keeps only an opening paragraph will drop it — a loss that lands long after a green check.
    throw fail(
      1,
      `${label}:${frontLines + open.index + 1}: "${lines[open.index]}" opens a code fence that is ` +
        'never closed, so every heading after it is invisible and its text is silently absorbed. ' +
        `Close it with a bare \`${open.char.repeat(open.length)}\`, then re-run.`,
    );
  }

  return { frontmatter, frontLines, lines, headings, fencedLines };
};

// The index of the first blank line at or after `from` that is NOT inside a fence, or -1. Callers
// that split a block into "opening paragraph" and "rest" must use this rather than a bare blank-line
// scan: a fenced sample contains blank lines, and cutting there writes a half-fence into an archive
// that the next run cannot read.
export const findParagraphBreak = (lines, fencedLines, from = 0) => {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].trim() === '' && !fencedLines.has(index)) return index;
  }
  return -1;
};
