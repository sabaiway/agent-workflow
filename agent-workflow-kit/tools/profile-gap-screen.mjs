import { lstatSync, readFileSync } from 'node:fs';
import { refuseDirectRun } from './direct-run.mjs';
import { GAP_STATES, NO_COMMAND_SENTENCE, STORY_REGION_ABSENT, judgeProfileGaps } from './profile-gaps.mjs';
import { readDeclines, readShippedProfile } from './reference-profile.mjs';

const SESSION_RULES_ID = 'session-close-rules';
const NOT_IN_PROFILE = 'not in the shipped profile';

const refused = (reason) => ({ gaps: [], skips: [reason] });

const disposeOf = ({ entry, state, reason }, root, hasById) => {
  if (state === GAP_STATES.present || state === GAP_STATES.declined) return {};
  if (state === GAP_STATES.undecidable) {
    if (entry.id === SESSION_RULES_ID && reason === STORY_REGION_ABSENT) return {};
    return { skip: `${entry.id}: ${reason}` };
  }
  const has = hasById.get(entry.id);
  if (has === undefined) return { skip: `${entry.id}: ${NOT_IN_PROFILE}` };
  const apply = entry.apply(root);
  if (!apply) return { skip: `${entry.id}: ${NO_COMMAND_SENTENCE}` };
  return { gap: { id: entry.id, what: `${entry.id}: ${has}`, apply } };
};

export const composeProfileGapScreen = ({ root, deps = {} }) => {
  const io = { readFileSync, lstatSync, ...deps };
  const shipped = readShippedProfile(io);
  if (shipped.refusal) return refused(shipped.refusal);
  const record = readDeclines(root, io);
  if (record.refusal) return refused(record.refusal);
  const hasById = new Map(shipped.profile.items.map(({ id, has }) => [id, has]));
  const judged = judgeProfileGaps({ root, deps: io, lineage: shipped.profile.lineage, declined: record.declined });
  const gaps = [];
  const skips = [];
  for (const item of judged) {
    const { gap, skip } = disposeOf(item, root, hasById);
    if (gap) gaps.push(gap);
    if (skip) skips.push(skip);
  }
  return { gaps, skips };
};

refuseDirectRun(import.meta.url);
