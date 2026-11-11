import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as changelog from './archive-changelog.mjs';
import * as issues from './archive-issues.mjs';

// Structural pin (green by construction, a tripwire not a proof): all three archivers read
// documents through the ONE shared tokenizer. A fourth archiver — or a future edit that reaches
// for a quick raw-line regex — reds here instead of quietly reintroducing the class the tokenizer
// retired: private frontmatter regexes, per-raw-line heading scans, fence blindness. Modeled on
// the release-scan / doc-parity precedent of asserting over the sources themselves.
const DIR = dirname(fileURLToPath(import.meta.url));
const ARCHIVERS = ['archive-changelog.mjs', 'archive-issues.mjs', 'archive-decisions.mjs'];
// The two archivers' load closure as module paths, deployed into a fixture's kit folder like a consumer.
const ARCHIVER_CLOSURE = ['archives/archive-changelog.mjs', 'archives/archive-issues.mjs', 'archives/archive-caps.mjs',
  'shared/index.mjs', 'shared/markdown-blocks.mjs', 'shared/project-root.mjs', 'shared/verdict-block.mjs'];
const FIXED_DATE = '2026-09-02';
const FM = '---\ntype: history\nlastUpdated: 2026-07-28\nmaxLines: 700\n---\n';
const INTRO = `${FM}\n# Doc\n\n`;
const MODES = [[], ['--dry-run'], ['--check']];
const ROTATIONS = [
  { name: 'archive-changelog', file: 'docs/ai/changelog.md', module: changelog, parse: changelog.parseChangelogText,
    usage: 'Usage: archive-changelog.mjs [--dry-run|--check] [--hot-days=N] [--warm-days=N] [--today=YYYY-MM-DD]' },
  { name: 'archive-issues', file: 'docs/ai/known_issues.md', module: issues, parse: issues.parseKnownIssues,
    usage: 'Usage: archive-issues.mjs [--dry-run|--check] [--cutoff-days=N] [--today=YYYY-MM-DD]' },
];
const shown = (text) => text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const catchError = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
};
const withRoot = (run) => {
  const root = mkdtempSync(join(tmpdir(), 'archiver-structure-'));
  try {
    mkdirSync(join(root, 'docs/ai'), { recursive: true });
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const snapshot = (root, rel = '') => readdirSync(join(root, rel), { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [[path, 'directory'], ...snapshot(root, path)]
      : [[path, readFileSync(join(root, path)).toString('base64')]];
  });
const runRotation = (rotation, root, argv) => {
  const log = [];
  const logError = [];
  const code = rotation.module.runCli([...argv, '--today=2026-07-28'], {
    root, log: (line) => log.push(line), logError: (line) => logError.push(line),
  });
  return { code, log, logError };
};
const buildRows = ({ name, file }) => [
  { title: 'source absent', text: null },
  ...['LF', 'CRLF'].flatMap((eol) => [
    { title: `ambiguous leading block ${eol}`, text: '---\n\n# Doc\n\n---\n',
      place: name === 'archive-changelog' ? 'docs/ai/changelog.md:3' : 'docs/ai/known_issues.md:3', eol },
    { title: `unclosed fence ${eol}`, text: `${INTRO}~~~markdown\nx\n`,
      place: name === 'archive-changelog' ? 'docs/ai/changelog.md:9' : 'docs/ai/known_issues.md:9', eol },
  ]),
  ...(name === 'archive-changelog' ? [
    { title: 'impossible calendar date', text: `${INTRO}## 2026-02-30 — x\n`, place: 'docs/ai/changelog.md:9' },
    { title: 'entry after footer', text: `${INTRO}## 2026-07-20 — x\n\n## Footer\n\n## 2026-07-19 — y\n`, place: 'docs/ai/changelog.md:13' },
    { title: 'date-shaped non-entry', text: `${INTRO}### 2026-07-20\n`, place: 'docs/ai/changelog.md:9' },
  ] : [
    { title: 'issue heading refusal', text: `${INTRO}## Issue-020 — wrong level\n`, place: 'docs/ai/known_issues.md:9' },
    { title: 'undated claim', text: `${INTRO}### Issue-001 — x\n\n- **Status:** ✅ FIXED\n`, findings: [
      [11, '"- **Status:** ✅ FIXED" claims resolution but carries no recognisable date — add a line-leading `- **Resolved:** YYYY-MM-DD` (or `- **Status:** … FIXED (YYYY-MM-DD)`). Previously this section was silently skipped forever.'],
    ] },
    { title: 'bad resolution date', text: `${INTRO}### Issue-001 — x\n\n- **Resolved:** 2026-02-30\n`, findings: [
      [11, 'resolution marker date "2026-02-30" in "- **Resolved:** 2026-02-30" is not a valid calendar date in one separator form (YYYY-MM-DD or YYYY.MM.DD) — fix the date, then re-run.'],
    ] },
    { title: 'conflicting resolution', text: `${INTRO}### Issue-001 — x\n\n- **Status:** Open\n- **Resolved:** 2026-04-10\n`, findings: [
      [12, '"- **Resolved:** 2026-04-10" contradicts the explicit open status "- **Status:** Open" (line 11) — an issue is either open or resolved; delete the stale line, then re-run.'],
    ] },
    { title: 'two loud sections', text: `${INTRO}### Issue-001 — x\n\n- **Status:** ✅ FIXED\n\n### Issue-002 — y\n\n- **Resolved:** 2026-02-30\n`, findings: [
      [11, '"- **Status:** ✅ FIXED" claims resolution but carries no recognisable date — add a line-leading `- **Resolved:** YYYY-MM-DD` (or `- **Status:** … FIXED (YYYY-MM-DD)`). Previously this section was silently skipped forever.'],
      [15, 'resolution marker date "2026-02-30" in "- **Resolved:** 2026-02-30" is not a valid calendar date in one separator form (YYYY-MM-DD or YYYY.MM.DD) — fix the date, then re-run.'],
    ] },
  ]),
];
const expectedBlock = (rotation, row, text) => {
  const { name, file } = rotation;
  if (row.text === null) return [
    `${name}: FAIL — ${file} not found`, `${file}: the file this rotation reads does not exist`,
    `${name}: REMEDY — create ${file}, then re-run`,
  ];
  if (row.findings) return [
    `${name}: FAIL — sections claiming a resolution the rotation cannot accept in ${file}: ${row.findings.length}`,
    ...row.findings.map(([line, text]) => `${file}:${line}: ${text}`),
    `${name}: REMEDY — fix each section named above, then re-run`,
  ];
  const error = catchError(() => rotation.parse(text, file));
  assert.ok(error.message.startsWith(`${row.place}: `), error.message);
  if (row.eol === 'CRLF') assert.ok(error.message.includes('\r'));
  return [`${name}: FAIL — cannot parse ${file}`,
    `${row.place}: ${shown(error.message.slice(row.place.length + 2))}`,
    `${name}: REMEDY — fix the place named above, then re-run`];
};

describe('spec:archive-rotations/S1 one red-block table for both rotations', () => {
  for (const rotation of ROTATIONS) describe(rotation.name, () => {
    for (const row of buildRows(rotation)) it(`${row.title}: identical refusal in all three modes`, () => {
      const text = row.eol === 'CRLF' ? row.text.replace(/\n/g, '\r\n') : row.text;
      const expected = expectedBlock(rotation, row, text);
      const results = MODES.map((argv) => withRoot((root) => {
        if (text !== null) writeFileSync(join(root, rotation.file), text);
        const before = snapshot(root);
        const result = runRotation(rotation, root, argv);
        assert.deepEqual(snapshot(root), before);
        return result;
      }));
      for (const result of results) {
        assert.equal(result.code, 1);
        assert.deepEqual(result.log, expected);
        assert.deepEqual(result.logError, []);
      }
      assert.deepEqual(results.map(({ log }) => log), MODES.map(() => expected));
    });
  });
  it('a partition that drops a line carries the whole-file place', () => {
    const error = catchError(() => issues.verifySectionPartition([{ lines: ['a'] }], ['a', 'b'], 'docs/ai/known_issues.md'));
    assert.equal(error.exitCode, 1);
    assert.equal(error.place, 'docs/ai/known_issues.md');
  });
});

const CHECK_SEEDS = [
  `${INTRO}## 2026-07-20 — first old\nbody.\n\n## 2026-07-28 — fresh\nbody.\n\n## 2026-07-10 — second old\nbody.\n`,
  `${INTRO}### Issue-001 — first old\n- **Resolved:** 2026-04-10\n\n### Issue-002 — open\n- **Status:** Open\n\n### Issue-003 — second old\n- **Resolved:** 2026-04-11\n`,
];
describe('spec:archive-rotations/S2 check names two findings in file order around a kept unit', () => {
  for (const [index, rotation] of ROTATIONS.entries()) {
    for (const argv of MODES) it(`${rotation.name} ${JSON.stringify(argv)}`, () => withRoot((root) => {
      writeFileSync(join(root, rotation.file), CHECK_SEEDS[index]);
      const result = runRotation(rotation, root, argv);
      assert.equal(result.code, argv.includes('--check') ? 1 : 0);
      assert.deepEqual(result.logError, []);
      if (!argv.includes('--check')) return;
      const findings = index === 0
        ? ['docs/ai/changelog.md:9: 2026.07.20 — first old', 'docs/ai/changelog.md:15: 2026.07.10 — second old']
        : ['docs/ai/known_issues.md:9: ### Issue-001 — first old', 'docs/ai/known_issues.md:15: ### Issue-003 — second old'];
      assert.deepEqual(result.log, [index === 0
        ? 'archive-changelog: FAIL — entries of docs/ai/changelog.md older than 3 days (relative to 2026-07-28): 2'
        : 'archive-issues: FAIL — archivable issues in docs/ai/known_issues.md: 2', ...findings,
      `${rotation.name}: REMEDY — ${index === 0 ? 'rotate' : 'archive'} them with node scripts/agent-workflow/run.mjs ${rotation.name}`]);
    }));
  }
});

describe('spec:archive-rotations/S3 usage and help precede the name read', () => {
  for (const rotation of ROTATIONS) for (const directory of [false, true]) {
    for (const arg of ['--wat', '--a\nb']) it(`${rotation.name} ${shown(arg)}, package directory ${directory}`, () => withRoot((root) => {
      if (directory) mkdirSync(join(root, 'package.json'));
      const result = runRotation(rotation, root, [arg]);
      assert.equal(result.code, 2);
      assert.deepEqual(result.log, [`${rotation.name}: FAIL — unknown argument: ${shown(arg)}`, rotation.usage]);
      assert.deepEqual(result.logError, []);
    }));
    it(`${rotation.name} help, package directory ${directory}`, () => withRoot((root) => {
      if (directory) mkdirSync(join(root, 'package.json'));
      assert.deepEqual(runRotation(rotation, root, ['--help']), { code: 0, log: [rotation.usage], logError: [] });
    }));
  }
});

describe('spec:archive-rotations/S4 unexpected source read errors lead with their failure', () => {
  for (const rotation of ROTATIONS) for (const argv of MODES) {
    it(`${rotation.name} source directory ${JSON.stringify(argv)}`, () => withRoot((root) => {
      mkdirSync(join(root, rotation.file));
      const error = catchError(() => readFileSync(join(root, rotation.file), 'utf8'));
      const firstLine = error.message.split(/\r\n|[\r\n]/)[0];
      const result = runRotation(rotation, root, argv);
      assert.equal(result.code, 1);
      assert.deepEqual(result.logError, []);
      assert.equal(result.log[0], `${rotation.name}: FAIL — unexpected error: ${firstLine}`);
      assert.equal(result.log[1], `${rotation.name}: REMEDY — fix the cause the stack below names, then re-run`);
      assert.ok(result.log.length > 3);
      assert.ok(result.log[2].startsWith('Error: '));
      assert.ok(result.log[2].includes(firstLine));
      for (const line of result.log) assert.doesNotMatch(line, /[\r\n]/);
    }));
  }
});

const buildArchiveHeadings = async (directory, run) => {
  const root = mkdtempSync(join(tmpdir(), 'archiver-name-'));
  try {
    const scripts = join(root, 'scripts', 'agent-workflow');
    for (const path of ARCHIVER_CLOSURE) {
      mkdirSync(dirname(join(scripts, path)), { recursive: true });
      cpSync(join(DIR, '..', path), join(scripts, path));
    }
    if (directory) mkdirSync(join(root, 'package.json'));
    else writeFileSync(join(root, 'package.json'), '{"name":"named-fixture"}');
    const modules = await Promise.all(ROTATIONS.map(({ name }) => import(pathToFileURL(join(scripts, 'archives', `${name}.mjs`)).href)));
    await run(modules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
describe('spec:archive-rotations/S5 project name state table and builders', () => {
  for (const rotation of ROTATIONS) {
    for (const value of [null, '{ not json', 'null', '42', '[1]', '{}', '{"name":""}', '{"name":"named-fixture"}', 'directory']) {
      it(`${rotation.name} readProjectName over ${value ?? 'no file'}`, () => withRoot((root) => {
        if (value === 'directory') mkdirSync(join(root, 'package.json'));
        else if (value !== null) writeFileSync(join(root, 'package.json'), value);
        if (value === 'directory') {
          const error = catchError(() => rotation.module.readProjectName(root));
          assert.ok(error.code);
          assert.notEqual(error.code, 'ENOENT');
        } else assert.equal(rotation.module.readProjectName(root), value === '{"name":"named-fixture"}' ? 'named-fixture' : basename(root));
      }));
    }
    it(`${rotation.name} unreadable name wins in every mode even without the source`, () => {
      const answers = [false, true].flatMap((missing) => MODES.map((argv) => withRoot((root) => {
        mkdirSync(join(root, 'package.json'));
        if (!missing) writeFileSync(join(root, rotation.file), INTRO);
        const error = catchError(() => readFileSync(join(root, 'package.json'), 'utf8'));
        const before = snapshot(root);
        const result = runRotation(rotation, root, argv);
        assert.deepEqual(snapshot(root), before);
        return { result, firstLine: error.message.split(/\r\n|[\r\n]/)[0] };
      })));
      for (const { result, firstLine } of answers) {
        assert.equal(result.code, 1);
        assert.deepEqual(result.log, [`${rotation.name}: FAIL — cannot read package.json: ${firstLine}`,
          "package.json: the project's name cannot be read from it",
          `${rotation.name}: REMEDY — make package.json a readable file, or remove it, then re-run`]);
        assert.deepEqual(result.logError, []);
      }
      for (const { result } of answers) assert.deepEqual(result.log, answers[0].result.log);
    });
  }
  const builders = [
    ['buildRecent', (modules, names) => modules[0].buildRecent([], FIXED_DATE, ...names), '# Changelog WARM Archive — '],
    ['buildCondensedIndex', (modules, names) => modules[0].buildCondensedIndex(changelog.parseChangelogText('## 2026-07-20 — x\n').entries, new Map(), FIXED_DATE, ...names), '# Condensed Index — '],
    ['buildResolvedFile', (modules, names) => modules[1].buildResolvedFile(null, [], FIXED_DATE, ...names), '# Resolved Issues — '],
  ];
  for (const [title, build, heading] of builders) for (const name of [undefined, 'handed-name']) {
    it(`${title} uses ${name ?? 'the deployment name'}`, async () => {
      await buildArchiveHeadings(false, (modules) => assert.ok(build(modules, name === undefined ? [] : [name]).includes(`${heading}${name ?? 'named-fixture'}`)));
    });
  }
  it('both modules import when the deployment package.json is a directory', async () => {
    await buildArchiveHeadings(true, (modules) => {
      for (const module of modules) assert.equal(typeof module.runCli, 'function');
    });
  });
});

describe('every archiver reads through the tokenizer — no raw scan survives', () => {
  for (const name of ARCHIVERS) {
    const source = readFileSync(resolve(DIR, name), 'utf8');

    it(`${name} imports and calls tokenizeMarkdown`, () => {
      assert.match(source, /import \{[^}]*tokenizeMarkdown[^}]*\} from '\.\.\/shared\/index\.mjs'/);
      assert.match(source, /tokenizeMarkdown\(/);
    });

    it(`${name} carries no private frontmatter regex`, () => {
      // The CRLF-fragile `/^(---\n[\s\S]*?\n---\n)/` was triplicated beside each archiver; the
      // tokenizer is now its only home.
      assert.doesNotMatch(source, /---\\n\[\\s\\S\]/);
    });

    it(`${name} never scans raw split lines for headings`, () => {
      // The historical form: iterate `text.split('\n')` and regex-test each raw line. Both loop
      // shapes that carried it are banned; heading recognition belongs to the tokenizer, unit
      // grammars apply to `heading.text` tokens only.
      assert.doesNotMatch(source, /\.forEach\(\(line/);
      assert.doesNotMatch(source, /for \(const line of lines\)/);
    });
  }
});

describe('the archives index, the door suites outside the module use', () => {
  it('re-exports names of the rotator alone, each its very export', async () => {
    const [door, rotator] = await Promise.all([import('./index.mjs'), import('./archive-decisions.mjs')]);
    assert.ok(Object.keys(door).length > 0);
    for (const name of Object.keys(door)) assert.equal(door[name], rotator[name], name);
  });
});
