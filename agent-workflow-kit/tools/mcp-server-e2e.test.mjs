// mcp-server-e2e.test.mjs — ONE real process: the server is spawned the way a client spawns it.
//
// Pinned here, and only here (everything else is in-process):
//   • cwd OUTSIDE the project and the root taken from CLAUDE_PROJECT_DIR, the way Claude Code runs a
//     stdio server — initialize → tools/list → tools/call with the corpus byte `2>/dev/null`;
//   • stdout carries ONLY JSON lines, one message each; stderr is not part of the protocol;
//   • `--self-check` exits 0 from the checkout — the free probe lane for later sessions;
//   • neither transport nor server carries a write or exec API (a pure reader, like the CLIs it wraps).
//
// The spawn targets the module PATH, so on a tree without the module the spawn itself fails: red.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, 'mcp-server.mjs');
const TRANSPORT_PATH = join(HERE, 'mcp-stdio.mjs');
const WRITE_OR_EXEC_API = /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream|copyFileSync|node:child_process/u;

const scratch = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// Write every request up front, close stdin, collect stdout until exit: a stdio server answers in
// order and exits when its input ends, so no interleaving is needed to read the conversation back.
const converse = (requests, { cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(requests.map((r) => `${JSON.stringify(r)}\n`).join(''));
  });

describe('mcp-server — end to end over stdio', () => {
  it('serves a client from a cwd outside the project, rooted by CLAUDE_PROJECT_DIR, and answers the corpus byte', async () => {
    const root = scratch('aw-mcp-e2e-root-');
    const elsewhere = scratch('aw-mcp-e2e-cwd-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.sh'), 'grep x f 2>/dev/null\n');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const { code, stdout } = await converse(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repo_search', arguments: { pattern: '2>/dev/null', paths: ['src'] } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'path_inventory', arguments: { paths: ['src', 'missing.txt'] } } },
      ],
      { cwd: elsewhere, env },
    );
    assert.equal(code, 0);
    const lines = stdout.split('\n').filter((l) => l !== '');
    const messages = lines.map((l) => JSON.parse(l)); // every stdout line is ONE JSON document
    assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4], 'notifications get no answer; requests are answered in order');
    assert.equal(messages[0].result.protocolVersion, '2025-06-18');
    assert.equal(messages[0].result.serverInfo.name, 'agent-workflow');
    assert.deepEqual(messages[1].result.tools.map((t) => t.name), ['path_inventory', 'repo_search']);
    assert.equal(messages[2].result.isError, false);
    assert.match(messages[2].result.content[0].text, /src\/a\.sh:1:/u, 'the search ran against the env root, not the cwd');
    assert.equal(messages[3].result.isError, false);
    assert.match(messages[3].result.content[0].text, /src: directory, 1 entr/u);
    assert.match(messages[3].result.content[0].text, /missing\.txt: absent/u);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('--self-check exits 0 from the checkout and says so on stdout', () => {
    const result = spawnSync(process.execPath, [SERVER_PATH, '--self-check'], { cwd: join(HERE, '..'), encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /self-check: OK/u);
  });

  it('--help prints the tool names and exits 0; an unknown flag is a usage error', () => {
    const help = spawnSync(process.execPath, [SERVER_PATH, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /path_inventory/u);
    assert.match(help.stdout, /repo_search/u);
    const bad = spawnSync(process.execPath, [SERVER_PATH, '--bogus'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--bogus/u);
  });

  it('neither the transport nor the server carries a write or exec API', () => {
    for (const path of [TRANSPORT_PATH, SERVER_PATH]) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), WRITE_OR_EXEC_API, `${path} must stay a pure reader`);
    }
  });
});
