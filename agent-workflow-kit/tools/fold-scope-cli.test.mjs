import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI suite for the finding-scope checker: argv, the two REQUIRED path flags, the fs refusals, and
// a real subprocess smoke of ACCEPT, REFUSE and --help (the rendered command an agent pastes must
// actually run). The rule itself is the core suite's; this file pins only the edges around it.
//
// Reached by DYNAMIC import inside each case, like the core suite: a static import of an absent
// module makes the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'fold-scope-cli.mjs');
const load = () => import('./fold-scope-cli.mjs');

const PLAN = ['# Plan: a fixture', '', '## Verification', '', '- the checker refuses a claim whose reference does not resolve.', ''].join('\n');
const QUEUE = [
  '# Plans queue',
  '',
  '- **A-DEFERRED-GENERALIZATION — queued 2026-08-22.**',
  '  - invariant: every deferral row is machine-readable',
  '  - origin: agent-workflow-kit/tools/fold-scope-cli.mjs:1',
  '  - narrow fix: this row is written in the labelled form',
  '  - proof: fold-scope-cli.test.mjs#ACCEPT',
  '  - residual exposure: older rows are still prose - not live',
  '',
].join('\n');

let dir;
let planPath;
let queuePath;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fold-scope-cli-'));
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  planPath = join(dir, 'docs', 'plans', 'a-plan.md');
  queuePath = join(dir, 'docs', 'plans', 'queue.md');
  writeFileSync(planPath, PLAN);
  writeFileSync(queuePath, QUEUE);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const run = async (argv) => (await load()).main(argv);
const paths = () => ['--plan', planPath, '--queue', queuePath];

describe('fold-scope-cli — the two path flags are REQUIRED, never defaulted', () => {
  it('refuses an absent --plan, naming the flag (exit 2)', async () => {
    const r = await run(['--class', 'in-scope', '--claim', 'x', '--queue', queuePath]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--plan is required/);
    assert.ok(!r.stderr.includes('docs/plans/queue.md'), 'no default path is ever suggested as the answer');
    assert.equal(r.stdout, '');
  });

  it('refuses an absent --queue, naming the flag (exit 2)', async () => {
    const r = await run(['--class', 'in-scope', '--claim', 'x', '--plan', planPath]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--queue is required/);
  });

  it('refuses a flag with no value, an unknown flag and a positional argument (exit 2)', async () => {
    for (const argv of [[...paths(), '--class'], [...paths(), '--nope', 'x'], [...paths(), 'stray']]) {
      const r = await run(argv);
      assert.equal(r.code, 2, `${argv.join(' ')} is a usage refusal`);
      assert.match(r.stderr, /^fold-scope: /);
    }
  });

  it('accepts the --flag=value spelling for every flag', async () => {
    const r = await run([`--plan=${planPath}`, `--queue=${queuePath}`, '--class=in-scope', '--claim=refuses a claim whose reference does not resolve']);
    assert.equal(r.code, 0, r.stderr);
  });

  it('refuses an unreadable path, naming which flag pointed at it (exit 2)', async () => {
    const r = await run(['--class', 'in-scope', '--claim', 'x', '--plan', join(dir, 'no-such-plan.md'), '--queue', queuePath]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--plan/);
    assert.match(r.stderr, /unreadable/);
  });
});

describe('fold-scope-cli — the verdict rides the exit code', () => {
  it('ACCEPTs an in-scope claim that resolves (exit 0, verdict on stdout, nothing on stderr)', async () => {
    const r = await run([...paths(), '--class', 'in-scope', '--claim', 'refuses a claim whose reference does not resolve']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^fold-scope: ACCEPT in-scope/);
    assert.equal(r.stderr, '');
  });

  it('REFUSEs an in-scope claim that resolves to nothing (exit 1)', async () => {
    const r = await run([...paths(), '--class', 'in-scope', '--claim', 'a criterion this plan never states']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^fold-scope: REFUSE in-scope-unmatched/);
  });

  it('ACCEPTs a new-invariant backed by a complete queue row (exit 0)', async () => {
    const r = await run([...paths(), '--class', 'new-invariant', '--claim', 'every deferral row is machine-readable']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /ACCEPT new-invariant/);
  });

  it('REFUSEs an unknown class through the core, with no default arm (exit 2)', async () => {
    const r = await run([...paths(), '--class', 'fold', '--claim', 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /REFUSE class-unknown/);
  });

  it('reads the plan and the queue through an injected reader (no fs of its own)', async () => {
    const { main } = await load();
    const seen = [];
    const r = main(['--plan', 'P', '--queue', 'Q', '--class', 'in-scope', '--claim', 'injected criterion'], {
      readFileSync: (p) => {
        seen.push(p);
        return p === 'P' ? '## Verification\n\n- the injected criterion is here.\n' : '# queue\n';
      },
    });
    assert.deepEqual(seen, ['P', 'Q']);
    assert.equal(r.code, 0, r.stdout);
  });
});

describe('fold-scope-cli — help', () => {
  it('--help and -h print the usage, name both required flags and all three classes, exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await run([flag]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Usage:/);
      for (const token of ['--plan', '--queue', 'in-scope', 'new-invariant', 'blocking', 'advisory']) {
        assert.ok(r.stdout.includes(token), `${flag} names "${token}"`);
      }
      assert.equal(r.stderr, '');
    }
  });

  it('--help wins over an otherwise invalid argv (a user asking for help is never lectured)', async () => {
    const r = await run(['--nope', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
  });
});

describe('fold-scope-cli — subprocess smoke (the pasted command really runs)', () => {
  const smoke = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('ACCEPT exits 0 in a real process', () => {
    const r = smoke(['--plan', planPath, '--queue', queuePath, '--class', 'in-scope', '--claim', 'refuses a claim whose reference does not resolve']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ACCEPT in-scope/);
  });

  it('REFUSE exits non-zero in a real process', () => {
    const r = smoke(['--plan', planPath, '--queue', queuePath, '--class', 'new-invariant', '--claim', 'nothing queued says this']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /REFUSE new-invariant-row-absent/);
  });

  it('--help exits 0 in a real process', () => {
    const r = smoke(['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  });
});
