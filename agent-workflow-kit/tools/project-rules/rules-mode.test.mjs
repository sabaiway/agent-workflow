// The rules mode doc and the upgrade's words that offer it. Contract: docs/ai/specs/kit/project-rules/rules-mode.md.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const KIT_ROOT = new URL('../../', import.meta.url);

const readDoc = (rel) => readFileSync(new URL(rel, KIT_ROOT), 'utf8');
const readRules = () => readDoc('references/modes/rules.md');
const readUpgrade = () => readDoc('references/modes/upgrade.md');
const findLine = (text, prefix) => text.split('\n').find((line) => line.trimStart().startsWith(prefix)) ?? '';
const assertPhrases = (text, phrases, what) => {
  const missing = phrases.filter((phrase) => !text.includes(phrase));
  assert.deepEqual(missing, [], `${what} carries every phrase`);
};

describe('spec:project-rules/S31 the rules mode doc changes the local file on a yes and keeps the effective file built', () => {
  it('opens with its header, the none declaration and the Requires line naming command-shapes.md', () => {
    const text = readRules();
    assert.equal(text.split('\n')[0], '### Mode: rules');
    assertPhrases(text, [
      '\n<!-- opt-in-capability: none — ',
      '\nRequires: ${CLAUDE_SKILL_DIR}/references/shared/command-shapes.md\n',
    ], 'the mode doc head');
  });

  it('starts with the ensure run --only rules and says the effective file is built, never written by hand', () => {
    assertPhrases(readRules(), [
      '**1. Start with the ensure.** Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only rules --cwd <project>`',
      'The effective file is built, never written by hand: this mode moves no edit out of it',
    ], 'the opening step');
  });

  it('changes a rule by showing the local text and writing it on the yes, the request and the yes being the consent', () => {
    assertPhrases(readRules(), [
      'Show the exact text you will write to `docs/ai/rules/local/<theme>.md`, its frontmatter included',
      "holding only the user's own rules and never a copy of the kit's, and write it on the user's yes.",
      'That request and that yes are the consent for the write of the local file.',
    ], 'the change step');
  });

  it('moves a kit-file edit whose line says carries your edit, whatever the token, then deletes the kit file; drops the local file on request', () => {
    assertPhrases(readRules(), [
      'When an ensure line for the kit file says it `carries your edit`, whatever token the run printed',
      'compare `docs/ai/rules/<theme>.md` with the bundled `${CLAUDE_SKILL_DIR}/references/rules/<theme>.md`',
      "write the user's changes, by meaning, into the local file (shown first, written on the yes), then delete the kit file.",
      "**Drop the local rules.** On the user's request, delete the local file",
    ], 'the move and drop steps');
  });

  it('merges and records on pending, and stops with nothing further written on failed or a non-zero record command', () => {
    assertPhrases(readRules(), [
      '**3. After each of these, run the ensure again.** On `pending`, do the merge its line states, show the user what changed in the final rules, then run the record command the line prints with the sha256 of the merged file',
      'When an ensure run answers `failed`, or the record command exits non-zero, relay the line and stop: write, delete and record nothing further, and run no closing check as if the change held.',
    ], 'the pending and refusal steps');
  });

  it('ends with the --only index run and the --check run answering current, and states what it never does', () => {
    assertPhrases(readRules(), [
      'Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only index --cwd <project>`, then `node ${CLAUDE_SKILL_DIR}/tools/project-rules/rules-cli.mjs --check --cwd <project>`, which answers `current` for every theme',
      "It never writes the effective file except with the merge a `pending` line states, never changes the kit file's text (the move deletes the file whole and the ensure seeds it again), and never writes a local file without the user's request.",
    ], 'the closing checks and the never sentence');
  });
});

describe('spec:project-rules/S32 upgrade.md offers the rules mode and relays the Memory Map rows', () => {
  it('the project-rules paragraph offers the mode on a carries-your-edit line and names the line words, not the token', () => {
    const paragraph = findLine(readUpgrade(), '**What the project-rules ensure does.**');
    assertPhrases(paragraph, [
      "A kit-file line saying it carries your edit, whatever the run's token, is offered `/agent-workflow-kit rules` to move the edit into the local file.",
      '(an edit is kept, its line saying it carries your edit)',
    ], 'the project-rules paragraph');
    assert.ok(!paragraph.includes('(an edit is kept → `customized-preserved`)'), 'the parenthetical no longer names the token');
  });

  it('the pointers row and paragraph keep one Memory Map row per theme, the zero-diff clause asking the rows present', () => {
    const text = readUpgrade();
    assertPhrases(findLine(text, '1. `pointers`'), [
      'per Memory Map row of a rules theme: added · already present · refreshed · skipped (reported)',
    ], 'the pointers run-list row');
    assertPhrases(findLine(text, '**`pointers` — the bounded pointers.**'), [
      'zero-diff when all are already present + filled and the Memory Map rows present',
      'The same call keeps one Memory Map row per project-rules theme',
    ], 'the pointers paragraph');
  });

  it('the step-4 report and step 8 relay the Memory Map row outcome beside the pointers', () => {
    const text = readUpgrade();
    assertPhrases(findLine(text, "- **Report step 3's outcome in plain language**"), [
      'and each Memory Map row the same way (or *refreshed*)',
    ], 'the step-4 report bullet');
    assertPhrases(findLine(text, '8. Re-stamp'), ['the `pointers` slots and Memory Map rows'], 'step 8');
  });
});
