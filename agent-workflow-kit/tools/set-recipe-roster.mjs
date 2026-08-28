import {
  addReviewer,
  expandShorthand,
  lensMembersOf,
  obligationsOf,
  parseSlotToken,
  removeReviewer,
} from './review-roster.mjs';
import { isReadyMember, resolveRoster, skippedLine } from './review-roster-resolve.mjs';
import { applySetOps, assertSlot, fail } from './orchestration-config.mjs';
import { refuseDirectRun } from './direct-run.mjs';

const REVIEWER_KINDS = new Set(['add-reviewer', 'remove-reviewer']);

const parseQualified = (token, flag) => {
  const equals = token.indexOf('=');
  const qualified = equals < 0 ? token : token.slice(0, equals);
  const dot = qualified.indexOf('.');
  if (equals <= 0 || equals === token.length - 1 || dot <= 0 || dot === qualified.length - 1) {
    throw fail(2, `--${flag} must be <activity>.review=<member> (got "${token}")`);
  }
  return {
    activity: qualified.slice(0, dot),
    slot: qualified.slice(dot + 1),
    member: token.slice(equals + 1),
  };
};

export const parseReviewerOp = (kind, token) => {
  if (!REVIEWER_KINDS.has(kind)) throw fail(2, `unknown reviewer op: ${kind}`);
  const parsed = parseQualified(token, kind);
  if (assertSlot(parsed.activity, parsed.slot) !== 'review') {
    throw fail(2, `--${kind} requires a review slot (got "${parsed.activity}.${parsed.slot}")`);
  }
  try {
    parseSlotToken(parsed.member);
  } catch (error) {
    throw fail(2, error.message);
  }
  return { kind, ...parsed };
};

const membersOf = (value) => {
  if (Array.isArray(value)) return value;
  const expanded = expandShorthand(value);
  return expanded.lossless ? expanded.members : null;
};

const sameMembers = (left, right) => {
  const a = membersOf(left);
  const b = membersOf(right);
  return a !== null && b !== null && a.length === b.length && a.every((member, index) => member === b[index]);
};

const reviewedRefusal = (activity) => fail(
  2,
  `reviewed has no lossless roster expansion — run --set ${activity}.review=council first, or use --add-reviewer ${activity}.review=codex-review / --add-reviewer ${activity}.review=agy-review on a solo slot`,
);

const applyOne = (value, op) => {
  if (membersOf(value) === null) throw reviewedRefusal(op.activity);
  try {
    return op.kind === 'add-reviewer'
      ? addReviewer(value, op.member)
      : removeReviewer(value, op.member);
  } catch (error) {
    throw fail(2, error.code === 'last-member' ? `${error.message} — run --set ${op.activity}.review=solo` : error.message);
  }
};

export const applyReviewerOps = (current, ops, { defaults = {}, seedReadme = null } = {}) => {
  const states = new Map();
  for (const op of ops) {
    const key = `${op.activity}.${op.slot}`;
    const raw = current?.[op.activity]?.[op.slot] ?? null;
    const state = states.get(key) ?? {
      activity: op.activity,
      slot: op.slot,
      from: raw,
      beforeValue: raw ?? defaults[key],
      value: raw ?? defaults[key],
      named: new Set(),
    };
    if (state.value === undefined) throw fail(2, `no computed default supplied for ${key}`);
    state.value = applyOne(state.value, op);
    if (op.kind === 'add-reviewer') state.named.add(parseSlotToken(op.member).stem);
    states.set(key, state);
  }
  const rows = [...states.values()].map((state) => {
    const changed = !sameMembers(state.beforeValue, state.value);
    return {
      ...state,
      changed,
      to: changed ? state.value : state.from,
      afterValue: changed ? state.value : state.beforeValue,
    };
  });
  const changes = rows.filter((row) => row.changed).map((row) => ({
    kind: 'set', activity: row.activity, slot: row.slot, recipe: row.to,
  }));
  return {
    config: changes.length ? applySetOps(current, changes, { seedReadme }) : current,
    rows,
  };
};

const gateLabel = (value) => {
  const members = membersOf(value) ?? [];
  if (members.length === 0) return 'solo []';
  const obligation = obligationsOf(members);
  return `${obligation.recipe} [${obligation.backends.join(', ')}]`;
};

const valueLabel = (value) => value == null
  ? '(computed default)'
  : Array.isArray(value) ? JSON.stringify(value) : value;

const lensRemedy = (parsed, member, agentsApply) => {
  if (parsed.kind !== 'lens' || member.state !== 'missing') return null;
  if (parsed.template === null) return `HAND-APPLY: create .claude/agents/${parsed.stem}.md as a read-only vehicle`;
  return agentsApply ? `to place it, run exactly: ${agentsApply}` : null;
};

export const persistedLensStems = (config) => new Set(lensMembersOf(config ?? {})
  .map((member) => parseSlotToken(member))
  .filter((parsed) => parsed.derived)
  .map((parsed) => parsed.stem));

export const renderRosterPreview = (row, { agentsApply, wrote = false, persistedLenses = new Set() } = {}) => {
  const lines = [row.changed
    ? `  ${row.activity}.${row.slot}: ${valueLabel(row.from)} → ${valueLabel(row.to)}`
    : `  ${row.activity}.${row.slot}: already ${valueLabel(row.from)} (no change)`];
  const persisted = new Set((membersOf(row.from) ?? []).map((member) => parseSlotToken(member).stem));
  for (const member of row.roster) {
    const parsed = parseSlotToken(member.member);
    const apply = lensRemedy(parsed, member, agentsApply);
    const remedy = [member.reason, apply].filter(Boolean).join('; ') || null;
    const posture = member.posture == null ? '' : ` (${member.posture})`;
    lines.push(`      ↳ ${member.member}: ${isReadyMember(member) ? member.state : skippedLine(member, remedy)}${posture}`);
    if (apply && parsed.derived && !wrote && !persisted.has(parsed.stem) && !persistedLenses.has(parsed.stem)) {
      lines.push('        after --write — the agents writer derives this lens from what docs/ai/orchestration.json names');
    }
    if (parsed.kind === 'lens' && parsed.template === null && row.named.has(parsed.stem)) {
      lines.push(`        resolved as a lens with no bundled template — a hand-written vehicle; if you meant a bridge, the review cmds are ${expandShorthand('council').members.join(', ')}`);
    }
  }
  lines.push(`      gate: ${gateLabel(row.beforeValue)} → ${gateLabel(row.afterValue)}`);
  return lines.join('\n');
};

export const resolveReviewerRows = (rows, deps = {}) => rows.map((row) => {
  const members = membersOf(row.afterValue);
  return {
    ...row,
    roster: members.length === 0 ? [] : resolveRoster({ value: members, ...deps }),
  };
});

export const rosterJsonRows = (rows, changed) => rows.map((row) => changed ? ({
  activity: row.activity, slot: row.slot, from: row.from, to: row.to,
  effective: row.effective, degradedFrom: row.degradedFrom ?? null, reason: row.reason ?? null,
  roster: row.roster ?? null,
}) : ({
  activity: row.activity, slot: row.slot, recipe: row.from, roster: row.roster ?? null,
}));

refuseDirectRun(import.meta.url);
