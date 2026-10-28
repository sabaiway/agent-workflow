// The append-only catalog of the kit-file bodies earlier releases shipped, and its one question.
// Contract: docs/ai/specs/kit/project-rules/rules-priors.md.

import { digestOf } from './rules-check.mjs';

export const RULES_PRIORS = Object.freeze([
  Object.freeze({ theme: 'project-layout', release: '14.37.0', sha256: 'b79f19a9e0583f1e0619ee6aca06feb2c359b9655f1d260e87d8d5647bd1de19' }),
  Object.freeze({ theme: 'project-layout', release: '19.4.0', sha256: 'ec4ef10c05ba365e73df96d175042314ea120f3fe1c946fdd94d3d1237de8be9' }),
]);

// isKnownPrior(theme, bytes, catalog?) → true exactly when the bytes hash to an entry of that theme.
export const isKnownPrior = (theme, bytes, catalog = RULES_PRIORS) => {
  const digest = digestOf(bytes);
  return catalog.some((entry) => entry.theme === theme && entry.sha256 === digest);
};
