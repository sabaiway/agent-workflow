// mcp-stdio.mjs — JSON-RPC 2.0 line framing for the kit's stdio MCP server (the transport half).
//
// The MCP stdio transport is newline-delimited JSON-RPC over stdin/stdout: one message per line, no
// embedded newline, UTF-8, nothing on stdout that is not a message. This module owns exactly that and
// nothing about tools: a bounded line reader, the request/notification/response classification, the
// lifecycle gate (initialize first, ping any time) and a dispatcher that turns a parsed message into
// ONE response object or null. Streams are INJECTED so the whole contract is testable without a process.
//
// Bounds, stated: a line longer than `maxLineBytes` is answered with -32600 (id null) and the transport
// then CLOSES — a null-id error cannot be correlated with the request that caused it, so a client would
// otherwise wait on it forever, while a server that exits is one it can restart. (The line reader itself
// can resync at the next newline; the transport chooses not to continue.) Bytes are buffered and decoded
// only per complete line, so a UTF-8 code point split across two chunks is never replaced. Dependency-
// free, Node >= 22, no side effects on import; no CLI of its own (mcp-server.mjs is the entry point).

export const PROTOCOL_VERSION = '2025-06-18';
// Newest first. A requested version in this set is echoed; anything else is answered with the newest,
// as the lifecycle spec prescribes (the client then decides whether to continue).
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

const JSONRPC_VERSION = '2.0';
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const METHOD_INITIALIZE = 'initialize';
const METHOD_PING = 'ping';
const PRE_INITIALIZE_METHODS = Object.freeze([METHOD_INITIALIZE, METHOD_PING]);

export const rpcError = (code, message) => Object.assign(new Error(message), { rpcCode: code });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// MCP's RequestId is a string or an integer, never null; and a numeric id must survive parse →
// serialize unchanged, or the answer no longer correlates with the request: only a safe integer does
// (1.5, 1e400 and friends are refused as invalid requests). The server's OWN null id on an error
// for an unparseable line is a different thing: a response, not a request.
const isValidId = (id) => typeof id === 'string' || Number.isSafeInteger(id);
// A client RESPONSE carries an id and exactly one of result / error; it is the one shape the server
// never answers. Anything else without a method is an invalid request, answered — never swallowed.
const isClientResponse = (message) =>
  'id' in message && (Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error'));

export const negotiateProtocolVersion = (requested) =>
  SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;

export const isNotification = (message) => typeof message.method === 'string' && !('id' in message);

// One line → { message } or { error: { code, message } } (the error is answered with id null).
export const parseLine = (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: { code: JSONRPC_ERRORS.PARSE_ERROR, message: 'Parse error' } };
  }
  if (!isPlainObject(parsed) || parsed.jsonrpc !== JSONRPC_VERSION) {
    return { error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: not a JSON-RPC 2.0 object' } };
  }
  if ('id' in parsed && !isValidId(parsed.id)) {
    return { error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: id must be a string or an integer' } };
  }
  if ('method' in parsed && typeof parsed.method !== 'string') {
    return { error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: method must be a string' } };
  }
  return { message: parsed };
};

const errorResponse = (id, code, message) => ({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
const resultResponse = (id, result) => ({ jsonrpc: JSONRPC_VERSION, id, result });

// A lossy decode would replace an invalid byte with U+FFFD and the request could then name a DIFFERENT,
// existing path — the substitution class both readers refuse; a line that is not UTF-8 is a parse error.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// Bytes in, complete lines out. The pending buffer is capped: past `maxLineBytes` without a newline the
// reader drops bytes until the next newline, reporting the overflow ONCE, then frames normally again.
export const createLineReader = ({ maxLineBytes = MAX_LINE_BYTES, onLine, onOverflow, onInvalidUtf8 = () => {} }) => {
  let pending = [];
  let pendingBytes = 0;
  let discarding = false;

  const emit = () => {
    const buf = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const end = buf.length > 0 && buf[buf.length - 1] === CARRIAGE_RETURN ? buf.length - 1 : buf.length;
    let text;
    try {
      text = strictUtf8.decode(buf.subarray(0, end));
    } catch {
      onInvalidUtf8();
      return;
    }
    onLine(text);
  };

  const feed = (chunk) => {
    let from = 0;
    for (;;) {
      const at = chunk.indexOf(NEWLINE, from);
      const piece = chunk.subarray(from, at === -1 ? chunk.length : at);
      if (discarding) {
        if (at === -1) return;
        discarding = false;
      } else if (pendingBytes + piece.length > maxLineBytes) {
        pending = [];
        pendingBytes = 0;
        onOverflow();
        if (at === -1) {
          discarding = true;
          return;
        }
      } else {
        if (piece.length > 0) {
          pending.push(piece);
          pendingBytes += piece.length;
        }
        if (at === -1) return;
        emit();
      }
      from = at + 1;
      if (from >= chunk.length) return;
    }
  };

  // A final line without a trailing newline is still a message; a discarded tail is not.
  const end = () => {
    if (!discarding && pendingBytes > 0) emit();
  };

  return { feed, end };
};

// handlers: { [method]: (params) => result } for everything beyond initialize/ping. A handler may throw
// rpcError(code, message) for a typed error; any other throw is an internal error WITH its message.
export const createDispatcher = ({ handlers = {}, serverInfo, capabilities = { tools: {} }, instructions }) => {
  let initialized = false;

  const handle = (message) => {
    if (typeof message.method !== 'string') {
      if (isClientResponse(message)) return null; // a response to something — never answered
      return errorResponse(message.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: neither a request, a notification nor a response');
    }
    if (isNotification(message)) return null; // initialized, cancelled, anything: silence
    const { id, method } = message;
    if ('params' in message && message.params !== undefined && !isPlainObject(message.params)) {
      return errorResponse(id, JSONRPC_ERRORS.INVALID_PARAMS, `Invalid params: "${method}" params must be an object`);
    }
    if (!initialized && !PRE_INITIALIZE_METHODS.includes(method)) {
      return errorResponse(id, JSONRPC_ERRORS.INVALID_REQUEST, `Invalid Request: "${method}" before initialize`);
    }
    if (method === METHOD_PING) return resultResponse(id, {});
    if (method === METHOD_INITIALIZE) {
      // The three required fields are checked BEFORE the state flips: a malformed initialize leaves the
      // server un-initialized and is answered as invalid params, never served as a handshake.
      const params = isPlainObject(message.params) ? message.params : null;
      const client = params !== null && isPlainObject(params.clientInfo) ? params.clientInfo : null;
      if (params === null || typeof params.protocolVersion !== 'string' || !isPlainObject(params.capabilities) || client === null || typeof client.name !== 'string' || typeof client.version !== 'string') {
        return errorResponse(id, JSONRPC_ERRORS.INVALID_PARAMS, 'initialize: protocolVersion (string), capabilities (object) and clientInfo { name, version } (strings) are required');
      }
      initialized = true;
      const result = { protocolVersion: negotiateProtocolVersion(params.protocolVersion), capabilities, serverInfo };
      if (typeof instructions === 'string') result.instructions = instructions;
      return resultResponse(id, result);
    }
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (typeof handler !== 'function') return errorResponse(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    try {
      return resultResponse(id, handler(isPlainObject(message.params) ? message.params : {}));
    } catch (err) {
      if (typeof err?.rpcCode === 'number') return errorResponse(id, err.rpcCode, err.message);
      return errorResponse(id, JSONRPC_ERRORS.INTERNAL_ERROR, `Internal error: ${err?.message ?? err}`);
    }
  };

  return { handle };
};

// Serve until the input ends. `input` is an async iterable of Buffers (process.stdin, a PassThrough),
// `output` anything with write(string) — and, when it also has once(), its backpressure is honoured:
// a write that returns false stops the flush until 'drain', so a run of large answers never piles up
// unbounded in process memory. Every write is exactly one JSON document plus "\n" — JSON.stringify
// escapes every newline inside strings, so no message ever embeds one.
export const serveStdio = async ({ input, output, dispatcher, maxLineBytes = MAX_LINE_BYTES }) => {
  // The reader only QUEUES framed lines (bounded by the chunk size); each line is dispatched and its
  // answer written one at a time, with the drain wait BETWEEN lines — so a chunk holding many compact
  // requests never has all their answers computed and held in memory at once.
  const pending = [];
  const reader = createLineReader({
    maxLineBytes,
    onOverflow: () => pending.push({ overflow: true }),
    onInvalidUtf8: () => pending.push({ invalidUtf8: true }),
    onLine: (line) => pending.push({ line }),
  });
  const answerFor = (entry) => {
    if (entry.overflow) return errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, `Invalid Request: line exceeds ${maxLineBytes} byte(s) — the transport is closing; restart the server`);
    if (entry.invalidUtf8) return errorResponse(null, JSONRPC_ERRORS.PARSE_ERROR, 'Parse error: the line is not valid UTF-8');
    if (entry.line.trim() === '') return null;
    const parsed = parseLine(entry.line);
    if (parsed.error) return errorResponse(null, parsed.error.code, parsed.error.message);
    return dispatcher.handle(parsed.message);
  };
  // Returns true once the transport must close: a null-id overflow error cannot be correlated, so
  // nothing after it is served — not even the rest of the same chunk.
  const drainPending = async () => {
    while (pending.length > 0) {
      const entry = pending.shift();
      const response = answerFor(entry);
      if (response !== null) {
        const accepted = output.write(`${JSON.stringify(response)}\n`);
        if (accepted === false && typeof output.once === 'function') await new Promise((resolve) => output.once('drain', resolve));
      }
      if (entry.overflow) return true;
    }
    return false;
  };
  for await (const chunk of input) {
    reader.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (await drainPending()) return;
  }
  reader.end();
  await drainPending();
};
