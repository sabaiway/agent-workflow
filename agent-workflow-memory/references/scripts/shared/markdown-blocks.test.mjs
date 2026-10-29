import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeMarkdown, findParagraphBreak } from './markdown-blocks.mjs';

const FM = '---\ntype: history\nlastUpdated: 2026-07-28\nmaxLines: 700\n---\n';
const B = '```';
const T = '~~~';

describe('frontmatter', () => {
  it('splits the leading block and counts its lines, leaving the body byte-exact', () => {
    const { frontmatter, frontLines, lines } = tokenizeMarkdown(`${FM}\n# Doc\n\n## 2026-07-20 — a\n`);
    assert.equal(frontmatter, FM);
    assert.equal(frontLines, 5);
    assert.equal(lines[1], '# Doc');
  });

  it('recognises CRLF frontmatter', () => {
    const { frontmatter, frontLines } = tokenizeMarkdown(`${FM}\n# Doc\n`.replace(/\n/g, '\r\n'));
    assert.match(frontmatter, /^---\r\n/);
    assert.equal(frontLines, 5);
  });

  it('tolerates a document with no frontmatter at all', () => {
    const { frontmatter, frontLines, headings } = tokenizeMarkdown('# Doc\n\n## 2026-07-20 — a\n');
    assert.equal(frontmatter, '');
    assert.equal(frontLines, 0);
    assert.equal(headings.length, 2);
  });

  it('REFUSES a leading `---` block that is indistinguishable from a thematic break', () => {
    assert.throws(
      () => tokenizeMarkdown('---\n\n# Doc\n\n## 2026-07-20 — a\n\n---\n\n## 2026-07-19 — b\n', 'docs/ai/changelog.md'),
      (err) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /docs\/ai\/changelog\.md:3:/);
        return true;
      },
    );
  });

  it('REFUSES rather than silently demoting frontmatter that holds a YAML comment', () => {
    // Demoting it would leave the real frontmatter in the body, so a rebuild writes a fresh one and
    // the original is duplicated. Guessing the other way hides content. Both are silent; refuse.
    assert.throws(
      () => tokenizeMarkdown('---\n# pinned by AD-084\ntype: history\n---\n\n## 2026-07-20 — a\n', 'f.md'),
      /f\.md:2:/,
    );
  });
});

describe('headings', () => {
  it('reports level, index and a trailing-whitespace-free text, keeping raw byte-exact', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n## 2026-07-20 — a  \n\n### deeper\n`);
    assert.deepEqual(headings.map((h) => h.level), [2, 3]);
    assert.equal(headings[0].text, '## 2026-07-20 — a');
    assert.equal(headings[0].raw, '## 2026-07-20 — a  ');
  });

  it('sees a heading that carries a CR, so a Windows file parses identically', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n## 2026-07-20\n`.replace(/\n/g, '\r\n'));
    assert.equal(headings.length, 1);
    assert.equal(headings[0].text, '## 2026-07-20');
  });

  it('emits an indented heading as a TOKEN so a column-0 grammar can refuse it loudly', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n## 2026-07-20 — a\n\n  ## 2026-07-19 — indented\n`);
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — a', '  ## 2026-07-19 — indented']);
  });

  it('does not treat a bare hash run without a space as a heading', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n##notaheading\n`);
    assert.equal(headings.length, 0);
  });

  it('a tab after the hashes still makes a heading token (CommonMark allows spaces or tabs)', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n##\t2026-07-18 — tab separated\n`);
    assert.deepEqual(headings.map((h) => h.level), [2]);
    assert.equal(headings[0].text, '##\t2026-07-18 — tab separated');
  });
});

describe('fences', () => {
  it('hides headings inside a backtick fence', () => {
    const { headings, fencedLines } = tokenizeMarkdown(
      `${FM}\n## 2026-07-20 — real\n\n${B}markdown\n## 2026-07-19 — a sample\n${B}\n\nend.\n`,
    );
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — real']);
    assert.equal(fencedLines.has(3), true);
    assert.equal(fencedLines.has(5), true);
  });

  it('a backtick run whose info string contains a backtick is inline code, not a fence', () => {
    const { headings } = tokenizeMarkdown(
      `${FM}\n${B}a${B} used inline\n\n## 2026-07-20 — a real entry\n\nbody.\n\n${B}\nsample\n${B}\n`,
    );
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — a real entry']);
  });

  it('a tilde fence MAY carry backticks in its info string', () => {
    const { headings } = tokenizeMarkdown(`${FM}\n${T}a${B}\n## 2026-07-19 — fenced\n${T}\n\n## 2026-07-20 — real\n`);
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — real']);
  });

  it('closes only on the same marker, so a backtick run inside a tilde fence stays content', () => {
    const { headings } = tokenizeMarkdown(
      `${FM}\n## 2026-07-20 — real\n\n${T}markdown\n${B}\n## 2026-07-19 — nested sample\n${B}\n${T}\n\nend.\n`,
    );
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — real']);
  });

  it('needs a closer at least as long as the opener', () => {
    const { headings } = tokenizeMarkdown(
      `${FM}\n## 2026-07-20 — real\n\n\`\`\`\`\n${B}\n## 2026-07-19 — still fenced\n\`\`\`\`\n\nend.\n`,
    );
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — real']);
  });

  it('does not let an info string close a fence', () => {
    const { headings } = tokenizeMarkdown(
      `${FM}\n## 2026-07-20 — real\n\n${B}markdown\n${B}js\n## 2026-07-19 — still fenced\n${B}\n\nend.\n`,
    );
    assert.deepEqual(headings.map((h) => h.text), ['## 2026-07-20 — real']);
  });

  it('REFUSES an unclosed fence, naming the 1-based file line that opened it', () => {
    let caught;
    try {
      tokenizeMarkdown(`${FM}\n## 2026-07-20 — real\n\n${B}markdown\n## 2026-07-19 — hidden\n`, 'docs/ai/changelog.md');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected a refusal');
    assert.equal(caught.exitCode, 1);
    assert.match(caught.message, /docs\/ai\/changelog\.md:9:/);
    assert.match(caught.message, /never closed/);
  });
});

describe('findParagraphBreak', () => {
  it('skips blank lines that live inside a fence', () => {
    const { lines, fencedLines } = tokenizeMarkdown(`${FM}\n## 2026-07-20 — a\n${B}\nx\n\ny\n${B}\n\nafter.\n`);
    assert.equal(fencedLines.has(4), true);
    assert.equal(findParagraphBreak(lines, fencedLines, 1), 7);
  });

  it('returns -1 when no unfenced blank line follows', () => {
    const { lines, fencedLines } = tokenizeMarkdown(`${FM}\n## 2026-07-20 — a\nbody.\n`);
    assert.equal(findParagraphBreak(lines, fencedLines, 4), -1);
  });
});

// ── properties over generated documents ───────────────────────────────────────────────
//
// The generator builds each document AND its ground truth in the SAME pass, by construction: when
// it emits a fenced region it records those line indexes directly, never by re-deriving them with a
// regex. So the oracle is independent of the tokenizer's logic, and a disagreement is a real
// failure rather than two copies of the same mistake agreeing.
//
// It deliberately emits the shapes that shipped as bugs: unclosed fences mid-document, closers that
// are too short, closers carrying an info string, the other marker inside a fence, backtick inline
// code at column 0, indented headings, trailing whitespace, and both line endings. Seeded, so a
// failure replays from its seed alone.

const buildDocument = (seed) => {
  let state = seed;
  // Drawn from the HIGH bits: this LCG's low bit strictly alternates, so `state % 2` is fixed by
  // call parity and every other two-apart draw correlates. With the low bits, a backtick fence
  // carrying an info string was unreachable in every seed — a generator blind spot that looks like
  // coverage.
  const rand = (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor(state / 65536) % n;
  };

  const eol = rand(2) === 0 ? '\n' : '\r\n';
  const rows = [];
  const fenced = new Set();
  const headings = [];
  let unclosedAt = null;

  const pushHeading = () => {
    const indent = ' '.repeat(rand(4));
    const hashes = '#'.repeat(2 + rand(2));
    const body = rand(2) === 0 ? `2026-07-2${rand(9)} — entry` : `2026-7-${rand(9)} — malformed`;
    const text = `${indent}${hashes} ${body}`;
    headings.push({ index: rows.length, text });
    rows.push(text + ' '.repeat(rand(3)));
  };

  const pushFence = (allowUnclosed) => {
    const char = rand(2) === 0 ? '`' : '~';
    const length = 3 + rand(3);
    const marker = char.repeat(length);
    const info = rand(2) === 0 ? '' : 'markdown';
    const openIndex = rows.length;
    fenced.add(openIndex);
    rows.push(`${marker}${info}` + ' '.repeat(rand(3)));

    const inner = [
      `## 2026-07-1${rand(9)} — fenced sample`,
      '',
      char.repeat(length - 1), // too short to close
      `${marker}js`, // info string never closes
      (char === '`' ? '~' : '`').repeat(length + 1), // the other marker never closes
      'plain fenced text',
    ];
    const innerCount = 1 + rand(inner.length);
    for (let i = 0; i < innerCount; i += 1) {
      fenced.add(rows.length);
      rows.push(inner[(i + rand(inner.length)) % inner.length]);
    }

    if (allowUnclosed && rand(4) === 0) {
      unclosedAt = openIndex;
      return;
    }
    fenced.add(rows.length);
    rows.push(char.repeat(length + rand(2)) + ' '.repeat(rand(3)));
  };

  const frontmatter = rand(2) === 0 ? FM.replace(/\n/g, eol) : '';
  const segmentCount = 3 + rand(5);
  // An unclosed fence may open ANYWHERE, not only last: the generator keeps emitting after it and
  // marks the remainder fenced, so the refusal is exercised with real content behind it rather than
  // at a convenient end-of-file.
  for (let i = 0; i < segmentCount; i += 1) {
    if (unclosedAt !== null) {
      fenced.add(rows.length);
      rows.push(rand(2) === 0 ? `## 2026-07-0${i} — hidden behind the open fence` : `trailing text ${i}`);
      continue;
    }
    const kind = rand(5);
    if (kind === 0) pushHeading();
    else if (kind === 1) rows.push('');
    else if (kind === 2) rows.push(`${B}inline${B} used in prose`);
    else if (kind === 3) pushFence(true);
    else rows.push(`body text ${i}`);
  }

  return { text: frontmatter + rows.join(eol) + eol, frontmatter, fenced, headings, unclosedAt };
};

describe('properties over generated documents', () => {
  const SEEDS = 400;

  it('the fenced-line set equals the oracle the generator recorded', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDocument(seed);
      if (doc.unclosedAt !== null) continue;
      const { fencedLines } = tokenizeMarkdown(doc.text, `seed-${seed}`);
      assert.deepEqual([...fencedLines].sort((a, b) => a - b), [...doc.fenced].sort((a, b) => a - b), `seed ${seed}`);
    }
  });

  it('the heading tokens equal the oracle — index and text', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDocument(seed);
      if (doc.unclosedAt !== null) continue;
      const { headings } = tokenizeMarkdown(doc.text, `seed-${seed}`);
      assert.deepEqual(
        headings.map((h) => ({ index: h.index, text: h.text })),
        doc.headings,
        `seed ${seed}`,
      );
    }
  });

  it('an unclosed fence always refuses, naming the line the generator opened it on', () => {
    let covered = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDocument(seed);
      if (doc.unclosedAt === null) continue;
      covered += 1;
      const frontLines = doc.frontmatter === '' ? 0 : doc.frontmatter.split('\n').length - 1;
      assert.throws(
        () => tokenizeMarkdown(doc.text, `seed-${seed}`),
        (err) => {
          assert.equal(err.exitCode, 1, `seed ${seed}`);
          assert.ok(
            err.message.startsWith(`seed-${seed}:${frontLines + doc.unclosedAt + 1}:`),
            `seed ${seed}: refusal names the wrong line — ${err.message.slice(0, 60)}`,
          );
          return true;
        },
      );
    }
    assert.ok(covered >= 10, `the generator must actually produce unclosed fences (got ${covered})`);
  });

  it('line endings never change the block structure', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDocument(seed);
      if (doc.unclosedAt !== null) continue;
      const lf = doc.text.replace(/\r\n/g, '\n');
      const a = tokenizeMarkdown(lf, `seed-${seed}`);
      const b = tokenizeMarkdown(lf.replace(/\n/g, '\r\n'), `seed-${seed}`);
      assert.deepEqual(a.headings.map((h) => h.text), b.headings.map((h) => h.text), `seed ${seed}`);
      assert.deepEqual([...a.fencedLines], [...b.fencedLines], `seed ${seed}`);
    }
  });

  it('the body is returned byte-exact — rejoining reproduces the input', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDocument(seed);
      if (doc.unclosedAt !== null) continue;
      const { frontmatter, lines } = tokenizeMarkdown(doc.text, `seed-${seed}`);
      assert.equal(frontmatter + lines.join('\n'), doc.text, `seed ${seed}`);
    }
  });
});
