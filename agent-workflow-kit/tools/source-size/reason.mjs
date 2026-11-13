export const INITIAL_ADOPTION_REASON = 'initial adoption';
export const GROWTH_REASON_PLACEHOLDER = '<why this size is accepted>';

const HALF_OF_DIMENSION = Object.freeze({
  lines: 'baseline',
  maxLineBytes: 'baseline',
  'aggregate lines': 'aggregate',
  files: 'layout',
  entries: 'layout',
  depth: 'layout',
});
const MACHINE_HALVES = Object.freeze([...new Set(Object.values(HALF_OF_DIMENSION))]);
const PLACEHOLDER_RE = /^<.*>$/;

export const halfOf = ({ dimension }) => HALF_OF_DIMENSION[dimension];

export const presentHalves = (config) => MACHINE_HALVES.filter((half) => config?.[half] != null);

export const refusedRaises = ({ plan, config, reason }) => {
  const present = presentHalves(config);
  return reason === INITIAL_ADOPTION_REASON ? plan.raises.filter((delta) => present.includes(halfOf(delta))) : [];
};

export const mintReasonOf = (config) => presentHalves(config).length > 0 ? GROWTH_REASON_PLACEHOLDER : INITIAL_ADOPTION_REASON;

export const commandReasonDefect = (reason, { override = false } = {}) => {
  if (PLACEHOLDER_RE.test(reason)) return `--reason still carries the placeholder ${reason} — write the reason in its place; the command line never takes a placeholder as a reason`;
  if (override && reason === INITIAL_ADOPTION_REASON) {
    return `--override takes its own reason — "${INITIAL_ADOPTION_REASON}" is the kit's sentence for a record's first entries, and an override is a reasoned change of a kit number`;
  }
  return null;
};
