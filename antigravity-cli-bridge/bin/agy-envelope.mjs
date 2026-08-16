#!/usr/bin/env node
// agy-envelope.mjs — read ONE captured `agy --output-format json` payload and hand the review
// wrapper the fields it needs, or fail with a DISTINGUISHABLE cause.
//
// Why a module and not bash: the CLI answers with ONE JSON object whose `response` carries the
// model's Markdown VERBATIM, and JSON parsing in bash is a defect farm. The trade — node becomes a
// hard runtime requirement for every review — is paid deliberately and bought back by the wrapper's
// pre-spend capability door, which refuses BEFORE a subscription turn is spent rather than after
// one is wasted.
//
// Every failure is LOUD: a named cause, a non-zero exit. There is no degraded verdict and no
// fallback to parsing raw stdout — a review whose answer cannot be read has not happened, and
// saying otherwise would attest a tree nobody reviewed.
//
// The parse is a PURE function so it can be tested without a subprocess; the CLI below is a thin
// file-I/O shell around it, exercised end-to-end by the wrapper's own acceptance tests.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const EXIT_NAMED_CAUSE = 1;
const EXIT_USAGE = 2;
const SUCCESS_STATUS = 'SUCCESS';
// The SAME grammar the retired `capture_conversation_id` log scrape validated. A named envelope
// field can still carry a malformed or wrong-typed value, and an unvalidated one would route every
// later feed turn at an arbitrary conversation.
const CONVERSATION_ID_GRAMMAR = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const failed = (cause, sentence) => ({ ok: false, cause, sentence });

// Read one captured payload. `requireConversationId` is the caller's declaration that it will ROUTE
// a later turn at this conversation: only then is the field required and validated, so a lane that
// never routes one cannot fail over a value it does not use.
export const parseAgyEnvelope = (text, { requireConversationId = false } = {}) => {
  if (text.length === 0) {
    return failed('empty-payload', 'the captured payload is empty — the CLI printed nothing at all.');
  }
  // Parsed-ness is carried SEPARATELY from the parsed value: `null` is both a legal JSON document
  // and the obvious failure sentinel, and conflating them reported valid JSON `null` as "not JSON".
  const parsed = (() => {
    try {
      return { parsed: true, value: JSON.parse(text) };
    } catch {
      return { parsed: false, value: null };
    }
  })();
  if (!parsed.parsed) {
    return failed('not-json', 'the captured payload is not JSON — the dispatch did not return an envelope.');
  }
  const envelope = parsed.value;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return failed('not-an-envelope', 'the captured payload is JSON but not a single object.');
  }
  if (envelope.status !== SUCCESS_STATUS) {
    return failed('status', `the envelope reports status ${JSON.stringify(envelope.status ?? null)}, not "${SUCCESS_STATUS}".`);
  }
  // An EMPTY response is a real (if useless) answer and rides through to the wrapper's verdict-less
  // arm; only an ABSENT or wrong-typed field means the answer is not in the envelope at all.
  if (typeof envelope.response !== 'string') {
    return failed('response', 'the envelope carries no string `response` field — the model\'s answer is not in it.');
  }
  if (!requireConversationId) {
    return { ok: true, response: envelope.response, conversationId: '' };
  }
  if (typeof envelope.conversation_id !== 'string') {
    return failed('conversation-id', 'the envelope carries no string `conversation_id` field, so a later turn could not be routed at this conversation.');
  }
  if (!CONVERSATION_ID_GRAMMAR.test(envelope.conversation_id)) {
    return failed('conversation-id', 'the envelope\'s `conversation_id` does not match the UUID grammar — routing a later turn at it would target an arbitrary conversation.');
  }
  return { ok: true, response: envelope.response, conversationId: envelope.conversation_id };
};

const FLAG_KEYS = {
  '--envelope': 'envelope',
  '--response-out': 'responseOut',
  '--conversation-id-out': 'conversationIdOut',
};

const USAGE = [
  'agy-envelope — read ONE captured `agy --output-format json` payload, or fail with a named cause.',
  '',
  'Usage:',
  '  node agy-envelope.mjs --envelope <path> --response-out <path> [--conversation-id-out <path>]',
  '',
  '  --envelope <path>             the captured stdout of ONE `agy --output-format json` dispatch',
  '  --response-out <path>         write the envelope\'s `response` VERBATIM here',
  '  --conversation-id-out <path>  ALSO require `conversation_id`, validate it against the UUID',
  '                                grammar, and write it here',
  '',
  'Exit: 0 parsed; 1 a named failure cause on stderr; 2 usage.',
].join('\n');

const usageOutcome = (message) => ({ code: EXIT_USAGE, message: `agy-envelope: ${message}\n\n${USAGE}\n` });
const causeOutcome = (cause, sentence) => ({ code: EXIT_NAMED_CAUSE, message: `agy-envelope: ${cause} — ${sentence}\n` });
const isOutcome = (value) => value !== null && typeof value === 'object' && typeof value.code === 'number';

const parseArguments = (argv) =>
  argv.reduce((options, token, index) => {
    if (isOutcome(options)) return options;
    if (!Object.hasOwn(FLAG_KEYS, token)) {
      if (index > 0 && Object.hasOwn(FLAG_KEYS, argv[index - 1])) return options;
      return usageOutcome(`unknown argument '${token}'`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return usageOutcome(`${token} needs a value`);
    return { ...options, [FLAG_KEYS[token]]: value };
  }, { envelope: '', responseOut: '', conversationIdOut: '' });

const readPayloadText = (path) => {
  const bytes = (() => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  })();
  if (bytes === null) return causeOutcome('unreadable-payload', `the captured payload '${path}' could not be read.`);
  try {
    // A BOM is stripped rather than fed to JSON.parse; any other invalid byte refuses loudly.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return causeOutcome('not-utf8', `the captured payload '${path}' is not valid UTF-8.`);
  }
};

const writeField = (path, value, field) => {
  try {
    writeFileSync(path, value, 'utf8');
    return null;
  } catch {
    return causeOutcome('write-failed', `the envelope's ${field} could not be written to '${path}'.`);
  }
};

// The CLI as a PURE-ish function: every arm RETURNS its outcome instead of exiting, so each one can
// be driven in-process by a test. Writing and exiting happen once, at the entry point below — the
// single impure boundary. (Subprocess tests could not close this: coverage is collected in the test
// process, so an arm only reachable through a spawn is an arm nothing can prove was exercised.)
export const runEnvelopeCli = (argv) => {
  const options = parseArguments(argv);
  if (isOutcome(options)) return options;
  if (!options.envelope) return usageOutcome('--envelope is required.');
  if (!options.responseOut) return usageOutcome('--response-out is required.');
  const payload = readPayloadText(options.envelope);
  if (isOutcome(payload)) return payload;
  const result = parseAgyEnvelope(payload.text, { requireConversationId: Boolean(options.conversationIdOut) });
  if (!result.ok) return causeOutcome(result.cause, result.sentence);
  const wroteResponse = writeField(options.responseOut, result.response, 'response');
  if (wroteResponse !== null) return wroteResponse;
  if (!options.conversationIdOut) return { code: 0 };
  const wroteId = writeField(options.conversationIdOut, result.conversationId, 'conversation_id');
  return wroteId === null ? { code: 0 } : wroteId;
};

// Entry-point guard (not import.meta.main — that landed after the family's Node >= 22 floor). ONE
// statement so the line is executed on import and carries no unreachable-by-test body.
const entryOutcome = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? runEnvelopeCli(process.argv.slice(2)) : null;
if (entryOutcome !== null) { if (entryOutcome.message) process.stderr.write(entryOutcome.message); process.exit(entryOutcome.code); }
