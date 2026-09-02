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
const ARCHIVER_CLOSURE = ['archive-changelog.mjs', 'archive-issues.mjs', 'archive-caps.mjs', 'markdown-blocks.mjs'];
const FIXED_DATE = '2026-09-02';
const MALFORMED_PACKAGE_JSON = '{ not json';
const NAMED_PACKAGE_JSON = '{"name":"named-fixture"}';
const NAMED_FIXTURE = 'named-fixture';

const buildArchiveHeadings = async (packageJson) => {
  const root = mkdtempSync(join(tmpdir(), 'archiver-name-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  for (const name of ARCHIVER_CLOSURE) cpSync(join(DIR, name), join(scripts, name));
  if (packageJson !== null) writeFileSync(join(root, 'package.json'), packageJson);
  const changelog = await import(pathToFileURL(join(scripts, 'archive-changelog.mjs')).href);
  const issues = await import(pathToFileURL(join(scripts, 'archive-issues.mjs')).href);
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
});

describe('every archiver reads through the tokenizer — no raw scan survives', () => {
  for (const name of ARCHIVERS) {
    const source = readFileSync(resolve(DIR, name), 'utf8');

    it(`${name} imports and calls tokenizeMarkdown`, () => {
      assert.match(source, /import \{[^}]*tokenizeMarkdown[^}]*\} from '\.\/markdown-blocks\.mjs'/);
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
