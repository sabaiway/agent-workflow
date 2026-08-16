// agy-envelope.test.mjs — the envelope parse and the CLI boundary, both driven IN-PROCESS: no
// subprocess, ever. The parse suites are pure; the CLI suite writes real temporary files under one
// mkdtemp root, because its failure arms ARE filesystem failures (an unreadable payload, an
// unwritable destination) and stubbing them would test the stub.
// Fixtures are INLINE (the packed tarball bans fixtures/ directories) and REDACTED per the plan's
// Decision 7: no local absolute path, no real conversation id. The payload below is the RECORDED
// bytes of a live `agy --output-format json` run with only its id replaced, so the test really
// parses what the CLI printed rather than something this file serialized for itself.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgyEnvelope, runEnvelopeCli } from './agy-envelope.mjs';

const REDACTED_ID = '00000000-1111-2222-3333-444444444444';

const RECORDED_RESPONSE = [
  '### Delivery proof',
  'part 1 line 7: alpha-bravo-charlie-delta',
  'Requested addresses, one per line:',
  'part 1 line 7',
  '### Verdict',
  'SHIP — probe run, nothing reviewed.',
  '### Blocking',
  'none',
  '### Non-blocking',
  'none',
  '### Questions',
  'none',
  '',
].join('\n');

const RECORDED_PAYLOAD = `{"conversation_id":"${REDACTED_ID}","status":"SUCCESS","response":"### Delivery proof\\npart 1 line 7: alpha-bravo-charlie-delta\\nRequested addresses, one per line:\\npart 1 line 7\\n### Verdict\\nSHIP — probe run, nothing reviewed.\\n### Blocking\\nnone\\n### Non-blocking\\nnone\\n### Questions\\nnone\\n","duration_seconds":3.640368748,"num_turns":1,"usage":{"input_tokens":16398,"output_tokens":187,"thinking_tokens":118,"cache_read_tokens":0,"total_tokens":16585}}`;

const withFields = (fields) => JSON.stringify({ conversation_id: REDACTED_ID, status: 'SUCCESS', response: 'body', ...fields });

describe('agy-envelope — a recorded envelope parses', () => {
  it('yields the response text byte-for-byte and the conversation id', () => {
    const result = parseAgyEnvelope(RECORDED_PAYLOAD, { requireConversationId: true });
    assert.equal(result.ok, true, result.sentence);
    assert.equal(result.response, RECORDED_RESPONSE, 'the model Markdown survives the envelope VERBATIM');
    assert.equal(result.conversationId, REDACTED_ID);
  });

  it('an EMPTY response is a real answer, not an unreadable envelope (the verdict-less arm owns it)', () => {
    const result = parseAgyEnvelope(withFields({ response: '' }));
    assert.equal(result.ok, true, result.sentence);
    assert.equal(result.response, '');
  });
});

describe('agy-envelope — every failure carries its OWN named cause', () => {
  for (const [name, payload, cause] of [
    ['empty input', '', 'empty-payload'],
    ['a non-JSON blob', 'jetski: no output produced\n', 'not-json'],
    ['JSON that is not one object', '[{"status":"SUCCESS","response":"body"}]', 'not-an-envelope'],
    // `null` is a LEGAL JSON document and the obvious failure sentinel at once — it must report
    // what it actually is, or the operator hunts a transport bug that is really a shape bug.
    ['the literal JSON document `null`', 'null', 'not-an-envelope'],
    ['a bare JSON string', '"just a string"', 'not-an-envelope'],
    ['a bare JSON number', '42', 'not-an-envelope'],
    ['valid JSON with no response field', '{"conversation_id":"x","status":"SUCCESS"}', 'response'],
    ['a non-string response', withFields({ response: 42 }), 'response'],
    ['a non-SUCCESS status', withFields({ status: 'ERROR' }), 'status'],
    ['an absent status', '{"response":"body"}', 'status'],
  ]) {
    it(`${name} → cause "${cause}"`, () => {
      const result = parseAgyEnvelope(payload);
      assert.equal(result.ok, false, `${name} must not parse`);
      assert.equal(result.cause, cause);
      assert.ok(result.sentence.length > 0, 'a cause without a sentence tells the operator nothing');
    });
  }
});

// The id is required ONLY when the caller declares it will route a later turn at this conversation.
// Failing a single-turn review over a field it never uses would be a refusal with no defect behind it.
describe('agy-envelope — the conversation id is validated exactly when it is needed', () => {
  for (const [name, payload] of [
    ['an absent id', '{"status":"SUCCESS","response":"body"}'],
    ['a non-string id', withFields({ conversation_id: 12345 })],
    ['an id failing the UUID grammar', withFields({ conversation_id: 'not-a-uuid' })],
    ['a TRUNCATED uuid', withFields({ conversation_id: '00000000-1111-2222-3333-4444444444' })],
  ]) {
    it(`${name} fails with cause "conversation-id" when routing is required`, () => {
      const result = parseAgyEnvelope(payload, { requireConversationId: true });
      assert.equal(result.ok, false);
      assert.equal(result.cause, 'conversation-id');
    });

    it(`${name} parses fine when routing is NOT required`, () => {
      const result = parseAgyEnvelope(payload);
      assert.equal(result.ok, true, result.sentence);
      assert.equal(result.response, 'body');
      assert.equal(result.conversationId, '', 'an unrequested id is never handed back as if it were validated');
    });
  }
});

// ── evidence: the plan's REJECTED and DEFERRED decisions stay checkable ──────────────────────────
// STRUCTURAL EXCERPTS of two recorded probes (redacted). Nothing here is claimed byte-complete —
// only the fields the Appendix really recorded are asserted.

// Probe C: probe A's prompt with a schema ON — the matched control for the schema-cost claim.
const SCHEMA_RUN_RESULT = {
  conversation_id: REDACTED_ID,
  status: 'SUCCESS',
  response: 'the full prose review, with the structured JSON appended as trailing text',
  duration_seconds: 6.718974944,
  num_turns: 2,
  usage: { input_tokens: 33165, output_tokens: 281, thinking_tokens: 185, cache_read_tokens: 0, total_tokens: 33446 },
};

// The stream-json `init` event of the same run — the ONLY place the ACTUALLY resolved model appears.
const STREAM_INIT_EVENT = {
  event: 'init',
  conversation_id: REDACTED_ID,
  init: { model: 'Gemini 3.7 Flash (High)', cwd: '<redacted local path>', permission_mode: 'request-review' },
};

// ── the CLI boundary, driven IN-PROCESS ──────────────────────────────────────────────────────────
// Every CLI arm RETURNS its outcome, so each one is exercised here rather than through a spawn.
// That is not a convenience: coverage is collected in the test process, so an arm reachable only
// through a subprocess is an arm nothing can prove was ever run. Real temp files, no subprocess.
const CLI_ROOT = mkdtempSync(join(tmpdir(), 'agy-envelope-cli-'));
after(() => rmSync(CLI_ROOT, { recursive: true, force: true }));

const cliCase = (name, payload) => {
  const dir = join(CLI_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const envelope = join(dir, 'envelope.json');
  writeFileSync(envelope, payload);
  return { envelope, responseOut: join(dir, 'response.txt'), conversationIdOut: join(dir, 'conv.txt'), dir };
};

describe('agy-envelope — the CLI boundary returns an outcome for every arm', () => {
  it('a complete invocation writes the response VERBATIM and the conversation id, exit 0', () => {
    const c = cliCase('ok', RECORDED_PAYLOAD);
    const outcome = runEnvelopeCli(['--envelope', c.envelope, '--response-out', c.responseOut, '--conversation-id-out', c.conversationIdOut]);
    assert.equal(outcome.code, 0, outcome.message);
    assert.equal(readFileSync(c.responseOut, 'utf8'), RECORDED_RESPONSE);
    assert.equal(readFileSync(c.conversationIdOut, 'utf8'), REDACTED_ID);
  });

  it('without --conversation-id-out no id file is written and the id is never required', () => {
    const c = cliCase('no-id', withFields({ conversation_id: 'not-a-uuid' }));
    const outcome = runEnvelopeCli(['--envelope', c.envelope, '--response-out', c.responseOut]);
    assert.equal(outcome.code, 0, outcome.message);
    assert.equal(readFileSync(c.responseOut, 'utf8'), 'body');
  });

  for (const [name, argv, fragment] of [
    ['an unknown argument', ['--bogus', 'x'], "unknown argument '--bogus'"],
    ['a flag with no value', ['--envelope'], '--envelope needs a value'],
    ['a flag swallowing the next flag', ['--envelope', '--response-out'], '--envelope needs a value'],
    ['a missing --envelope', ['--response-out', '/dev/null'], '--envelope is required'],
    ['a missing --response-out', ['--envelope', '/dev/null'], '--response-out is required'],
  ]) {
    it(`${name} is a USAGE refusal (exit 2) carrying the usage text`, () => {
      const outcome = runEnvelopeCli(argv);
      assert.equal(outcome.code, 2, `${name}: ${outcome.message}`);
      assert.ok(outcome.message.includes(fragment), `${name}: ${outcome.message}`);
      assert.ok(outcome.message.includes('Usage:'), 'a usage refusal prints the usage');
    });
  }

  it('an unreadable payload (a DIRECTORY at the path) is the named unreadable-payload cause', () => {
    const c = cliCase('unreadable', '{}');
    const outcome = runEnvelopeCli(['--envelope', c.dir, '--response-out', c.responseOut]);
    assert.equal(outcome.code, 1, outcome.message);
    assert.ok(outcome.message.includes('unreadable-payload'), outcome.message);
  });

  it('a payload that is not valid UTF-8 is the named not-utf8 cause', () => {
    const dir = join(CLI_ROOT, 'not-utf8');
    mkdirSync(dir, { recursive: true });
    const envelope = join(dir, 'envelope.json');
    writeFileSync(envelope, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const outcome = runEnvelopeCli(['--envelope', envelope, '--response-out', join(dir, 'r.txt')]);
    assert.equal(outcome.code, 1, outcome.message);
    assert.ok(outcome.message.includes('not-utf8'), outcome.message);
  });

  it('a parse failure rides out as its own named cause (exit 1), not as usage', () => {
    const c = cliCase('bad-json', 'not json at all');
    const outcome = runEnvelopeCli(['--envelope', c.envelope, '--response-out', c.responseOut]);
    assert.equal(outcome.code, 1, outcome.message);
    assert.ok(outcome.message.includes('not-json'), outcome.message);
  });

  it('an unwritable response destination is the named write-failed cause', () => {
    const c = cliCase('unwritable-response', RECORDED_PAYLOAD);
    const outcome = runEnvelopeCli(['--envelope', c.envelope, '--response-out', join(c.dir, 'no-such-dir', 'r.txt')]);
    assert.equal(outcome.code, 1, outcome.message);
    assert.ok(outcome.message.includes('write-failed'), outcome.message);
    assert.ok(outcome.message.includes('response'), 'the failing field is named');
  });

  it('an unwritable conversation-id destination is named too — the response write already succeeded', () => {
    const c = cliCase('unwritable-id', RECORDED_PAYLOAD);
    const outcome = runEnvelopeCli([
      '--envelope', c.envelope, '--response-out', c.responseOut,
      '--conversation-id-out', join(c.dir, 'no-such-dir', 'conv.txt'),
    ]);
    assert.equal(outcome.code, 1, outcome.message);
    assert.ok(outcome.message.includes('conversation_id'), outcome.message);
    assert.equal(readFileSync(c.responseOut, 'utf8'), RECORDED_RESPONSE, 'the response was already written');
  });
});

describe('agy-envelope — recorded evidence for the rejected and deferred decisions', () => {
  it('--json-schema is REJECTED: it buys a SECOND billed turn, not a constrained decode', () => {
    const plain = JSON.parse(RECORDED_PAYLOAD);
    assert.equal(plain.num_turns, 1, 'the plain envelope answers in ONE turn');
    assert.equal(SCHEMA_RUN_RESULT.num_turns, 2, 'the schema run answers in TWO — the model restates its own prose');
    assert.ok(
      SCHEMA_RUN_RESULT.usage.total_tokens > 2 * plain.usage.total_tokens,
      `matched control: ${plain.usage.total_tokens} tokens without a schema against ${SCHEMA_RUN_RESULT.usage.total_tokens} with one`,
    );
  });

  it('stream-json is DEFERRED for a real gain: the RESOLVED model rides `init` and nothing else', () => {
    assert.equal(typeof STREAM_INIT_EVENT.init.model, 'string', 'the init event names the model that actually answered');
    assert.ok(!Object.hasOwn(JSON.parse(RECORDED_PAYLOAD), 'model'), 'the plain envelope carries no resolved model');
    assert.ok(!Object.hasOwn(SCHEMA_RUN_RESULT, 'model'), 'and neither does the stream-json result event');
  });

  it('the parse ignores the envelope fields it does not need — an added CLI field is not a breakage', () => {
    const result = parseAgyEnvelope(JSON.stringify({ ...SCHEMA_RUN_RESULT, structured_output: { verdict: 'REWORK' } }));
    assert.equal(result.ok, true, result.sentence);
    assert.equal(result.response, SCHEMA_RUN_RESULT.response);
  });
});
