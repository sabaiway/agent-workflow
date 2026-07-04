// Drift guard for the bridge-DELIVERY lens (Plan: deterministic freshness & delivery, §2.4):
//
//   "a bridge is PLACED by `setup` (opt-in) — never by `init`; ONCE PLACED, `init`/`upgrade`
//    REFRESH it from the kit's bundled copies; an absent bridge is never placed; a placed bridge
//    newer than the bundle is never downgraded."
//
// The lens lives in PROSE at several spots that share no runtime import — the kit SKILL.md
// (composition-root intro, Mode: setup, Mode: upgrade's stamp-independent reconcile), both
// front-facing READMEs, and the family-members data-leaf comment. Nothing else keeps that shared
// vocabulary in lockstep, so this dev-only test pins the distinctive tokens inside each spot's
// REGION (not merely somewhere in the file — a token surviving elsewhere must not keep the guard
// green). Region+token shape per the lens-mirror.test.mjs precedent; only COMMITTED copies are
// checked (the project-local docs/ai/agent_rules.md hand-sync is gitignored).
//
// Reads the monorepo checkout (root README beside the kit); same cross-package precedent as
// lens-mirror.test.mjs. Dev-only repo test (test/ is outside the package `files` whitelist).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(kitRoot, '..');

const DRIFT_MESSAGE =
  'bridge-delivery lens drifted — re-sync "placed by setup (opt-in), refreshed by init/upgrade once placed" across SKILL.md, both READMEs and family-members.mjs.';

// Slice the region between two anchors (to = end-of-file when omitted); asserting the anchors keeps
// the extraction non-vacuous (a renamed heading fails loudly instead of matching nothing).
const region = (text, from, to, where) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `${where}: missing region anchor "${from}". ${DRIFT_MESSAGE}`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `${where}: missing region anchor "${to}". ${DRIFT_MESSAGE}`);
  return text.slice(a, b);
};

// Case-insensitive, wrap-robust token check (collapse whitespace so a token may span a line break).
const missingTokens = (regionText, tokens) => {
  const haystack = regionText.toLowerCase().replace(/\s+/g, ' ');
  return tokens.filter((token) => !haystack.includes(token.toLowerCase()));
};

const SKILL = readFileSync(resolve(kitRoot, 'SKILL.md'), 'utf8');
// Post-split: the setup/upgrade procedures live in references/modes/; the composition-root intro
// (the init refresh-cascade paragraph) stays on the router.
const SETUP_FILE = readFileSync(resolve(kitRoot, 'references', 'modes', 'setup.md'), 'utf8');
const UPGRADE_FILE = readFileSync(resolve(kitRoot, 'references', 'modes', 'upgrade.md'), 'utf8');
const KIT_README = readFileSync(resolve(kitRoot, 'README.md'), 'utf8');
const ROOT_README = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
const FAMILY_MEMBERS_SRC = readFileSync(resolve(kitRoot, 'tools', 'family-members.mjs'), 'utf8');

// label · text · region anchors · the distinctive tokens that must live INSIDE that region.
const SPOTS = [
  {
    label: 'kit SKILL.md — composition-root intro (router)',
    text: SKILL, from: '## Memory substrate', to: '## Modes',
    tokens: ['once placed', 'refresh', 'never a downgrade', '--no-bridges'],
  },
  {
    label: 'kit references/modes/setup.md — Mode: setup',
    text: SETUP_FILE, from: '### Mode: setup', to: undefined,
    tokens: ['once placed', '--refresh-placed', 'never a first placement, never a downgrade', 'paste verbatim'],
  },
  {
    label: 'kit references/modes/upgrade.md — Mode: upgrade (the 4th stamp-independent reconcile)',
    text: UPGRADE_FILE, from: '### Mode: upgrade', to: undefined,
    tokens: ['placed-bridge refresh — stamp-independent', '--refresh-placed', 'output lines verbatim', 'never a first placement', 'never a downgrade'],
  },
  {
    label: 'kit README — Install',
    text: KIT_README, from: '## 🚀 Install', to: '## 🛠️ Use',
    tokens: ['once placed', 'never placed', 'never downgraded', '--no-bridges'],
  },
  {
    label: 'kit README — Use (the upgrade row)',
    text: KIT_README, from: '## 🛠️ Use', to: '## 🔍 How it works',
    tokens: ['refreshes the already-placed bridges', 'never installs a new one'],
  },
  {
    label: 'root README — Start using it',
    text: ROOT_README, from: '## 🚀 Start using it', to: '## 📦 What you get',
    tokens: ['once placed', 'refreshes them', '--no-bridges'],
  },
  {
    label: 'root README — bridges caveats + member table',
    text: ROOT_README, from: 'Honest caveats', to: 'Most people only ever need',
    tokens: ['not placed by `init`', 'never a first placement, never a downgrade', '`init` refreshes'],
  },
  {
    label: 'family-members.mjs — the data-leaf comment',
    text: FAMILY_MEMBERS_SRC, from: '// ── the unified registry', to: 'export const FAMILY_MEMBERS',
    tokens: ['placed by `setup`', 'refreshed', 'never npm'],
  },
];

describe('bridge-delivery lens — placed by setup, refreshed by init/upgrade (drift guard)', () => {
  for (const spot of SPOTS) {
    it(`keeps the lens tokens inside: ${spot.label}`, () => {
      const slice = region(spot.text, spot.from, spot.to, spot.label);
      const missing = missingTokens(slice, spot.tokens);
      assert.deepEqual(missing, [], `${spot.label} lost lens token(s) ${JSON.stringify(missing)}. ${DRIFT_MESSAGE}`);
    });
  }

  it('is non-vacuous: a doctored region with a stripped token is reported missing (injected red→green proof)', () => {
    const doctored = SETUP_FILE.replaceAll('--refresh-placed', '--REDACTED');
    const slice = region(doctored, '### Mode: setup', undefined, 'doctored setup.md');
    assert.deepEqual(missingTokens(slice, ['--refresh-placed']), ['--refresh-placed'],
      'the checker must flag a stripped token — otherwise every spot assertion above is vacuous');
    // And the real, undoctored region passes the same probe (the pair proves red→green).
    assert.deepEqual(missingTokens(region(SETUP_FILE, '### Mode: setup', undefined, 'setup.md'), ['--refresh-placed']), []);
  });
});
