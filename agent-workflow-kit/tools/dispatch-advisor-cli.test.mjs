// dispatch-advisor-cli.test.mjs — the advisor's two POINTS OF USE on the dispatch CLI (Plan 3, D1):
// the standalone `advise` verb and the advisory FOOTER on a form-valid `check`. Its own suite so the
// recorded dispatch.test.mjs baseline does not grow, and so the D1 no-gate proof — `check`'s exit
// code and FIRST line are identical whether the advised vehicle is present or absent — reads as one
// pinned claim rather than a paragraph.
//
// Driven IN-PROCESS through main(): a spawned child's executed lines never reach the coverage map
// (D14), so the process-facing lane is exercised here rather than through a subprocess.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The NAMESPACE form: a missing export surfaces as a failing assertion inside the test that needs
// it, never as a link-time error that reddens the whole file — the red-first discipline needs every
// proof to fail for its OWN reason.
import * as engine from './dispatch.mjs';
import { DELEGATION_SCHEMA_VERSION, STEP_CLASSES } from './dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME } from './dispatch-store.mjs';
import { AGENTS_DIR } from './cheap-agents.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-advisor-cli-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const plainDir = () => {
  const dir = join(TMP, `d-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// A real git work tree plus a store on the AW_DELEGATION_STORE seam, so no test depends on the repo
// it runs in.
const workspace = () => {
  const cwd = plainDir();
  const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  const store = join(cwd, DELEGATION_STORE_BASENAME);
  return { cwd, store, env: { AW_DELEGATION_STORE: store } };
};

const placeAgent = (ws, name) => {
  mkdirSync(join(ws.cwd, AGENTS_DIR), { recursive: true });
  writeFileSync(join(ws.cwd, AGENTS_DIR, `${name}.md`), '# a vehicle\n');
};

const run = (argv, ws) => engine.main(argv, { cwd: ws.cwd, env: ws.env });
const firstLine = (text) => text.split('\n')[0];

const CONTRACT = {
  schema: DELEGATION_SCHEMA_VERSION,
  nonce: 'p3-advise',
  stepClass: 'extraction',
  vehicle: { requested: 'mechanical-sweep', selected: 'mechanical-sweep' },
  scope: 'inventory the record fields',
  inputs: 'the plan section',
  acceptance: 'the named tests are green',
  returnShape: 'a report',
  producerContract: 'the orchestrator records the observation',
  deadlineS: 900,
  retry: { cap: 2, index: 0 },
};

const dispatchFile = (ws, name, contract) => {
  writeFileSync(join(ws.cwd, name), `# a sub-task\n\n\`\`\`aw-dispatch-contract\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`);
  return name;
};

describe('dispatch advise — the standalone verb', () => {
  it('advise on a legal step class exits 0 and prints the block', () => {
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const r = run(['advise', '--step-class', 'extraction'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(firstLine(r.stdout), 'dispatch advisor — step class: extraction');
    assert.match(r.stdout, /advice: mechanical-sweep \(ready\)/);
    assert.match(r.stdout, /fallback: solo \(this orchestrator\)/);
    assert.match(r.stdout, /history: no recorded history/);
    assert.match(r.stdout, /note: /);
  });

  it('advise on an unknown step class exits 2 naming the closed class set', () => {
    const ws = workspace();
    const r = run(['advise', '--step-class', 'not-a-class'], ws);
    assert.equal(r.code, 2);
    for (const stepClass of STEP_CLASSES) assert.match(r.stderr, new RegExp(stepClass));
  });

  it('advise with no --step-class is usage (exit 2), and an unknown flag refuses by name', () => {
    const ws = workspace();
    assert.equal(run(['advise'], ws).code, 2);
    const unknown = run(['advise', '--step-class', 'code', '--frobnicate', 'x'], ws);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown argument: --frobnicate/);
  });

  it('advise with no ledger present exits 0 — never a refusal', () => {
    // Two absences, both legal: a store path that resolves to nothing on disk, and no store to
    // resolve at all (a plain directory outside any work tree, with no override).
    const ws = workspace();
    const absent = run(['advise', '--step-class', 'code'], ws);
    assert.equal(absent.code, 0, absent.stderr);
    assert.match(absent.stdout, /history: no recorded history/);

    const outside = { cwd: plainDir(), env: {} };
    const unreadable = run(['advise', '--step-class', 'code'], outside);
    assert.equal(unreadable.code, 0, unreadable.stderr);
    assert.match(unreadable.stdout, /history: unavailable — /);
    assert.match(unreadable.stdout, /advice: codex-exec \(/, 'an unresolvable store never suppresses the advice');
  });

  it('a store override the resolver REFUSES still exits 0 and prints the store own words', () => {
    // Round-1 blocker: the store path resolution refuses two shapes by THROWING — a relative override
    // and one ending in a separator — and an exception escaping the advisory probe made `advise` exit
    // 1 where D1 says 0. Both shapes are covered: one of them alone would leave the other lane open.
    const ws = workspace();
    for (const override of ['relative/store.jsonl', `${ws.cwd}/`]) {
      const r = run(['advise', '--step-class', 'code'], { cwd: ws.cwd, env: { AW_DELEGATION_STORE: override } });
      assert.equal(r.code, 0, `override ${override}: ${r.stderr}`);
      assert.match(r.stdout, /history: unavailable — /);
      assert.match(r.stdout, /AW_DELEGATION_STORE must/, 'the store refuses in its own words — the advisory relays them, never invents one');
      assert.match(r.stdout, /advice: codex-exec \(/, 'an unusable store never suppresses the advice');
    }
  });

  it('the cheap vehicles are anchored at the repository top-level, not the caller cwd', () => {
    // A vehicle placed at the repo root is placed for the whole repo; resolving it against the
    // caller's directory reported it absent from any subdirectory.
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const nested = join(ws.cwd, 'nested', 'deep');
    mkdirSync(nested, { recursive: true });
    const r = run(['advise', '--step-class', 'extraction'], { cwd: nested, env: ws.env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /advice: mechanical-sweep \(ready\)/);
  });

  it('outside a work tree the agent lane is UNKNOWN, even with a vehicle file sitting right there', () => {
    // A present file under an unanchored directory is not evidence that it is THIS repository's
    // vehicle — the same bytes would appear in a nested shadow copy. The advisory answers, exit 0,
    // and says what it does not know instead of guessing either way.
    const outside = plainDir();
    mkdirSync(join(outside, AGENTS_DIR), { recursive: true });
    writeFileSync(join(outside, AGENTS_DIR, 'gate-triage.md'), '# a vehicle\n');
    const r = run(['advise', '--step-class', 'triage'], { cwd: outside, env: {} });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /advice: gate-triage \(unknown — the repository root was not resolved/);
    assert.ok(!r.stdout.includes('(ready)'), 'presence without an anchor proves nothing');
    assert.match(r.stdout, /fallback: solo \(this orchestrator\)/);
    assert.match(r.stdout, /history: unavailable — /);
  });

  it('a nested SHADOW .claude/agents never reads as the repository vehicle', () => {
    // The refutation that produced the tri-state, pinned: the repository has NO vehicle placed, a
    // subdirectory has one. Anchoring resolves the repository root, so the shadow copy is simply not
    // where the tool looks — the answer is "not placed", never a false ready.
    const ws = workspace();
    const nested = join(ws.cwd, 'nested');
    mkdirSync(join(nested, AGENTS_DIR), { recursive: true });
    writeFileSync(join(nested, AGENTS_DIR, 'mechanical-sweep.md'), '# a shadow\n');
    const r = run(['advise', '--step-class', 'extraction'], { cwd: nested, env: ws.env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /advice: mechanical-sweep \(unavailable — not placed/);
  });

  it('a git probe that cannot answer renders UNKNOWN, and never moves the exit code', () => {
    // The anchor is resolved through git. When there is no work tree to anchor to — here by pointing
    // the run at a plain directory while the ledger still resolves through its override — the lane
    // says unknown rather than reporting a vehicle it never looked for as unplaced.
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const anchored = run(['advise', '--step-class', 'extraction'], ws);
    const blind = run(['advise', '--step-class', 'extraction'], { cwd: plainDir(), env: ws.env });
    assert.equal(anchored.code, 0, anchored.stderr);
    assert.equal(blind.code, anchored.code, 'an unresolvable anchor never moves the exit code');
    assert.match(anchored.stdout, /advice: mechanical-sweep \(ready\)/);
    assert.match(blind.stdout, /advice: mechanical-sweep \(unknown — the repository root was not resolved/);
  });

  it('a root resolver that THROWS is unknown too, and the exit code and FIRST line still do not move', () => {
    // The other ignorance, through the ctx seam: the probe raised rather than answering. It must not
    // escape (D1), and it must not be reported as "no repository root" — that root question was
    // never answered at all.
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const thrower = () => { throw Object.assign(new Error('git exploded'), { code: 'EIO' }); };
    const good = engine.main(['advise', '--step-class', 'extraction'], { cwd: ws.cwd, env: ws.env });
    const raised = engine.main(['advise', '--step-class', 'extraction'], { cwd: ws.cwd, env: ws.env, repoRoot: thrower });
    assert.equal(raised.code, good.code, 'a throwing probe never moves the exit code');
    assert.equal(firstLine(raised.stdout), firstLine(good.stdout));
    assert.match(raised.stdout, /advice: mechanical-sweep \(unknown — the repository root was not resolved/);

    const file = dispatchFile(ws, 'raised.md', CONTRACT);
    const checkGood = engine.main(['check', file], { cwd: ws.cwd, env: ws.env });
    const checkRaised = engine.main(['check', file], { cwd: ws.cwd, env: ws.env, repoRoot: thrower });
    assert.equal(checkRaised.code, checkGood.code);
    assert.equal(firstLine(checkRaised.stdout), firstLine(checkGood.stdout));
  });

  it('an anchored probe that cannot READ the vehicle dir is a PROBE ERROR, not an absent vehicle', () => {
    // The round-3 finding, pinned end to end: the root resolves, but `.claude/agents/` cannot be
    // probed. Saying "the repository root was not resolved" there would be false about a root that
    // resolved fine, and saying "not placed" would be false about a file nobody could look at.
    const ws = workspace();
    mkdirSync(join(ws.cwd, AGENTS_DIR), { recursive: true });
    chmodSync(join(ws.cwd, AGENTS_DIR), 0o000);
    try {
      const r = run(['advise', '--step-class', 'extraction'], ws);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /advice: mechanical-sweep \(unknown — the repository root resolved, but/);
    } finally {
      chmodSync(join(ws.cwd, AGENTS_DIR), 0o755);
    }
  });

  it('the HELP surface lists advise', () => {
    const r = engine.main(['--help'], {});
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dispatch\.mjs advise --step-class/);
  });
});

describe('dispatch check — the advisory FOOTER (D1: it can never mask a refusal)', () => {
  it('check on a form-valid contract prints the advisory footer and exits 0', () => {
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const file = dispatchFile(ws, 'ok.md', CONTRACT);
    const r = run(['check', file], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(firstLine(r.stdout), /^dispatch check: FORM OK/);
    assert.match(r.stdout, /dispatch advisor — step class: extraction/);
    assert.match(r.stdout, /advice: mechanical-sweep \(ready\)/);
  });

  it('check on a form-INVALID contract prints the first violated field, no advisory block, exit 1', () => {
    const ws = workspace();
    const file = dispatchFile(ws, 'bad.md', { ...CONTRACT, deadlineS: 0 });
    const r = run(['check', file], ws);
    assert.equal(r.code, 1);
    assert.match(firstLine(r.stdout), /^dispatch check: FORM VIOLATION — /);
    assert.match(r.stdout, /deadlineS/);
    assert.ok(!r.stdout.includes('dispatch advisor'), 'an advisory footer under a refusal would mask it');
  });

  it("check's exit code and FIRST line are identical whether the advised vehicle is present or absent", () => {
    // The D1 no-gate proof, over the ONE fact the advisor can see change: host capability. Same
    // contract bytes, two hosts — one with the vehicle placed, one without.
    const present = workspace();
    placeAgent(present, 'mechanical-sweep');
    const absent = workspace();
    const file = 'same.md';
    dispatchFile(present, file, CONTRACT);
    dispatchFile(absent, file, CONTRACT);

    const a = run(['check', file], present);
    const b = run(['check', file], absent);
    assert.equal(a.code, 0);
    assert.equal(b.code, a.code, 'availability must not move the exit code');
    assert.equal(firstLine(b.stdout), firstLine(a.stdout), 'availability must not move the verdict line');
    assert.match(a.stdout, /advice: mechanical-sweep \(ready\)/);
    assert.match(b.stdout, /advice: mechanical-sweep \(unavailable/);
  });

  it('the footer names vehicle.requested when it differs from vehicle.selected', () => {
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const diverged = { ...CONTRACT, stepClass: 'code', vehicle: { requested: 'mechanical-sweep', selected: 'review-lens' } };
    const r = run(['check', dispatchFile(ws, 'diverged.md', diverged)], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /divergence: the contract selected "review-lens" \(requested "mechanical-sweep"\)/);
    assert.match(r.stdout, /the advisor advises "codex-exec"/);

    const agreed = { ...CONTRACT, stepClass: 'extraction', vehicle: { requested: 'mechanical-sweep', selected: 'mechanical-sweep' } };
    const clean = run(['check', dispatchFile(ws, 'agreed.md', agreed)], ws);
    assert.equal(clean.code, 0, clean.stderr);
    assert.ok(!clean.stdout.includes('divergence:'), 'an agreeing selection prints no divergence at all');
  });

  it('a store override the resolver REFUSES never moves check exit code or FIRST line', () => {
    // The blocker's other half: `check` reads the ledger only for its footer, so a throwing store
    // resolution must leave the verdict byte-identical to the same contract under a usable store.
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    const file = dispatchFile(ws, 'store.md', CONTRACT);
    const good = run(['check', file], ws);
    assert.equal(good.code, 0, good.stderr);
    for (const override of ['relative/store.jsonl', `${ws.cwd}/`]) {
      const r = run(['check', file], { cwd: ws.cwd, env: { AW_DELEGATION_STORE: override } });
      assert.equal(r.code, good.code, `override ${override} moved the exit code`);
      assert.equal(firstLine(r.stdout), firstLine(good.stdout), `override ${override} moved the verdict line`);
      assert.match(r.stdout, /history: unavailable — /);
    }
  });

  it('an unreadable ledger never moves check: the footer degrades, the verdict does not', () => {
    const ws = workspace();
    placeAgent(ws, 'mechanical-sweep');
    writeFileSync(ws.store, 'not a record\n');
    const r = run(['check', dispatchFile(ws, 'stored.md', CONTRACT)], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(firstLine(r.stdout), /^dispatch check: FORM OK/);
    assert.match(r.stdout, /history: unavailable — /);
  });
});
