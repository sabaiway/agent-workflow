import { REVIEW_CMD_ALIASES, receiptIdOfCmd, LENS_VERDICTS } from './carriers.mjs';
import { KNOWN_BACKENDS } from './detect-backends.mjs';
import { refuseDirectRun } from './direct-run.mjs';

export { LENS_VERDICTS };

export const BUNDLED_LENS_TEMPLATES = Object.freeze(['review-lens']);
const MEMBER_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SUFFIX_TOKEN = /^[a-z0-9]+$/u;

const reviewCommands = () => KNOWN_BACKENDS
  .map((backend) => backend.roleCmds?.review)
  .filter(Boolean);

const failRoster = (message) => new Error(`review roster: ${message}`);

export const parseSlotToken = (member) => {
  if (typeof member !== 'string' || member.length === 0) {
    throw failRoster('every member must be a non-empty string');
  }
  const bridgeCommands = reviewCommands();
  if (bridgeCommands.includes(member)) {
    const alias = REVIEW_CMD_ALIASES[member];
    if (!alias) throw failRoster(`bridge member "${member}" has no receipt alias`);
    return {
      member,
      instrument: member,
      kind: 'bridge',
      stem: alias.receiptId,
      model: null,
      effort: null,
      template: null,
      derived: false,
    };
  }
  const parts = member.split(':');
  if (parts.length !== 1 && parts.length !== 3) {
    if (bridgeCommands.includes(parts[0])) throw failRoster(`bridge member "${parts[0]}" takes no suffix`);
    throw failRoster(`member "${member}" must be a bare stem or carry both model and effort`);
  }
  const [instrument, model = null, effort = null] = parts;
  if (bridgeCommands.includes(instrument)) throw failRoster(`bridge member "${instrument}" takes no suffix`);
  if (!MEMBER_TOKEN.test(instrument)) throw failRoster(`member instrument "${instrument}" is not a slug`);
  if (model !== null && (!SUFFIX_TOKEN.test(model) || !SUFFIX_TOKEN.test(effort))) {
    throw failRoster(`member "${member}" has an invalid model or effort token`);
  }
  if (model !== null && !BUNDLED_LENS_TEMPLATES.includes(instrument)) {
    throw failRoster(`derived member "${member}" has no bundled lens template`);
  }
  return {
    member,
    instrument,
    kind: 'lens',
    stem: model === null ? instrument : `${instrument}-${model}-${effort}`,
    model,
    effort,
    template: BUNDLED_LENS_TEMPLATES.includes(instrument) ? instrument : null,
    derived: model !== null,
  };
};

export const validateRoster = (value) => {
  if (!Array.isArray(value)) throw failRoster('value must be an array');
  if (value.length === 0) throw failRoster('array must not be empty');
  const parsed = value.map(parseSlotToken);
  const seen = new Set();
  for (const member of parsed) {
    if (seen.has(member.stem)) throw failRoster(`duplicate resolved stem "${member.stem}"`);
    seen.add(member.stem);
  }
  return value;
};

export const expandShorthand = (value) => {
  if (value === 'solo') return { lossless: true, members: [] };
  if (value === 'council') return { lossless: true, members: reviewCommands() };
  return { lossless: false, members: null };
};

export const bridgeMembersOf = (value) => validateRoster(value)
  .filter((member) => parseSlotToken(member).kind === 'bridge');

export const lensMembersOf = (value) => {
  const values = Array.isArray(value)
    ? [value]
    : Object.values(value ?? {}).flatMap((activity) => (
      Array.isArray(activity?.review) ? [activity.review] : []
    ));
  return values.flat().filter((member) => parseSlotToken(member).kind === 'lens');
};

export const obligationsOf = (value) => {
  const backends = bridgeMembersOf(value).map(receiptIdOfCmd);
  if (backends.length === 0) return { recipe: 'solo', backends, minShip: 0, perBackend: false };
  return {
    recipe: backends.length === 1 ? 'reviewed' : 'council',
    backends,
    minShip: 1,
    perBackend: true,
  };
};

const explicitMembers = (value) => {
  if (Array.isArray(value)) return [...value];
  const expanded = expandShorthand(value);
  if (!expanded.lossless) throw failRoster('reviewed has no lossless roster expansion');
  return [...expanded.members];
};

export const addReviewer = (value, member) => {
  const next = explicitMembers(value);
  const parsed = parseSlotToken(member);
  if (next.some((entry) => parseSlotToken(entry).stem === parsed.stem)) return next;
  next.push(member);
  validateRoster(next);
  return next;
};

export const removeReviewer = (value, member) => {
  const next = explicitMembers(value);
  const stem = parseSlotToken(member).stem;
  const filtered = next.filter((entry) => parseSlotToken(entry).stem !== stem);
  if (next.length > 0 && filtered.length === 0) throw failRoster('removing the last member requires the solo shorthand');
  if (filtered.length > 0) validateRoster(filtered);
  return filtered;
};

refuseDirectRun(import.meta.url);
