// doc-parity-advisor-matrix.test.mjs — the advisor matrix STRUCTURE check (delegation Plan 3, 1.1.c).
//
// Why a structure check and not more value bindings: the mode doc's dispatch matrix must correspond
// to the frozen registry EXACTLY — same rows, same order, no duplicates, and every CELL equal. Per-row
// token presence would catch none of the ways that correspondence breaks, because every token still
// appears SOMEWHERE in the table. So each way is pinned here, in its own suite, over an injected
// reader.
//
// Two of these cases came from the round-1 council and are the reason the check is anchored rather
// than header-located: a faithful copy of the table plus a canonical one whose HEADER drifted leaves
// exactly one matching header — the decoy's — so "exactly one header" would read the decoy and pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The NAMESPACE form: a missing export fails the test that needs it, never the whole file.
import * as parity from './doc-parity.mjs';

const advisor = await import('./dispatch-advisor.mjs').catch(() => null);
const leaf = (await import('./advisor-matrix.mjs').catch(() => null)) ?? {};

const DOC = 'references/modes/dispatch.md';
const surface = (text) => (rel) => {
  if (rel !== DOC) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return text;
};

const anchored = (matrix) => `${parity.ADVISOR_MATRIX_BEGIN}\n\n${matrix}\n\n${parity.ADVISOR_MATRIX_END}`;
const page = (body) => `### Mode: dispatch\n\nprose before.\n\n${body}\n\nprose after.\n`;
const matrixLines = () => advisor.renderAdvisorMatrix().split('\n');
const classRows = (lines) => lines.filter((l) => l.startsWith('| `'));
const check = (body) => parity.checkMatrixStructure(surface(page(body)));
const drift = (mutate) => {
  const lines = matrixLines();
  mutate(lines, classRows(lines));
  return check(anchored(lines.join('\n')));
};

describe('the advisor matrix structure check — the shipped doc', () => {
  it('the real references/modes/dispatch.md carries the matrix, cell for cell (dogfood)', () => {
    const r = parity.checkMatrixStructure();
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.files[0].rel, DOC);
  });

  it('a faithful copy of the rendered matrix inside the anchor passes', () => {
    assert.equal(check(anchored(advisor.renderAdvisorMatrix())).ok, true);
  });

  it('an unreadable bound file fails closed', () => {
    const r = parity.checkMatrixStructure(() => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /unreadable/);
  });
});

describe('the advisor matrix structure check — the anchored surface', () => {
  it('an absent anchor fails CLOSED, even with a perfect table in the doc', () => {
    const r = check(advisor.renderAdvisorMatrix());
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /anchored matrix surface is not unique — found 0 /);
  });

  it('a DUPLICATED anchor fails closed — two surfaces are not one table', () => {
    const r = check(`${anchored(advisor.renderAdvisorMatrix())}\n\n${anchored(advisor.renderAdvisorMatrix())}`);
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /found 2 /);
  });

  it('an INVERTED anchor pair fails closed', () => {
    const r = check(`${parity.ADVISOR_MATRIX_END}\n\n${advisor.renderAdvisorMatrix()}\n\n${parity.ADVISOR_MATRIX_BEGIN}`);
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /inverted/);
  });

  it('a faithful DECOY outside the anchor cannot stand in for a drifted canonical table', () => {
    // The round-1 refutation, pinned: the decoy is byte-perfect, the anchored table has a drifted
    // vehicle. A header-located check reads whichever header comes first; an anchored one reads the
    // table the doc actually declares.
    const lines = matrixLines();
    const rows = classRows(lines);
    lines[lines.indexOf(rows[0])] = rows[0].replace(/\| ([a-z-]+) \|/, '| not-a-vehicle |');
    const r = check(`${advisor.renderAdvisorMatrix()}\n\n${anchored(lines.join('\n'))}`);
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /not-a-vehicle/);
  });

  it('a DRIFTED header inside the anchor fails closed rather than falling through to a decoy', () => {
    // The exact shape "exactly one header anywhere" leaves open: one matching header exists in the
    // document — the decoy's — while the anchored table's header no longer matches.
    const lines = matrixLines();
    lines[0] = lines[0].replace('| step class |', '| stepclass |');
    const r = check(`${advisor.renderAdvisorMatrix()}\n\n${anchored(lines.join('\n'))}`);
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /carries 0 header line\(s\)/);
  });

  it('a DUPLICATED header inside the anchor is ambiguous, never last-wins', () => {
    const r = check(anchored(`${advisor.renderAdvisorMatrix()}\n${advisor.renderAdvisorMatrix()}`));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /carries 2 header line\(s\)/);
  });
});

describe('the advisor matrix structure check — the whole block, not just its class rows', () => {
  it('a DELETED alignment rule fails — a table that no longer renders is not the registry table', () => {
    const r = drift((lines) => lines.splice(1, 1));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /matrix line 2 reads /);
  });

  it('a REWRITTEN harness lane fails — the lane is IN the table, not merely somewhere in the doc', () => {
    const r = drift((lines) => {
      lines[lines.length - 1] = '| harness subagent | the host\'s own | always available, just ask | not measured |';
    });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /always available, just ask/);
  });

  it('a DELETED harness lane fails', () => {
    const r = drift((lines) => lines.pop());
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /missing line 10, which the canonical table renders/);
  });

  it('an EXTRA row inside the anchor fails, even when it names no class', () => {
    const r = drift((lines) => lines.push('| something else | a vehicle | ready | a thing |'));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /extra line 11: .*something else/);
  });

  it('significant EDGE whitespace is drift, not something a trim may eat', () => {
    // The surface is trimmed of blank LINES only. Trimming the joined block with String.trim() would
    // silently absorb this, and the check would pass a table whose first cell moved.
    const r = drift((lines) => { lines[0] = ` ${lines[0]}`; });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /carries 0 header line\(s\)/);
  });

  it('blank lines around the table are NOT drift — only the table is compared', () => {
    const lines = matrixLines();
    assert.equal(check(anchored(`\n\n${lines.join('\n')}\n\n`)).ok, true);
  });

  it('a CRLF document passes through the PUBLIC check — line endings are not drift', () => {
    const body = anchored(advisor.renderAdvisorMatrix());
    const crlf = page(body).replace(/\n/g, '\r\n');
    assert.equal(parity.checkMatrixStructure(surface(crlf)).ok, true, 'a CRLF-authored doc is an ordinary doc');
    // And the same document with a real drift still FAILS — the normalization must not swallow it.
    const drifted = crlf.replace('codex-exec', 'not-a-vehicle');
    assert.equal(parity.checkMatrixStructure(surface(drifted)).ok, false);
  });
});

describe('the advisor matrix structure check — the ways correspondence breaks', () => {
  it('a REORDERED row fails, though every token is still present', () => {
    const r = drift((lines, rows) => {
      const a = lines.indexOf(rows[0]);
      const b = lines.indexOf(rows[1]);
      lines[a] = rows[1];
      lines[b] = rows[0];
    });
    assert.equal(r.ok, false);
    assert.equal(r.files[0].reason, 'the advisor matrix is out of registry order — row 1 is `extraction`, the registry has `code`');
  });

  it('a DUPLICATED row fails, though every token is still present', () => {
    const r = drift((lines, rows) => lines.splice(lines.indexOf(rows[1]), 0, rows[0]));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /names `code` more than once — the registry has exactly one row per step class/);
  });

  it('a MISSING row fails and names the registry row that is gone', () => {
    const r = drift((lines, rows) => lines.splice(lines.indexOf(rows[rows.length - 1]), 1));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /is missing 1 registry row\(s\): `worktree-stream`/);
  });

  it('a NON-FINAL missing row names the row that is gone, never the row that slid up behind it', () => {
    // The round-3 finding, pinned: a positional walk reads this as "row 3's step-class cell is
    // wrong", which points the reader at a row that is perfectly correct.
    const r = drift((lines, rows) => lines.splice(lines.indexOf(rows[2]), 1));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /is missing 1 registry row\(s\): `triage`/);
    assert.ok(!r.files[0].reason.includes('cell reads'), 'a deleted row is not a corrupted cell in its neighbour');
  });

  it('a row the registry does not know is named as UNREGISTERED', () => {
    const r = drift((lines) => lines.splice(lines.length - 1, 0, '| `not-a-class` | a vehicle | somehow | a thing |'));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /names 1 row\(s\) the registry does not: `not-a-class`/);
  });

  it('a row bound to the WRONG vehicle fails, naming the vehicle cell', () => {
    const r = drift((lines, rows) => {
      const cells = rows[0].split('|');
      lines[lines.indexOf(rows[0])] = cells.map((c, i) => (i === 2 ? ' not-a-vehicle ' : c)).join('|');
    });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /the vehicle cell reads "not-a-vehicle"/);
  });

  it('a drifted AVAILABILITY cell fails — the column a two-cell comparison could not see', () => {
    const r = drift((lines, rows) => {
      const cells = rows[0].split('|');
      lines[lines.indexOf(rows[0])] = cells.map((c, i) => (i === 3 ? ' always ready, no probe needed ' : c)).join('|');
    });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /the availability cell reads "always ready, no probe needed"/);
  });

  it('a drifted RETURNS cell fails — the other column a two-cell comparison could not see', () => {
    const r = drift((lines, rows) => {
      const cells = rows[0].split('|');
      lines[lines.indexOf(rows[0])] = cells.map((c, i) => (i === 4 ? ' whatever you like ' : c)).join('|');
    });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /the returns cell reads "whatever you like"/);
  });

  it('a FIFTH cell fails on arity — an unread column could otherwise say anything', () => {
    const r = drift((lines, rows) => {
      lines[lines.indexOf(rows[0])] = `${rows[0]} a fifth column nobody compares |`;
    });
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /carries 5 cell\(s\), the table has 4 columns/);
  });
});

describe('the extraction preserved the surface — pinned, not asserted in prose', () => {
  it('every name doc-parity exported for the matrix check is still reachable from doc-parity, and IS the leaf binding', () => {
    // The leaf moved a parser out of the lint. "Callers keep working" was prose; this is the pin —
    // a future extraction that drops one of these fails here instead of in a consumer.
    const names = ['ADVISOR_MATRIX_DOC', 'ADVISOR_MATRIX_BEGIN', 'ADVISOR_MATRIX_END', 'parseAdvisorMatrix', 'checkMatrixStructure', 'readKitDoc'];
    for (const name of names) {
      assert.notEqual(parity[name], undefined, `doc-parity must still export ${name}`);
      assert.equal(parity[name], leaf[name], `${name} must BE the leaf's binding, never a second copy`);
    }
  });
});

describe('the structure check joins the gate, and the registry stays reachable from it', () => {
  it('--check reports the structure result beside the bindings, and the real tree is green', () => {
    const r = parity.main(['--check']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /structure/);
  });

  it('--json carries the structure result WITHOUT growing the per-binding result set', () => {
    const r = parity.main(['--json']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.results.length, parity.BINDINGS.length, 'the structure check is its own key, never a fake binding');
    assert.equal(j.structure.ok, true);
    assert.equal(j.ok, true);
  });

  it('a drifted structure fails the --check gate (exit 1) even with every binding green', () => {
    const r = parity.main(['--check'], { readText: driftedDoc });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /structure/);
  });

  it('the DEFAULT report never prints PASS while the structure fails', () => {
    // The summary verdict is derived from both halves: a PASS token computed from the bindings alone
    // made the human report the one surface that contradicted the gate beside it.
    const r = parity.main([], { readText: driftedDoc });
    assert.equal(r.code, 0, 'the default report is a report, not a gate — its exit stays 0');
    assert.match(r.stdout, /check: FAIL/);
    assert.match(r.stdout, /✗ advisor-matrix-structure/);
  });
});

// A surface where every VALUE binding still renders, and only the matrix rows are reordered.
function driftedDoc(rel) {
  const real = parity.readKitDoc(rel);
  if (rel !== DOC) return real;
  const lines = matrixLines();
  const rows = classRows(lines);
  lines[lines.indexOf(rows[0])] = rows[1];
  return real.replace(advisor.renderAdvisorMatrix(), lines.join('\n'));
}
