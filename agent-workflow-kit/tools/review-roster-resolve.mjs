import { safeLine, REVIEW_CMD_ALIASES } from './carriers.mjs';
import { READY, NEEDS_SKILL, NEEDS_CLI, NEEDS_CREDENTIALS, DEGRADED } from './detect-backends.mjs';
import { parseSlotToken, validateRoster } from './review-roster.mjs';
import { refuseDirectRun } from './direct-run.mjs';

const READY_STATES = new Set([READY, 'placed', 'customized']);

const setupTarget = (entry) => entry?.setupHint?.local ?? entry?.setupHint?.url ?? null;

export const remedyFor = (entry = {}) => {
  const setup = setupTarget(entry);
  if (entry.readiness === NEEDS_SKILL) return setup ? `bridge skill not installed — ${safeLine(setup)}` : 'bridge skill not installed — run /agent-workflow-kit setup';
  if (entry.readiness === NEEDS_CLI) return setup ? `the CLI is not installed — ${safeLine(setup)}` : 'the CLI is not installed';
  if (entry.readiness === NEEDS_CREDENTIALS) return 'not signed in (credentials missing)';
  if (entry.readiness === DEGRADED) return 'wrapper not on PATH — run /agent-workflow-kit setup';
  return entry.readiness ? safeLine(entry.readiness) : 'bridge readiness unavailable';
};

export const lensVehicleSpec = (member) => {
  const parsed = typeof member === 'string' ? parseSlotToken(member) : member;
  if (parsed.kind !== 'lens') throw new Error(`not a lens member: ${parsed.member ?? member}`);
  return {
    stem: parsed.stem,
    template: parsed.template,
    model: parsed.model,
    effort: parsed.effort,
    tools: 'read-only',
    derived: parsed.derived,
  };
};

export const deriveLensTemplate = (template, spec) => {
  if (!spec?.derived) return String(template);
  return String(template)
    .replace(/^name:.*$/mu, `name: ${spec.stem}`)
    .replace(/^model:.*$/mu, `model: ${spec.model}`)
    .replace(/^effort:.*$/mu, `effort: ${spec.effort}`);
};

const postureValue = (postures, receiptId) => {
  const value = postures?.[receiptId];
  if (typeof value === 'string') return value;
  return value?.state === 'valid' ? value.posture : null;
};

const bridgeRow = (parsed, readiness, postures) => {
  const alias = REVIEW_CMD_ALIASES[parsed.instrument];
  const entry = readiness.find((candidate) => candidate?.name === alias.backend);
  const state = entry?.readiness ?? NEEDS_SKILL;
  return {
    member: parsed.member,
    stem: parsed.stem,
    kind: 'bridge',
    state,
    reason: state === READY ? null : remedyFor({ ...entry, readiness: state }),
    posture: postureValue(postures, parsed.stem),
  };
};

const lensRow = (parsed, surveyLens) => {
  if (typeof surveyLens !== 'function') {
    return {
      member: parsed.member, stem: parsed.stem, kind: 'lens', state: 'unsurveyed',
      reason: null, posture: null,
    };
  }
  const survey = surveyLens(lensVehicleSpec(parsed)) ?? {};
  const state = survey.state ?? 'unusable';
  const posture = READY_STATES.has(state) && survey.model && survey.effort
    ? `model=${safeLine(survey.model)} effort=${safeLine(survey.effort)}`
    : null;
  return {
    member: parsed.member,
    stem: parsed.stem,
    kind: 'lens',
    state,
    reason: survey.reason == null ? null : safeLine(survey.reason),
    posture,
  };
};

export const resolveRoster = ({ value, readiness = [], surveyLens, postures } = {}) => {
  validateRoster(value);
  return value.map((member) => {
    const parsed = parseSlotToken(member);
    return parsed.kind === 'bridge'
      ? bridgeRow(parsed, readiness, postures)
      : lensRow(parsed, surveyLens);
  });
};

export const rosterLabel = (roster, { states = true } = {}) => roster.map((row) => {
  if (!states || READY_STATES.has(row.state)) return row.member;
  return `${row.member} (${safeLine(row.state)})`;
}).join(' + ');

export const activeLineCell = (roster, options) => `[${rosterLabel(roster, options)}]`;

refuseDirectRun(import.meta.url);
