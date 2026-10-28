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
const scriptEnsure = () => flat(region(UPGRADE, 'ensure the SCRIPTS', 'ensure the ADR-store enforcement pair', 'script ensure'));
const pairEnsure = () => flat(region(UPGRADE, 'ensure the ADR-store enforcement pair', 'ensure the SPEC LAYER', 'ADR pair ensure'));
const specEnsure = () => flat(region(UPGRADE, 'ensure the SPEC LAYER', 'ensure the NAVIGATOR', 'spec-layer ensure'));

describe('SKILL.md and contracts.md — the standalone upgrade keeps the deployed scripts current', () => {
  it('spec:standalone-scripts/S1 the script ensure, its survey and its component', () => {
    const at = (anchor) => UPGRADE.indexOf(anchor);
    const order = ['ensure the THREE seeded', 'ensure the SCRIPTS', 'ensure the ADR-store enforcement pair', 'ensure the SPEC LAYER'].map(at);
    assert.ok(order.every((x, i) => x !== -1 && (i === 0 || order[i - 1] < x)), 'three-config ensure < script ensure < ADR pair ensure < spec layer');
    const scripts = scriptEnsure();
    has(scripts, [
      'every `*.mjs` of `${CLAUDE_SKILL_DIR}/references/scripts/`',
      '`_expect-shim.mjs` included',
      '`archive-decisions.mjs`', '`archive-decisions.test.mjs`', '`spec-schema.mjs`', '`spec-schema.test.mjs`',
      '`markdown-blocks.mjs`', '`_expect-shim.mjs`',
      '`ls -ld scripts`', 'no trailing slash', 'non-following', 'never a test that follows a link', 'ENOENT',
      'any other failed probe is named with its error, nothing is written and the reconcile STOPs',
      '`cmp`',
      'holding any node other than a regular file',
      'this ensure writes nothing, and the reconcile STOPs', 'An absent `scripts` holds no bundled name: the component is not accepted and this ensure writes nothing',
      'judged once',
      'accepted when a bundled name outside the seed names stands in `scripts/` as any node',
      'owns every bundled name, standing or absent, and the pair ensures copy nothing',
      'writes every standing bundled name and every bundled module a standing one imports, and places nothing else',
      'does not run and judges no component',
    ], 'script ensure');
    assert.doesNotMatch(scripts, /\bkit\b/i, 'script ensure: names no kit');
    assert.doesNotMatch(scripts, /catalog/i, 'script ensure: names no catalog');
    const stepFive = flat(region(UPGRADE, '5. Reconcile drift', '6. **Never regenerate', 'step 5'));
    has(stepFive, ['never a file of `references/scripts/`'], 'step 5');
  });

  it('spec:standalone-scripts/S2 the write asks no question and keeps no copy', () => {
    const scripts = scriptEnsure();
    has(scripts, [
      'with no question', 'no preview and no yes precede it', 'no copy of an overwritten file is kept',
      'overwritten in place', 'create-only',
      'each written file is compared with `cmp` to the bundled body',
      'names every file already written', 'rolls nothing back',
      'never that the user edited it',
    ], 'script write');
    const first = scripts.indexOf('`install-git-hooks.mjs` first');
    const suite = scripts.indexOf('`install-git-hooks.test.mjs`', first);
    const repoExec = scripts.indexOf('`install-git-hooks-repo-exec.test.mjs`', suite);
    const rest = scripts.indexOf('every other file by name', repoExec);
    assert.ok(first !== -1 && suite > first && repoExec > suite && rest > repoExec, 'installer, its two suites, then every other file by name');
    assert.doesNotMatch(scripts, /kept[- ]aside/i, 'script write: no kept-aside path');
  });

  it('spec:standalone-scripts/S3 the ADR store is brought current by the rotator after every run', () => {
    const pair = pairEnsure();
    has(pair, [
      '`node scripts/archive-decisions.mjs --ensure-current` with no question',
      'relay its summary line',
      'the ADR store, current after every run',
      '`scripts/archive-decisions.mjs` and `scripts/markdown-blocks.mjs`',
      'regular files `cmp` finds equal to their bundled bodies',
      'in delegated mode, also when the composition root kept them current',
      '`brought-current`', '1: refused', '3: failed after a write',
      'whether a re-run completes the move or the closing check failed',
      'STOPs, every written script kept and nothing put back',
      "the composition root's upgrade owns that file",
      'nothing of the store is touched until the first run that finds both current',
      '`docs/ai/history/decisions-archive.md`', '`decisions-archive-early.md`', 'pending move',
    ], 'ADR pair ensure');
    const whole = flat(SKILL);
    for (const retired of ['--migrate', '--write-navigator', 'snapshot']) assert.equal(count(whole, retired), 0, `SKILL.md still names ${retired}`);
  });

  it('spec:standalone-scripts/S4 the retired preserve clauses are gone and the reports name the writes', () => {
    const whole = flat(SKILL).toLowerCase();
    for (const retired of [
      'preserve an existing file byte-for-byte', 'never overwrites a deployed script', "composition root's own upgrade",
      'without consent leave the tree untouched', 'remove the just-copied pair',
    ]) assert.equal(count(whole, retired), 0, `SKILL.md still says ${retired}`);
    const handOff = "an existing file is the script ensure's (in delegated mode, the composition root's)";
    has(pairEnsure(), [handOff], 'ADR pair ensure');
    has(specEnsure(), [handOff], 'spec-layer ensure');
    const equalHead = flat(region(UPGRADE, '**Then**, if the stamp **equals** the head', '3. Show the relevant', 'equal-head report'));
    assert.match(equalHead, /changed something.{0,80}what changed/i, 'equal-head report: the 80-character pin');
    has(equalHead, ['naming each written script and the move'], 'equal-head report');
    const restamp = flat(region(UPGRADE, '7. **Re-stamp**', undefined, 'step 7'));
    has(restamp, ['naming each file step 2 wrote and the ADR move'], 'step 7');
    has(scriptEnsure(), ['runs no hook installer', '`scripts/pre-commit.local` runs once the installer has run'], 'script ensure');
  });

  it('spec:standalone-scripts/S5 the reserved names and channels, the gotcha and bootstrap step 8', () => {
    const opening = flat(CONTRACTS.slice(0, CONTRACTS.indexOf('\n---')));
    assert.ok(opening.includes('Reserved names and channels'), 'contracts.md: the opening paragraph names the section');
    assert.equal(count(CONTRACTS, '## Reserved names and channels'), 1, 'contracts.md: one section heading');
    const reserved = flat(region(CONTRACTS, '## Reserved names and channels', undefined, 'reserved section'));
    has(reserved, [
      'never a customization', 'the next upgrade overwrites it',
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
    const steps = flat(region(SKILL, '8. **Offer enforcement', '10. **', 'bootstrap steps 8-9'));
    has(steps, [
      'each file already standing in `scripts/` at a bundled name', 'with no copy of it kept', 'created when absent',
      'a link, dangling or not, or a file', 'holding any node other than a regular file',
      'nothing is copied', 'continues as on a no',
    ], 'bootstrap steps 8-9');
  });
});
