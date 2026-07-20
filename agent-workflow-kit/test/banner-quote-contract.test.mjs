// banner-quote-contract.test.mjs — AD-061 cross-file drift guard: the «quote the posture banner
// verbatim» orchestrator duty ships in each bridge's OWN driving contracts, PLACED on the role it
// governs (placement-aware — a clause parked on the wrong role is a miss), and the exec-banner
// guarantee rides EVERY execute-role mode-catalog entry. Surfaces pinned separately: the specific
// role notes in capability.json, the driving reference doc, the bridge SKILL.md (root AND kit
// bundle trees), and the kit registry via the imported wrapperContractFor (kit-only, checked
// once). The --help Notes surfaces stay covered by the exact wrapper↔manifest lockstep tests in
// each wrapper's own suite — never re-checked here.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapperContractFor } from '../tools/detect-backends.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// Whitespace-tolerant: the driving docs hard-wrap prose, so the phrase may span lines.
const QUOTE_DUTY = /quote\s+the\s+posture\s+banner\s+verbatim/i;

const notesOf = (manifest, role) => (manifest.roles?.[role]?.contract?.notes ?? []).join(' ');

for (const base of [ROOT, join(ROOT, 'agent-workflow-kit', 'bridges')]) {
  const label = base === ROOT ? 'root' : 'kit bundle';

  describe(`banner quote-verbatim duty — role-placed manifest notes (${label})`, () => {
    it('codex: BOTH the execute AND the review contract notes carry the duty (placement-aware)', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'codex-cli-bridge', 'capability.json'), 'utf8'));
      assert.match(notesOf(manifest, 'execute'), QUOTE_DUTY, 'roles.execute.contract.notes must carry the duty');
      assert.match(notesOf(manifest, 'review'), QUOTE_DUTY, 'roles.review.contract.notes must carry the duty');
    });

    it('agy: the review contract notes carry the duty', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'antigravity-cli-bridge', 'capability.json'), 'utf8'));
      assert.match(notesOf(manifest, 'review'), QUOTE_DUTY, 'roles.review.contract.notes must carry the duty');
    });
  });

  describe(`banner quote-verbatim duty — driving reference + SKILL surfaces (${label})`, () => {
    for (const [bridge, drivingDoc] of [
      ['codex-cli-bridge', 'driving-codex.md'],
      ['antigravity-cli-bridge', 'driving-agy.md'],
    ]) {
      it(`${bridge}: references/${drivingDoc} carries the duty`, () => {
        assert.match(readFileSync(join(base, bridge, 'references', drivingDoc), 'utf8'), QUOTE_DUTY);
      });
      it(`${bridge}: SKILL.md carries the duty`, () => {
        assert.match(readFileSync(join(base, bridge, 'SKILL.md'), 'utf8'), QUOTE_DUTY);
      });
    }
  });

  describe(`exec-banner guarantee — every execute-role mode (${label})`, () => {
    it('codex: exec + both resume continuations each guarantee the exec posture banner', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'codex-cli-bridge', 'capability.json'), 'utf8'));
      const execModes = manifest.modeCatalog.filter((m) => m.role === 'execute');
      assert.deepEqual(execModes.map((m) => m.key).sort(), ['exec', 'exec.resume', 'exec.resume-last'],
        'the execute-role catalog is exactly exec + the two resume continuations');
      for (const mode of execModes) {
        assert.ok(JSON.stringify(mode).includes('exec posture'),
          `${mode.key} must carry the exec-posture banner guarantee`);
      }
    });

    it('agy: NO execute-role mode exists (the banner guarantee has no agy exec surface to ride)', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'antigravity-cli-bridge', 'capability.json'), 'utf8'));
      const execModes = (manifest.modeCatalog ?? []).filter((m) => m.role === 'execute');
      assert.deepEqual(execModes, [], 'agy has no exec mode — a new one must adopt the banner contract deliberately');
    });
  });
}

describe('banner quote-verbatim duty — the kit registry (kit-only surface, via the imported reader)', () => {
  it('wrapperContractFor surfaces the duty on the roles that carry it (never placement-blind)', () => {
    for (const [backend, role] of [
      ['codex-cli-bridge', 'execute'],
      ['codex-cli-bridge', 'review'],
      ['antigravity-cli-bridge', 'review'],
    ]) {
      const contract = wrapperContractFor(backend, role);
      assert.ok(contract, `${backend}/${role} contract resolves`);
      assert.match((contract.notes ?? []).join(' '), QUOTE_DUTY,
        `${backend}/${role}: the registry mirror notes must carry the duty`);
    }
  });
});
