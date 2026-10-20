// setup.mjs — the layout setup: its closed answers, the one statement of what a --check run judges,
// and the setup's answer for a project. It writes no file, spawns no process of its own and imports no
// file of the practice: every read reaches it through the values its caller hands it, so the advisor,
// the git-hooks leaf and the check ask one rule.
//
// Dependency-free, Node >= 22. No side effects on import.

import { SPEC_STORE_ROOT } from './layout.mjs';

export const SETUP_ANSWERS = Object.freeze(['armable', 'record', 'held']);

// checkTargetOf({ loaded, absentConfig }) → exactly one of: the schema-1 stop, the unminted stop (a
// present config authored or incomplete), or the config to judge with the dimensions judged.
export const checkTargetOf = ({ loaded, absentConfig }) => {
  const absent = loaded.state === 'absent';
  const config = absent ? absentConfig : loaded.config;
  if (config.schema === 1) return { stop: 'schema-1', config };
  if (!absent && loaded.state !== 'minted') return { stop: 'unminted', config, state: loaded.state, missing: loaded.missingMachineKeys };
  return { stop: null, config, judged: { absent, layout: absent || config.layout !== null } };
};

// The store-root rule of a config that starts layout: the store is a root of its own there.
const insideStore = (root) => root === SPEC_STORE_ROOT || root.startsWith(`${SPEC_STORE_ROOT}/`);

// layoutSetupOf(root, practice, deps) → { answer: 'armable' } | { answer: 'record', args } |
// { answer: 'held', reason } with reason schema-1, unminted, store-root (with the root) or stops.
// `practice` carries the loader, judgeTree, stopsOf, the absent config the check judges and the reason
// the record's first entries take.
export const layoutSetupOf = (root, practice, deps = {}) => {
  const target = checkTargetOf({ loaded: practice.loadSourceSizeConfig(root, deps), absentConfig: practice.absentConfig });
  if (target.stop !== null) return { answer: 'held', reason: target.stop };
  const { config, judged } = target;
  const starts = !judged.layout;
  const storeRoot = starts ? config.roots.find(insideStore) : undefined;
  if (storeRoot !== undefined) return { answer: 'held', reason: 'store-root', root: storeRoot };
  const stops = practice.stopsOf(practice.judgeTree(root, config, deps, judged).findings).length > 0;
  if (judged.absent) return stops ? { answer: 'record', args: ['--write-baseline', '--reason', practice.reason] } : { answer: 'armable' };
  if (stops) return { answer: 'held', reason: 'stops' };
  return starts ? { answer: 'record', args: ['--write-baseline', '--layout', '--reason', practice.reason] } : { answer: 'armable' };
};
