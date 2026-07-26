// settings-row-consumers.test.mjs — the drift guard for a cross-cutting settings FIELD.
//
// AD-078 added `retired` to the settings registry. The plan's own invariant said "enumerate every
// consumer"; that enumeration was done from memory, got 4 of 7, and the council then found the
// missing ones ONE PER ROUND across three consecutive final passes — the advisor copy, the status
// view model, the status renderer, `procedures`. Every miss rendered a DEAD knob as an active
// setting on some surface, which is exactly the confusion the retirement exists to prevent.
//
// The lesson is not "sweep harder": a prose instruction to enumerate consumers has no checker. This
// file is the checker. Any module that BUILDS a settings row — an object literal carrying `key:`
// alongside `source:` (an effective-value row) or `allowed:` (a contract row) — must also name every
// field in FIELDS. Adding the next cross-cutting field means adding it here and going red until each
// consumer carries it.
//
// STATED RESIDUAL: this proves the field is NAMED where rows are built. It cannot prove a renderer
// does something SENSIBLE with it — that stays each surface's own test.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(kitRoot, 'tools');

// The cross-cutting fields a settings row must carry wherever one is constructed.
const FIELDS = ['retired'];

// A row-building site: an object literal naming `key:` together with `source:` or `allowed:`.
// Deliberately syntactic — the point is to catch a NEW consumer written the same shape as the
// existing ones, which is how every miss in this class happened.
const ROW_RE = /\{[^{}]*\bkey:[^{}]*\b(?:source|allowed):[^{}]*\}/g;

const sources = readdirSync(TOOLS)
  .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
  .map((f) => ({ file: f, text: readFileSync(join(TOOLS, f), 'utf8') }));

describe('settings rows — every consumer carries the cross-cutting fields', () => {
  it('the guard finds the row-building sites at all (non-vacuous)', () => {
    const hits = sources.flatMap(({ file, text }) => (text.match(ROW_RE) ?? []).map((m) => ({ file, m })));
    assert.ok(hits.length >= 4, `expected several row-building sites, found ${hits.length}`);
    const files = new Set(hits.map((h) => h.file));
    for (const expected of ['bridge-settings-read.mjs', 'bridge-settings.mjs', 'view-model.mjs', 'procedures.mjs']) {
      assert.ok(files.has(expected), `${expected} builds a settings row and must be scanned`);
    }
  });

  for (const field of FIELDS) {
    it(`every settings row names \`${field}\``, () => {
      const missing = [];
      for (const { file, text } of sources) {
        for (const row of text.match(ROW_RE) ?? []) {
          if (!row.includes(`${field}:`)) missing.push(`${file}: ${row.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
      assert.deepEqual(missing, [], `these settings rows drop \`${field}\` — a consumer that drops it renders a dead knob as an active setting:\n${missing.join('\n')}`);
    });
  }

  // The mirror direction: a field in FIELDS must actually exist in the manifest schema, so this
  // guard can never enforce a field the manifests do not define.
  it('every guarded field is documented in the manifest schema', () => {
    const schema = readFileSync(join(TOOLS, 'manifest', 'schema.md'), 'utf8');
    for (const field of FIELDS) {
      assert.match(schema, new RegExp(`\`${field}\``), `${field} must be documented in schema.md before it can be guarded`);
    }
  });
});
