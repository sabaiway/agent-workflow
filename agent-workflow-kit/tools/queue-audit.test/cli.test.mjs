import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'queue-audit-cli.mjs');
// The errnos that mean the child never STARTED: a host fault carries no verdict about this CLI, so
// the arm below skips by errno rather than scoring the machine's failure as a truncated report.
const HOST_SPAWN_FAULTS = ['EIO', 'EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'];

// argv, exit codes and the operator-facing text.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit-cli.mjs');

describe('queue-audit — the CLI', () => {
  const write = (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-audit-'));
    const path = join(dir, 'queue.md');
    writeFileSync(path, text);
    return path;
  };
  const run = async (argv) => {
    const out = [];
    const err = [];
    const code = (await load()).main(argv, { log: (m) => out.push(m), error: (m) => err.push(m) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('--report prints the manifest and accepts', async () => {
    const path = write('- **A-ROW — queued 2026-08-26.** Work.\n');
    const result = await run(['--report', path]);
    assert.equal(result.code, 0);
    assert.match(result.out, /1\tlive\t/);
  });

  it('--check accepts a clean queue and refuses a dirty one, naming the row', async () => {
    const clean = await run(['--check', write('- **A-ROW — queued 2026-08-26.** Work.\n')]);
    assert.equal(clean.code, 0);
    assert.match(clean.out, /1 rows/);

    const dirty = await run(['--check', write('- **B-ROW — ✅ DONE 2026-08-20.** Shipped.\n')]);
    assert.equal(dirty.code, 1);
    assert.match(dirty.err, /a terminal row is still listed/);
  });

  it('a section that does not exist is a USAGE error — the argument is what is wrong', async () => {
    const result = await run(['--check', write('- **A-ROW.** Work.\n'), '--section', '## Nope']);
    assert.equal(result.code, 2, 'the CLI contract promises 2 for a bad section');
    assert.match(result.err, /## Nope/);
  });

  it('--help describes the per-row cap as covering every work-carrying class', async () => {
    const result = await run(['--help']);
    assert.match(result.out, /live, parked and ambiguous/);
  });

  it('usage errors exit 2: unknown flag, missing path, a non-numeric cap, an unreadable file', async () => {
    assert.equal((await run(['--wat'])).code, 2);
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--check'])).code, 2);
    assert.equal((await run(['--check', 'x.md', '--max-rows', 'many'])).code, 2);
    const missing = await run(['--check', join(tmpdir(), 'queue-audit-absent', 'queue.md')]);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /cannot read/);
  });

  // spec:queue-audit/S6
  it('a flag whose value is missing REFUSES — it never silently widens the domain', async () => {
    const path = write('- **A-ROW — queued 2026-08-26.** Work.\n');
    const noSection = await run(['--check', path, '--section']);
    assert.equal(noSection.code, 2, '--section with no value must not fall back to the whole document');
    assert.match(noSection.err, /--section/);
    assert.equal((await run(['--check', path, '--section', ''])).code, 2, 'an empty section is not a domain');
    assert.equal((await run(['--check', path, '--max-rows'])).code, 2);
  });

  // A refusal must not be answerable by a listing. With a last-one-wins parse, `--check <f>
  // --report <f>` asks a gate question and gets an exit-0 report — the verdict replaced, silently.
  // spec:queue-audit/S7
  it('a SECOND mode flag is usage, so a refusal can never be overwritten by a report', async () => {
    const terminal = write('## Pending\n\n- **A-ROW — ✅ DONE 2026-01-01.** Shipped.\n');
    const alone = await run(['--check', terminal, '--section', '## Pending']);
    assert.equal(alone.code, 1, 'the check alone refuses — a terminal row is still listed');
    const overwritten = await run(['--check', terminal, '--report', terminal, '--section', '## Pending']);
    assert.equal(overwritten.code, 2, 'the pair is usage, never the report exit 0 that would hide the refusal');
    assert.match(overwritten.err, /exactly one of --report or --check/);
    assert.equal((await run(['--check', terminal, '--check', terminal])).code, 2, 'repetition is refused too');
  });

  // A help flag that wins from anywhere is a gate bypass reached by the least suspicious argument
  // there is: the refusal is replaced by a help page and the run exits 0.
  // spec:queue-audit/S9
  it('--help riding a check is USAGE, never a help page that swallows the refusal', async () => {
    const terminal = write('## Pending\n\n- **A-ROW — ✅ DONE 2026-01-01.** Shipped.\n');
    assert.equal((await run(['--check', terminal, '--section', '## Pending'])).code, 1, 'the check alone refuses');
    const riding = await run(['--check', terminal, '--section', '## Pending', '--help']);
    assert.equal(riding.code, 2, 'usage — never the exit 0 a help page would hand back');
    assert.match(riding.err, /whole invocation/);
    assert.equal((await run(['--help', '--check', terminal])).code, 2, 'leading --help is refused the same way');
  });

  // Each option is named once. A repeat used to win silently, and both directions it moves in are
  // the permissive one: a second section narrows what is judged, a softer cap raises the ratchet.
  it('a repeated --section or cap is usage — a softer second value never overwrites the first', async () => {
    const path = write('## Pending\n\n- **A-ROW — queued 2026-08-26.** Work.\n');
    assert.equal((await run(['--check', path, '--section', '## Pending', '--section', '## Pending'])).code, 2);
    assert.equal((await run(['--check', path, '--max-rows', '1', '--max-rows', '900'])).code, 2);
    const repeated = await run(['--check', path, '--max-row-lines', '1', '--max-row-lines', '900']);
    assert.equal(repeated.code, 2);
    assert.match(repeated.err, /exactly once/);
  });

  // The one arm that runs the REAL process, because the defect only exists there: stdout is a pipe
  // under a gate runner, and an immediate `process.exit()` drops whatever of a large report has not
  // flushed. A truncated manifest is worse than none — it is what a deletion is driven by, and a
  // short one reads exactly like a complete one.
  // The reader must be LAZY for the defect to appear: `spawnSync` polls its pipe eagerly and drains
  // the child as it writes, which hides the truncation entirely (measured — the same fixture that
  // loses everything past 65536 bytes through a shell pipeline arrives whole through spawnSync). So
  // the run goes through a real pipeline, and the assertion is the byte count the far end received.
  // spec:queue-audit/S20
  it('a CHECK-only option named beside --report is usage, never a silently ignored knob', async () => {
    const path = write('## Pending\n\n- **A-ROW — queued 2026-08-26.** Work.\n');
    const withCap = await run(['--report', path, '--max-rows', '1']);
    assert.equal(withCap.code, 2, 'accepted-then-ignored told an operator nothing and exited 0');
    assert.match(withCap.err, /--check option/);
    assert.equal((await run(['--report', path, '--max-row-lines', '1'])).code, 2);
    assert.equal((await run(['--report', path])).code, 0, 'the report itself is unaffected');
  });

  // spec:queue-audit/S10
  it('a LARGE report reaches a pipe WHOLE — the process never exits before stdout drains', async (t) => {
    const rows = Array.from({ length: 4000 }, (_, i) => `- **ROW-${i} ${'x'.repeat(220)} — queued 2026-08-26.** body`);
    const path = write(`## Pending\n\n${rows.join('\n\n')}\n`);
    // The oracle is the EXACT byte count, computed from the same report read in-process: a
    // greater-than threshold would pass a manifest truncated anywhere above it, and a truncated
    // manifest is the whole defect. `console.log` appends the newline, so the expectation carries it.
    const inProcess = await run(['--report', path, '--section', '## Pending']);
    assert.equal(inProcess.code, 0);
    const expected = Buffer.byteLength(`${inProcess.out}\n`, 'utf8');
    assert.ok(expected > 900_000, `the fixture must dwarf one pipe buffer (65536), got ${expected} bytes`);
    // `pipefail`, or the producer's own failure is hidden behind `wc`'s exit 0 and a short count
    // reads as a delivery result rather than as a crash.
    const piped = spawnSync('bash', ['-c', `set -o pipefail; "${process.execPath}" "${CLI}" --report "${path}" --section '## Pending' | wc -c`], { encoding: 'utf8' });
    if (HOST_SPAWN_FAULTS.includes(piped.error?.code)) {
      return t.skip(`host spawn fault ${piped.error.code}: the child never started, so this run carries no truncation verdict`);
    }
    assert.equal(piped.status, 0, `the CLI itself must exit 0 through the pipeline: ${piped.stdout}\n${piped.stderr}`);
    assert.equal(Number(piped.stdout.trim()), expected, 'every byte the report produced reached the far end');
  });

  it('--help explains the classes and exits 0', async () => {
    const result = await run(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.out, /ambiguous/);
  });
});
