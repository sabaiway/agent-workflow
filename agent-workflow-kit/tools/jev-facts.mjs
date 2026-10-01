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
// carries it. `toolsDir` is the kit's tools directory (the file beside this one).
export const connectLine = (toolsDir) => `node ${quoteArg(join(toolsDir, 'jev-connect.mjs'))}`;

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
