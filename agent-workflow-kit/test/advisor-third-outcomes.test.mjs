// advisor-third-outcomes.test.mjs — the advisor's THIRD outcomes (feedback-hardening Plan 2, D4/D8),
// exercised against a REAL foreign project rather than a hand-written census.
//
// The class these outcomes close: `probeGatesInert` returned the moment a recognized producer
// preceded the checker, and the section then rendered `no recommendations — flow optimal.` So on a
// TS/vitest project, declaring a `node --test` gate over incidental `scripts/*.mjs` bought an
// attestation of optimality over a tree whose primary sources the coverage domain never assesses —
// the exact false green the runner's own vocabulary exists to prevent, one layer up.
//
// Every row here binds a real `git ls-files` census over a real temp repo (test/foreign-fixture.mjs).
// A faked census would leave the one thing that broke — the JOIN between the declaration arms and
// the tree — untested, and it is the join that produced the false green.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecommendations,
  formatRecommendations,
  main,
  probeGatesInert,
  ACKS_FILE,
  RECOMMENDATIONS_EMPTY_LINE,
  SEVERITY_ATTENTION,
} from '../tools/recommendations.mjs';
import { COVERAGE_PRODUCER_BODY } from '../tools/coverage-producer.mjs';
import { buildForeignFixture, hermeticAdvisorDeps } from '../../scripts/testing/foreign-fixture.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(KIT, 'tools');
const CHECKER = `node "${join(TOOLS, 'coverage-check.mjs')}" --check`;
const ACK_WRITE = join(TOOLS, 'ack-write.mjs');
const PLACED_HOOK_REL = join('.claude', 'hooks', 'agent-workflow-gates.mjs');
const REAL_BUNDLE = readFileSync(join(KIT, 'references', 'hooks', 'gate-approve.mjs'), 'utf8');
const HOOK_WIRING = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"' }] }],
  },
});

const teardowns = [];
after(() => { for (const t of teardowns) t(); });

const fixture = (options) => {
  const built = buildForeignFixture(options);
  teardowns.push(built.teardown);
  return built;
};

const gate = (id, cmd, extra = {}) => ({ id, title: id, ...extra, cmd });
const report = (root) => {
  const built = buildRecommendations({ cwd: root, deps: hermeticAdvisorDeps(root) });
  return {
    ...built,
    item: built.items.find((i) => i.key === 'gates-inert'),
    skip: built.skips.find((s) => s.key === 'gates-inert'),
    hook: built.items.find((i) => i.key === 'gate-hook'),
    readLane: built.items.find((i) => i.key === 'read-lane'),
  };
};
// The optimality claim is the whole subject of this plan, so it is asserted NON-VACUOUSLY. A fixture
// project also leaves velocity, the hook and the source-size practice unconfigured, so `flow optimal`
// would be absent from a full report whatever this probe decided — the assertion would pass over the
// bug it exists to catch. With ONLY this probe in the chain, an empty item list renders EXACTLY the
// frozen empty line, so its presence or absence is an assertion about THIS probe and nothing else.
const soloInert = (root) => formatRecommendations(
  buildRecommendations({ cwd: root, deps: { ...hermeticAdvisorDeps(root), probes: [probeGatesInert] } }),
);
// Re-stage after an edit: the census reads the INDEX, so a file written and not added is invisible.
const stage = (root) => {
  const r = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const writeGates = (root, gates) => {
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), `${JSON.stringify({ gates }, null, 2)}\n`);
  stage(root);
};

describe('advisor third outcomes — gates-inert on a tree the coverage domain cannot reach', () => {
  it('a LIVE pair over a TS-dominated tree fires coverage-domain-narrow — and never the flow-optimal line', () => {
    // The whole point: nothing here is broken. The producer runs, the checker certifies, the run is
    // green — and the honest sentence is that it certified the assessable minority.
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)],
    });
    const built = report(root);
    assert.equal(built.skip, undefined, 'a git tree with a readable declaration is decided, never skipped');
    assert.ok(built.item, 'a live pair over a domain-narrow tree is not optimality');
    assert.equal(built.variant ?? built.item.variant, 'gates-inert.coverage-domain-narrow');
    assert.equal(built.item.severity, SEVERITY_ATTENTION);
    assert.match(built.item.what, /assessable minority/, built.item.what);
    assert.match(built.item.what, /\.ts/, 'the WHAT names what dominates the tree');
    assert.ok(!soloInert(root).includes(RECOMMENDATIONS_EMPTY_LINE), 'flow optimal must not render over an unacknowledged narrow domain');
    // The positive control that makes the line above mean something: the SAME probe over the SAME
    // shaped declaration on a JS tree renders exactly the flow-optimal line. So the absence above is
    // this outcome firing, never the harness being unable to produce the line at all.
    const jsTree = fixture({ tsFiles: 0, jsFiles: 3, gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)] });
    assert.ok(soloInert(jsTree.root).includes(RECOMMENDATIONS_EMPTY_LINE), 'and the harness CAN render it — on a tree the domain reaches');
  });

  it('the narrow outcome converges on the RENDERED ack command — and running that exact command is what converges it', () => {
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)],
    });
    const { item } = report(root);
    assert.ok(item.apply.startsWith(`node ${ACK_WRITE} --lane coverage-domain --fingerprint `), item.apply);
    assert.ok(item.apply.endsWith(`--cwd ${root}`), item.apply);
    // Non-vacuity: the preview's own printed --apply is run, and the item is gone afterwards. A
    // rendered lane that does not converge the item it was rendered for is the defect this asserts.
    const fingerprint = item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1];
    const applied = spawnSync('node', [ACK_WRITE, '--lane', 'coverage-domain', '--fingerprint', fingerprint, '--cwd', root, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ACKS_FILE), 'utf8')), { coverageDomainAck: fingerprint });
    const after = report(root);
    assert.equal(after.item, undefined, 'the acknowledged fact is converged');
    assert.equal(after.skip, undefined, 'and convergence is an answer, never a skipped probe');
    // The section still carries this fixture's OTHER offers (an unwired hook, no source-size gate),
    // so the empty line is not the assertion here — the disappearance of the narrow sentence is.
    assert.doesNotMatch(formatRecommendations(after), /assessable minority/, 'and the sentence it converged is gone from the render');
  });

  it('the ack binds the FACT, not the counts: growth keeps it, a NEW unsupported language re-fires it', () => {
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)],
    });
    const fingerprint = report(root).item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1];
    writeFileSync(join(root, ACKS_FILE), `${JSON.stringify({ coverageDomainAck: fingerprint })}\n`);
    // More of the SAME language is the ordinary life of a project. A count-bound ack would re-fire
    // here on every added file, which turns an acknowledgment into a nag.
    writeFileSync(join(root, 'packages', 'app', 'src', 'grown.ts'), 'export const grown = 1;\n');
    stage(root);
    assert.equal(report(root).item, undefined, 'the acknowledged fact is unchanged by growth');
    // A new unsupported EXTENSION is a different fact — the maintainer acknowledged a .ts tree.
    writeFileSync(join(root, 'packages', 'app', 'src', 'view.tsx'), 'export const view = null;\n');
    stage(root);
    const after = report(root);
    assert.ok(after.item, 'a changed fact re-fires the item');
    assert.match(after.item.what, /\.tsx/, after.item.what);
    assert.notEqual(after.item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1], fingerprint, 'and it renders a FRESH fingerprint');
  });

  it('a DEAD pair over the same tree fires producer-unrecognized: the marker/drop remedies, never a fill preview', () => {
    const { root } = fixture({ tsFiles: 3, gates: [gate('lint', 'true'), gate('coverage-check', CHECKER)] });
    const { item } = report(root);
    assert.ok(item, 'a checker with nothing writing its lcov is inert whatever the tree');
    assert.equal(item.variant, 'gates-inert.producer-unrecognized');
    assert.equal(item.severity, SEVERITY_ATTENTION);
    // The WHAT says only what the probe KNOWS. The retired claim — that the suite is inexpressible —
    // was false over a project carrying a recognizable body under a script name the fill never
    // offers, so it is pinned ABSENT in both directions.
    assert.match(item.what, /NO producer declared and none offerable/, item.what);
    assert.doesNotMatch(item.what, /cannot be expressed/, item.what);
    assert.ok(item.apply.startsWith('HAND-APPLY:'), item.apply);
    assert.match(item.apply, /"lcovProducer": true/, 'the honest remedy is marking the real producer');
    assert.match(item.apply, /or drop coverage-check/, 'or dropping the checker — those are the two');
    assert.doesNotMatch(item.apply, /gates-init/, 'never the fill preview: this suite has no form the fill can offer');
    // `node --test` may appear ONLY as the named residual, never as the prescription: the two
    // remedies above are the whole of what this arm tells the reader to do.
    assert.doesNotMatch(item.apply, /declare a .*node --test/, 'never a node --test prescription over a project that has no such suite');
    assert.match(item.apply, /a recognized body under another name/, 'and the fill\'s name screen is named as the gap it is');
  });

  it('an OFFERABLE producer disqualifies the arm — a TS-dominant tree with a node --test script gets the fill preview', () => {
    // The census answers how much of the tree the coverage DOMAIN reaches. It says nothing about
    // whether a producer can be EXPRESSED, and conflating the two would tell a project whose own
    // package.json carries a `node --test` script that its suite is inexpressible — while a working
    // preview sat one line away. Without this row the arm above stays green over that mistake.
    const { root } = fixture({
      tsFiles: 3,
      testScript: 'node --test',
      gates: [gate('lint', 'true'), gate('coverage-check', CHECKER)],
    });
    const { item } = report(root);
    assert.ok(item, 'the dead pair is still a dead pair');
    assert.equal(item.variant, 'gates-inert', `the fill can help here, so the base arm owns it: ${item.apply}`);
    assert.match(item.apply, /gates-init\.mjs --cwd .* --only test$/, `and its apply names the producer to declare: ${item.apply}`);
  });

  it('an offered producer whose id COLLIDES is still expressible — the arm keys on the offer, not on what the fill may select', () => {
    // The fill filters its selection by id collision, and reusing that filtered answer for the
    // EXPRESSIBILITY claim is the same falsity one corner further in: this project has a `node --test`
    // script, so its suite is expressible; only the preview is blocked, because the id is taken.
    const { root } = fixture({
      tsFiles: 3,
      testScript: 'node --test',
      gates: [gate('test', 'true'), gate('coverage-check', CHECKER)],
    });
    const { item } = report(root);
    assert.ok(item, 'the dead pair is still a dead pair');
    assert.equal(item.variant, 'gates-inert', `the suite is expressible, so this is the base arm: ${item.what}`);
    assert.doesNotMatch(item.what, /cannot be expressed/, item.what);
    assert.ok(item.apply.startsWith('HAND-APPLY:'), `and the fill cannot help, so the edit is the maintainer's: ${item.apply}`);
    // The REASON is the assertion, not the prefix: a hand-apply that blames an absent producer sends
    // the reader looking for a script they already have, and this row would stay green over it.
    assert.doesNotMatch(item.apply, /no offerable producer exists here/, `a producer IS offerable — it collides: ${item.apply}`);
    assert.match(item.apply, /its id "test" is already declared/, `the conflicting id is named: ${item.apply}`);
    assert.match(item.apply, /rename that gate, or repoint it/, `and the two edits that clear it: ${item.apply}`);
  });

  it('a marker on the CHECKER ITSELF is not its own producer — the dead pair still fires producer-unrecognized', () => {
    // Producer-ness is POSITIONAL everywhere in this family precisely so a marker on the checker
    // cannot self-pair. A producer-anywhere test that forgot to exclude the checker rows would read
    // this declaration as having a producer and route a dead pair into the ordering arm instead.
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('lint', 'true'), gate('coverage-check', CHECKER, { lcovProducer: true })],
    });
    const { item } = report(root);
    assert.ok(item, 'nothing writes the lcov this checker reads');
    assert.equal(item.variant, 'gates-inert.producer-unrecognized', `a self-marked checker paired with itself: ${item.what}`);
  });

  it('the ack lane is CLOSED to the dead pair: removing the producer fires it DESPITE a recorded narrow ack', () => {
    // The acknowledgment says "this tree is narrow", never "stop checking this declaration". Letting
    // it silence a dead pair would re-open the false green through the convergence lane itself.
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)],
    });
    const fingerprint = report(root).item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1];
    writeFileSync(join(root, ACKS_FILE), `${JSON.stringify({ coverageDomainAck: fingerprint })}\n`);
    assert.equal(report(root).item, undefined, 'acknowledged while the pair is live');
    writeGates(root, [gate('lint', 'true'), gate('coverage-check', CHECKER)]);
    const after = report(root);
    assert.ok(after.item, 'the recorded ack does not survive the producer being removed');
    assert.equal(after.item.variant, 'gates-inert.producer-unrecognized');
  });

  it('a producer AFTER the checker keeps the ORDERING arm byte-unchanged — recognized cmd and marker alike', () => {
    // A producer that exists is one MOVE away from working, and the marker prescription would teach
    // the wrong fix there. Both forms of "it exists, in the wrong place" must reach the same arm.
    for (const [label, producer] of [
      ['a recognized cmd', gate('unit-tests', COVERAGE_PRODUCER_BODY)],
      ['a marker claim', gate('suite', 'vitest run --coverage', { lcovProducer: true })],
    ]) {
      const { root } = fixture({ tsFiles: 3, gates: [gate('coverage-check', CHECKER), producer] });
      const { item } = report(root);
      assert.ok(item, label);
      assert.equal(item.variant, 'gates-inert', `${label}: the base ordering arm, not a third outcome`);
      assert.match(item.what, /has no producer before it/, label);
      assert.match(item.apply, /declare or MOVE a suite gate/, `${label}: the MOVE remedy survives`);
    }
  });

  it('a marker-claimed producer BEFORE the checker is a live pair — the narrow outcome, never the dead one', () => {
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('suite', 'vitest run --coverage', { lcovProducer: true }), gate('coverage-check', CHECKER)],
    });
    const { item } = report(root);
    assert.ok(item, 'the tree is still narrow');
    assert.equal(item.variant, 'gates-inert.coverage-domain-narrow', 'the marker made the pair live, exactly as a recognized cmd would');
  });

  it('STRICT dominance: a JS-dominant tree and a TIE are both silent, and their existing arms are byte-unchanged', () => {
    for (const [label, counts] of [
      ['dominant-assessable', { tsFiles: 0, jsFiles: 3 }],
      ['a tie (a stray .d.ts beside real JS)', { tsFiles: 2, jsFiles: 2 }],
    ]) {
      const live = fixture({ ...counts, gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)] });
      const liveReport = report(live.root);
      assert.equal(liveReport.item, undefined, `${label}: a live pair over a reachable domain is converged`);
      assert.equal(liveReport.skip, undefined, `${label}: and answered, never skipped`);
      // The dead pair on the SAME tree must keep the pre-existing cause-A wording and its fill lane.
      const dead = fixture({ ...counts, gates: [gate('lint', 'true'), gate('coverage-check', CHECKER)] });
      const deadItem = report(dead.root).item;
      assert.ok(deadItem, `${label}: a dead pair is still a dead pair`);
      assert.equal(deadItem.variant, 'gates-inert', `${label}: the base arm, not a third outcome`);
      assert.match(deadItem.what, /certifies nothing this run, or reads a stale lcov/, label);
    }
  });

  it('the --json payload carries the exact VARIANT identifier a consumer can assert on', () => {
    const { root } = fixture({
      tsFiles: 3,
      gates: [gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)],
    });
    const r = main(['--cwd', root, '--json'], { deps: hermeticAdvisorDeps(root) });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.items.some((i) => i.variant === 'gates-inert.coverage-domain-narrow'),
      'the exact outcome is machine-readable, not only prose the registry may reword',
    );
    assert.ok(!r.stdout.includes(RECOMMENDATIONS_EMPTY_LINE));
  });
});

describe('advisor third outcomes — an UNAVAILABLE census never buys an optimality claim', () => {
  // The census is a spawned `git ls-files`; a non-git tree has no answer at all. D2's invariant is
  // that the absence surfaces, never converges — and the two arms surface it differently because
  // only one of them would otherwise render nothing.
  const nonGit = (gates) => {
    const root = fixture({ tsFiles: 1, gates }).root;
    rmSync(join(root, '.git'), { recursive: true, force: true });
    return root;
  };

  it('a LIVE pair in a non-git tree is a STATED SKIP — the one arm where silence would be the false green', () => {
    const root = nonGit([gate('unit-tests', COVERAGE_PRODUCER_BODY), gate('coverage-check', CHECKER)]);
    const built = report(root);
    assert.equal(built.item, undefined, 'nothing is claimed about a tree that could not be read');
    assert.ok(built.skip, 'and the failure is stated');
    assert.match(built.skip.reason, /census unavailable/, built.skip.reason);
    assert.ok(!soloInert(root).includes(RECOMMENDATIONS_EMPTY_LINE), 'a skip withholds the optimality claim');
  });

  it('a DEAD pair in a non-git tree keeps the existing cause-A arm — the defect is real without any census', () => {
    const root = nonGit([gate('lint', 'true'), gate('coverage-check', CHECKER)]);
    const built = report(root);
    assert.ok(built.item, 'a checker with no producer is inert whether or not the tree can be censused');
    assert.equal(built.item.variant, 'gates-inert', 'the arm that needs no census states it');
    assert.equal(built.skip, undefined, 'and an item that renders needs no skip beside it to block optimality');
  });

  it('only the census\'s OWN unavailability is absorbed — a programming error surfaces as a stated skip', () => {
    // The dead-pair arm deliberately continues without a census. If that absorption were unconditional
    // it would launder a bug into an ordinary cause-A diagnosis, which is the quietest way for a
    // broken probe to keep reporting confidently.
    const { root } = fixture({ tsFiles: 3, gates: [gate('lint', 'true'), gate('coverage-check', CHECKER)] });
    const boom = () => { throw new TypeError('census leaf regression'); };
    const built = buildRecommendations({ cwd: root, deps: { ...hermeticAdvisorDeps(root), takeCensus: boom } });
    assert.equal(built.items.find((i) => i.key === 'gates-inert'), undefined, 'no confident item over a broken probe');
    assert.match(built.skips.find((s) => s.key === 'gates-inert').reason, /census leaf regression/);
  });
});

describe('advisor third outcomes — the marker refresh path (D8)', () => {
  // The placed hook validates the declaration through its OWN baked copy and goes dark on any key it
  // does not know. So a marker-carrying declaration under a pre-marker hook silently switches
  // auto-approval off: everything still works, and every gate prompts again, with no error anywhere.
  const MARKER_GATES = [gate('suite', 'vitest run --coverage', { lcovProducer: true })];
  const PLAIN_GATES = [gate('suite', 'vitest run --coverage')];
  const hookProject = ({ gates = MARKER_GATES, hook = '// an old placed hook\n', lanes } = {}) => {
    const extraFiles = { '.claude/settings.json': HOOK_WIRING };
    if (hook !== null) extraFiles[PLACED_HOOK_REL] = hook;
    if (lanes !== undefined) extraFiles['docs/ai/lanes.json'] = lanes;
    return fixture({ tsFiles: 1, gates, extraFiles }).root;
  };

  it('a marker declaration under a STALE placed hook fires the reseed arm, and RUNNING that recovery converges it', () => {
    const root = hookProject();
    const { hook } = report(root);
    assert.ok(hook, 'a configured capability silently switched off is attention, not silence');
    assert.equal(hook.variant, 'gate-hook.marker-stale');
    assert.equal(hook.severity, SEVERITY_ATTENTION);
    assert.match(hook.what, /lcovProducer/, hook.what);
    // `gate-hook --apply` places only an ABSENT target, so remove-then-reseed is the ONLY lane that
    // converges — and the rm is absolute, so running it from any cwd can only delete this hook.
    assert.ok(hook.apply.startsWith(`HAND-APPLY: rm ${join(root, PLACED_HOOK_REL)}, then node `), hook.apply);
    // EXECUTED, not matched. A rendered recovery that does not converge the item it was rendered for
    // is this repo's standing defect, and a test that only reads the string would stay green through
    // exactly that — including if the writer ever stopped placing the hook at all.
    const applied = hook.apply.match(/^HAND-APPLY: rm (\S+), then node (\S+) --apply --cwd (\S+)$/);
    assert.ok(applied, `the recovery parses as the two steps it claims to be: ${hook.apply}`);
    rmSync(applied[1]);
    const reseed = spawnSync('node', [applied[2], '--apply', '--cwd', applied[3]], { encoding: 'utf8' });
    assert.equal(reseed.status, 0, `${reseed.stdout}${reseed.stderr}`);
    assert.equal(readFileSync(join(root, PLACED_HOOK_REL), 'utf8'), REAL_BUNDLE, 'the reseeded hook IS the current bundle');
    assert.equal(report(root).hook, undefined, 'and the item it was rendered for is gone');
  });

  it('the arm keys on the marker KEY, not its value — lcovProducer false darkens an older hook just the same', () => {
    // A pre-marker hook rejects a key it does not know whatever that key says, so the honest
    // condition is presence. Keying on the literal true would leave a valid declaration silently
    // un-auto-approved with nothing reporting it.
    const root = hookProject({ gates: [gate('suite', 'vitest run --coverage', { lcovProducer: false })] });
    const { hook } = report(root);
    assert.ok(hook, 'a false marker is still a key an older hook cannot honor');
    assert.equal(hook.variant, 'gate-hook.marker-stale');
  });

  it('the arm is MARKER-SCOPED and CURRENCY-scoped: no marker, or a byte-current hook, is silent', () => {
    for (const [label, options] of [
      ['a stale hook under a declaration with no marker', { gates: PLAIN_GATES }],
      ['a byte-current hook under a marker declaration', { hook: REAL_BUNDLE }],
    ]) {
      const built = report(hookProject(options));
      assert.equal(built.hook, undefined, `${label}: nothing to say`);
      assert.equal(built.skips.find((s) => s.key === 'gate-hook'), undefined, `${label}: and no skip either`);
    }
  });

  it('a MISSING placed hook belongs to the place offers, never to this arm', () => {
    const built = report(hookProject({ hook: null }));
    assert.equal(built.hook, undefined, 'a hook that is not there cannot be reseeded');
    assert.ok(built.readLane, 'the wired-but-unplaced state has its own item');
    assert.equal(built.readLane.variant, 'read-lane.missing', 'and that item PLACES one');
  });

  it('a SYMLINKED or NON-REGULAR placed hook is a stated SKIP — never a currency verdict read through a link', () => {
    // The retired byte-compare used a plain readFile, which FOLLOWS a symlink: a hook linked at the
    // real bundle would have read as current. A wrong verdict is worse than a missing one.
    const linked = hookProject({ hook: null });
    mkdirSync(join(linked, '.claude', 'hooks'), { recursive: true });
    symlinkSync(join(KIT, 'references', 'hooks', 'gate-approve.mjs'), join(linked, PLACED_HOOK_REL));
    const viaLink = report(linked);
    assert.equal(viaLink.hook, undefined, 'a symlink is not a placed hook');
    assert.match(viaLink.skips.find((s) => s.key === 'gate-hook').reason, /symlink.*not a regular file/, 'and the refusal says so');

    const dir = hookProject({ hook: null });
    mkdirSync(join(dir, PLACED_HOOK_REL), { recursive: true });
    const viaDir = report(dir);
    assert.equal(viaDir.hook, undefined, 'a directory at the path is not a placed hook either');
    assert.match(viaDir.skips.find((s) => s.key === 'gate-hook').reason, /directory.*not a regular file/);
  });

  it('an UNREADABLE placed hook is a stated SKIP, never a reseed recommendation over bytes nobody read', () => {
    const root = hookProject();
    const built = buildRecommendations({
      cwd: root,
      deps: { ...hermeticAdvisorDeps(root), readRegularFileNoFollow: () => ({ outcome: 'error', code: 'EACCES' }) },
    });
    assert.equal(built.items.find((i) => i.key === 'gate-hook'), undefined);
    assert.match(built.skips.find((s) => s.key === 'gate-hook').reason, /unreadable \(EACCES\)/);
  });

  it('ONE render per condition: marker + an ENABLED read-lane + a stale hook is ONE item, and it is the one whose CAUSE is true', () => {
    // Both arms carry the same remove-then-reseed recovery, so which one renders is decided by which
    // sentence is TRUE. `read-lane.stale` says "an old hook never reads lanes.json" — false for a
    // hook that postdates the read-lane and merely predates the marker key, which is exactly the
    // deployment this arm exists for. The marker arm's cause holds in every such case.
    const root = hookProject({ lanes: JSON.stringify({ readLane: true }) });
    const built = report(root);
    assert.ok(built.hook, 'the marker arm owns it');
    assert.equal(built.hook.variant, 'gate-hook.marker-stale');
    assert.equal(built.readLane, undefined, 'and the read-lane item does not repeat it under a false cause');
    const staleItems = built.items.filter((i) => /rm .*agent-workflow-gates\.mjs/.test(i.apply));
    assert.equal(staleItems.length, 1, `exactly one reseed recovery renders: ${staleItems.map((i) => i.key).join(', ')}`);
  });

  it('the deferral binds the RENDERED item, not a re-derived condition — a hook that changes between the two probes is still reported', () => {
    // Each probe reads the placed hook itself. Suppressing on "the declaration carries the marker"
    // would let the gate-hook probe see a CURRENT hook and stay silent while the read-lane probe sees
    // a STALE one and defers to an item that was never added — a dark lane reported by nobody. The
    // seam hands out CURRENT first and STALE after, which is exactly that race made deterministic.
    const root = hookProject({ lanes: JSON.stringify({ readLane: true }) });
    const bundle = readFileSync(join(KIT, 'references', 'hooks', 'gate-approve.mjs'), 'utf8');
    let reads = 0;
    const built = buildRecommendations({
      cwd: root,
      deps: {
        ...hermeticAdvisorDeps(root),
        readRegularFileNoFollow: () => {
          reads += 1;
          return { outcome: 'ok', content: reads === 1 ? bundle : '// an old placed hook\n' };
        },
      },
    });
    assert.ok(reads >= 2, 'both probes really read the hook independently');
    const recoveries = built.items.filter((i) => /agent-workflow-gates\.mjs/.test(i.apply));
    assert.equal(recoveries.length, 1, `the dark lane is reported exactly once: ${built.items.map((i) => i.variant).join(', ')}`);
    assert.equal(recoveries[0].variant, 'read-lane.stale', 'by the probe that actually saw it stale');
  });

  it('the deferral is SCOPED: with no marker, an enabled lane over a stale hook still fires read-lane.stale', () => {
    const root = hookProject({ gates: PLAIN_GATES, lanes: JSON.stringify({ readLane: true }) });
    const built = report(root);
    assert.equal(built.hook, undefined, 'nothing for the marker arm to say');
    assert.ok(built.readLane, 'and the arm that owns a plain stale hook is untouched');
    assert.equal(built.readLane.variant, 'read-lane.stale');
  });
});
