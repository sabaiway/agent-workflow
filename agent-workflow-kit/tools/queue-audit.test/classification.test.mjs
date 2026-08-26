import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Which class each row shape gets, and why. Every arm here decides whether a row may be DELETED.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit.mjs');

const rowsOf = async (text, options) => (await load()).auditQueue(text, options).rows;
const classOf = async (text, options) => (await rowsOf(text, options)).map((row) => row.klass);

describe('queue-audit — classification', () => {
  it('a row with no status marker anywhere is live', async () => {
    const text = ['- **A-THING-IS-BROKEN — queued 2026-08-26.** It breaks on input X.', '  More detail.'].join('\n');
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('every terminal marker in the TITLE classifies the row terminal', async () => {
    const { TERMINAL_MARKERS } = await load();
    assert.ok(TERMINAL_MARKERS.length >= 8, 'the marker set is the closed list the queue actually uses');
    for (const marker of TERMINAL_MARKERS) {
      const text = `- **A-ROW — ${marker} 2026-08-20 (AD-100).** The story lives in the ADR.`;
      const [row] = await rowsOf(text);
      assert.equal(row.klass, 'terminal', `${marker} in the title must classify terminal`);
      assert.match(row.evidence, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('the BODY decides when the heading reads open and a bold status says closed', async () => {
    // The live shape this arm exists for: queue.md's PLAIN-LANGUAGE-CANON row, whose heading carries
    // no marker at all and whose body carries `**CLOSED 2026-07-20 …**`.
    const text = [
      '- **PLAIN-LANGUAGE-CANON — speak in plain language (maintainer directive).**',
      '  **Fix (small canon change):** the communication contract gains a bar.',
      '  **CLOSED 2026-07-20 (minimum-approvals plan, Phase 3; kit 3.2.0):** the bar landed.',
    ].join('\n');
    const [row] = await rowsOf(text);
    assert.equal(row.klass, 'terminal');
    assert.match(row.evidence, /CLOSED/);
  });

  it('a terminal WORD in ordinary body prose leaves the row live — only a bold status decides', async () => {
    // queue.md's WALKFORNAME row says "Why it was CUT rather than fixed" and cites a CLOSED sibling;
    // reading either as its own status would delete live work.
    const text = [
      '- **WALKFORNAME-HIDES-AN-ALIAS — queued 2026-08-26 (AD-119 non-goal).**',
      '  It was CUT from that plan, and the sibling row was CLOSED 2026-08-25 by AD-118.',
    ].join('\n');
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('the TITLE ends where its bold span ends — prose after it is body', async () => {
    const text = '- **A live row.** Its sibling was CLOSED 2026-08-20, which says nothing about this one.';
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('a title that WRAPS is still one title, markers included', async () => {
    const text = [
      '- **A live row whose title runs onto a second line, queued 2026-08-26 and still',
      '  open.** Body follows.',
      '  **CLOSED 2026-08-21:** or so a stray line claims.',
    ].join('\n');
    // `queued` in the wrapped title + a bold terminal body is the self-contradiction arm.
    assert.deepEqual(await classOf(text), ['ambiguous']);
  });

  it('a LIVE marker is matched in any case — the corpus writes "queued", not "QUEUED"', async () => {
    for (const live of ['queued', 'Queued', 'QUEUED', 'pending']) {
      const text = [`- **A-ROW — ${live} 2026-08-26.** Work.`, '  **CLOSED 2026-08-27:** says the body.'].join('\n');
      assert.deepEqual(await classOf(text), ['ambiguous'], `"${live}" must arm the contradiction`);
    }
  });

  it('a LOWER-CASE terminal word is prose, never a status', async () => {
    // Measured: matching terminal markers case-insensitively flipped EIGHT live rows of the real
    // corpus to terminal — "(decided 2026-07-22)", "…until resolved", "the class gets asked for" —
    // every one a false positive, and every one would have been a deletion.
    const rows = [
      '- **PARALLEL-TRACK-REDESIGN — the AD-063 work is RESET out of main; re-plan it SMALLER (decided 2026-07-22).** Body.',
      '- **THE PUBLISH STEP IS UNREACHABLE — it stays open until resolved by a plan.** Body.',
      '- **A-ROW — the instance gets fixed and the work is done by hand every time.** Body.',
    ].join('\n');
    assert.deepEqual(await classOf(rows), ['live', 'live', 'live']);
  });

  it('a lower-case record prefix is prose too', async () => {
    const text = '- **A-ROW — tallying the failures is not a TALLY row.** Work.';
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('a marker glued to more word by a hyphen is not a status', async () => {
    const text = ['- **A-ROW — a live row.** Work.', '  **CLOSED-loop design:** how the loop closes.'].join('\n');
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('a bare check mark opens a bold status even with no word after it', async () => {
    const text = ['- **A-ROW — a row.** Work.', '  **✅ 2026-08-20 (AD-100):** shipped.'].join('\n');
    assert.deepEqual(await classOf(text), ['terminal']);
  });

  it('TALLY / SEQUENCING need a boundary — a slug that merely starts with them is work', async () => {
    const text = [
      '- **TALLYING-FAILURES-HAS-NO-RUNG — queued 2026-08-26.** Work.',
      '- **SEQUENCING-BUG-IN-THE-DISPATCHER — queued 2026-08-26.** Work.',
    ].join('\n');
    assert.deepEqual(await classOf(text), ['live', 'live']);
  });

  // spec:queue-audit/S1
  it('PARKED and STOPPED are frozen work, never terminal, and never a refusal', async () => {
    const { FROZEN_MARKERS, checkQueue } = await load();
    for (const marker of FROZEN_MARKERS) {
      const text = `- **${marker} 2026-08-21 by AD-105 (costs nothing until a chain is adopted again) — A-ROW.** Body.`;
      const [row] = await rowsOf(text);
      assert.equal(row.klass, 'parked', `${marker} must classify parked`);
      const result = checkQueue(text);
      assert.equal(result.ok, true, `${marker} must not refuse — the work is only waiting`);
      assert.match(result.notes.join('\n'), /frozen, not dead/);
    }
  });

  // spec:queue-audit/S4
  it('a bold status that WRAPS across lines is still a status', async () => {
    // Measured in the live corpus (two rows): the opener sits on one line and the `:**` on the next,
    // and a per-line matcher reported them live — a false GREEN from the gate that judges deletions.
    const text = [
      '- **PLAIN-LANGUAGE-CANON — speak in plain language.** Body.',
      '  **CLOSED 2026-07-20 (minimum-approvals plan, Phase 3; released memory 3.1.0 / kit 3.2.0, AD-061,',
      '  commit `1ad59fb`):** the bar landed.',
    ].join('\n');
    const [row] = await rowsOf(text);
    assert.equal(row.klass, 'terminal');
    assert.match(row.evidence, /CLOSED/);
  });

  it('a bold span that runs on past its line budget declares nothing', async () => {
    // The opener is never closed within the lines a status may span, so it is prose, not a status —
    // the row stays live rather than being closed by an opener nobody finished.
    const text = [
      '- **A-ROW — a live row.** Work.',
      '  **CLOSED 2026-08-20 but this emphasis just keeps going',
      '  and going',
      '  and going',
      '  and going',
      '  and going without ever closing.',
    ].join('\n');
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('a check mark alone closes nothing — it needs a marker or a date behind it', async () => {
    const open = ['- **A-ROW — a live row.** Work.', '  **✅ ENTRY GATE OPEN:** the gate is armed.'].join('\n');
    assert.deepEqual(await classOf(open), ['live']);
    const dated = ['- **A-ROW — a row.** Work.', '  **✅ 2026-08-20 (AD-100):** shipped.'].join('\n');
    assert.deepEqual(await classOf(dated), ['terminal']);
  });

  // spec:queue-audit/S2
  it('a status marker without a DATE behind it is not a status', async () => {
    // Measured over the 272-row corpus: a real status carries its date — `DONE 2026-08-21 ·`,
    // `CLOSED 2026-07-20 (…)`, `SUPERSEDED 2026-08-21 by the row above`, `PARKED 2026-08-21 by
    // AD-105` — while the same words in prose do not: `STOPPED. That is`, `PARKED rather than`,
    // `RESOLVED; the npm-pack`, `SUPERSEDED by a`. A row NAMED after the machinery it fixes is the
    // dangerous case: it opens with the word and must never be deleted for it.
    const rows = [
      '- **CLOSED STATUS PARSER DROPS ROWS — the classifier reads the wrong span.** Work.',
      '- **A-ROW — a live row.** Work.\n  **DONE criteria:** what counts as finished here.',
    ].join('\n');
    const classes = await classOf(rows);
    assert.ok(
      classes.every((klass) => klass !== 'terminal'),
      `neither row may be terminal, got ${classes.join(', ')}`,
    );
  });

  // spec:queue-audit/S11
  it('the date is ADJACENT to the marker — prose between the two is not a closure, it is a question', async () => {
    // A window of arbitrary text between the marker and the date read `DONE criteria due <date>` as
    // a closure, and this verdict authorises a DELETION. The only gap the corpus writes is a second
    // shouted word introduced by `+` (measured: three rows in 6900 lines, all `DONE + SHIPPED` /
    // `DONE + PUBLISHED`), so that gap stays and prose does not.
    const rows = [
      '- **A-ROW — a live row.** Work.\n  **DONE criteria due 2026-09-01:** what counts as finished.',
      '- **B-ROW — a live row.** Work.\n  **DONE CRITERIA 2026-09-01:** shouted, still not a closure.',
    ].join('\n');
    const classes = await classOf(rows);
    assert.deepEqual(classes, ['ambiguous', 'ambiguous'], 'reported for a human, never terminal and never silent');

    const shipped = '- **C-ROW — a row.** Work.\n  **DONE + SHIPPED 2026-07-09 (kit 2.0.0):** the closure the corpus writes.';
    assert.deepEqual(await classOf(shipped), ['terminal'], 'the measured `+ WORD` gap still closes a row');
  });

  // spec:queue-audit/S12
  it('two declared states are none — and a dated frozen BODY status is a state', async () => {
    const both = '- **PARKED 2026-08-21 by AD-105 — QUEUED 2026-08-20 — A-ROW.** Work.';
    assert.deepEqual(await classOf(both), ['ambiguous'], 'parked and queued at once is settled by a human, not by the arm order');

    const bodyFrozen = '- **A-ROW — a row.** Work.\n  **PARKED 2026-08-21 (no chain is armed here):** waiting.';
    assert.deepEqual(await classOf(bodyFrozen), ['parked'], 'the body decides a frozen state exactly as it decides a closure');
  });

  // spec:queue-audit/S18
  it('a row is judged on what it DECLARES, never on what it QUOTES', async () => {
    const { auditQueue } = await load();
    // Inline code names a literal. Stripping the backticks and keeping the text turned a row ABOUT
    // the parser into a closed row — and that verdict authorises a deletion.
    const quoting = '- **`DONE 2026-01-01` is the parser input this row is about.** Work.';
    const [quoted] = auditQueue(quoting).rows;
    assert.equal(quoted.klass, 'live');
    assert.match(quoted.title, /DONE 2026-01-01 is the parser input/, 'the MANIFEST still reads what the row wrote');

    // A body line indented past the row's own continuation is a code block, not this row's status.
    const sample = '- **A-ROW — a row.** Work.\n\n      **DONE 2026-02-01:** sample output.\n';
    assert.deepEqual(await classOf(sample), ['live']);
  });

  // spec:queue-audit/S19
  it('a terminal TITLE never hides a frozen BODY — the classes are reduced, not the positions', async () => {
    const both = '- **A-ROW — ✅ DONE 2026-01-01.** Work.\n  **PARKED 2026-08-21 (waiting on the chain):** still frozen.';
    assert.deepEqual(await classOf(both), ['ambiguous'], 'two classes declared, so neither authorises a deletion');

    const agreeing = '- **A-ROW — ✅ DONE 2026-01-01.** Work.\n  **CLOSED 2026-01-02:** and closed in place too.';
    assert.deepEqual(await classOf(agreeing), ['terminal'], 'two sightings of the SAME class are one state');
  });

  // spec:queue-audit/S16
  it('the BODY declares live too — a closure under an open body status is a contradiction, not a verdict', async () => {
    // Measured before this arm: the row below classified `terminal`, so a row whose own body says it
    // is still open was handed to a deletion as closed.
    const both = '- **A-ROW — a row.** Work.\n  **QUEUED 2026-08-20:** still open.\n  **CLOSED 2026-01-01:** closed in place.';
    assert.deepEqual(await classOf(both), ['ambiguous']);

    const undatedFrozen = '- **B-ROW — a row.** Work.\n  **PARKED until the chain is armed:** no date beside it.';
    assert.deepEqual(await classOf(undatedFrozen), ['ambiguous'], 'an undated frozen body status is reported, never silent');
  });

  it('a bare check mark with no date is a LIVE gate, never a status word missing its date', async () => {
    // `**✅ ENTRY GATE OPEN — …**` is how the corpus marks a gate that OPENED. Reading a bare mark as
    // an undated status turned three live rows ambiguous in one measured pass.
    const row = '- **A-ROW — a live row.** Work.\n  **✅ ENTRY GATE OPEN — consent was granted here.**';
    assert.deepEqual(await classOf(row), ['live']);
  });

  it('a dot or a pipe does not open a status position — only the dash family does', async () => {
    const rows = [
      '- **A-ROW | CLOSED is an input the parser reads.** Work.',
      '- **A-ROW · DONE is a token, not a state.** Work.',
    ].join('\n');
    const classes = await classOf(rows);
    assert.ok(
      classes.every((klass) => klass !== 'terminal'),
      `neither row may be terminal, got ${classes.join(', ')}`,
    );
  });

  // spec:queue-audit/S3
  it('an identifier that merely STARTS with a marker is a name — digits and underscores included', async () => {
    const rows = [
      '- **DONE2-STATE-IS-UNREACHABLE — queued 2026-08-26.** Work.',
      '- **TALLY2-COUNTER-HAS-NO-RESET — queued 2026-08-26.** Work.',
      '- **CLOSED_LOOP-DESIGN-IS-UNDOCUMENTED — queued 2026-08-26.** Work.',
    ].join('\n');
    assert.deepEqual(await classOf(rows), ['live', 'live', 'live']);
  });

  it('a bracket or a colon does not open a status position', async () => {
    // A row ABOUT status words is live work: `(CLOSED is an input)` and `note: CLOSED is data` are
    // prose, and treating either as a segment head would authorise deleting the row that says so.
    const rows = [
      '- **The reader must keep status words as data (CLOSED is an input).** Work.',
      '- **A-ROW — note: DONE is a token the parser reads.** Work.',
    ].join('\n');
    const classes = await classOf(rows);
    assert.ok(
      classes.every((klass) => klass !== 'terminal'),
      `neither row may be terminal, got ${classes.join(', ')}`,
    );
  });

  it('a terminal word in the MIDDLE of a title is a mention, not a status', async () => {
    const text = '- **THE CLOSED state drops live work — a defect in the reader.** Body.';
    const [row] = await rowsOf(text);
    assert.equal(row.klass, 'ambiguous', 'a mention must be settled by a human, never auto-deleted');
  });

  it('a status opening the title, or opening a segment after a dash, still decides', async () => {
    const rows = [
      '- **✅ DONE 2026-08-20 (AD-100).** Shipped.',
      '- **A-ROW-THAT-SHIPPED — ✅ CLOSED 2026-08-20 (AD-100).** Shipped.',
      '- **SUPERSEDED 2026-08-21 by the row above — A-ROW.** Body.',
    ].join('\n');
    assert.deepEqual(await classOf(rows), ['terminal', 'terminal', 'terminal']);
  });

  it('a QUALIFIED closure in the body closes a part, not the row', async () => {
    // Measured: five of the six body-decided rows in the live corpus were this shape — a row whose
    // second face, second part or one sub-lane closed while the row itself stayed open.
    for (const status of ['PART (2) IS CLOSED — kit 3.14.0', 'SECOND FACE CLOSED 2026-08-18', '+ bare-lane DECIDED 2026-07-22', 'DISPOSITION DECIDED 2026-08-17']) {
      const text = ['- **A-ROW — a live row.** Work.', `  **${status}:** the other half.`].join('\n');
      assert.deepEqual(await classOf(text), ['live'], `"${status}" must not close the row`);
    }
  });

  it('a leading check mark opens a bold status the same as a word marker', async () => {
    const text = ['- **A-ROW — a row.** Work.', '  **✅ CLOSED 2026-08-20 (AD-100):** shipped.'].join('\n');
    assert.deepEqual(await classOf(text), ['terminal']);
  });

  it('a terminal word inside a kebab SLUG is part of a name, not a status', async () => {
    // Measured: the only false positive in the live 272-row corpus was
    // THE-SCRATCH-NAMING-CONVENTION-IS-A-CLOSED-LIST-SESSIONS-KEEP-ADDING-TO, an open row.
    const text = '- **QUEUED 2026-08-19 — B — THE-CONVENTION-IS-A-CLOSED-LIST-SESSIONS-KEEP-ADDING-TO.** Work.';
    assert.deepEqual(await classOf(text), ['live']);
  });

  it('TALLY and SEQUENCING rows are records, not work', async () => {
    const text = [
      '- **TALLY 2026-08-17 — [[zero-tolerance-useless-approvals]] instance 106.** Counted.',
      '- **SEQUENCING 2026-08-25 (maintainer-approved) — THE ARCHIVER ROW RUNS FIRST.** Order.',
      '- **A-REAL-ROW — queued 2026-08-26.** Work.',
    ].join('\n');
    assert.deepEqual(await classOf(text), ['record', 'record', 'live']);
  });

  it('a title carrying BOTH a terminal and a live marker is ambiguous, never auto-deleted', async () => {
    const text = '- **SUPERSEDED 2026-08-21 by the row above — QUEUED 2026-08-20 — A — THE-THING.** Body.';
    const [row] = await rowsOf(text);
    assert.equal(row.klass, 'ambiguous');
    assert.match(row.evidence, /SUPERSEDED/);
    assert.match(row.evidence, /QUEUED/);
  });

  it('an explicitly QUEUED title with a bold terminal body is ambiguous, not terminal', async () => {
    const text = [
      '- **QUEUED 2026-08-20 — B — A-ROW-THAT-DISAGREES-WITH-ITSELF.** Work.',
      '  **CLOSED 2026-08-21:** or is it?',
    ].join('\n');
    assert.deepEqual(await classOf(text), ['ambiguous']);
  });
});
