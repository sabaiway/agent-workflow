#!/usr/bin/env node
// mcp-server.mjs — the kit's stdio MCP server: the two promptless readers as TYPED tools.
//
// WHY THIS EXISTS. Every lane an agent used for a path question or a literal search ended in a STRING
// handed to a shell, and a string always admits a pipe, a redirect, a quote, an `||`. Here the same two
// readers (path-inventory.mjs, repo-search.mjs) are reached through named JSON fields: validated against
// a CLOSED schema, turned into an in-process argv LIST, handed to each reader's exported `main(argv,
// {cwd})`. No shell, no subprocess, no string — a decoration has no slot; `>`, a backtick, `$(` are bytes.
// Root = `--root` > env CLAUDE_PROJECT_DIR (Claude Code sets it for a stdio server) > cwd; containment
// stays the readers' own real-path rule. A client's child, outside any Bash sandbox, read-only,
// root-contained. Dependency-free, Node >= 22, no side effects on import.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { isDirectRun } from './direct-run.mjs';
import { JSONRPC_ERRORS, createDispatcher, rpcError, serveStdio } from './mcp-stdio.mjs';
import {
  main as inventoryMain,
  HARD_MAX_CONTENT_BYTES,
  HARD_MAX_ENTRIES,
  HARD_MAX_TOTAL_BYTES as INVENTORY_HARD_MAX_TOTAL_BYTES,
  HARD_MAX_TOTAL_ENTRIES,
} from './path-inventory.mjs';
import {
  main as searchMain,
  HARD_MAX_TARGETS,
  HARD_MAX_RESULTS,
  HARD_MAX_FILE_BYTES,
  HARD_MAX_TOTAL_BYTES as SEARCH_HARD_MAX_TOTAL_BYTES,
} from './repo-search.mjs';

export const SERVER_NAME = 'agent-workflow';
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const ROOT_ENV = 'CLAUDE_PROJECT_DIR';
const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const INSTRUCTIONS =
  'Read-only tools over the project root. Prefer them to a shell for a path question (exists / type / size / lines / listing / a small file) and for a literal search: a pattern or path is a JSON field, never a command string.';

const pathList = (description) => ({
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  maxItems: HARD_MAX_TARGETS,
  description,
});
const count = (maximum, description) => ({ type: 'integer', minimum: 0, maximum, description });

// The public definitions — exactly what tools/list returns. The schema a client sees is the schema
// validateArgs enforces: one object, no second copy to drift.
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'path_inventory',
    title: 'Path inventory',
    description:
      'Facts about named paths inside the project root, in ONE call: exists, type, bytes, line count (wc -l compatible), a directory listing (one level), and with contents=true the text of a small file. A missing path is a RESULT (absent), never an error. Symlinks are reported by type and never followed; binaries are never decoded.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: pathList('Project-relative paths, any number; a trailing "/" asserts a directory.'),
        contents: { type: 'boolean', description: 'Also return the text of each regular text file.' },
        maxContentBytes: count(HARD_MAX_CONTENT_BYTES, 'Per-file ceiling for the line count and contents.'),
        maxEntries: count(HARD_MAX_ENTRIES, 'Per-directory listing ceiling.'),
        maxTotalBytes: count(INVENTORY_HARD_MAX_TOTAL_BYTES, 'Whole-call byte ceiling.'),
        maxTotalEntries: count(HARD_MAX_TOTAL_ENTRIES, 'Whole-call listed-entries ceiling.'),
      },
    },
    annotations: READ_ONLY,
  }),
  Object.freeze({
    name: 'repo_search',
    title: 'Repository search (literal)',
    description:
      'LITERAL search (no regex) for a pattern across the project root or the named paths: every hit as file:line with a bounded snippet. The pattern is a plain JSON string, so shell-significant bytes need no quoting. A fired bound is reported as INCOMPLETE with its name, never as an empty result.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', minLength: 1, description: 'The literal bytes to find; multiline allowed.' },
        paths: pathList('Project-relative search targets (default: the whole root).'),
        max: count(HARD_MAX_RESULTS, 'Result ceiling.'),
        maxBytes: count(HARD_MAX_FILE_BYTES, 'Per-file byte ceiling.'),
        maxTotalBytes: count(SEARCH_HARD_MAX_TOTAL_BYTES, 'Whole-call byte ceiling.'),
      },
    },
    annotations: READ_ONLY,
  }),
]);

const numericFlags = (value, pairs) => pairs.flatMap(([key, flag]) => (value[key] === undefined ? [] : [flag, String(value[key])]));
const pathFlags = (paths = []) => paths.flatMap((p) => ['--path', p]);

// Field → argv, deterministic and ONE flag per field. Kept beside the public definitions by NAME.
const RUNTIME = Object.freeze({
  path_inventory: Object.freeze({
    main: inventoryMain,
    argv: (v) => [
      ...pathFlags(v.paths),
      ...(v.contents === true ? ['--contents'] : []),
      ...numericFlags(v, [['maxContentBytes', '--max-content-bytes'], ['maxEntries', '--max-entries'], ['maxTotalBytes', '--max-total-bytes'], ['maxTotalEntries', '--max-total-entries']]),
    ],
  }),
  repo_search: Object.freeze({
    main: searchMain,
    argv: (v) => ['--pattern', v.pattern, ...pathFlags(v.paths), ...numericFlags(v, [['max', '--max'], ['maxBytes', '--max-bytes'], ['maxTotalBytes', '--max-total-bytes']])],
  }),
});

const toolByName = (name) => TOOLS.find((t) => t.name === name);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A walker over the schema subset the two tools use — the public schema IS the validator's input. A
// schema type outside that subset is a fault, never a silent pass; exported so that arm has a test.
export const checkAgainst = (schema, value, at) => {
  if (schema.type === 'object') {
    if (!isPlainObject(value)) return `${at} must be an object`;
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) return `${at}: unknown key "${key}"`;
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${at}: "${key}" is required`;
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const fault = checkAgainst(sub, value[key], `${at}.${key}`);
      if (fault !== null) return fault;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${at} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} must not be empty`;
    // A lone surrogate becomes U+FFFD on the way to the filesystem, so the reader could answer about
    // a DIFFERENT, existing path — the substitution class the readers refuse; refused here, before argv.
    if (!value.isWellFormed()) return `${at} must be well-formed Unicode (no lone surrogate)`;
    return null;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${at} must be a boolean`;
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${at} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be <= ${schema.maximum}`;
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} must not be empty`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} holds more than ${schema.maxItems} item(s)`;
    for (const [i, item] of value.entries()) {
      const fault = checkAgainst(schema.items, item, `${at}[${i}]`);
      if (fault !== null) return fault;
    }
    return null;
  }
  return `${at}: unsupported schema type ${schema.type}`;
};

export const validateArgs = (name, args) => {
  const tool = toolByName(name);
  if (tool === undefined) return { ok: false, message: `Unknown tool: ${name}` };
  const fault = checkAgainst(tool.inputSchema, args, 'arguments');
  return fault === null ? { ok: true, value: args } : { ok: false, message: fault };
};

export const toolArgv = (name, args) => {
  if (!Object.hasOwn(RUNTIME, name)) throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`);
  return RUNTIME[name].argv(args);
};

// Reader outcome → tool result. 0 and 3 (INCOMPLETE, the reader names the bound in its own stdout)
// are answers; 1 (I/O or containment refusal) and 2 (usage) are errors carrying the reader's stderr.
export const toToolResult = (r) => {
  const isError = !(r.code === 0 || r.code === 3);
  const text = isError ? (r.stderr || r.stdout) : r.stdout;
  return { content: [{ type: 'text', text }], isError };
};

export const callTool = (name, args, root) => {
  if (!Object.hasOwn(RUNTIME, name)) throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`);
  const verdict = validateArgs(name, args);
  if (!verdict.ok) throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, `${name}: ${verdict.message}`);
  return toToolResult(RUNTIME[name].main(toolArgv(name, verdict.value), { cwd: root }));
};

const usage = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });

export const parseArgv = (argv) => {
  const opts = { root: null, selfCheck: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--self-check') opts.selfCheck = true;
    else if (arg === '--root') {
      i += 1;
      // An EMPTY value is refused: `'' ?? env` keeps the empty string, and resolve(cwd, '') is the cwd —
      // a silent override of a correct CLAUDE_PROJECT_DIR by whatever directory the client started in.
      if (argv[i] === undefined || argv[i] === '') throw usage('--root requires a non-empty value');
      opts.root = argv[i];
    } else throw usage(`unknown argument: ${arg} (see --help)`);
  }
  return opts;
};

export const resolveRoot = ({ argv = [], env = {}, cwd }) => {
  const opts = parseArgv(argv);
  const fromEnv = typeof env[ROOT_ENV] === 'string' && env[ROOT_ENV] !== '' ? env[ROOT_ENV] : null;
  // The same rule as a tool argument: a lone surrogate would reach the filesystem as U+FFFD and pick
  // a DIFFERENT existing directory as the root. EVERY string resolve() will see is checked — the flag,
  // the env value and the cwd a relative candidate resolves against — not only the one selected.
  for (const [source, value] of [['--root', opts.root], [ROOT_ENV, fromEnv], ['cwd', cwd]]) {
    if (value === null) continue;
    if (typeof value !== 'string' || !value.isWellFormed()) throw usage(`${source} must be a well-formed Unicode string (no lone surrogate)`);
  }
  const candidate = opts.root ?? fromEnv ?? cwd;
  let real;
  try {
    real = realpathSync(resolve(cwd, candidate));
  } catch (err) {
    throw usage(`root does not exist: ${candidate} (${err?.code ?? err?.message ?? err})`);
  }
  if (!statSync(real).isDirectory()) throw usage(`root is not a directory: ${candidate}`);
  return real;
};

// The kit's package version, informational: an unreadable or versionless package.json degrades to 0.0.0.
export const readServerVersion = (readFile = readFileSync) => {
  try {
    return JSON.parse(readFile(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const createServer = ({ root }) =>
  createDispatcher({
    serverInfo: { name: SERVER_NAME, version: readServerVersion() },
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    handlers: {
      'tools/list': () => ({ tools: TOOLS }),
      'tools/call': (params) => {
        if (typeof params.name !== 'string') throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'tools/call: "name" must be a string');
        return callTool(params.name, params.arguments ?? {}, root);
      },
    },
  });

// In-process round trip through the SAME transport and dispatcher a client drives: the installed bytes
// load, the handshake answers, both tools answer a call rooted here. No process is spawned.
export const selfCheck = async ({ root }) => {
  const input = new PassThrough();
  const lines = [];
  const done = serveStdio({ input, output: { write: (t) => lines.push(t) }, dispatcher: createServer({ root }) });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-check', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'path_inventory', arguments: { paths: ['.'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo_search', arguments: { pattern: '2>/dev/null', paths: ['.'], max: 1 } } },
  ];
  input.end(requests.map((r) => `${JSON.stringify(r)}\n`).join(''));
  await done;
  const answers = lines.map((l) => JSON.parse(l));
  const byId = (id) => answers.find((a) => a.id === id);
  const checks = [
    ['initialize answered', byId(1)?.result?.protocolVersion !== undefined],
    ['tools/list names both tools', JSON.stringify(byId(2)?.result?.tools?.map((t) => t.name)) === JSON.stringify(TOOLS.map((t) => t.name))],
    ['path_inventory answers', byId(3)?.result?.isError === false],
    ['repo_search answers a shell-significant pattern', byId(4)?.result?.isError === false],
  ];
  const ok = checks.every(([, passed]) => passed);
  const report = [...checks.map(([label, passed]) => `  ${passed ? 'ok ' : 'FAIL'} ${label}`), `self-check: ${ok ? 'OK' : 'FAILED'} (root ${root})`];
  return { ok, report };
};

const HELP = `mcp-server — the kit's stdio MCP server (server name "${SERVER_NAME}").

Tools: ${TOOLS.map((t) => t.name).join(', ')} — the kit's read-only path inventory and literal search,
reached through typed JSON fields instead of a shell string.
Usage:
  node mcp-server.mjs [--root <dir>]      serve JSON-RPC over stdin/stdout until stdin closes
  node mcp-server.mjs --self-check        in-process handshake + one call per tool, exit 0 on success
Root = --root > env ${ROOT_ENV} > cwd; every path is contained to it on the REAL path.
Exit codes: 0 served / self-check passed · 1 self-check failed · 2 usage.`;

export const main = async (argv, deps = {}) => {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  try {
    const opts = parseArgv(argv);
    if (opts.help) {
      out.write(`${HELP}\n`);
      return EXIT_OK;
    }
    const root = resolveRoot({ argv, env: deps.env ?? process.env, cwd: deps.cwd ?? process.cwd() });
    if (opts.selfCheck) {
      const result = await selfCheck({ root });
      out.write(`${result.report.join('\n')}\n`);
      return result.ok ? EXIT_OK : EXIT_FAILED;
    }
    await serveStdio({ input: deps.stdin ?? process.stdin, output: out, dispatcher: createServer({ root }) });
    return EXIT_OK;
  } catch (e) {
    err.write(`mcp-server: ${e?.message ?? e}\n`);
    return e?.exitCode ?? EXIT_FAILED;
  }
};

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
