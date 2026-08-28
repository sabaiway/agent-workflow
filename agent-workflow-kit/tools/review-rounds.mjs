import { isShipVerdict, isRecognizedVerdict } from './core-evidence.mjs';

export const SIGNALS = Object.freeze({
  NO_RECEIPTS: 'no receipts for <path>',
  INCOMPLETE: 'incomplete round — <backend> missing: dispatch it',
  CONVERGED: 'converged',
  CROSSOVER: 'crossover — stop: diff-review',
  CAP_REACHED: 'cap reached — classify each surviving finding: fixable-bug / inherent-layer-residual / escalate',
  FOLD_AND_RE_REVIEW: 'round 1 — fold and re-review',
});

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
// A receipt-derived string is REFUSED, never escaped: no C0/C1 control and no Unicode line or
// paragraph separator, so the render's one-signal-line contract cannot be forged from the store.
const isPlainLine = (value) => typeof value === 'string' && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

const invalidFieldOf = (receipt) => {
  if (typeof receipt?.artifactPath !== 'string') return 'artifactPath';
  if (typeof receipt.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.fingerprint)) return 'fingerprint';
  if (!isPlainLine(receipt.backend) || receipt.backend.length === 0) return 'backend';
  if (receipt.probe !== false) return 'probe';
  if (!isPlainLine(receipt.verdict)) return 'verdict';
  if (!isNonNegativeInteger(receipt.durationS)) return 'durationS';
  if (!isNonNegativeInteger(receipt.blocking)) return 'blocking';
  return null;
};

export const groupRounds = (receipts, obligation) => {
  const expected = new Set(obligation.backends);
  const rounds = [];
  const invalid = [];
  const unexpected = [];
  for (const receipt of receipts) {
    const invalidField = invalidFieldOf(receipt);
    if (invalidField !== null) {
      invalid.push({ field: invalidField, receipt });
      continue;
    }
    if (!expected.has(receipt.backend)) {
      unexpected.push(receipt);
      continue;
    }
    const previous = rounds.at(-1);
    const round = previous?.fingerprint === receipt.fingerprint
      ? previous
      : { fingerprint: receipt.fingerprint, byBackend: {} };
    if (round !== previous) rounds.push(round);
    round.byBackend[receipt.backend] = receipt;
  }
  return { rounds, invalid, unexpected };
};

export const isComplete = (round, obligation) => {
  const present = obligation.backends.filter((backend) => round.byBackend[backend] !== undefined);
  return obligation.perBackend
    ? present.length === obligation.backends.length
    : present.length >= obligation.minShip;
};

const isConverged = (round, obligation) => obligation.backends
  .map((backend) => round.byBackend[backend])
  .filter(Boolean)
  .every((receipt) => receipt.blocking === 0 && isShipVerdict(receipt.verdict));

const hasCrossover = (rounds, obligation) => {
  const [earlier, latest] = rounds.slice(-2);
  return obligation.backends.some((shipBackend) => {
    const shipEarlier = earlier.byBackend[shipBackend];
    const shipLatest = latest.byBackend[shipBackend];
    if (!isShipVerdict(shipEarlier?.verdict) || !isShipVerdict(shipLatest?.verdict)) return false;
    return obligation.backends.some((negativeBackend) => {
      if (negativeBackend === shipBackend) return false;
      const negativeEarlier = earlier.byBackend[negativeBackend]?.verdict;
      const negativeLatest = latest.byBackend[negativeBackend]?.verdict;
      return isRecognizedVerdict(negativeEarlier) && !isShipVerdict(negativeEarlier)
        && isRecognizedVerdict(negativeLatest) && !isShipVerdict(negativeLatest);
    });
  });
};

export const signalFor = (rounds, obligation, artifactPath) => {
  if (rounds.length === 0) return SIGNALS.NO_RECEIPTS.replace('<path>', () => artifactPath);
  const latest = rounds.at(-1);
  if (!isComplete(latest, obligation)) {
    const missing = obligation.backends.find((backend) => latest.byBackend[backend] === undefined);
    return SIGNALS.INCOMPLETE.replace('<backend>', () => missing);
  }
  if (isConverged(latest, obligation)) return SIGNALS.CONVERGED;
  const complete = rounds.filter((round) => isComplete(round, obligation));
  if (complete.length >= 2 && hasCrossover(complete, obligation)) return SIGNALS.CROSSOVER;
  if (complete.length >= 2) return SIGNALS.CAP_REACHED;
  return SIGNALS.FOLD_AND_RE_REVIEW;
};

export const renderRounds = ({ rounds, invalid = [], unexpected = [], obligation, artifactPath, pathless = 0, malformed = 0 }) => {
  const lines = [];
  rounds.reduce((total, round, index) => {
    const receipts = obligation.backends.map((backend) => round.byBackend[backend]).filter(Boolean);
    const duration = receipts.reduce((sum, receipt) => sum + receipt.durationS, 0);
    const cells = obligation.backends.map((backend) => {
      const receipt = round.byBackend[backend];
      return receipt === undefined
        ? `${backend}: missing`
        : `${backend}: ${receipt.verdict} (${receipt.blocking} blocking, ${receipt.durationS}s)`;
    });
    const next = total + duration;
    lines.push(`round ${index + 1} · ${cells.join(' · ')} · receipted duration: ${duration}s · cumulative: ${next}s`);
    return next;
  }, 0);
  for (const entry of invalid) lines.push(`invalid: ${entry.field}`);
  for (const receipt of unexpected) lines.push(`unexpected: ${receipt.backend}`);
  lines.push(`pathless plan/diff receipts: ${pathless}`);
  lines.push(`malformed receipt lines: ${malformed}`);
  lines.push(`signal: ${signalFor(rounds, obligation, artifactPath)}`);
  return lines.join('\n');
};
