import { readFileSync } from 'node:fs';
import { SCRIPT_PRIORS } from '../../agent-workflow-kit/tools/script-priors.mjs';
import { compareSemver } from '../../agent-workflow-kit/tools/semver-lite.mjs';

const LAST_FLAT_VERSION = '9.0.0';
const FIXTURE_ROOT = new URL('../../agent-workflow-kit/test/fixtures/script-priors/', import.meta.url);

const isAtMost = (version, ceiling) => {
  const order = compareSemver(version, ceiling);
  return order !== null && order <= 0;
};

export const readLastFlatBody = (name) => {
  const matches = SCRIPT_PRIORS.filter(({ file, firstShipped, lastShipped }) => file === name
    && isAtMost(firstShipped, LAST_FLAT_VERSION) && isAtMost(LAST_FLAT_VERSION, lastShipped));
  if (matches.length !== 1) {
    throw new Error(`Expected one script prior for ${name} at ${LAST_FLAT_VERSION}, found ${matches.length}`);
  }
  const [{ firstShipped }] = matches;
  return readFileSync(new URL(`${firstShipped}/${name}.txt`, FIXTURE_ROOT));
};
