import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Structural pin (green by construction, a tripwire not a proof): all three archivers read
// documents through the ONE shared tokenizer. A fourth archiver — or a future edit that reaches
// for a quick raw-line regex — reds here instead of quietly reintroducing the class the tokenizer
// retired: private frontmatter regexes, per-raw-line heading scans, fence blindness. Modeled on
// the release-scan / doc-parity precedent of asserting over the sources themselves.

const DIR = dirname(fileURLToPath(import.meta.url));
const ARCHIVERS = ['archive-changelog.mjs', 'archive-issues.mjs', 'archive-decisions.mjs'];
// The two archivers' load closure as module paths, deployed into a fixture's kit folder like a consumer.
const ARCHIVER_CLOSURE = ['archives/archive-changelog.mjs', 'archives/archive-issues.mjs', 'archives/archive-caps.mjs',
  'shared/index.mjs', 'shared/markdown-blocks.mjs', 'shared/project-root.mjs'];
const FIXED_DATE = '2026-09-02';
const MALFORMED_PACKAGE_JSON = '{ not json';
const NAMED_PACKAGE_JSON = '{"name":"named-fixture"}';
const NAMELESS_PACKAGE_JSON = '{"version":"1.0.0"}';
const NAMED_FIXTURE = 'named-fixture';

const buildArchiveHeadings = async (packageJson) => {
  const root = mkdtempSync(join(tmpdir(), 'archiver-name-'));
  const scripts = join(root, 'scripts', 'agent-workflow');
  for (const path of ARCHIVER_CLOSURE) {
    mkdirSync(dirname(join(scripts, path)), { recursive: true });
    cpSync(join(DIR, '..', path), join(scripts, path));
  }
  if (packageJson !== null) writeFileSync(join(root, 'package.json'), packageJson);
  const changelog = await import(pathToFileURL(join(scripts, 'archives', 'archive-changelog.mjs')).href);
  const issues = await import(pathToFileURL(join(scripts, 'archives', 'archive-issues.mjs')).href);
  const result = {
    fallback: basename(root),
    changelog: changelog.buildRecent([], FIXED_DATE),
    issues: issues.buildResolvedFile(null, [], FIXED_DATE),
  };
  rmSync(root, { recursive: true, force: true });
  return result;
};

const assertArchiveHeadings = (result, projectName) => {
  assert.ok(result.changelog.includes(`# Changelog WARM Archive \u2014 ${projectName}`));
  assert.ok(result.issues.includes(`# Resolved Issues \u2014 ${projectName}`));
};

describe('the archivers head their archives with the directory basename when no package.json, or a malformed one, names the project', () => {
  it('no package.json names the directory basename', async () => {
    const result = await buildArchiveHeadings(null);
    assertArchiveHeadings(result, result.fallback);
  });

  it('a malformed package.json names the directory basename', async () => {
    const result = await buildArchiveHeadings(MALFORMED_PACKAGE_JSON);
    assertArchiveHeadings(result, result.fallback);
  });

  it('a named package.json wins', async () => {
    const result = await buildArchiveHeadings(NAMED_PACKAGE_JSON);
    assertArchiveHeadings(result, NAMED_FIXTURE);
  });

  it('in place, each archiver\'s readProjectName(root) answers the basename unless a package.json there names the project', async () => {
    for (const archiver of ['./archive-changelog.mjs', './archive-issues.mjs']) {
      const { readProjectName } = await import(archiver);
      assert.equal(typeof readProjectName, 'function', `${archiver} exports readProjectName`);
      for (const [packageJson, expected] of [[null, null], [MALFORMED_PACKAGE_JSON, null], [NAMELESS_PACKAGE_JSON, null], [NAMED_PACKAGE_JSON, NAMED_FIXTURE]]) {
        const root = mkdtempSync(join(tmpdir(), 'archiver-name-'));
        try {
          if (packageJson !== null) writeFileSync(join(root, 'package.json'), packageJson);
          assert.equal(readProjectName(root), expected ?? basename(root), `${archiver} over ${packageJson}`);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
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
