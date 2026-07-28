// advisor-coverage.test.mjs — the OPT-IN-SHIPS-INVISIBLE drift guard.
//
// kit 3.14.0 shipped the state-block-guard detector with a mode doc, a catalog row, a SKILL.md row
// and a README row — and NO advisor entry — so `upgrade` reported «no recommendations — flow
// optimal» to a user who did not have the capability that version had just shipped. Every OTHER
// surface of a new mode is drift-guarded (commands.test.mjs asserts catalog ⟷ SKILL.md ⟷
// references/modes/*.md); the advisor was the one surface with no guard, and it is the only surface
// a user receives PASSIVELY. The omission was therefore structurally invited.
//
// Why capabilities and not modes: a per-MODE registry cannot detect a new opt-in added INSIDE an
// already-registered mode (the read-lane is a capability of mode `hook`, not a mode of its own) —
// the mode set does not move, so set-equality against the command catalog stays green. Capability
// ids are therefore DECLARED at their point of use in each references/modes/<key>.md, mirroring the
// triangle commands.test.mjs already enforces, and the registry is asserted set-equal to those
// declarations.
//
// STATED RESIDUAL: this proves every DECLARED capability has a reachable offer or a stated
// exemption. It cannot prove that code carrying an UNDECLARED capability was declared at all — the
// same honest limit the existing catalog ⟷ docs triangle carries.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../tools/commands.mjs';
import { OPT_IN_CAPABILITIES, SEVERITIES, WHATS, BENEFITS } from '../tools/recommendations.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODES_DIR = join(kitRoot, 'references', 'modes');
const TOOL_SOURCE = readFileSync(join(kitRoot, 'tools', 'recommendations.mjs'), 'utf8');

// A mode doc declares each opt-in capability it owns, or explicitly declares it has none:
//   <!-- opt-in-capability: read-lane -->
//   <!-- opt-in-capability: none — <stated reason> -->
const DECL_RE = /<!--\s*opt-in-capability:\s*(.+?)\s*-->/g;
const NONE_PREFIX = 'none';

const declarationsFor = (mode) => {
  const text = readFileSync(join(MODES_DIR, `${mode}.md`), 'utf8');
  return [...text.matchAll(DECL_RE)].map((m) => m[1]);
};

const modeKeys = COMMANDS.map((c) => c.key);
const declared = new Map(modeKeys.map((mode) => [mode, declarationsFor(mode)]));

const isNone = (decl) => decl === NONE_PREFIX || decl.startsWith(`${NONE_PREFIX} `);
const declaredIds = [...declared.entries()].flatMap(([mode, list]) =>
  list.filter((d) => !isNone(d)).map((id) => ({ id, mode })),
);

describe('advisor coverage — every mode declares its opt-in capabilities', () => {
  for (const mode of modeKeys) {
    it(`${mode}: carries at least one opt-in-capability declaration`, () => {
      const list = declared.get(mode);
      assert.ok(list.length > 0, `references/modes/${mode}.md must declare its opt-in capabilities, or declare "none — <reason>"`);
    });
  }

  it('a "none" declaration carries a non-trivial stated reason', () => {
    for (const [mode, list] of declared) {
      for (const decl of list.filter(isNone)) {
        const reason = decl.slice(NONE_PREFIX.length).replace(/^\s*[—-]\s*/, '');
        assert.ok(reason.trim().length >= 20, `${mode}: "none" must state WHY, not just "none" (got: ${JSON.stringify(decl)})`);
      }
    }
  });

  it('a mode declaring "none" declares nothing else (no half-exempt mode)', () => {
    for (const [mode, list] of declared) {
      if (list.some(isNone)) {
        assert.equal(list.length, 1, `${mode}: "none" and a real capability cannot both be declared`);
      }
    }
  });
});

describe('advisor coverage — registry ⟷ declarations (set equality, no drift)', () => {
  it('every declared capability id has exactly one registry row, owned by the declaring mode', () => {
    for (const { id, mode } of declaredIds) {
      const rows = OPT_IN_CAPABILITIES.filter((c) => c.id === id);
      assert.equal(rows.length, 1, `capability "${id}" declared in ${mode}.md must have exactly one registry row`);
      assert.equal(rows[0].mode, mode, `capability "${id}" is declared in ${mode}.md but the registry says mode ${rows[0].mode}`);
    }
  });

  it('every registry row is declared in its owning mode doc', () => {
    for (const row of OPT_IN_CAPABILITIES) {
      const list = declared.get(row.mode);
      assert.ok(list, `registry row "${row.id}" names mode ${row.mode}, which is not a catalog mode`);
      assert.ok(list.includes(row.id), `registry row "${row.id}" is not declared in references/modes/${row.mode}.md`);
    }
  });

  it('registry ids are unique', () => {
    const ids = OPT_IN_CAPABILITIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  // The case codex's blocker demands: a SECOND capability added to an already-registered mode. A
  // per-mode set-equality could never go red here — the mode set does not move.
  it('non-vacuous: a second capability declared on the existing hook mode, unregistered, goes RED', () => {
    const synthetic = [...declaredIds, { id: 'hook-synthetic-capability', mode: 'hook' }];
    assert.throws(() => {
      for (const { id, mode } of synthetic) {
        const rows = OPT_IN_CAPABILITIES.filter((c) => c.id === id);
        assert.equal(rows.length, 1, `capability "${id}" declared in ${mode}.md must have exactly one registry row`);
      }
    }, /hook-synthetic-capability/);
  });
});

describe('advisor coverage — every capability is offered or exempt with a reason', () => {
  for (const row of OPT_IN_CAPABILITIES) {
    it(`${row.id}: names an advisor key XOR a stated exemption`, () => {
      const hasKey = typeof row.advisorKey === 'string' && row.advisorKey.length > 0;
      const hasExempt = typeof row.exempt === 'string' && row.exempt.length > 0;
      assert.ok(hasKey !== hasExempt, `${row.id} must carry exactly one of advisorKey / exempt`);
      if (hasExempt) {
        assert.ok(row.exempt.trim().length >= 20, `${row.id}: the exemption must state WHY`);
      }
    });
  }

  it('every named advisor key has its SEVERITIES / WHATS / BENEFITS rows', () => {
    for (const row of OPT_IN_CAPABILITIES.filter((c) => c.advisorKey)) {
      assert.ok(row.advisorKey in SEVERITIES, `${row.advisorKey} is missing from SEVERITIES`);
      assert.ok(row.advisorKey in WHATS, `${row.advisorKey} is missing from WHATS`);
      assert.ok(row.advisorKey in BENEFITS, `${row.advisorKey} is missing from BENEFITS`);
    }
  });

  // Declared coverage is worthless if no live probe can emit the key. Prove REACHABILITY: the key
  // has an add() call site, and the probe function enclosing that site is listed in PROBES.
  it('every named advisor key is reachable from the active PROBES chain', () => {
    // EXACT membership, never a substring test: `probesList.includes('probeFoo')` would be satisfied
    // by an unrelated `probeFooBar` in the chain, so an unreachable probe would pass the one
    // assertion that exists to prove reachability. Parse the entries into a Set instead.
    const ANCHOR = 'const PROBES = Object.freeze([';
    const probesBlock = TOOL_SOURCE.slice(TOOL_SOURCE.indexOf(ANCHOR) + ANCHOR.length);
    const probeNames = new Set(
      probesBlock
        .slice(0, probesBlock.indexOf(']'))
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => /^probe\w+$/.test(entry)),
    );
    assert.ok(probeNames.size > 0, 'the PROBES array was located and parsed');

    for (const row of OPT_IN_CAPABILITIES.filter((c) => c.advisorKey)) {
      // The call sites are hand-formatted: several wrap the key onto its own line.
      const at = TOOL_SOURCE.search(new RegExp(`\\badd\\(\\s*'${row.advisorKey}'`));
      assert.notEqual(at, -1, `${row.advisorKey} has no add() call site — nothing can ever emit it`);
      const before = TOOL_SOURCE.slice(0, at);
      // An `export` in front of the declaration must not hide it: matching only `\nconst probe`
      // attributed an exported probe's add() site to the PREVIOUS probe, so removing the exported
      // one from the PROBES chain would have left this guard green.
      const decls = [...before.matchAll(/\n(?:export )?const (probe\w*)/g)];
      assert.notEqual(decls.length, 0, `${row.advisorKey}'s add() site is not inside a probe function`);
      const probeName = decls[decls.length - 1][1];
      assert.ok(
        probeNames.has(probeName),
        `${row.advisorKey} is emitted by ${probeName}, which is NOT in the PROBES chain — the offer can never fire`,
      );
    }
  });

  // Non-vacuity for the EXPORTED-probe case: an `export const probeX` whose add() site follows a
  // plain `const probeY` must resolve to probeX, not to probeY.
  it('non-vacuous: an exported probe declaration is attributed to ITSELF, not the previous probe', () => {
    const sample = "\nconst probeAlpha = () => {\n  add('alpha', 1, 2);\n};\n\nexport const probeBeta = () => {\n  add('beta', 1, 2);\n};\n";
    const at = sample.search(/\badd\(\s*'beta'/);
    const decls = [...sample.slice(0, at).matchAll(/\n(?:export )?const (probe\w*)/g)];
    assert.equal(decls[decls.length - 1][1], 'probeBeta');
    const legacy = sample.slice(0, at).lastIndexOf('\nconst probe');
    assert.equal(sample.slice(legacy + '\nconst '.length).match(/^(\w+)/)[1], 'probeAlpha', 'the old parser mis-attributed it');
  });

  // Non-vacuity for the reachability guard itself: a name that is only a PREFIX of a real chain entry
  // must NOT read as present. Before this, the substring form let an unreachable probe pass.
  it('non-vacuous: a probe name that is merely a prefix of a chain entry does not count as reachable', () => {
    const ANCHOR = 'const PROBES = Object.freeze([';
    const probesBlock = TOOL_SOURCE.slice(TOOL_SOURCE.indexOf(ANCHOR) + ANCHOR.length);
    const listText = probesBlock.slice(0, probesBlock.indexOf(']'));
    const probeNames = new Set(
      listText.split(',').map((e) => e.trim()).filter((e) => /^probe\w+$/.test(e)),
    );
    const real = [...probeNames].find((n) => n.length > 'probe'.length + 3);
    assert.ok(real, 'a real probe name exists to truncate');
    const prefix = real.slice(0, -1);
    assert.ok(listText.includes(prefix), 'the truncated name IS a substring of the chain text');
    assert.ok(!probeNames.has(prefix), 'but exact membership rejects it — the guard cannot false-green');
  });

  it('no orphan advisor offer: every add() key in the tool belongs to a registered capability', () => {
    const emitted = [...TOOL_SOURCE.matchAll(/\badd\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
    const registered = new Set(OPT_IN_CAPABILITIES.filter((c) => c.advisorKey).map((c) => c.advisorKey));
    for (const key of new Set(emitted)) {
      assert.ok(registered.has(key), `the advisor can emit "${key}" but no declared capability claims it`);
    }
  });
});
