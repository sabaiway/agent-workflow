// mcp-server.test.mjs — the tool contract of the kit's stdio MCP server, in-process (no spawn).
//
// Pinned here:
//   • exactly two tools, each a LITERAL schema fixture this file carries — the schema the client sees
//     IS the schema validateArgs enforces (one object, no second copy);
//   • every field maps to ONE argv flag, deterministically (the per-field argv fixture);
//   • an unknown key, a wrong type, an out-of-range number, an empty string or an empty list is a
//     -32602 BEFORE any argv exists; an unknown tool is -32602 too;
//   • the four reader outcomes map distinguishably: 0 → text, 1/2 → isError + stderr, 3 → the
//     reader's own INCOMPLETE text with isError false;
//   • the bytes that fired the corpus (`2>/dev/null`, `$(`, a backtick) and a path with a space
//     travel VERBATIM — they are JSON fields, not shell;
//   • root = --root > CLAUDE_PROJECT_DIR > cwd, each branch alone, and a non-directory root refuses.
//
// Loaded with a dynamic import() so the file LOADS and FAILS before the module exists (red-proof lane).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HARD_MAX_CONTENT_BYTES,
  HARD_MAX_ENTRIES,
  HARD_MAX_TOTAL_BYTES as INVENTORY_HARD_MAX_TOTAL_BYTES,
  HARD_MAX_TOTAL_ENTRIES,
} from './path-inventory.mjs';
import { HARD_MAX_TARGETS, HARD_MAX_RESULTS, HARD_MAX_FILE_BYTES, HARD_MAX_TOTAL_BYTES as SEARCH_HARD_MAX_TOTAL_BYTES } from './repo-search.mjs';

const MODULE_URL = new URL('./mcp-server.mjs', import.meta.url).href;
const api = () => import(MODULE_URL);

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'aw-mcp-server-')));
const seed = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
};

const pathList = () => ({
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  maxItems: HARD_MAX_TARGETS,
});
const count = (maximum) => ({ type: 'integer', minimum: 0, maximum });

// The literal fixtures: what a client is told, byte for byte in meaning.
const PATH_INVENTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paths'],
  properties: {
    paths: pathList(),
    contents: { type: 'boolean' },
    maxContentBytes: count(HARD_MAX_CONTENT_BYTES),
    maxEntries: count(HARD_MAX_ENTRIES),
    maxTotalBytes: count(INVENTORY_HARD_MAX_TOTAL_BYTES),
    maxTotalEntries: count(HARD_MAX_TOTAL_ENTRIES),
  },
};
const REPO_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
    paths: pathList(),
    max: count(HARD_MAX_RESULTS),
    maxBytes: count(HARD_MAX_FILE_BYTES),
    maxTotalBytes: count(SEARCH_HARD_MAX_TOTAL_BYTES),
  },
};

const stripDescriptions = (schema) => JSON.parse(JSON.stringify(schema, (key, value) => (key === 'description' ? undefined : value)));

describe('mcp-server — the two tools and their schemas', () => {
  it('lists exactly the two tools, read-only annotated, with the literal schema fixtures', async () => {
    const m = await api();
    assert.equal(m.SERVER_NAME, 'agent-workflow');
    assert.deepEqual(m.TOOLS.map((t) => t.name), ['path_inventory', 'repo_search']);
    for (const tool of m.TOOLS) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
    }
    assert.deepEqual(stripDescriptions(m.TOOLS[0].inputSchema), PATH_INVENTORY_SCHEMA);
    assert.deepEqual(stripDescriptions(m.TOOLS[1].inputSchema), REPO_SEARCH_SCHEMA);
  });

  it('tools/list through the dispatcher returns the same public definitions and nothing private', async () => {
    const m = await api();
    const root = scratch();
    const server = m.createServer({ root });
    server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const listed = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools;
    assert.deepEqual(listed.map((t) => Object.keys(t).sort()), [
      ['annotations', 'description', 'inputSchema', 'name', 'title'],
      ['annotations', 'description', 'inputSchema', 'name', 'title'],
    ]);
    assert.deepEqual(listed.map((t) => t.name), ['path_inventory', 'repo_search']);
    rmSync(root, { recursive: true, force: true });
  });

  it('every field maps to ONE argv flag, in a fixed order (the per-field argv fixture)', async () => {
    const m = await api();
    assert.deepEqual(
      m.toolArgv('path_inventory', { paths: ['a', 'b c'], contents: true, maxContentBytes: 5, maxEntries: 6, maxTotalBytes: 7, maxTotalEntries: 8 }),
      ['--path', 'a', '--path', 'b c', '--contents', '--max-content-bytes', '5', '--max-entries', '6', '--max-total-bytes', '7', '--max-total-entries', '8'],
    );
    assert.deepEqual(m.toolArgv('path_inventory', { paths: ['x'], contents: false }), ['--path', 'x']);
    assert.deepEqual(
      m.toolArgv('repo_search', { pattern: '2>/dev/null', paths: ['src', 'docs'], max: 1, maxBytes: 2, maxTotalBytes: 3 }),
      ['--pattern', '2>/dev/null', '--path', 'src', '--path', 'docs', '--max', '1', '--max-bytes', '2', '--max-total-bytes', '3'],
    );
    assert.deepEqual(m.toolArgv('repo_search', { pattern: 'needle' }), ['--pattern', 'needle']);
  });
});

describe('mcp-server — validation happens BEFORE any argv exists', () => {
  const refused = (m, name, args) => {
    const verdict = m.validateArgs(name, args);
    assert.equal(verdict.ok, false, `${JSON.stringify(args)} must be refused`);
    assert.equal(typeof verdict.message, 'string');
    return verdict.message;
  };

  it('unknown key, wrong type, out of range, empty string, empty list, missing required — each refused', async () => {
    const m = await api();
    refused(m, 'path_inventory', { paths: ['a'], extra: 1 });
    refused(m, 'path_inventory', { paths: 'a' });
    refused(m, 'path_inventory', { paths: [] });
    refused(m, 'path_inventory', { paths: [''] });
    refused(m, 'path_inventory', { paths: ['a'], contents: 'yes' });
    refused(m, 'path_inventory', { paths: ['a'], maxEntries: -1 });
    refused(m, 'path_inventory', { paths: ['a'], maxEntries: HARD_MAX_ENTRIES + 1 });
    refused(m, 'path_inventory', { paths: ['a'], maxEntries: 1.5 });
    refused(m, 'path_inventory', {});
    refused(m, 'repo_search', { pattern: '' });
    refused(m, 'repo_search', { pattern: 'x', max: HARD_MAX_RESULTS + 1 });
    refused(m, 'repo_search', { pattern: 'x', paths: ['a', ''] });
    refused(m, 'repo_search', 'not an object');
    refused(m, 'repo_search', null);
    assert.equal(m.validateArgs('repo_search', { pattern: 'x' }).ok, true);
    assert.equal(m.validateArgs('path_inventory', { paths: ['a'] }).ok, true);
    // A schema type outside the supported subset is a FAULT, never a silent pass.
    assert.match(m.checkAgainst({ type: 'number' }, 1, 'x'), /unsupported schema type number/u);
    assert.equal(m.checkAgainst({ type: 'boolean' }, true, 'x'), null);
  });

  it('a lone surrogate is refused before argv — it would reach the filesystem as U+FFFD and name another path', async () => {
    const m = await api();
    const lone = String.fromCharCode(0xd800);
    const replacement = String.fromCharCode(0xfffd);
    refused(m, 'repo_search', { pattern: `x${lone}` });
    refused(m, 'repo_search', { pattern: 'x', paths: [`a${lone}`] });
    refused(m, 'path_inventory', { paths: [`caf${lone}.txt`] });
    // The path that WOULD have been read exists; the call must still be a refusal, never that file.
    const root = seed(scratch(), { [`caf${replacement}.txt`]: 'secret\n' });
    assert.throws(() => m.callTool('path_inventory', { paths: [`caf${lone}.txt`] }, root), (err) => err.rpcCode === -32602);
    assert.equal(m.callTool('path_inventory', { paths: [`caf${replacement}.txt`] }, root).isError, false);
    rmSync(root, { recursive: true, force: true });
  });

  it('callTool refuses an unknown tool and invalid arguments with -32602, never running a reader', async () => {
    const m = await api();
    const root = scratch();
    assert.throws(() => m.callTool('nope', {}, root), (err) => err.rpcCode === -32602 && /nope/u.test(err.message));
    assert.throws(() => m.callTool('repo_search', { pattern: 'x', bogus: true }, root), (err) => err.rpcCode === -32602);
    assert.throws(() => m.toolArgv('nope', {}), (err) => err.rpcCode === -32602 && /nope/u.test(err.message));
    rmSync(root, { recursive: true, force: true });
  });

  it('serverInfo.version is the kit package version, and an unreadable package.json degrades to 0.0.0', async () => {
    const m = await api();
    assert.match(m.readServerVersion(), /^\d+\.\d+\.\d+$/u);
    assert.equal(m.readServerVersion(() => { throw new Error('unreadable'); }), '0.0.0');
    assert.equal(m.readServerVersion(() => '{"name":"x"}'), '0.0.0');
  });
});

describe('mcp-server — the four reader outcomes map distinguishably', () => {
  it('0 → text, isError false; 3 → the INCOMPLETE text, isError false', async () => {
    const m = await api();
    const root = seed(scratch(), { 'a.txt': 'needle\nneedle\n' });
    const ok = m.callTool('path_inventory', { paths: ['a.txt'] }, root);
    assert.equal(ok.isError, false);
    assert.match(ok.content[0].text, /a\.txt: file, 14 byte\(s\), 2 line\(s\)/u);
    const bounded = m.callTool('repo_search', { pattern: 'needle', paths: ['a.txt'], max: 1 }, root);
    assert.equal(bounded.isError, false);
    assert.match(bounded.content[0].text, /INCOMPLETE \(max-results\)/u);
    rmSync(root, { recursive: true, force: true });
  });

  it('1 → isError with the reader\'s stderr; the pure mapping also carries 2', async () => {
    const m = await api();
    const root = scratch();
    const outside = m.callTool('repo_search', { pattern: 'x', paths: ['../outside'] }, root);
    assert.equal(outside.isError, true);
    assert.match(outside.content[0].text, /repo-search:/u);
    assert.deepEqual(m.toToolResult({ code: 2, stdout: '', stderr: 'usage' }), { content: [{ type: 'text', text: 'usage' }], isError: true });
    assert.deepEqual(m.toToolResult({ code: 0, stdout: 'fine', stderr: '' }), { content: [{ type: 'text', text: 'fine' }], isError: false });
    rmSync(root, { recursive: true, force: true });
  });

  it('a path that does not exist is a RESULT of path_inventory, not an error', async () => {
    const m = await api();
    const root = scratch();
    const r = m.callTool('path_inventory', { paths: ['nope.txt'] }, root);
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /nope\.txt: absent/u);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('mcp-server — the corpus bytes are just bytes', () => {
  it('`2>/dev/null`, `$(`, a backtick and a path with a space search verbatim', async () => {
    const m = await api();
    const root = seed(scratch(), {
      'dir with space/code.txt': 'grep x f 2>/dev/null\nrun $(thing)\nsay `hi`\n',
    });
    for (const pattern of ['2>/dev/null', '$(thing)', '`hi`']) {
      const r = m.callTool('repo_search', { pattern, paths: ['dir with space'] }, root);
      assert.equal(r.isError, false, pattern);
      assert.match(r.content[0].text, /code\.txt:\d+:/u, pattern);
    }
    const inv = m.callTool('path_inventory', { paths: ['dir with space/code.txt'], contents: true }, root);
    assert.match(inv.content[0].text, /2>\/dev\/null/u);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('mcp-server — root resolution', () => {
  it('--root beats CLAUDE_PROJECT_DIR beats cwd, each branch alone', async () => {
    const m = await api();
    const a = scratch();
    const b = scratch();
    const c = scratch();
    assert.equal(m.resolveRoot({ argv: ['--root', a], env: { CLAUDE_PROJECT_DIR: b }, cwd: c }), a);
    assert.equal(m.resolveRoot({ argv: [], env: { CLAUDE_PROJECT_DIR: b }, cwd: c }), b);
    assert.equal(m.resolveRoot({ argv: [], env: {}, cwd: c }), c);
    assert.equal(m.resolveRoot({ argv: [], env: { CLAUDE_PROJECT_DIR: '' }, cwd: c }), c);
    for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
  });

  it('a missing root, a file as root, or --root without a value is a usage refusal', async () => {
    const m = await api();
    const root = seed(scratch(), { 'f.txt': 'x' });
    assert.throws(() => m.resolveRoot({ argv: ['--root', join(root, 'nope')], env: {}, cwd: root }), /root/u);
    assert.throws(() => m.resolveRoot({ argv: ['--root', join(root, 'f.txt')], env: {}, cwd: root }), /root/u);
    assert.throws(() => m.resolveRoot({ argv: ['--root'], env: {}, cwd: root }), /--root/u);
    // An empty --root must not silently win over CLAUDE_PROJECT_DIR and land on the cwd.
    assert.throws(() => m.resolveRoot({ argv: ['--root', ''], env: { CLAUDE_PROJECT_DIR: root }, cwd: join(root, 'f.txt') }), /--root/u);
    // A lone surrogate in ANY root source would reach the filesystem as U+FFFD and pick another directory.
    const lone = String.fromCharCode(0xd800);
    assert.throws(() => m.resolveRoot({ argv: ['--root', `${root}${lone}`], env: {}, cwd: root }), /well-formed/u);
    assert.throws(() => m.resolveRoot({ argv: [], env: { CLAUDE_PROJECT_DIR: `${root}${lone}` }, cwd: root }), /well-formed/u);
    assert.throws(() => m.resolveRoot({ argv: [], env: {}, cwd: `${root}${lone}` }), /well-formed/u);
    // A relative flag or env candidate resolves AGAINST the cwd, so a malformed cwd is refused there too.
    assert.throws(() => m.resolveRoot({ argv: ['--root', '.'], env: {}, cwd: `${root}${lone}` }), /cwd/u);
    assert.throws(() => m.resolveRoot({ argv: [], env: { CLAUDE_PROJECT_DIR: '.' }, cwd: `${root}${lone}` }), /cwd/u);
    assert.throws(() => m.resolveRoot({ argv: [], env: {}, cwd: 42 }), /cwd/u);
    assert.throws(() => m.resolveRoot({ argv: ['--bogus'], env: {}, cwd: root }), /--bogus/u);
    rmSync(root, { recursive: true, force: true });
  });
});
