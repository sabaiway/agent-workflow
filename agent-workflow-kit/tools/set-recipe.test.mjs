import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './set-recipe.mjs';
import { CONFIG_REL, CANON_README, serializeConfig } from './orchestration-config.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const detect = (codex, agy) => () => [
  { name: CODEX, readiness: codex },
  { name: AGY, readiness: agy },
];

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'set-recipe-'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const write = (json) => writeFileSync(join(cwd, CONFIG_REL), json);
const read = () => readFileSync(join(cwd, CONFIG_REL), 'utf8');
const run = (argv, { codex = READY, agy = READY } = {}) => main(argv, { cwd, detect: detect(codex, agy) });

describe('set-recipe — arg parsing (usage → exit 2)', () => {
  it('a bare recipe (no activity) → exit 2 (name the activity)', () => {
    const r = run(['--set', 'review=council']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /name the activity/);
  });
  it('unknown slot / invalid recipe-for-slot → exit 2', () => {
    assert.equal(run(['--set', 'plan-authoring.execute=delegated']).code, 2);
    assert.equal(run(['--set', 'plan-authoring.review=delegated']).code, 2);
  });
  it('a duplicate op for the same activity.slot → exit 2', () => {
    const r = run(['--set', 'plan-execution.review=council', '--set', 'plan-execution.review=solo']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /duplicate op/);
  });
  it('--write with zero ops → exit 2', () => {
    const r = run(['--write']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /nothing to write/);
  });
  it('--unset with a stray recipe → exit 2', () => {
    assert.equal(run(['--unset', 'plan-authoring.review=solo']).code, 2);
  });
  it('--help is read-only, exit 0, names the writer posture', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /never commits/i);
    assert.match(r.stdout, /Previews by default/);
  });
});

describe('set-recipe — preview by default (writes NOTHING)', () => {
  it('shows the changed slot (from → to) + effective recipe; no file written', () => {
    const r = run(['--set', 'plan-authoring.review=council'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /plan-authoring\.review: \(computed default\) → council/);
    assert.match(r.stdout, /effective here: council/);
    assert.match(r.stdout, /preview/);
    assert.equal(existsSync(join(cwd, CONFIG_REL)), false, 'preview writes nothing');
  });

  it('degradation honesty: council with only 1 ready reviewer → effective reviewed, requested council', () => {
    const r = run(['--set', 'plan-authoring.review=council'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /effective here: reviewed \(requested council → degraded/);
    assert.equal(existsSync(join(cwd, CONFIG_REL)), false);
  });

  it('no ops + no --write → prints the current config + a hint (read-only)', () => {
    write(serializeConfig({ _README: 'x', 'plan-authoring': { review: 'council' } }));
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-authoring/);
    assert.match(r.stdout, /--set <activity>\.<slot>=<recipe>/);
  });
});

describe('set-recipe — --write applies (atomic) with the same degradation note', () => {
  it('writes a new config (seeding _README) and reports the effective recipe', () => {
    const r = run(['--set', 'plan-authoring.review=council', '--write'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote docs\/ai\/orchestration\.json/);
    const cfg = JSON.parse(read());
    assert.equal(cfg._README, CANON_README, 'a fresh write seeds the canonical _README');
    assert.equal(cfg['plan-authoring'].review, 'council');
  });

  it('--write carries the degradation note too (never quieter than a dry-run)', () => {
    const r = run(['--set', 'plan-authoring.review=council', '--write'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /requested council → degraded/);
  });

  it('preserves a CUSTOM _README on a touched write (never reseeds it)', () => {
    write(serializeConfig({ _README: 'my own note', 'plan-authoring': { review: 'solo' } }));
    const r = run(['--set', 'plan-authoring.review=council', '--write'], { codex: READY, agy: READY });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(read())._README, 'my own note', 'an existing _README is preserved');
  });

  it('preserves untouched slots on a touched write', () => {
    write(serializeConfig({ 'plan-execution': { execute: 'delegated', review: 'solo' } }));
    run(['--set', 'plan-execution.review=council', '--write'], { codex: READY, agy: READY });
    const cfg = JSON.parse(read());
    assert.equal(cfg['plan-execution'].execute, 'delegated');
    assert.equal(cfg['plan-execution'].review, 'council');
  });
});

describe('set-recipe — --unset returns a slot to its computed default', () => {
  it('removes the slot; the effective falls to the computed default', () => {
    write(serializeConfig({ 'plan-execution': { execute: 'delegated', review: 'council' } }));
    const r = run(['--unset', 'plan-execution.review', '--write'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(read());
    assert.equal(cfg['plan-execution'].review, undefined, 'the slot is removed');
    assert.equal(cfg['plan-execution'].execute, 'delegated', 'sibling slot preserved');
    assert.match(r.stdout, /effective here: reviewed/, 'computed default with 1 ready reviewer = reviewed');
  });
});

describe('set-recipe — idempotence + no spurious seeding', () => {
  it('a no-op --set (slot already equals) → "no change", writes nothing, no _README seeded', () => {
    write(serializeConfig({ 'plan-authoring': { review: 'solo' } })); // no _README on disk
    const before = read();
    const r = run(['--set', 'plan-authoring.review=solo', '--write'], { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no change/i);
    assert.equal(read(), before, 'a no-op write leaves the file byte-for-byte unchanged (no _README seeded)');
  });
});

describe('set-recipe — config error / write STOP surfacing', () => {
  it('malformed config + --write → exit 1, file left UNTOUCHED', () => {
    write('{ not valid json');
    const r = run(['--set', 'plan-authoring.review=council', '--write']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /malformed JSON/);
    assert.equal(read(), '{ not valid json', 'a malformed file is never clobbered');
  });

  it('no deployment (no docs/ai) + --write → exit 1 STOP (deployment gate)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'set-recipe-bare-'));
    try {
      const r = main(['--set', 'plan-authoring.review=council', '--write'], { cwd: bare, detect: detect(READY, READY) });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no agent-workflow deployment/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('set-recipe — detection failure degrades, never blocks (exit 0)', () => {
  const throwingDetect = () => { throw Object.assign(new Error('corrupt bridge (EISDIR)'), { code: 'EISDIR' }); };

  it('detect() throwing → exit 0, a warning, effective floors at solo, write still proceeds', () => {
    const r = main(['--set', 'plan-authoring.review=council', '--write'], { cwd, detect: throwingDetect });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /backend detection failed/);
    assert.equal(JSON.parse(read())['plan-authoring'].review, 'council', 'the config write is readiness-independent');
  });
});

describe('set-recipe — --json schema + readiness permutations', () => {
  it('--json emits the pinned schema', () => {
    const r = run(['--set', 'plan-authoring.review=council', '--json'], { codex: READY, agy: NEEDS_SKILL });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), ['changed', 'noop', 'unchanged', 'warnings', 'writtenPath'].sort());
    assert.equal(j.noop, false);
    assert.equal(j.writtenPath, null, 'a preview never reports a written path');
    assert.deepEqual(Object.keys(j.changed[0]).sort(), ['activity', 'degradedFrom', 'effective', 'from', 'reason', 'slot', 'to'].sort());
    assert.equal(j.changed[0].effective, 'reviewed');
    assert.equal(j.changed[0].degradedFrom, 'council');
  });

  it('--write --json reports writtenPath', () => {
    const r = run(['--set', 'plan-authoring.review=council', '--write', '--json'], { codex: READY, agy: READY });
    const j = JSON.parse(r.stdout);
    assert.equal(j.writtenPath, CONFIG_REL);
    assert.equal(j.changed[0].effective, 'council');
  });

  for (const [codex, agy, eff, degraded] of [
    [NEEDS_SKILL, NEEDS_SKILL, 'solo', true],
    [READY, NEEDS_SKILL, 'reviewed', true],
    [READY, READY, 'council', false],
  ]) {
    it(`council with codex=${codex}/agy=${agy} → effective ${eff}`, () => {
      const r = run(['--set', 'plan-authoring.review=council', '--json'], { codex, agy });
      const j = JSON.parse(r.stdout);
      assert.equal(j.changed[0].effective, eff);
      assert.equal(j.changed[0].degradedFrom, degraded ? 'council' : null);
    });
  }
});
