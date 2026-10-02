// spec:jev-guide — docs/ai/specs/kit/jev-guide/index.md
// The one leaf the Jev surfaces share: the key rule, the connect line, and the vendor facts the
// connect command's one request uses. No side effect, no import beyond node:path — the read-only
// guide imports it under its closed import graph, the advisor and the connect command beside it.
import { join } from 'node:path';

export const KEY_VARIABLE = 'TYPESAFE_API_KEY';

// The ONE key rule: set exactly when the variable is a string that is not empty after trimming.
export const keySet = (env) => typeof env[KEY_VARIABLE] === 'string' && env[KEY_VARIABLE].trim() !== '';

// A minimal POSIX quoting for the one path the connect line carries: bare when every byte is safe,
// else single-quoted with the shell's own escape for a single quote.
const SAFE = /^[A-Za-z0-9_./:=+@%,-]+$/;
export const quoteArg = (value) => (SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

// The command the user runs in a terminal of their own; the guide prints it, the advisor's apply
// carries it. `toolsDir` is the kit's tools directory (the file beside this one). On win32 the line
// is for PowerShell: always single-quoted, a quote doubled, one backslash by concatenation.
export const connectLine = (toolsDir, platform) => (platform === 'win32'
  ? `node '${`${toolsDir}\\jev-connect.mjs`.replace(/'/g, "''")}'`
  : `node ${quoteArg(join(toolsDir, 'jev-connect.mjs'))}`);

// The one restart step the connect command's all-saved line and the guide's STEP 1 print.
export const RESTART_STEP = 'restart the agent so it reads the key: in VS Code or a VS Code fork, quit the editor completely (every window) and open it again; in a terminal, open a new terminal and start the agent there';

// Where the user runs the connect line, by one ordered rule; a name outside the set drops its rung.
const NAME = /^[A-Za-z0-9._-]+$/;
const named = (value) => typeof value === 'string' && NAME.test(value);
const nonEmpty = (value) => typeof value === 'string' && value !== '';
export const placeOf = ({ env = {}, platform, hostname, container } = {}) => {
  if (platform === 'win32') return 'a PowerShell terminal';
  if (named(env.WSL_DISTRO_NAME)) return `the WSL distro ${env.WSL_DISTRO_NAME} terminal`;
  if (nonEmpty(env.SSH_CONNECTION) && named(hostname)) return `a terminal on SSH host ${hostname}`;
  if (nonEmpty(env.REMOTE_CONTAINERS) || nonEmpty(env.CODESPACES) || container === true) return 'a terminal inside this container';
  return '';
};

// The vendor's smallest documented request (docs.typesafe.ai quickstart, read 2026-09-29) and the
// meanings of its documented error codes, quoted as the vendor prints them.
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_SAMPLE_BODY = Object.freeze({
  state: 'Help! My payouts have been failing for 3 days.',
  model: 'jev-latest',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades, new accounts' },
    },
  },
});
export const JEV_ERROR_MEANINGS = Object.freeze({
  401: 'Missing or invalid API key. Check the `Authorization` header.',
  422: 'The request body failed validation — for example a missing required field or a malformed question. The body details the offending field.',
  429: 'You have exceeded your rate limit. Back off and retry after a short delay.',
  529: 'TypeSafe is temporarily overloaded. Retry after a short delay.',
});
