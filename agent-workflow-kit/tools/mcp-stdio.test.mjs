// mcp-stdio.test.mjs — the JSON-RPC 2.0 line-framing contract of the kit's stdio MCP server.
//
// Pinned here, over INJECTED streams (no process is spawned):
//   • initialize answers the negotiated protocol version, the declared capabilities and serverInfo,
//     and echoes the request id BYTE-FOR-BYTE (string or number);
//   • a request other than initialize/ping before initialize is refused, never served;
//   • a notification — known or unknown — never produces output;
//   • the three JSON-RPC error classes are distinguishable: -32600 / -32601 / -32700;
//   • an over-limit line is answered with an ERROR and the transport then CLOSES (a null-id error
//     cannot be correlated) — never a silent drop, never a hung client; the reader alone can resync;
//   • a UTF-8 code point split across two chunks, and several messages in one chunk, both frame.
//
// The module is loaded with a dynamic import() so the file LOADS and FAILS on a tree where the module
// does not exist yet — the shape the red-proof lane requires for a new module.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const MODULE_URL = new URL('./mcp-stdio.mjs', import.meta.url).href;
const api = () => import(MODULE_URL);

const SERVER_INFO = Object.freeze({ name: 'test-server', version: '0.0.1' });
const CAPABILITIES = Object.freeze({ tools: {} });

const makeDispatcher = (m, handlers = {}) =>
  m.createDispatcher({ handlers, serverInfo: SERVER_INFO, capabilities: CAPABILITIES });

const initialize = (id = 1, protocolVersion = '2025-06-18') => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
});

const collectOutput = () => {
  const lines = [];
  return { lines, write: (text) => { lines.push(text); return true; } };
};

// Drive serveStdio end-to-end over a PassThrough: the chunks arrive exactly as written.
const serve = async (m, chunks, dispatcher = makeDispatcher(m), options = {}) => {
  const input = new PassThrough();
  const output = collectOutput();
  const done = m.serveStdio({ input, output, dispatcher, ...options });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await done;
  return output.lines;
};

describe('mcp-stdio — initialize and the lifecycle', () => {
  it('answers initialize with the negotiated version, capabilities, serverInfo, and the echoed id', async () => {
    const m = await api();
    const response = makeDispatcher(m).handle(initialize('req-0001'));
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 'req-0001',
      result: { protocolVersion: m.PROTOCOL_VERSION, capabilities: CAPABILITIES, serverInfo: SERVER_INFO },
    });
  });

  it('echoes a NUMERIC id as a number and a STRING id as a string', async () => {
    const m = await api();
    const d = makeDispatcher(m);
    assert.equal(d.handle(initialize(7)).id, 7);
    assert.equal(d.handle(initialize('7')).id, '7');
  });

  it('a supported requested version is echoed; an unknown one is answered with the newest supported', async () => {
    const m = await api();
    assert.equal(m.PROTOCOL_VERSION, '2025-06-18');
    for (const v of m.SUPPORTED_PROTOCOL_VERSIONS) assert.equal(m.negotiateProtocolVersion(v), v);
    assert.equal(m.negotiateProtocolVersion('2099-01-01'), m.PROTOCOL_VERSION);
    assert.equal(m.negotiateProtocolVersion(undefined), m.PROTOCOL_VERSION);
    assert.equal(makeDispatcher(m).handle(initialize(1, '2099-01-01')).result.protocolVersion, m.PROTOCOL_VERSION);
  });

  it('a request before initialize is REFUSED with -32600, except ping', async () => {
    const m = await api();
    const d = makeDispatcher(m, { 'tools/list': () => ({ tools: [] }) });
    const early = d.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(early.error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(early.id, 1);
    assert.deepEqual(d.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });
    d.handle(initialize(3));
    assert.deepEqual(d.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }).result, { tools: [] });
  });

  it('the initialized notification, and any unknown notification, produce NO output', async () => {
    const m = await api();
    const d = makeDispatcher(m);
    d.handle(initialize(1));
    assert.equal(d.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(d.handle({ jsonrpc: '2.0', method: 'notifications/whatever', params: { x: 1 } }), null);
    assert.equal(m.isNotification({ jsonrpc: '2.0', method: 'x' }), true);
    assert.equal(m.isNotification({ jsonrpc: '2.0', id: 1, method: 'x' }), false);
  });

  it('a client RESPONSE (id + exactly one of result/error) is ignored; any other method-less object is -32600', async () => {
    const m = await api();
    const d = makeDispatcher(m);
    d.handle(initialize(1));
    assert.equal(d.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
    assert.equal(d.handle({ jsonrpc: '2.0', id: 9, error: { code: 1, message: 'x' } }), null);
    const bare = d.handle({ jsonrpc: '2.0', id: 1 }); // a waiting client must hear back
    assert.equal(bare.error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(bare.id, 1);
    assert.equal(d.handle({ jsonrpc: '2.0' }).id, null);
    assert.equal(d.handle({ jsonrpc: '2.0', id: 2, result: {}, error: {} }).error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
  });

  it('a numeric id is accepted only as a safe integer — a fraction or an overflow cannot be echoed faithfully', async () => {
    const m = await api();
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":1.5,"method":"ping"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":1e400,"method":"ping"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":42,"method":"ping"}').message.id, 42);
  });
});

describe('mcp-stdio — the error classes are distinguishable', () => {
  it('an unknown method after initialize → -32601 with the id echoed', async () => {
    const m = await api();
    const d = makeDispatcher(m);
    d.handle(initialize(1));
    const r = d.handle({ jsonrpc: '2.0', id: 'x', method: 'nope' });
    assert.equal(r.error.code, m.JSONRPC_ERRORS.METHOD_NOT_FOUND);
    assert.equal(r.id, 'x');
  });

  it('a handler throwing rpcError carries its code; any other throw is -32603', async () => {
    const m = await api();
    const d = makeDispatcher(m, {
      typed: () => { throw m.rpcError(m.JSONRPC_ERRORS.INVALID_PARAMS, 'bad params'); },
      crash: () => { throw new Error('boom'); },
    });
    d.handle(initialize(1));
    const typed = d.handle({ jsonrpc: '2.0', id: 1, method: 'typed' });
    assert.equal(typed.error.code, m.JSONRPC_ERRORS.INVALID_PARAMS);
    assert.equal(typed.error.message, 'bad params');
    const crash = d.handle({ jsonrpc: '2.0', id: 2, method: 'crash' });
    assert.equal(crash.error.code, m.JSONRPC_ERRORS.INTERNAL_ERROR);
    assert.match(crash.error.message, /boom/u);
  });

  it('parseLine: invalid JSON → -32700; a non-object or wrong jsonrpc → -32600', async () => {
    const m = await api();
    assert.equal(m.parseLine('{nope').error.code, m.JSONRPC_ERRORS.PARSE_ERROR);
    assert.equal(m.parseLine('[1,2]').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('"str"').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"1.0","id":1,"method":"m"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":{},"method":"m"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":1,"method":5}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.deepEqual(m.parseLine('{"jsonrpc":"2.0","id":1,"method":"m"}').message, { jsonrpc: '2.0', id: 1, method: 'm' });
  });

  it('over the stream, a parse error is answered with id null and the next line is served normally', async () => {
    const m = await api();
    const lines = await serve(m, ['{nope\n', `${JSON.stringify(initialize(5))}\n`]);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.id, null);
    assert.equal(first.error.code, m.JSONRPC_ERRORS.PARSE_ERROR);
    assert.equal(JSON.parse(lines[1]).id, 5);
  });
});

describe('mcp-stdio — framing', () => {
  it('MAX_LINE_BYTES is 4 MiB and every output line is exactly one JSON document ending in \\n', async () => {
    const m = await api();
    assert.equal(m.MAX_LINE_BYTES, 4 * 1024 * 1024);
    const lines = await serve(m, [`${JSON.stringify(initialize(1))}\n`]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('\n'));
    assert.equal(lines[0].indexOf('\n'), lines[0].length - 1, 'no embedded newline');
    JSON.parse(lines[0]);
  });

  it('several messages in ONE chunk frame separately, and a final line without newline still frames', async () => {
    const m = await api();
    const chunk = `${JSON.stringify(initialize(1))}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}`;
    const lines = await serve(m, [chunk]);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
  });

  it('a UTF-8 code point split across two chunks is reassembled, never replaced', async () => {
    const m = await api();
    const accent = String.fromCharCode(0xe9); // U+00E9, built at runtime: the source stays ASCII-only
    const text = JSON.stringify({ jsonrpc: '2.0', id: `caf${accent}`, method: 'ping' });
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from(accent, 'utf8')) + 1; // inside the 2-byte sequence
    const lines = await serve(m, [bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(JSON.parse(lines[0]).id, `caf${accent}`);
  });

  it('an over-limit line is answered with -32600 (id null) and the transport then CLOSES — nothing after it is served', async () => {
    const m = await api();
    const maxLineBytes = 64;
    const huge = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'x'.repeat(200)}"}}\n`;
    const next = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`;
    const lines = await serve(m, [huge, next], makeDispatcher(m), { maxLineBytes });
    assert.equal(lines.length, 1, 'a null-id error cannot be correlated, so the client gets a closed transport, not a hung request');
    const first = JSON.parse(lines[0]);
    assert.equal(first.id, null);
    assert.equal(first.error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
    assert.match(first.error.message, /64/u);
    assert.match(first.error.message, /closing/u);
  });

  it('a request id of null is an invalid request — MCP ids are strings or integers', async () => {
    const m = await api();
    assert.equal(m.parseLine('{"jsonrpc":"2.0","id":null,"method":"ping"}').error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
  });

  it('the line reader reports the overflow ONCE per oversized line, even when it arrives in many chunks', async () => {
    const m = await api();
    const seen = [];
    let overflows = 0;
    const reader = m.createLineReader({ maxLineBytes: 8, onLine: (l) => seen.push(l), onOverflow: () => { overflows += 1; } });
    for (const piece of ['abcd', 'efgh', 'ijkl', 'mn\nok', '\n']) reader.feed(Buffer.from(piece, 'utf8'));
    reader.end();
    assert.equal(overflows, 1);
    assert.deepEqual(seen, ['ok']);
  });

  it('a line that is not valid UTF-8 is a PARSE ERROR, never a lossy decode that could name another path', async () => {
    const m = await api();
    const bad = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}\n', 'utf8')]);
    const next = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`;
    const lines = await serve(m, [bad, next]);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, null);
    assert.equal(JSON.parse(lines[0]).error.code, m.JSONRPC_ERRORS.PARSE_ERROR);
    assert.match(JSON.parse(lines[0]).error.message, /UTF-8/u);
    assert.equal(JSON.parse(lines[1]).id, 2);
  });

  it('a malformed initialize is -32602 and leaves the server UN-initialized', async () => {
    const m = await api();
    const d = makeDispatcher(m, { 'tools/list': () => ({ tools: [] }) });
    const good = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } };
    for (const params of [undefined, {}, { ...good, protocolVersion: 7 }, { ...good, clientInfo: undefined }, { ...good, clientInfo: {} }, { ...good, clientInfo: { name: 'c' } }]) {
      const r = d.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
      assert.equal(r.error.code, m.JSONRPC_ERRORS.INVALID_PARAMS, JSON.stringify(params));
    }
    assert.equal(d.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).error.code, m.JSONRPC_ERRORS.INVALID_REQUEST);
  });

  it('a write the output refuses (false) pauses the flush until drain — and the NEXT line is not even dispatched', async () => {
    const m = await api();
    const { EventEmitter } = await import('node:events');
    let dispatched = 0;
    const dispatcher = makeDispatcher(m, { count: () => { dispatched += 1; return { n: dispatched }; } });
    const output = new EventEmitter();
    output.writes = [];
    output.write = (text) => { output.writes.push(text); return output.writes.length !== 1; }; // refuse the FIRST write
    const input = new PassThrough();
    const done = m.serveStdio({ input, output, dispatcher });
    // Three requests in ONE chunk: the answers must not all be computed up front and held in memory.
    input.end(`${JSON.stringify(initialize(1))}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'count' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'count' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(output.writes.length, 1, 'the second answer waits for drain');
    assert.equal(dispatched, 0, 'the line after a refused write is not dispatched until drain');
    output.emit('drain');
    await done;
    assert.equal(dispatched, 2);
    assert.deepEqual(output.writes.map((l) => JSON.parse(l).id), [1, 2, 3]);
  });

  it('a scalar params on a request is -32602, never silently treated as an empty object', async () => {
    const m = await api();
    const d = makeDispatcher(m, { 'tools/list': () => ({ tools: [] }) });
    d.handle(initialize(1));
    assert.equal(d.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: 42 }).error.code, m.JSONRPC_ERRORS.INVALID_PARAMS);
    assert.equal(d.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: [1] }).error.code, m.JSONRPC_ERRORS.INVALID_PARAMS);
    assert.deepEqual(d.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }).result, { tools: [] });
  });

  it('a CRLF-terminated line frames without the carriage return', async () => {
    const m = await api();
    const seen = [];
    const reader = m.createLineReader({ onLine: (l) => seen.push(l), onOverflow: () => {} });
    reader.feed(Buffer.from('{"a":1}\r\n', 'utf8'));
    reader.end();
    assert.deepEqual(seen, ['{"a":1}']);
  });
});
