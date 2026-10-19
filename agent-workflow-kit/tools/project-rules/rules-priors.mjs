// The append-only catalog of the kit-file bodies earlier releases shipped, and its one question.
// Contract: docs/ai/specs/kit/project-rules/rules-priors.md.

import { digestOf } from './rules-check.mjs';

export const RULES_PRIORS = Object.freeze([]);

// isKnownPrior(theme, bytes, catalog?) → true exactly when the bytes hash to an entry of that theme.
export const isKnownPrior = (theme, bytes, catalog = RULES_PRIORS) => {
  const digest = digestOf(bytes);
  return catalog.some((entry) => entry.theme === theme && entry.sha256 === digest);
};
