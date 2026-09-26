import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lens from './lens-region.mjs';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const BACKSLASH = String.fromCharCode(92);
const SECTION_SIGN = String.fromCharCode(167);
const EM_DASH = String.fromCharCode(8212);
const WHITESPACE_RE = new RegExp(BACKSLASH + 's+', 'g');
const LEAF_URL = new URL('./rules-regions.mjs', import.meta.url);
const BOM_CHAR = String.fromCharCode(65279);
const CAP_WITH_BOM = 150;
const REGION_KEYS = ['canon', 'headingRe', 'id', 'label', 'priors'];
const COMMS_TITLE = 'Communication (user-facing messages)';
const STORY_TITLE = 'Story sessions';
const LENS_TITLE = 'Planning, review & process-fidelity invariants';
const MATCH_NUMBERS = ['5', '17'];
const REGION_CASES = [
  { id: 'communication', title: COMMS_TITLE, canon: 'template', priorCount: 5 },
  { id: 'story-sessions', title: STORY_TITLE, canon: 'template', priorCount: 1 },
  { id: 'lens', title: LENS_TITLE, canon: 'engine', priorCount: 0 },
];
const STORY_RE = /^### 2[.]([0-9]+)[.] Story sessions/;
const BOUNDARIES = [
  { name: 'rule', lines: ['---', 'outside'] },
  { name: 'level two', lines: ['## Next', 'outside'] },
  { name: 'level three', lines: ['### Next', 'outside'] },
  { name: 'EOF', lines: [] },
];
const RETAINED_FUNCTIONS = [
  'parseLensPriors', 'renderLens', 'normalizeLensBody', 'normalizeCommsBody',
  'renderComms', 'extractLensRegion', 'extractCommsRegion', 'replaceLensRegion',
  'reconcileLensText', 'reconcileCommsText', 'frontmatterMaxLines', 'runCli',
];
const RETAINED_VALUES = ['LENS_HEADING_RE', 'COMMS_HEADING_RE', 'COMMS_PRIORS', 'OUTCOME_LINES'];
const VINTAGE_SENTENCE = 'Append the OUTGOING canon here in the same release that changes the template '
  + SECTION_SIGN + '2.5 or ' + SECTION_SIGN + '2.7 region ' + EM_DASH + ' the fragment-or-prior reconcile depends on it.';
// The two appended priors: the 7da8cff template's agent_rules.md:66-75 and :95-96, headed 2.x, LF-joined.
const NEW_PRIORS = [
  { id: 'communication', index: 4, bytes: 2788, sha256: '8737e992e7a513acf55da93fdc11ac8a22c3c51cb3922681599c9ce36f320279' },
  { id: 'story-sessions', index: 0, bytes: 923, sha256: '30f85c460df4945fb33aaf438ddbdf33d0ba14fd9bf1863f1c54f47b042dc38a' },
];
const IMPORT_RE = new RegExp(BACKSLASH + 'bimport(?:' + BACKSLASH + 's+|[(])[^;]+', 'g');
const WRITER_RE = /atomic-write|writeFile/;
const EXTRACT_PREFIX = '# Rules';
const REGION_BODY = 'first body';
const EXTRACT_NUMBER = '7';
const SECOND_HEADING = '### 2.8. Story sessions';
const SECOND_BODY = 'second body';
const ABSENT_TEXT = '# No managed section';
const TEMPLATE_DEFECT = { defect: 'heading-count' };
const NO_REGION = { found: false, count: 0 };
const EXTRACT_START = 1;
const EXTRACT_END = 5;
const COMMS_BODY = 'Template communication.';
const STORY_BODY = 'Template story sessions.';
const ANCHOR_LINES = [
  '### 2.9. High custom number',
  'Keep high bytes.',
  '',
  '### 2.2. Last custom section',
  'Keep last bytes.',
  '',
  '',
];
const TAIL_LINES = ['---', '## Tail', 'Keep tail bytes.', ''];
const PRESENT_COMMS = ['### 2.4. Communication (user-facing messages)', 'Custom communication.', ''];
const PRESENT_STORY = ['### 2.3. Story sessions', 'Custom story sessions.', ''];
const DOUBLED_COMMS = [...PRESENT_COMMS, ...PRESENT_COMMS];
const DOUBLED_STORY = [...PRESENT_STORY, ...PRESENT_STORY];
const ANCHOR_END = 7;
const PREFIXED_ANCHOR_END = 10;
const EOF_ANCHOR_END = 5;
const LOW_CAP = 1;
const RESULT_COUNT = 16;
const RESULT_CAP = 15;
const UNCAPPED = null;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLAIN_ROOT = '/project';
const PLAIN_INSERT = '/kit/tools/rules-insert.mjs';
const PROBE_SOURCE = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';
const SHELL_ROOTS = ['a b', 'x$HOME', "it's", 'semi;colon', 'glob*', 'back' + BACKSLASH + 'slash', '"dq"'];
const REJECTED_BYTES = [1, 9, 10, 31, 127, 96];

const makeHeading = (number, title) => '### 2.' + number + '. ' + title;
const makeSpanLines = (number, title, body) => [makeHeading(number, title), body, ''];
const COMMS_TEMPLATE = makeSpanLines('5', COMMS_TITLE, COMMS_BODY);
const STORY_TEMPLATE = makeSpanLines('7', STORY_TITLE, STORY_BODY);
const SPANS = {
  communication: { span: COMMS_TEMPLATE.join(LF), number: '5' },
  'story-sessions': { span: STORY_TEMPLATE.join(LF), number: '7' },
};
const DEFECT_CASES = [
  { name: 'absent', text: ABSENT_TEXT },
  { name: 'doubled', text: [...STORY_TEMPLATE, ...STORY_TEMPLATE].join(LF) },
];
const COMMS_TEN = makeSpanLines('10', COMMS_TITLE, COMMS_BODY);
const STORY_TEN = makeSpanLines('10', STORY_TITLE, STORY_BODY);
const STORY_ELEVEN = makeSpanLines('11', STORY_TITLE, STORY_BODY);
const BOTH_INPUT = [...ANCHOR_LINES, ...TAIL_LINES];
const BOTH_OUTPUT = [...ANCHOR_LINES, ...COMMS_TEN, ...STORY_ELEVEN, ...TAIL_LINES];
const BOTH_PLAN = [
  { id: 'communication', number: '10', insertAt: ANCHOR_END },
  { id: 'story-sessions', number: '11', insertAt: ANCHOR_END },
];
const EOF_INPUT = ANCHOR_LINES.slice(0, EOF_ANCHOR_END);
const ACCEPTED_CASES = [
  {
    name: 'both absent: inserted spans end before the boundary, never including it',
    input: BOTH_INPUT, output: BOTH_OUTPUT, planned: BOTH_PLAN, eol: LF, cap: UNCAPPED,
  },
  {
    name: 'only story sessions absent: preserve custom Communication and its number',
    input: [...PRESENT_COMMS, ...ANCHOR_LINES, ...TAIL_LINES],
    output: [...PRESENT_COMMS, ...ANCHOR_LINES, ...STORY_TEN, ...TAIL_LINES],
    planned: [{ id: 'story-sessions', number: '10', insertAt: PREFIXED_ANCHOR_END }],
    eol: LF, cap: UNCAPPED,
  },
  {
    name: 'only Communication absent: preserve custom story sessions and their number',
    input: [...PRESENT_STORY, ...ANCHOR_LINES, ...TAIL_LINES],
    output: [...PRESENT_STORY, ...ANCHOR_LINES, ...COMMS_TEN, ...TAIL_LINES],
    planned: [{ id: 'communication', number: '10', insertAt: PREFIXED_ANCHOR_END }],
    eol: LF, cap: UNCAPPED,
  },
  {
    name: 'both present: an over-cap document is unchanged',
    input: [...PRESENT_COMMS, ...PRESENT_STORY, ...ANCHOR_LINES, ...TAIL_LINES],
    output: [...PRESENT_COMMS, ...PRESENT_STORY, ...ANCHOR_LINES, ...TAIL_LINES],
    planned: [], eol: LF, cap: LOW_CAP,
  },
  {
    name: 'CRLF input keeps CRLF throughout both inserted spans',
    input: BOTH_INPUT, output: BOTH_OUTPUT, planned: BOTH_PLAN, eol: CRLF, cap: UNCAPPED,
  },
  {
    name: 'EOF without a line break gains exactly one before the first inserted heading',
    input: EOF_INPUT, output: [...EOF_INPUT, ...COMMS_TEN, ...STORY_ELEVEN, ''],
    planned: [
      { id: 'communication', number: '10', insertAt: EOF_ANCHOR_END },
      { id: 'story-sessions', number: '11', insertAt: EOF_ANCHOR_END },
    ],
    eol: LF, cap: UNCAPPED,
  },
];
const REFUSED_CASES = [
  {
    name: 'doubled Communication withholds the missing story section before checking cap',
    lines: [...DOUBLED_COMMS, ...TAIL_LINES], cap: LOW_CAP,
    expected: { refusal: 'heading-twice', region: 'communication' },
  },
  {
    name: 'doubled story sessions withhold the missing Communication before checking cap',
    lines: [...DOUBLED_STORY, ...TAIL_LINES], cap: LOW_CAP,
    expected: { refusal: 'heading-twice', region: 'story-sessions' },
  },
  {
    name: 'both doubled: template order wins even when story sessions appear first',
    lines: [...DOUBLED_STORY, ...DOUBLED_COMMS, ...TAIL_LINES], cap: LOW_CAP,
    expected: { refusal: 'heading-twice', region: 'communication' },
  },
  {
    name: 'no numbered section refuses anchor-absent before checking cap',
    lines: ['# Rules', 'No numbered section.', ...TAIL_LINES], cap: LOW_CAP,
    expected: { refusal: 'anchor-absent' },
  },
];
const CAP_ENDINGS = [
  { name: 'with final newline', tail: TAIL_LINES },
  { name: 'without final newline', tail: TAIL_LINES.slice(0, -1) },
];

const loaded = await import('./rules-regions.mjs').catch(() => ({}));
const buildInsertPreview = loaded.buildInsertPreview ?? null;
const getInsertPreview = () => {
  if (buildInsertPreview === null) throw new Error('buildInsertPreview is absent');
  return buildInsertPreview;
};
const throwAbsent = (name) => {
  throw new Error('rules-regions.mjs is absent or missing export ' + name);
};
const getRegions = () => loaded.RULES_REGIONS ?? throwAbsent('RULES_REGIONS');
const extractRegionBy = loaded.extractRegionBy ?? (() => throwAbsent('extractRegionBy'));
const readTemplateSpan = loaded.readTemplateSpan ?? (() => throwAbsent('readTemplateSpan'));
const planInsert = loaded.planInsert ?? (() => throwAbsent('planInsert'));
const frontmatterMaxLines = loaded.frontmatterMaxLines ?? (() => throwAbsent('frontmatterMaxLines'));
const readLeafSource = () => {
  getRegions();
  return readFileSync(LEAF_URL, 'utf8');
};

describe('closed region table spec:rules-regions/S1', () => {
  it('freezes the ordered table, entries, keys, matchers, labels and canon sources', () => {
    const regions = getRegions();
    assert.ok(Array.isArray(regions));
    assert.ok(Object.isFrozen(regions));
    assert.deepEqual(regions.map(({ id }) => id), REGION_CASES.map(({ id }) => id));
    for (const [index, expected] of REGION_CASES.entries()) {
      const region = regions[index];
      assert.ok(Object.isFrozen(region));
      assert.deepEqual(Object.keys(region).sort(), REGION_KEYS);
      assert.equal(region.label, makeHeading('x', expected.title));
      assert.equal(region.canon, expected.canon);
      assert.ok(Array.isArray(region.priors));
      assert.equal(region.priors.length, expected.priorCount);
      for (const number of MATCH_NUMBERS) {
        const match = makeHeading(number, expected.title).match(region.headingRe);
        assert.ok(match, expected.id + ' matches heading ' + number);
        assert.equal(match[1], number);
      }
    }
  });

  it('imports no atomic writer or writeFile binding', () => {
    const source = readLeafSource();
    for (const declaration of source.match(IMPORT_RE) ?? []) {
      assert.doesNotMatch(declaration, WRITER_RE);
    }
  });
});

describe('shared extraction spec:rules-regions/S2', () => {
  for (const boundary of BOUNDARIES) {
    it('ends before ' + boundary.name + ' and trims comparison bytes', () => {
      const heading = makeHeading(EXTRACT_NUMBER, STORY_TITLE);
      const lines = [EXTRACT_PREFIX, heading, REGION_BODY, '', '  ', ...boundary.lines];
      const text = lines.join(CRLF);
      const expected = {
        found: true, count: 1, start: EXTRACT_START, end: EXTRACT_END,
        number: EXTRACT_NUMBER, body: [heading, REGION_BODY].join(LF),
      };
      assert.deepEqual(extractRegionBy(text, STORY_RE), expected);
    });
  }

  it('reports zero matches without inventing a span', () => {
    assert.deepEqual(extractRegionBy(ABSENT_TEXT, STORY_RE), NO_REGION);
  });

  it('reports both matches but returns only the first span', () => {
    const heading = makeHeading(EXTRACT_NUMBER, STORY_TITLE);
    const text = [EXTRACT_PREFIX, heading, REGION_BODY, '', '  ', SECOND_HEADING, SECOND_BODY].join(CRLF);
    const expected = {
      found: true, count: 2, start: EXTRACT_START, end: EXTRACT_END,
      number: EXTRACT_NUMBER, body: [heading, REGION_BODY].join(LF),
    };
    assert.deepEqual(extractRegionBy(text, STORY_RE), expected);
  });

  it('retains every existing lens-region export', () => {
    for (const name of RETAINED_FUNCTIONS) {
      assert.equal(typeof lens[name], 'function', name);
    }
    for (const name of RETAINED_VALUES) {
      assert.notEqual(lens[name], undefined, name);
    }
  });
});

describe('insert preview shell arguments', () => {
  it('prints the default insert path and a plain root unquoted', () => {
    const expected = 'node ' + join(HERE, 'rules-insert.mjs') + ' --cwd ' + PLAIN_ROOT;
    assert.equal(getInsertPreview()(PLAIN_ROOT), expected);
  });
  it('prints an explicit plain insert path and root unquoted', () => {
    const expected = 'node ' + PLAIN_INSERT + ' --cwd ' + PLAIN_ROOT;
    assert.equal(getInsertPreview()(PLAIN_ROOT, PLAIN_INSERT), expected);
  });
  for (const root of SHELL_ROOTS) {
    it('passes one exact root argument for ' + JSON.stringify(root), (t) => {
      const build = getInsertPreview();
      const directory = mkdtempSync(join(tmpdir(), 'insert preview-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const insertPath = join(directory, 'argv.mjs');
      writeFileSync(insertPath, PROBE_SOURCE);
      const line = build(root, insertPath);
      const result = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['--cwd', root]);
    });
  }
  for (const code of REJECTED_BYTES) {
    const byte = String.fromCharCode(code);
    for (const [name, root, insertPath] of [
      ['root', PLAIN_ROOT + byte, PLAIN_INSERT],
      ['insertPath', PLAIN_ROOT, PLAIN_INSERT + byte],
    ]) {
      it('withholds a command for byte ' + code + ' in ' + name, () => {
        assert.equal(getInsertPreview()(root, insertPath), '');
      });
    }
  }
});

describe('template span reader spec:rules-regions/S3', () => {
  for (const boundary of BOUNDARIES) {
    it('keeps trailing blank lines before ' + boundary.name + ' in an LF span', () => {
      const text = [EXTRACT_PREFIX, ...STORY_TEMPLATE, ...boundary.lines].join(CRLF);
      assert.deepEqual(readTemplateSpan(text, STORY_RE), SPANS['story-sessions']);
    });
  }

  for (const cell of DEFECT_CASES) {
    it('returns heading-count for a heading ' + cell.name, () => {
      assert.deepEqual(readTemplateSpan(cell.text, STORY_RE), TEMPLATE_DEFECT);
    });
  }

  it('answers directly from text without a path or deps', () => {
    const text = STORY_TEMPLATE.join(LF);
    assert.deepEqual(readTemplateSpan(text, STORY_RE), SPANS['story-sessions']);
  });
});

describe('prior vintage contract spec:rules-regions/S4', () => {
  it('keeps five Communication bodies in vintage order and one story prior spec:session-rules/S2', () => {
    const regions = getRegions();
    const communication = regions.find(({ id }) => id === 'communication');
    const story = regions.find(({ id }) => id === 'story-sessions');
    assert.deepEqual(communication.priors, lens.COMMS_PRIORS);
    assert.equal(communication.priors.length, REGION_CASES[0].priorCount);
    assert.equal(story.priors.length, REGION_CASES[1].priorCount);
    for (const prior of communication.priors) {
      assert.equal(prior.split(LF)[0], makeHeading('x', COMMS_TITLE));
    }
    assert.ok(communication.priors[4].startsWith(communication.priors[3] + LF), 'the newest prior extends the one before it');
  });

  for (const { id, index, bytes, sha256 } of NEW_PRIORS) {
    it('pins the ' + id + ' prior appended by this release by its byte length and sha256', () => {
      const prior = getRegions().find((region) => region.id === id).priors[index];
      assert.equal(typeof prior, 'string', id + ' carries prior ' + index);
      const encoded = Buffer.from(prior, 'utf8');
      assert.equal(encoded.length, bytes);
      assert.equal(createHash('sha256').update(encoded).digest('hex'), sha256);
    });
  }

  it('states the outgoing-canon vintage sentence exactly once', () => {
    const source = readLeafSource();
    const comments = source.split(LF)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('//'))
      .map((line) => line.slice('//'.length).trim())
      .join(' ')
      .replace(WHITESPACE_RE, ' ');
    assert.equal(comments.split(VINTAGE_SENTENCE).length - 1, 1);
  });
});

describe('planInsert state table', () => {
  for (const cell of ACCEPTED_CASES) {
    it(cell.name, () => {
      const text = cell.input.join(cell.eol);
      const expected = { planned: cell.planned, text: cell.output.join(cell.eol) };
      assert.deepEqual(planInsert({ text, spans: SPANS, cap: cell.cap }), expected);
    });
  }

  for (const cell of REFUSED_CASES) {
    it(cell.name, () => {
      const text = cell.lines.join(LF);
      assert.deepEqual(planInsert({ text, spans: SPANS, cap: cell.cap }), cell.expected);
    });
  }

  for (const ending of CAP_ENDINGS) {
    it('names the complete result count ' + ending.name + ' when over cap', () => {
      const text = [...ANCHOR_LINES, ...ending.tail].join(LF);
      const expected = { refusal: 'cap', count: RESULT_COUNT, cap: RESULT_CAP };
      assert.deepEqual(planInsert({ text, spans: SPANS, cap: RESULT_CAP }), expected);
    });

    it('skips the cap guard for null ' + ending.name, () => {
      const text = [...ANCHOR_LINES, ...ending.tail].join(LF);
      const expected = {
        planned: BOTH_PLAN,
        text: [...ANCHOR_LINES, ...COMMS_TEN, ...STORY_ELEVEN, ...ending.tail].join(LF),
      };
      assert.deepEqual(planInsert({ text, spans: SPANS, cap: UNCAPPED }), expected);
    });
  }
});

describe('frontmatter cap reader', () => {
  it('an unclosed frontmatter block with no maxLines caps nothing', () => {
    assert.equal(frontmatterMaxLines(['---', 'type: state', '## Body'].join(LF)), null);
  });
  it('a leading byte-order mark hides no frontmatter', () => {
    const document = ['---', 'type: state', 'maxLines: 150', '---', '# Rules'].join(LF);
    assert.equal(frontmatterMaxLines(BOM_CHAR + document), CAP_WITH_BOM);
  });
});
