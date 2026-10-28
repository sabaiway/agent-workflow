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

  it('drops the local file on request, and neither the mode doc nor the README rules row offers a move of a kit-file edit or names carries your edit', () => {
    const rules = readRules();
    const row = findLine(readDoc('README.md'), '| `/agent-workflow-kit rules` |');
    const moves = (text) => ['carries your edit', 'Move an edit', 'moves an edit', 'delete the kit file'].filter((phrase) => text.includes(phrase));
    assert.deepEqual([moves(rules), moves(row)], [[], []], 'no move offered in the mode doc, then the README rules row');
    assertPhrases(rules, ["**Drop the local rules.** On the user's request, delete the local file"], 'the drop step');
    assertPhrases(row, ['and checks it is current. It also drops your local rules on request.'], 'the README rules row');
  });

  it('merges and records on pending, and stops with nothing further written on failed or a non-zero record command', () => {
    assertPhrases(readRules(), [
      '**3. After each of the two rules routes, run the ensure again.** On `pending`, do the merge its line states, show the user what changed in the final rules, then run the record command the line prints with the sha256 of the merged file',
      'When an ensure run answers `failed`, the record command exits non-zero, or the `--override` command exits non-zero, relay the line and stop: write, delete and record nothing further, and run no closing check as if the change held.',
    ], 'the pending and refusal steps');
  });

  it('ends with the --only index run and the --check run answering current, and states what it never does', () => {
    assertPhrases(readRules(), [
      'Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only index --cwd <project>`, then `node ${CLAUDE_SKILL_DIR}/tools/project-rules/rules-cli.mjs --check --cwd <project>`, which answers `current` for every theme',
      "It never writes the effective file except with the merge a `pending` line states, never changes the kit file's text, and never writes a local file without the user's request.",
    ], 'the closing checks and the never sentence');
  });
});

describe('spec:project-rules/S34 the rules mode routes a number to the size check override, never into a rules file', () => {
  it('shows the exact --override command with only the numbers the user named, --kit-default to return, run on the yes', () => {
    assertPhrases(readRules(), [
      "- **Change a size limit.** A request to change a limit of the size check, its value or its tolerance, is never written into a rules file: the kit keeps those numbers in its code",
      'Show the exact `node ${CLAUDE_SKILL_DIR}/tools/source-size-check.mjs --override <id> [--value <n>] [--tolerance <p>] --reason "<text>" --cwd <project>` command, passing only the numbers the user named',
      "with `--kit-default` in their place to return to the kit's numbers; run it on the user's yes and relay its lines.",
    ], 'the number route');
  });

  it('ends the number route with no ensure, merge, record or closing check', () => {
    assertPhrases(readRules(), [
      'This route ends there: it runs no ensure, merge, record or closing check.',
    ], 'the end of the number route');
  });

  it('counts three routes in step 2, names the two rules routes in step 3, and stops on a non-zero --override', () => {
    assertPhrases(readRules(), [
      '\n**2. Do what the user asks — one of three.**\n',
      '\n**3. After each of the two rules routes, run the ensure again.**',
      '**It stops on a refusal.** When an ensure run answers `failed`, the record command exits non-zero, or the `--override` command exits non-zero, relay the line and stop',
    ], 'the step headers and the stop');
  });
});

const PROJECT_RULES_PARAGRAPH = "**What the project-rules ensure does.** Each theme's kit file `docs/ai/rules/<theme>.md` is seeded, refreshed from a body a release shipped, and any other body replaced by the template with no question and no copy kept, its line naming the local rules file `docs/ai/rules/local/<theme>.md` for a rule meant to last; with no local file its effective copy and record are rebuilt. With a local file it writes neither: `pending` prints the merge to do and its record command — do the merge, show the user what changed, then run that command.";
const RULES_TOKEN_ARM = '; rules → `seeded` / `refreshed` / `regenerated` / `pending` / `already-current`; index → ';
const WRITTEN_OVER = 'written over by the next upgrade with no question and no copy kept';

describe('spec:project-rules/S32 upgrade.md states the project-rules words, contracts.md names the kit rules files as written over, the entry-block row and paragraph name one row per theme, and no report names a Memory Map row', () => {
  it('the project-rules paragraph is exactly the words rules-ensure states, and the rules token arm names no customized-preserved', () => {
    const text = readUpgrade();
    assert.deepEqual([findLine(text, '**What the project-rules ensure does.**').trimStart(), text.includes(RULES_TOKEN_ARM)], [PROJECT_RULES_PARAGRAPH, true]);
  });

  it("contracts.md's Reserved names and channels names docs/ai/rules/<theme>.md in its written-over sentence", () => {
    const contracts = readDoc('references/contracts.md');
    const section = contracts.slice(contracts.indexOf('## Reserved names and channels')).split('\n## ')[0].replace(/\s+/g, ' ');
    const sentence = section.split('. ').find((one) => one.includes(WRITTEN_OVER)) ?? '';
    assert.ok(sentence.includes('docs/ai/rules/<theme>.md'), sentence);
  });

  it('the entry-block run-list row and its paragraph each say the kit block carries one row per theme', () => {
    const lines = readUpgrade().split('\n').map((line) => line.trimStart());
    const row = lines.find((line) => /^[0-9]+\. `entry-block`/.test(line)) ?? '';
    const paragraph = lines.find((line) => line.startsWith('**`entry-block`')) ?? '';
    for (const [what, text] of [['the entry-block run-list row', row], ['the entry-block paragraph', paragraph]]) {
      assert.match(text, /\bone (?:table )?row per (?:rules )?theme\b/, `${what}: ${text}`);
    }
  });

  it('neither the step-4 report nor step 8 names a Memory Map row of a theme', () => {
    const text = readUpgrade();
    const reports = [findLine(text, "- **Report step 3's outcome in plain language**"), findLine(text, '8. Re-stamp')];
    assert.ok(reports.every((line) => line.length > 0), 'both reports are found');
    assert.deepEqual(reports.filter((line) => line.includes('Memory Map row')), []);
  });
});

describe('spec:project-rules/S38 the mode waits for the engine before it writes or drops the local file of an engine-homed theme', () => {
  it('runs the ensure --only rules first, and on the no-engine line relays it and stops with the engine install command, no local file written or dropped', () => {
    const route = readRules().split('\n\n').find((paragraph) => paragraph.includes('engine-homed')) ?? '';
    assertPhrases(route, [
      'before',
      '--only rules',
      'no installed engine supplies',
      'npx @sabaiway/agent-workflow-engine@latest init',
      'writing and dropping no local file',
    ], 'the engine-homed theme route');
    assert.match(route, /relay/i);
    assert.match(route, /\bstops?\b/);
  });
});
