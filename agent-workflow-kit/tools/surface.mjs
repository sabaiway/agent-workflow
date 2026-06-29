// surface.mjs — capability detection for the kit's OWN stdout (the direct CLI). Plan §4.5.
//
// Resolves how `node tools/family-registry.mjs` should render: the requested format, the effective
// render mode (json | plain | ansi), whether to emit color, the terminal width, and whether to fall
// back to ASCII glyphs. This governs ONLY the kit's direct-CLI output — the agent-mediated
// `/agent-workflow-kit status` surface always consumes `--json` and localizes itself.
//
// Pure + fully injectable (argv / env / isTTY / columns / platform are inputs), no side effects on
// import, Node >= 18. Tested in isolation against the §4.5 table.

export const FORMATS = Object.freeze(['auto', 'plain', 'ansi', 'json']);
export const FORMAT_ENV = 'AGENT_WORKFLOW_FORMAT';
export const MIN_WIDTH = 40; // below this, force plain ASCII (a box can't lay out under ~40 cols)
export const DEFAULT_WIDTH = 80;
const FORMAT_FLAG = '--format=';

// Resolve the requested format. A FLAG (--json or --format=X) beats the AGENT_WORKFLOW_FORMAT env;
// among flags the LAST on argv wins (deterministic, standard last-wins). `--json` is exact sugar for
// `--format=json`. A bare `--format` (no value), an empty value, or an unknown value → a LOUD reject
// (never a silent fallback — Hard Constraint). Absent everywhere → 'auto'.
export const resolveFormat = (argv = [], env = {}) => {
  let fromFlag = null;
  for (const a of argv) {
    if (a === '--json') fromFlag = 'json';
    else if (a === '--format') throw new Error(`[agent-workflow-kit] --format needs a value: --format=<${FORMATS.join('|')}>`);
    else if (a.startsWith(FORMAT_FLAG)) fromFlag = a.slice(FORMAT_FLAG.length);
  }
  const requested = fromFlag ?? env[FORMAT_ENV] ?? 'auto';
  if (!FORMATS.includes(requested)) {
    throw new Error(`[agent-workflow-kit] invalid format "${requested}" — expected one of ${FORMATS.join(', ')}`);
  }
  return requested;
};

// Terminal width: stdout.columns (>0) wins, else $COLUMNS (>0), else the 80-col default. A garbage /
// zero / undefined value falls through to the next source — never NaN.
export const resolveWidth = ({ columns, env = {} } = {}) => {
  const fromStdout = Number(columns);
  if (Number.isFinite(fromStdout) && fromStdout > 0) return fromStdout;
  const fromEnv = Number(env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_WIDTH;
};

// Color is ORTHOGONAL to the render mode (the ansi renderer applies it; plain ignores it). Precedence:
// CLICOLOR_FORCE / FORCE_COLOR present → on (unless explicitly '0'/'false'); else NO_COLOR present
// (incl. empty value) → off; else follow isTTY. FORCE beats NO_COLOR.
export const resolveColor = ({ env = {}, isTTY = false } = {}) => {
  if ('CLICOLOR_FORCE' in env || 'FORCE_COLOR' in env) {
    const v = 'CLICOLOR_FORCE' in env ? env.CLICOLOR_FORCE : env.FORCE_COLOR;
    return !(v === '0' || String(v).toLowerCase() === 'false');
  }
  if ('NO_COLOR' in env) return false; // any value, incl. empty, disables (the NO_COLOR spec)
  return Boolean(isTTY);
};

const isUtf8Env = (env = {}) => /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');

// The full resolved surface. mode: 'json' (machine envelope) | 'plain' | 'ansi'. For a non-json
// format: an explicit plain/ansi is honored; 'auto' detects a tier (plain when NOT a TTY, or TERM=dumb,
// or any CI env; else ansi). A width below MIN_WIDTH FORCES plain. ascii glyphs when narrow, or on a
// Windows TTY without a UTF-8 locale (shallow — deeper Windows/UTF-8 depth is deferred, Plan §9).
export const detectSurface = ({ argv = [], env = {}, isTTY = false, columns, platform = 'linux' } = {}) => {
  const format = resolveFormat(argv, env);
  const width = resolveWidth({ columns, env });
  if (format === 'json') return { format, mode: 'json', width, color: false, ascii: false };

  const autoTier = !isTTY || env.TERM === 'dumb' || 'CI' in env ? 'plain' : 'ansi';
  const requestedMode = format === 'auto' ? autoTier : format; // 'plain' | 'ansi'
  const narrow = width < MIN_WIDTH;
  const mode = narrow ? 'plain' : requestedMode; // the width floor wins over an ansi request
  const ascii = narrow || (platform === 'win32' && !isUtf8Env(env));
  const color = resolveColor({ env, isTTY }); // orthogonal — the ansi renderer gates on mode + color
  return { format, mode, width, color, ascii };
};
