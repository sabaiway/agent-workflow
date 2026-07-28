import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural pin (green by construction, a tripwire not a proof): all three archivers read
// documents through the ONE shared tokenizer. A fourth archiver — or a future edit that reaches
// for a quick raw-line regex — reds here instead of quietly reintroducing the class the tokenizer
// retired: private frontmatter regexes, per-raw-line heading scans, fence blindness. Modeled on
// the release-scan / doc-parity precedent of asserting over the sources themselves.

const DIR = dirname(fileURLToPath(import.meta.url));
const ARCHIVERS = ['archive-changelog.mjs', 'archive-issues.mjs', 'archive-decisions.mjs'];

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
