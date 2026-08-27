// Structure guard for the published, front-facing READMEs. The hero/altitude of these pages is
// reviewed by humans; the *mechanical* invariants below are easy to regress on an edit, so they are
// pinned here instead of re-checked by hand each time. See decisions AD-009 (the kit README is the
// npm-facing page; ASCII visuals must render on mobile GitHub + npm, links must resolve).
//
// Asserts, per README:
//   1. every line inside a ``` fenced block is ≤ 78 *display* columns (mobile/npm safe);
//   2. every in-page anchor `](#slug)` resolves to a heading in the same file (GitHub slug rules);
//   3. every local (non-http, non-anchor) link target exists on disk, relative to the README.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// agent-workflow-kit/test → repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const READMES = [
  'README.md', // family front door
  'agent-workflow-kit/README.md',
  'agent-workflow-memory/README.md',
];

// East-Asian-aware display width: wide/fullwidth = 2 cols, combining marks = 0, else 1. Box-drawing
// and arrows are narrow (1), so this matches how a fixed-width terminal / GitHub code block renders.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f]/;
const displayWidth = (line) => {
  let w = 0;
  for (const ch of line) {
    if (COMBINING.test(ch)) continue;
    w += WIDE.test(ch) ? 2 : 1;
  }
  return w;
};

// GitHub heading-slug rules: lowercase, drop everything that is not a letter/number/space/`_`/`-`
// (this removes emoji + punctuation), then turn each whitespace char into a hyphen. A leading emoji
// leaves a leading space → a leading hyphen (e.g. "## 🚀 Install" → "-install"), matching GitHub.
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const headingSlugs = (lines) => {
  const slugs = new Set();
  for (const l of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(l);
    if (m) slugs.add(slug(m[1]));
  }
  return slugs;
};

const present = (rel) => existsSync(resolve(repoRoot, rel));

describe('published READMEs — structure guard (AD-009)', () => {
  for (const rel of READMES) {
    const path = resolve(repoRoot, rel);
    if (!present(rel)) continue; // partial checkout — nothing to assert

    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n');

    it(`${rel}: fenced ASCII visuals are ≤ 78 display columns`, () => {
      let inFence = false;
      const over = [];
      lines.forEach((l, i) => {
        if (l.startsWith('```')) {
          inFence = !inFence;
          return;
        }
        if (inFence) {
          const w = displayWidth(l);
          if (w > 78) over.push(`L${i + 1} (${w} cols): ${l}`);
        }
      });
      assert.deepEqual(over, [], `${rel}: fenced lines exceed 78 columns (mobile/npm clip):\n${over.join('\n')}`);
    });

    it(`${rel}: every in-page anchor resolves to a heading`, () => {
      const slugs = headingSlugs(lines);
      const anchors = [...raw.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
      const missing = anchors.filter((a) => !slugs.has(a));
      assert.deepEqual(missing, [], `${rel}: in-page anchors with no matching heading: ${JSON.stringify(missing)}`);
    });

    it(`${rel}: every local link target exists on disk`, () => {
      const base = dirname(path);
      const missing = [];
      for (const m of raw.matchAll(/\]\(([^)]+)\)/g)) {
        const href = m[1];
        if (/^(#|https?:|mailto:)/.test(href)) continue;
        const target = href.split('#')[0].split(/\s/)[0];
        if (!target) continue; // pure-anchor handled above
        if (!existsSync(normalize(join(base, target)))) missing.push(href);
      }
      assert.deepEqual(missing, [], `${rel}: local links pointing nowhere: ${JSON.stringify(missing)}`);
    });
  }
});

// The recipe vocabulary is FIVE names on every normative shipped surface (AD-124). Known-prior stores
// (inject-methodology.mjs, orchestration-config.mjs) legitimately keep the four-name text and are not
// normative, so the scan is by path, never repo-wide.
describe('shipped surfaces name five recipes, never the retired four-name list', () => {
  const FOUR_ONLY = /Solo\s*\/\s*Reviewed\s*\/\s*Council\s*\/\s*Delegated(?!\s*\/\s*Subagent)/u;
  const normative = [
    'agent-workflow-kit/tools/commands.mjs',
    'agent-workflow-kit/README.md',
    'agent-workflow-kit/SKILL.md',
    'agent-workflow-memory/README.md',
    'agent-workflow-memory/SKILL.md',
    ...readdirSync(resolve(repoRoot, 'agent-workflow-kit/references/modes')).map((f) => `agent-workflow-kit/references/modes/${f}`),
    ...readdirSync(resolve(repoRoot, 'agent-workflow-kit/references/shared')).map((f) => `agent-workflow-kit/references/shared/${f}`),
  ].filter((rel) => /\.(md|mjs)$/.test(rel) && present(rel));
  it('no normative kit or memory surface lists Solo / Reviewed / Council / Delegated without Subagent', () => {
    assert.ok(normative.length >= 10, 'the scan covers the shipped surfaces, never an empty list');
    const stale = normative.filter((rel) => FOUR_ONLY.test(readFileSync(resolve(repoRoot, rel), 'utf8')));
    assert.deepEqual(stale, [], 'every recipe list names the fifth recipe');
  });
});
