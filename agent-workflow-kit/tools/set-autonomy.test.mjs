import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './set-autonomy.mjs';
import { AUTONOMY_REL, AUTONOMY_README, serializeAutonomy } from './autonomy-config.mjs';

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'set-autonomy-'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const write = (json) => writeFileSync(join(cwd, AUTONOMY_REL), json);
const read = () => readFileSync(join(cwd, AUTONOMY_REL), 'utf8');
const run = (argv) => main(argv, { cwd });

describe('set-autonomy — arg parsing (usage → exit 2)', () => {
  it('a bare key (no section) → exit 2 (name the section)', () => {
    const r = run(['--set', 'commit=ask']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /name the section/);
  });
  it('unknown section / unknown key / bad value → exit 2', () => {
    assert.equal(run(['--set', 'bogus.commit=ask']).code, 2);
    assert.equal(run(['--set', 'plan-execution.execute=sandbox']).code, 2);
    assert.equal(run(['--set', 'redlines.commit=maybe']).code, 2);
  });
  it('a duplicate op for the same section.key → exit 2', () => {
    const r = run(['--set', 'redlines.commit=ask', '--set', 'redlines.commit=deny']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /duplicate op/);
  });
  it('--write with zero ops → exit 2', () => {
    const r = run(['--write']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /nothing to write/);
  });
  it('--unset with a stray value → exit 2', () => {
    assert.equal(run(['--unset', 'redlines.commit=ask']).code, 2);
  });
  it('--help is read-only, exit 0, names the writer posture', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /never commits/i);
    assert.match(r.stdout, /Previews by default/);
    assert.match(r.stdout, /never renders enforcement/i);
  });
});

describe('set-autonomy — preview by default (writes NOTHING)', () => {
  it('shows the changed key (from → to) + effective value; no file written', () => {
    const r = run(['--set', 'plan-execution.autonomy=sandbox']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /plan-execution\.autonomy: \(computed default\) → sandbox/);
    assert.match(r.stdout, /effective: sandbox/);
    assert.match(r.stdout, /preview/);
    assert.equal(existsSync(join(cwd, AUTONOMY_REL)), false, 'preview writes nothing');
  });

  it('no ops + no --write → prints the current policy + a hint (read-only)', () => {
    write(serializeAutonomy({ _README: 'x', redlines: { commit: 'ask' } }));
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /redlines/);
    assert.match(r.stdout, /--set <section>\.<key>=<value>/);
  });

  it('no ops + no file → says computed defaults apply (read-only)', () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /computed defaults apply/);
  });
});

describe('set-autonomy — --write applies (atomic)', () => {
  it('writes a new policy (seeding _README) and points at the render step', () => {
    const r = run(['--set', 'plan-execution.autonomy=sandbox', '--write']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote docs\/ai\/autonomy\.json/);
    assert.match(r.stdout, /velocity autonomy mode/);
    const cfg = JSON.parse(read());
    assert.equal(cfg._README, AUTONOMY_README, 'a fresh write seeds the canonical _README');
    assert.equal(cfg['plan-execution'].autonomy, 'sandbox');
  });

  it('preserves a CUSTOM _README on a touched write (never reseeds it)', () => {
    write(serializeAutonomy({ _README: 'my own note', redlines: { commit: 'ask' } }));
    const r = run(['--set', 'redlines.commit=deny', '--write']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(read())._README, 'my own note', 'an existing _README is preserved');
  });

  it('preserves untouched keys on a touched write', () => {
    write(serializeAutonomy({ redlines: { commit: 'ask', push: 'ask' }, 'plan-execution': { autonomy: 'prompt' } }));
    run(['--set', 'plan-execution.autonomy=sandbox', '--write']);
    const cfg = JSON.parse(read());
    assert.equal(cfg.redlines.commit, 'ask');
    assert.equal(cfg.redlines.push, 'ask');
    assert.equal(cfg['plan-execution'].autonomy, 'sandbox');
  });

  it('seeds the full dogfood policy from two ops', () => {
    const r = run(['--set', 'plan-authoring.autonomy=sandbox', '--set', 'plan-execution.autonomy=sandbox', '--write']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(read());
    assert.equal(cfg['plan-authoring'].autonomy, 'sandbox');
    assert.equal(cfg['plan-execution'].autonomy, 'sandbox');
  });
});

describe('set-autonomy — --unset returns a key to its computed default', () => {
  it('removes the key; the effective falls to the computed default', () => {
    write(serializeAutonomy({ redlines: { network: 'ask' }, 'plan-execution': { autonomy: 'sandbox' } }));
    const r = run(['--unset', 'redlines.network', '--write']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(read());
    assert.equal(cfg.redlines, undefined, 'the emptied section is dropped');
    assert.equal(cfg['plan-execution'].autonomy, 'sandbox', 'sibling section preserved');
    assert.match(r.stdout, /effective: deny/, 'network computed default is deny');
  });
});

describe('set-autonomy — idempotence + no spurious seeding', () => {
  it('a no-op --set (value already equals) → "no change", writes nothing, no _README seeded', () => {
    write(serializeAutonomy({ redlines: { commit: 'ask' } }));
    const before = read();
    const r = run(['--set', 'redlines.commit=ask', '--write']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no change/i);
    assert.equal(read(), before, 'a no-op write leaves the file byte-for-byte unchanged (no _README seeded)');
  });
});

describe('set-autonomy — config error / write STOP surfacing', () => {
  it('malformed policy + --write → exit 1, file left UNTOUCHED', () => {
    write('{ not valid json');
    const r = run(['--set', 'redlines.commit=ask', '--write']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /malformed JSON/);
    assert.equal(read(), '{ not valid json', 'a malformed file is never clobbered');
  });

  it('no deployment (no docs/ai) + --write → exit 1 STOP (deployment gate)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'set-autonomy-bare-'));
    try {
      const r = main(['--set', 'redlines.commit=ask', '--write'], { cwd: bare });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no agent-workflow deployment/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('set-autonomy — --json schema', () => {
  it('--json (preview) emits the pinned schema; a preview reports no written path', () => {
    const r = run(['--set', 'redlines.network=deny', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), ['changed', 'noop', 'unchanged', 'writtenPath'].sort());
    assert.equal(j.noop, false);
    assert.equal(j.writtenPath, null);
    assert.deepEqual(Object.keys(j.changed[0]).sort(), ['effective', 'from', 'key', 'section', 'to'].sort());
    assert.equal(j.changed[0].effective, 'deny');
  });

  it('--write --json reports writtenPath', () => {
    const r = run(['--set', 'plan-execution.autonomy=sandbox', '--write', '--json']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.writtenPath, AUTONOMY_REL);
    assert.equal(j.changed[0].effective, 'sandbox');
  });
});
