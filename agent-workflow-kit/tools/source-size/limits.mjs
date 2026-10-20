// limits.mjs — the kit's five size limits and a project's reasoned overrides of them: the frozen
// table, the override grammar, the resolution every reader gets, the lines that state it, and the two
// transforms the writer applies (the schema-1 move and one override). Pure: it writes no file, spawns no process and
// imports no file of the practice, so the record's reason rule is handed in by its caller.
//
// Dependency-free, Node >= 22. No side effects on import.

const limit = (value, tolerance) => Object.freeze({ value, tolerance });

// `files-per-root` has no kit value: its count is the one a project records.
export const KIT_LIMITS = Object.freeze({
  'lines-per-file': limit(400, 10),
  'bytes-per-line': limit(1000, 0),
  'entries-per-directory': limit(20, 10),
  depth: limit(5, 0),
  'files-per-root': limit(null, 10),
});

export const SCHEMA1_REASON = 'carried from schema 1';

// The schema-1 `defaults` key each carried limit was spelled under.
const SCHEMA1_KEY = Object.freeze({ 'lines-per-file': 'maxLines', 'bytes-per-line': 'maxLineBytes' });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasValue = (id) => KIT_LIMITS[id].value !== null;
const overrideKeys = (id) => (hasValue(id) ? ['value', 'tolerance', 'reason'] : ['tolerance', 'reason']);

const overrideDefect = (id, override, reasonDefect) => {
  if (!isPlainObject(override)) return `"limits"."${id}" must be an object holding ${overrideKeys(id).join(', ')}`;
  const keys = overrideKeys(id);
  const unknown = Object.keys(override).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    const why = hasValue(id) ? '' : ` — ${id} takes no value, its count being the one a project records`;
    return `"limits"."${id}" carries unknown key(s): ${unknown.join(', ')}${why}`;
  }
  const missing = keys.filter((key) => !Object.hasOwn(override, key));
  if (missing.length > 0) return `"limits"."${id}" is missing ${missing.join(', ')} — an override holds exactly ${keys.join(', ')}`;
  if (hasValue(id) && !(Number.isSafeInteger(override.value) && override.value > 0)) {
    return `"limits"."${id}".value must be a positive integer, got ${JSON.stringify(override.value)}`;
  }
  if (!(Number.isSafeInteger(override.tolerance) && override.tolerance >= 0 && override.tolerance <= 100)) {
    return `"limits"."${id}".tolerance must be an integer percent from 0 to 100, got ${JSON.stringify(override.tolerance)}`;
  }
  const reason = reasonDefect(override.reason);
  return reason ? `"limits"."${id}".reason: ${reason}` : null;
};

// limitsDefect(limits, reasonDefect) → the first defect naming its key, or null. A mistyped override
// would otherwise leave the kit's value in force while its author believes it changed.
export const limitsDefect = (limits, reasonDefect) => {
  if (!isPlainObject(limits)) return '"limits" must be an object mapping a kit limit id to its override';
  for (const [id, override] of Object.entries(limits)) {
    if (!Object.hasOwn(KIT_LIMITS, id)) return `"limits" names "${id}", which is no kit limit — the kit's limits are ${Object.keys(KIT_LIMITS).join(', ')}`;
    const defect = overrideDefect(id, override, reasonDefect);
    if (defect) return defect;
  }
  return null;
};

// resolveLimits(limits) → { limits, defaults }: every limit with its value, tolerance and source, an
// override carrying its reason, and `defaults` in the shape the judge and the facts already read.
export const resolveLimits = (limits = {}) => {
  const resolved = Object.fromEntries(Object.entries(KIT_LIMITS).map(([id, kit]) => {
    if (!Object.hasOwn(limits, id)) return [id, { value: kit.value, tolerance: kit.tolerance, source: 'kit' }];
    const override = limits[id];
    return [id, { value: hasValue(id) ? override.value : null, tolerance: override.tolerance, source: 'override', reason: override.reason }];
  }));
  return {
    limits: resolved,
    defaults: { maxLines: resolved['lines-per-file'].value, maxLineBytes: resolved['bytes-per-line'].value },
  };
};

// limitLines(limits, { escape, recorded }) → one line per resolved limit, all five, in the table's
// order: value, tolerance and source. The escape that makes a reason safe on a line is handed in, so
// the check and the plan-time render state the same five lines from this one function.
export const limitLines = (limits, { escape = String, recorded = false } = {}) => Object.keys(KIT_LIMITS).map((id) => {
  const { value, tolerance, source, reason } = limits[id];
  const amount = value !== null ? `${value}` : recorded ? "each judged root's recorded count" : 'none recorded';
  return `limit ${id} ${amount}, tolerance ${tolerance}% — ${source === 'kit' ? 'from kit' : `from override: ${escape(reason)}`}`;
});

// migrateSchema1(parsed, readmes) → the schema-2 config the writer writes, every key in its place. A
// `_README` byte-equal to `readmes.schema1` becomes `readmes.schema2`; any other is carried verbatim.
export const migrateSchema1 = (parsed, readmes = {}) => {
  const overrides = Object.fromEntries(Object.entries(SCHEMA1_KEY)
    .filter(([id, key]) => parsed.defaults[key] !== KIT_LIMITS[id].value)
    .map(([id, key]) => [id, { value: parsed.defaults[key], tolerance: KIT_LIMITS[id].tolerance, reason: SCHEMA1_REASON }]));
  return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
    if (key === 'schema') return [[key, 2]];
    if (key === '_README') return [[key, value === readmes.schema1 ? readmes.schema2 : value]];
    if (key === 'defaults') return Object.keys(overrides).length === 0 ? [] : [['limits', overrides]];
    return [[key, value]];
  }));
};

// applyOverride(parsed, id, override) → the config with one id's override set from { value,
// tolerance, reason } or, given null, removed; a `limits` left empty is dropped and a new one is
// appended. It judges nothing about the tree: the writer regenerates the record from the result.
export const applyOverride = (parsed, id, override) => {
  const limits = { ...(parsed.limits ?? {}) };
  if (override === null) delete limits[id];
  else limits[id] = Object.fromEntries(overrideKeys(id).map((key) => [key, override[key]]));
  const kept = Object.keys(limits).length > 0;
  const entries = Object.entries(parsed)
    .filter(([key]) => key !== 'limits' || kept)
    .map(([key, value]) => [key, key === 'limits' ? limits : value]);
  if (kept && !Object.hasOwn(parsed, 'limits')) entries.push(['limits', limits]);
  return Object.fromEntries(entries);
};
