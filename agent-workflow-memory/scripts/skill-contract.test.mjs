// SKILL.md is the procedure an agent EXECUTES — its load-bearing contract lines need pins the same
// way code constants do (the doc-parity idea, memory-side). Pins here are token-level: tight enough
// to fail when the contract line is dropped or inverted, loose enough to survive prose rewording.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8');
const CONTRACTS = readFileSync(join(HERE, '..', 'references', 'contracts.md'), 'utf8');

const flat = (text) => text.replace(/\*\*/g, '').replace(/\s+/g, ' ');
const count = (text, token) => text.split(token).length - 1;

function region(text, from, to, name) {
  const start = text.indexOf(from);
  assert.ok(start !== -1, `${name}: missing anchor ${from}`);
  if (to === undefined) return text.slice(start);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end !== -1, `${name}: missing anchor ${to}`);
  return text.slice(start, end);
}

function has(text, tokens, name) {
  for (const token of tokens) assert.ok(text.includes(token), `${name}: ${token}`);
}

const UPGRADE = region(SKILL, '### Mode: upgrade', '## Version disclosure', 'upgrade section');
const KIT_FOLDER_COMMAND = 'node ${CLAUDE_SKILL_DIR}/scripts/kit-folder.mjs --project <target>';
const stepTwo = () => flat(region(UPGRADE, 'ensure the THREE seeded', 'ensure the NAVIGATOR', 'step 2'));
const equalHeadReport = () => flat(region(UPGRADE, '**Then**, if the stamp **equals** the head', '3. Show the relevant', 'equal-head report'));
const restampReport = () => flat(region(UPGRADE, '7. **Re-stamp**', undefined, 'step 7'));

describe('SKILL.md and contracts.md — the standalone upgrade keeps the deployed scripts current', () => {
  it('spec:standalone-scripts/S1 step 2 relays the script between the configs and store root, delegated to the composition root', () => {
    const at = (anchor) => UPGRADE.indexOf(anchor);
    const order = ['ensure the THREE seeded', KIT_FOLDER_COMMAND, 'docs/ai/specs/index.md', 'ensure the NAVIGATOR'].map(at);
    assert.ok(order.every((value, index) => value !== -1 && (index === 0 || order[index - 1] < value)), 'three-config ensure < script < store-root seed < NAVIGATOR');
    const steps = stepTwo();
    has(steps, [KIT_FOLDER_COMMAND, 'relay every line', 'STOP', 'non-zero exit', "composition root's upgrade owns", 'kit folder'], 'step 2');
    assert.match(steps, /delegated mode.{0,100}script does not run/i, 'delegated mode skips the script');
    assert.match(steps, /STOP.{0,60}non-zero exit|non-zero exit.{0,60}STOP/, 'a failed script stops the upgrade');
    for (const retired of ['ls -ld', 'cmp', 'references/scripts/*']) assert.equal(count(steps, retired), 0, `step 2 still names ${retired}`);
    const stepFive = flat(region(UPGRADE, '5. Reconcile drift', '6. **Never regenerate', 'step 5'));
    has(stepFive, ['never a file of `references/scripts/`'], 'step 5');
  });

  it('spec:standalone-scripts/S2 bootstrap previews enforcement, applies on yes and switches the hook through run.mjs', () => {
    const steps = flat(region(SKILL, '8. **Offer enforcement', '10. **', 'bootstrap steps 8-9'));
    const preview = [...steps.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      .find((command) => command.startsWith(KIT_FOLDER_COMMAND) && command.includes('--dry-run') && command.includes('--enforcement'));
    assert.ok(preview, 'step 8 previews the script with --dry-run and --enforcement');
    has(steps, ['same line', 'without `--dry-run`', 'hidden', 'relay', 'commit-together line', 'non-zero exit', 'named', 'continues as on a no'], 'bootstrap steps 8-9');
    assert.match(steps, /each file.{0,80}write over/, 'preview names every overwritten file');
    assert.match(steps, /hidden.{0,180}(?:but|except|no).{0,40}commit-together line/i, 'hidden deployment suppresses the commit line');
    for (const token of ['preview-first', 'on a yes copy']) assert.equal(count(steps, token), 1, `bootstrap steps 8-9: ${token}`);
    const stepNine = flat(region(SKILL, '9. **', '10. **', 'bootstrap step 9'));
    has(stepNine, ['node scripts/agent-workflow/run.mjs install-git-hooks'], 'bootstrap step 9');
  });

  it('spec:standalone-scripts/S3 the script owns the ADR store run and the skill relays its lines and pending move', () => {
    const steps = stepTwo();
    has(steps, ['ADR store: ', '--ensure-current', 'relay', 'docs/ai/history/decisions-archive.md', 'decisions-archive-early.md'], 'ADR store');
    assert.match(steps, /pending[- ]move/, 'no Node evidence leaves a named pending move');
    const whole = flat(SKILL);
    assert.doesNotMatch(steps, /node scripts\/(?:agent-workflow\/archives\/|archive-decisions\.mjs)/, 'step 2 runs no rotator itself');
    assert.doesNotMatch(whole, /node scripts\/(?:agent-workflow\/archives\/|archive-decisions\.mjs)/, 'SKILL.md runs no rotator itself');
    for (const mention of whole.matchAll(/.{0,100}--ensure-current.{0,100}/g)) {
      assert.match(mention[0], /\bscript(?:'s)?\b/, '--ensure-current belongs to the script');
    }
    for (const retired of ['--migrate', '--write-navigator', 'snapshot']) assert.equal(count(whole, retired), 0, `SKILL.md still names ${retired}`);
  });

  it('spec:standalone-scripts/S4 both reports name writes, removals, the ADR move and hook ask with wiring and grep legend', () => {
    const whole = flat(SKILL).toLowerCase();
    for (const retired of ['preserve an existing file byte-for-byte', 'never overwrites a deployed script', 'migrate-gates']) {
      assert.equal(count(whole, retired), 0, `SKILL.md still says ${retired}`);
    }
    const equalHead = equalHeadReport();
    assert.match(equalHead, /changed something.{0,80}what changed/i, 'equal-head report: the 80-character pin');
    for (const [name, report] of [['equal-head report', equalHead], ['step 7', restampReport()]]) {
      has(report, ['ADR move', 'lines after a removal', 'hook switch', 'one chat yes'], name);
      assert.match(report, /each (?:written file|file.{0,30}(?:written|wrote))/, `${name}: every written file`);
      assert.match(report, /each (?:removed flat file|flat file removed)/, `${name}: every removed flat file`);
    }
    has(flat(UPGRADE), ['`package.json`', 'documented', 'rewrites', 'wiring'], 'package wiring');
    has(stepTwo(), [
      'node scripts/<file>', 'node scripts/agent-workflow/run.mjs <name>', 'arguments',
      'scripts/agent-workflow/<path>', 'suite', 'support file', 'no deployed path',
    ], 'grep legend');
  });

  it('spec:standalone-scripts/S5 the guide uses the kit folder unconditionally, command wiring and reserved channels', async () => {
    const visibility = flat(region(CONTRACTS, '## Visibility contract', '## Communication contract', 'visibility'));
    has(visibility, ['/scripts/agent-workflow/', 'whatever the enforcement answer'], 'visibility');
    const wiring = flat(region(CONTRACTS, '- **visible**', '- **hidden**', 'visible wiring'));
    const hook = flat(region(CONTRACTS, '- **hidden**', '**Visibility changes', 'hidden hook'));
    for (const [name, text] of [['wiring', wiring], ['hook', hook]]) has(text, ['node scripts/agent-workflow/run.mjs'], name);
    assert.doesNotMatch(visibility, /\/scripts\/\*\.mjs/, 'visibility names no flat ignore line');
    const { FLAT_NAMES } = await import('./flat-scripts.mjs').catch(() => ({}));
    assert.ok(Array.isArray(FLAT_NAMES), 'flat-scripts.mjs exports FLAT_NAMES');
    for (const name of FLAT_NAMES) assert.ok(!visibility.includes(`scripts/${name}`), `visibility still names flat path ${name}`);
    assert.doesNotMatch(visibility, /node scripts\/<[^>]+>/, 'the hook uses the kit command');
    const opening = flat(CONTRACTS.slice(0, CONTRACTS.indexOf('\n---')));
    assert.ok(opening.includes('Reserved names and channels'), 'contracts.md: the opening paragraph names the section');
    assert.equal(count(CONTRACTS, '## Reserved names and channels'), 1, 'contracts.md: one section heading');
    const reserved = flat(region(CONTRACTS, '## Reserved names and channels', undefined, 'reserved section'));
    has(reserved, [
      '`scripts/agent-workflow/`', 'never a customization', 'the next upgrade overwrites it',
      '`scripts/pre-commit.local`', 'under names of your own', 'a config a script reads',
      '`.agent-workflow/` is reserved', 'the substrate writes nothing there',
      'never writes `scripts/pre-commit.local` or a script of your own',
    ], 'reserved section');
    const gotchas = region(SKILL, '## Gotchas', '## Setup contracts', 'Gotchas');
    const enforcement = gotchas.indexOf('**Enforcement is offered on every project.**');
    const pointer = gotchas.indexOf('](references/contracts.md#reserved-names-and-channels)');
    assert.ok(enforcement !== -1 && pointer > enforcement, 'Gotchas: the reserved-names bullet stands after the enforcement bullet');
    const contractsRef = region(SKILL, '## References', undefined, 'References')
      .split('\n- ')
      .find((bullet) => bullet.startsWith('[`references/contracts.md`]'));
    assert.ok(contractsRef, 'References: the contracts.md line');
    has(flat(contractsRef), ['reserved names and channels'], 'References');
  });

  it('spec:standalone-scripts/S15 residual reports relay the lines, switch only on its line and retain the hand route', async () => {
    const report = equalHeadReport();
    has(report, ['nothing changed', 'switch line', 'skip', 'pending-move', 'kept', 'flat path', 'relay'], 'residual report');
    assert.match(report, /not[- ]the[- ]kit's/, "residual report: the not-the-kit's line");
    assert.match(report, /never.{0,100}nothing changed|nothing changed.{0,100}never/, 'residuals are never a no-op');
    assert.match(report, /ask.{0,60}(?:only (?:with|when)|when).{0,60}switch line/, 'asks the switch only with its line');
    const steps = stepTwo();
    has(steps, [
      'scripts/*.test.mjs', 'outside `FLAT_NAMES`', 'flat suite', "not the kit's", 'node --test scripts/<file>',
      'scripts/pre-commit.local', 'git grep -n -F --untracked', "':!scripts/agent-workflow'",
      '${CLAUDE_SKILL_DIR}/scripts/flat-scripts.mjs', 'FLAT_NAMES',
      'visible', 'scripts/agent-workflow/', 'package.json', 'removed', 'one change', 'merge', 'branch',
    ], 'hand route');
    const { FLAT_NAMES } = await import('./flat-scripts.mjs').catch(() => ({}));
    assert.ok(Array.isArray(FLAT_NAMES), 'flat-scripts.mjs exports FLAT_NAMES');
    const outsideKitPaths = steps.replace(/scripts\/agent-workflow\/[^\s`'"]*/g, '');
    for (const name of FLAT_NAMES) assert.ok(!outsideKitPaths.includes(name), `hand route copies flat name ${name}`);
  });
});
