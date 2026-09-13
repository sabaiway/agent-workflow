import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, symlinkSync, readlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hermeticGitEnv } from '../git-env.mjs';
import { main as dispatchMain } from '../dispatch.mjs';
import { contractDigest } from '../dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const ABSENT = 'absent ../checkpoint.mjs';
const RESTORE_ABSENT = 'absent ../checkpoint-restore.mjs';
const loaded = await import('../checkpoint.mjs').catch(() => ({}));
const restored = await import('../checkpoint-restore.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error(ABSENT); });
const restoreCheckpoint = restored.restoreCheckpoint ?? (() => { throw new Error(RESTORE_ABSENT); });
const TMP = mkdtempSync(join(tmpdir(), 'aw-checkpoint-restore-test-'));
const ENV = hermeticGitEnv(process.env, TMP);
const CLI = fileURLToPath(new URL('../checkpoint.mjs', import.meta.url));
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const PREFIX = 'refs/agent-workflow/checkpoints/';
const NAMED = 'named';
const ALPHA = 'story-alpha';
const BETA = 'story-beta';
const BASE = 'base.txt';
const GONE = 'gone.bin';
const IGNORE = '.gitignore';
const EXTRA = 'extra.txt';
const INDEX_ONLY = 'index-only.txt';
const HIDDEN_PATH = 'docs/ai/x.md';
const LINK = 'link';
const PARENT = 'nested';
const CHILD = `${PARENT}/x.txt`;
const INITIAL = 'initial\n';
const CHANGED = 'changed\n';
const BINARY = Buffer.from([0, 255, 10]);
const MODE_FILE = 0o644;
const MODE_EXEC = 0o755;
const EXEC_BITS = 0o111;
const HIDDEN = '/docs/ai/\n/AGENTS.md\n';
const EXCLUDE = '.git/info/exclude';
const PLAN_TITLE = '# Synthetic plan\n';
const UNKNOWN = 'f'.repeat(40);
const BRIEF = `docs/plans/TASK-${ALPHA}-T1.md`;
const SETTINGS = '.claude/settings.local.json';
const EXCLUDED = [`docs/plans/${ALPHA}.md`, BRIEF, SETTINGS,
  '.claude/settings.json', '.mcp.json', '.claude/skills/x.md', 'node_modules/x.js'];
const EMPTY_PARENT = 'empty-after';
const EXISTING_EMPTY = 'existing-empty';
const KEPT_PARENT = 'keep';
const CAP_S = 600;
const GRACE_S = 15;
const WAVE = 'wave-a';
const NONCE = 'thread-a';
const RETRY_NONCE = 'thread-b';
const REPORT = Buffer.from('the requested file was written\n');
const CONTRACT = { schema: 1, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
  returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900 };
const RECEIPT = { schema: EXEC_RECEIPT_SCHEMA_VERSION, kind: EXEC_RECEIPT_KIND, state: 'terminal', backend: 'codex',
  owner: 'owner-token-1', wrapperVersion: '3.4.1', posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' },
  capS: CAP_S, killGraceS: GRACE_S, sessionId: 'session-a', exitStatus: ACCEPT, outcome: 'success' };
const REGISTER = ['register', '--wave', WAVE, '--step-classes', 'code', '--pairing-key', 'stepClass',
  '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1'];
after(() => rmSync(TMP, { recursive: true, force: true }));
const runGit = (args, cwd, input, env = ENV) => spawnSync('git', args, { cwd, input, env });
const readGit = (ws, args, input) => {
  const result = runGit(args, ws.cwd, input, ws.env);
  assert.equal(result.status, ACCEPT, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const sh = (ws, args, input) => readGit(ws, args, input).toString('utf8').trimEnd();
const put = (ws, path, bytes = INITIAL) => {
  mkdirSync(dirname(join(ws.cwd, path)), { recursive: true });
  writeFileSync(join(ws.cwd, path), bytes); ws.planted.add(path);
};
const getPlan = (stem = ALPHA) => `docs/plans/${stem}.md`;
const makeRepo = () => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  const store = join(cwd, '.git', DELEGATION_STORE_BASENAME);
  const ws = { cwd, store, planted: new Set(), env: { ...ENV, AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(cwd, '.git', 'evidence.jsonl') } };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'coder-tools@proton.me'], ['config', 'user.name', 'coder-tool']]) sh(ws, args);
  put(ws, BASE); put(ws, GONE, BINARY); put(ws, IGNORE, '\n'); chmodSync(join(cwd, BASE), MODE_EXEC);
  sh(ws, ['add', '-A']); sh(ws, ['commit', '-q', '-m', 'initial tree']);
  put(ws, EXCLUDE, HIDDEN); put(ws, getPlan(), PLAN_TITLE); put(ws, HIDDEN_PATH);
  return ws;
};
const mint = (ws, stem = ALPHA, n = 0) => {
  const result = accept(run(ws, ['mint', '--plan', getPlan(stem)]));
  const oid = sh(ws, ['rev-parse', `${PREFIX}${stem}/${n}`]);
  assert.equal(result.stdout, `checkpoint ${stem}/${n} ${oid}\n`);
  return oid;
};
const run = (ws, argv, io = {}) => {
  const result = main(argv, { cwd: ws.cwd, env: ws.env, ...io });
  assert.equal(typeof result.stdout, 'string'); assert.equal(typeof result.stderr, 'string');
  return result;
};
const accept = (result) => { assert.equal(result.code, ACCEPT, result.stderr); return result; };
const matchName = (name) => new RegExp('\\b' + name + '\\b');
const readNode = (path) => {
  const stat = (() => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } })();
  if (!stat) return null;
  return { mode: stat.mode, value: stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? readFileSync(path)
    : stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map((name) => [name, readNode(join(path, name))])) : null };
};
const readState = (ws) => ({ status: readGit(ws, ['status', '--porcelain']), index: readGit(ws, ['ls-files', '-s']),
  refs: readGit(ws, ['for-each-ref', PREFIX]),
  files: Object.fromEntries(readdirSync(ws.cwd).filter((name) => name !== '.git').sort().map((name) => [name, readNode(join(ws.cwd, name))])),
  planted: [...ws.planted].map((path) => [path, readNode(join(ws.cwd, path))]), ledger: readNode(ws.store) });
const refuse = (ws, oid, name, path) => {
  const before = readState(ws);
  const result = run(ws, ['restore', oid]);
  assert.equal(result.code, REFUSE, result.stderr);
  assert.match(result.stderr, name instanceof RegExp ? name : matchName(name));
  if (path) assert.ok(result.stderr.includes(path), result.stderr);
  assert.deepEqual(readState(ws), before);
  return result;
};
const prove = (ws, oid, io = {}) => {
  const result = accept(run(ws, ['restore', oid], io));
  assert.equal(result.stdout, `checkpoint restore ${oid} proof ${oid}\n`);
  return result.stdout;
};
const assertClean = (ws, oid) => assert.match(accept(run(ws, ['verify', oid])).stdout, new RegExp(`\\bCLEAN\\b.*${oid}|${oid}.*\\bCLEAN\\b`));
const assertTarget = (ws, oid) => {
  for (const line of sh(ws, ['ls-tree', '-r', oid]).split('\n')) {
    const [mode, , , path] = line.split(/\s+/);
    const stat = lstatSync(join(ws.cwd, path));
    assert.equal(stat.isSymbolicLink(), mode === '120000', path);
    assert.deepEqual(mode === '120000' ? Buffer.from(readlinkSync(join(ws.cwd, path))) : readFileSync(join(ws.cwd, path)), readGit(ws, ['show', `${oid}:${path}`]));
    if (mode !== '120000') assert.equal(Boolean(stat.mode & EXEC_BITS), mode === '100755', path);
  }
};
const spyIO = (observe = () => {}) => {
  const calls = [];
  return { calls, runGit: (args, cwd, input, env) => {
    calls.push({ args, index: env?.GIT_INDEX_FILE }); observe(args, calls);
    return runGit(args, cwd, input, env);
  } };
};
const assertRemoved = (calls) => {
  const indexes = [...new Set(calls.map(({ index }) => index).filter(Boolean))];
  assert.ok(indexes.length > 0);
  for (const index of indexes) { assert.equal(existsSync(dirname(index)), false); assert.equal(dirname(dirname(index)), tmpdir()); }
};
const openThread = (ws, oid, { retry = false, rationale = 'a bounded change' } = {}) => {
  if (!retry) accept(dispatchMain(REGISTER, ws));
  const contract = { ...CONTRACT, nonce: retry ? RETRY_NONCE : NONCE, retry: { cap: 2, index: retry ? 1 : 0 } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  const result = accept(dispatchMain(['open', '--contract', path, '--wave', WAVE, '--backend', RECEIPT.backend,
    '--rationale', rationale, '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S),
    ...(oid ? ['--checkpoint', oid] : []), ...(retry ? ['--retry-of', NONCE] : [])], ws));
  return { contract, result };
};
const returnThread = (ws, contract, outcome = 'success') => {
  put(ws, join('.git', execReportBasename(RECEIPT.backend, contract.nonce)), REPORT);
  put(ws, join('.git', execReceiptBasename(RECEIPT.backend, contract.nonce)), JSON.stringify({ ...RECEIPT,
    nonce: contract.nonce, contractDigest: contractDigest(contract), timestamp: new Date().toISOString(),
    reportDigest: createHash('sha256').update(REPORT).digest('hex'), reportLength: REPORT.length }));
  accept(dispatchMain(['return', '--nonce', contract.nonce, ...(outcome === 'success' ? [] : ['--outcome', outcome])], ws));
  const ledger = readDelegationStore(ws.store);
  assert.equal(ledger.malformed, ACCEPT);
  assert.equal(ledger.records.find((record) => record.kind === 'return' && record.nonce === contract.nonce).outcome, outcome);
};
const closeThread = (ws, fold = false) => accept(dispatchMain(fold ? ['fold', '--nonce', NONCE, '--verdict', 'accepted as returned']
  : ['degrade', '--wave', WAVE, '--nonce', NONCE, '--step-class', 'code', '--rationale', 'withdraw this thread'], ws));
const makeTree = (ws, path, mode = '100644', type = 'blob', oid = sh(ws, ['rev-parse', `HEAD:${BASE}`])) =>
  path.split('/').reduceRight((entry, name) => ({ mode: '040000', type: 'tree',
    oid: sh(ws, ['mktree'], `${entry.mode} ${entry.type} ${entry.oid}\t${name}\n`) }), { mode, type, oid }).oid;

describe('whole-tree restore — spec:checkpoint/S4', () => {
  it('exports restoreCheckpoint', () => {
    const ws = makeRepo(); mint(ws);
    assert.equal(typeof restoreCheckpoint, 'function'); assert.equal(restoreCheckpoint, restored.restoreCheckpoint);
  });
  it('materializes all bytes and modes, then deletes extras, then proves under temporary indexes', () => {
    const ws = makeRepo(); const oid = mint(ws);
    put(ws, BASE, CHANGED); chmodSync(join(ws.cwd, BASE), MODE_FILE); put(ws, EXTRA); put(ws, HIDDEN_PATH, CHANGED); rmSync(join(ws.cwd, GONE));
    const io = spyIO((args) => {
      if (args[0] === 'checkout-index') assert.equal(existsSync(join(ws.cwd, EXTRA)), true);
      if (args[0] === 'write-tree') { assertTarget(ws, oid); assert.equal(existsSync(join(ws.cwd, EXTRA)), false); }
    });
    prove(ws, oid, io); assertTarget(ws, oid); assert.equal(existsSync(join(ws.cwd, EXTRA)), false); assertClean(ws, oid);
    const read = io.calls.findIndex(({ args }) => args[0] === 'read-tree' && args.includes(oid));
    const checkout = io.calls.findIndex(({ args }) => args[0] === 'checkout-index');
    const proof = io.calls.findIndex(({ args }) => args[0] === 'write-tree');
    assert.ok(read >= 0 && checkout > read && proof > checkout);
    assert.ok(io.calls.filter(({ args }) => ['read-tree', 'checkout-index', 'write-tree'].includes(args[0])).every(({ index }) => index));
    assert.ok(io.calls.filter(({ args }) => args[0] === 'checkout-index').every(({ args }) => args.some((arg) => arg === '--force' || /^-[^-]*f/.test(arg))));
    assertRemoved(io.calls);
  });
  it('is idempotent with identical bytes, status and proof', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED);
    const line = prove(ws, oid); const before = readState(ws);
    assert.equal(prove(ws, oid), line); assert.deepEqual(readState(ws), before);
  });
  it('preserves the real index while restoring the work tree beneath staged bytes', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED); sh(ws, ['add', '--', BASE]);
    put(ws, EXCLUDE, HIDDEN + `${INDEX_ONLY}\n`); put(ws, INDEX_ONLY, CHANGED); sh(ws, ['add', '-f', '--', INDEX_ONLY]);
    const before = readGit(ws, ['ls-files', '-s']); prove(ws, oid);
    assert.deepEqual(readGit(ws, ['ls-files', '-s']), before); assertTarget(ws, oid);
    assert.equal(readFileSync(join(ws.cwd, INDEX_ONLY), 'utf8'), CHANGED);
  });
  it('preserves modified plans, briefs, settings, footprint and node_modules', () => {
    const ws = makeRepo(); put(ws, SETTINGS); const oid = mint(ws);
    for (const path of EXCLUDED) put(ws, path, CHANGED);
    prove(ws, oid);
    for (const path of EXCLUDED) assert.equal(readFileSync(join(ws.cwd, path), 'utf8'), CHANGED, path);
  });
  it('preserves earlier checkpoints and briefs while allowing an older target', () => {
    const ws = makeRepo(); const first = mint(ws); put(ws, BASE, CHANGED); const second = mint(ws, ALPHA, 1);
    put(ws, BRIEF, PLAN_TITLE); const refs = readGit(ws, ['for-each-ref', PREFIX]); put(ws, BASE);
    for (const oid of [second, first]) {
      prove(ws, oid); assertTarget(ws, oid); assert.deepEqual(readGit(ws, ['for-each-ref', PREFIX]), refs);
      for (const tree of [first, second]) assert.equal(sh(ws, ['cat-file', '-t', tree]), 'tree');
      assert.equal(readFileSync(join(ws.cwd, BRIEF), 'utf8'), PLAN_TITLE);
    }
  });
  it('removes only directories emptied by extras and preserves excluded descendants and repository top', () => {
    const ws = makeRepo(); const oid = mint(ws);
    mkdirSync(join(ws.cwd, EXISTING_EMPTY));
    put(ws, `${EMPTY_PARENT}/x`); put(ws, `${KEPT_PARENT}/x`); put(ws, `${KEPT_PARENT}/node_modules/x.js`); put(ws, 'docs/extra.txt');
    prove(ws, oid); assert.equal(existsSync(join(ws.cwd, EMPTY_PARENT)), false);
    for (const path of [KEPT_PARENT, EXISTING_EMPTY, 'docs', 'docs/plans', '.']) assert.ok(lstatSync(join(ws.cwd, path)).isDirectory());
    assert.equal(readFileSync(join(ws.cwd, `${KEPT_PARENT}/node_modules/x.js`), 'utf8'), INITIAL);
    assert.equal(existsSync(join(ws.cwd, `${KEPT_PARENT}/x`)), false);
  });
  it('restores a symlink entry over a regular file', () => {
    const ws = makeRepo(); symlinkSync(BASE, join(ws.cwd, LINK)); const oid = mint(ws);
    rmSync(join(ws.cwd, LINK)); put(ws, LINK, CHANGED); prove(ws, oid);
    assert.ok(lstatSync(join(ws.cwd, LINK)).isSymbolicLink()); assert.equal(readlinkSync(join(ws.cwd, LINK)), BASE); assertTarget(ws, oid);
  });
  it('writes the proof line, the exit code and nothing on stderr when run as a process', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED);
    const result = spawnSync(process.execPath, [CLI, 'restore', oid], { cwd: ws.cwd, env: ws.env, encoding: 'utf8' });
    assert.deepEqual([result.status, result.stdout, result.stderr], [ACCEPT, `checkpoint restore ${oid} proof ${oid}\n`, '']); assertClean(ws, oid);
    const usage = spawnSync(process.execPath, [CLI], { cwd: ws.cwd, env: ws.env, encoding: 'utf8' });
    assert.deepEqual([usage.status, usage.stdout], [USAGE, '']); assert.match(usage.stderr, /\busage\b/);
  });
});

describe('the sequence listing restore and newest both read', () => {
  const listingIO = (listing) => ({ runGit: (args, cwd, input, env) => args[0] === 'for-each-ref'
    ? { status: ACCEPT, stdout: Buffer.from(listing) } : runGit(args, cwd, input, env) });
  for (const kind of ['extra-token', 'not-an-oid']) it(`refuses a ${kind} listing line by the name sequence without writes`, () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED); const before = readState(ws);
    const io = listingIO(`${PREFIX}${ALPHA}/0 ${kind === 'extra-token' ? `${oid} extra` : oid.slice(1)}\n`);
    for (const argv of [['restore', oid], ['newest', '--plan', getPlan()]]) {
      const result = run(ws, argv, io); assert.equal(result.code, REFUSE, result.stderr); assert.match(result.stderr, matchName('sequence'));
    }
    assert.deepEqual(readState(ws), before);
  });
  it('refuses newest by the name sequence when a ref of the sequence has a non-numeric suffix', () => {
    const ws = makeRepo(); const oid = mint(ws); sh(ws, ['update-ref', `${PREFIX}${ALPHA}/${NAMED}`, oid]); const before = readState(ws);
    const result = run(ws, ['newest', '--plan', getPlan()]); assert.equal(result.code, REFUSE, result.stderr);
    assert.match(result.stderr, matchName('sequence')); assert.deepEqual(readState(ws), before);
  });
});

describe('restore convergence — spec:checkpoint/S5', () => {
  for (const verb of ['checkout-index', 'write-tree']) it(`converges after interruption at ${verb}`, () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED); put(ws, EXTRA);
    const io = spyIO((args, calls) => { if (args[0] === verb && calls.filter((call) => call.args[0] === verb).length === 1) throw new Error('interrupted'); });
    const result = run(ws, ['restore', oid], io);
    assert.equal(result.code, REFUSE, result.stderr); assert.doesNotMatch(result.stdout, /\bproof\b/);
    assert.ok(io.calls.some(({ args }) => args[0] === verb)); assertRemoved(io.calls);
    prove(ws, oid); assertTarget(ws, oid); assert.equal(existsSync(join(ws.cwd, EXTRA)), false); assertClean(ws, oid);
  });
  it('converges from materialized targets with extras still present', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, EXTRA); assertTarget(ws, oid);
    prove(ws, oid); assert.equal(existsSync(join(ws.cwd, EXTRA)), false); assertClean(ws, oid);
  });
  it('names both oids on an ignore-domain proof mismatch and converges on the next restore', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, IGNORE, `${EXTRA}\n`); put(ws, EXTRA);
    const io = spyIO(); const result = run(ws, ['restore', oid], io);
    assert.equal(result.code, REFUSE, result.stderr); assert.equal(existsSync(join(ws.cwd, EXTRA)), true);
    assertTarget(ws, oid); assertRemoved(io.calls);
    const recomputed = mint(ws, ALPHA, 1); assert.notEqual(recomputed, oid);
    for (const tree of [oid, recomputed]) assert.match(result.stderr, new RegExp(`\\b${tree}\\b`));
    assert.doesNotMatch(result.stdout, /\bproof\b/); assert.doesNotMatch(result.stderr, new RegExp(`\\bproof\\s+${oid}\\b`));
    prove(ws, oid); assert.equal(existsSync(join(ws.cwd, EXTRA)), false); assertClean(ws, oid);
  });
  it('restores an ignored deliverable through the positive scope', () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, HIDDEN_PATH, CHANGED); prove(ws, oid);
    assert.equal(readFileSync(join(ws.cwd, HIDDEN_PATH), 'utf8'), INITIAL);
  });
  it('unlinks an extra symlink without traversing its target directory', () => {
    const ws = makeRepo(); put(ws, CHILD); const oid = mint(ws); symlinkSync(PARENT, join(ws.cwd, LINK));
    prove(ws, oid); assert.equal(readNode(join(ws.cwd, LINK)), null); assertTarget(ws, oid);
  });
});

describe('restore pre-write refusals and dispatch order — spec:checkpoint/S6', () => {
  for (const held of ['target', 'same-sequence', 'shared-sequence']) it(`refuses an open thread in the held set: ${held}`, () => {
    const ws = makeRepo(); const oid = mint(ws);
    if (held === 'shared-sequence') { put(ws, getPlan(BETA), PLAN_TITLE); assert.equal(mint(ws, BETA), oid); }
    if (held !== 'target') put(ws, BASE, CHANGED);
    const base = held === 'target' ? oid : mint(ws, held === 'same-sequence' ? ALPHA : BETA, 1);
    openThread(ws, base); refuse(ws, oid, 'open-thread', NONCE); closeThread(ws); prove(ws, oid);
  });
  for (const outcome of ['success', 'acceptance-failure']) it(`keeps a non-terminal ${outcome} return open until closure`, () => {
    const ws = makeRepo(); const oid = mint(ws); const { contract } = openThread(ws, oid);
    put(ws, BASE, CHANGED); returnThread(ws, contract, outcome); refuse(ws, oid, 'open-thread', NONCE);
    closeThread(ws, outcome === 'success'); prove(ws, oid);
  });
  for (const base of ['disjoint', 'head']) it(`proceeds with an open thread on a ${base} base`, () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED);
    if (base === 'disjoint') { put(ws, getPlan(BETA), PLAN_TITLE); const other = mint(ws, BETA); assert.notEqual(other, oid); openThread(ws, other); }
    else openThread(ws, null);
    prove(ws, oid); assertClean(ws, oid);
  });
  for (const state of ['malformed', 'unreadable']) it(`refuses a ${state} ledger before writes`, () => {
    const ws = makeRepo(); const oid = mint(ws); put(ws, BASE, CHANGED);
    if (state === 'malformed') put(ws, join('.git', DELEGATION_STORE_BASENAME), '{malformed\n');
    else mkdirSync(ws.store);
    refuse(ws, oid, 'ledger');
  });
  it('proceeds over an absent ledger with exactly the retry proof line', () => {
    const ws = makeRepo(); const oid = mint(ws); assert.equal(existsSync(ws.store), false); put(ws, BASE, CHANGED);
    prove(ws, oid); assertClean(ws, oid);
  });
  for (const type of ['commit', 'blob', 'unresolvable']) it(`refuses a ${type} target through the tree proof before writes`, () => {
    const ws = makeRepo(); put(ws, BASE, CHANGED);
    const oid = type === 'unresolvable' ? UNKNOWN : sh(ws, ['rev-parse', type === 'commit' ? 'HEAD' : `HEAD:${BASE}`]);
    refuse(ws, oid, type === 'unresolvable' ? /unresolvable/ : new RegExp(`names a ${type}, not a tree`));
  });
  for (const path of ['docs/plans/x', 'sub/.git/x', 'sub', null]) it(`refuses target-scope for ${path ?? 'an unreferenced tree'}`, () => {
    const ws = makeRepo(); put(ws, BASE, CHANGED);
    const oid = path === 'sub' ? makeTree(ws, path, '160000', 'commit', sh(ws, ['rev-parse', 'HEAD'])) : makeTree(ws, path ?? BASE);
    if (path) sh(ws, ['update-ref', `${PREFIX}${ALPHA}/0`, oid]);
    refuse(ws, oid, 'target-scope', path);
  });
  for (const kind of ['empty-directory', 'nonempty-directory', 'symlink-directory', 'parent-file', 'parent-symlink']) it(`refuses type-conflict for ${kind}`, () => {
    const ws = makeRepo(); put(ws, CHILD);
    if (kind === 'symlink-directory') symlinkSync(BASE, join(ws.cwd, LINK));
    const oid = mint(ws);
    const path = kind.startsWith('parent-') ? PARENT : kind === 'symlink-directory' ? LINK : BASE;
    rmSync(join(ws.cwd, path), { recursive: true });
    if (kind === 'parent-file') put(ws, path);
    else if (kind === 'parent-symlink') symlinkSync('docs/ai', join(ws.cwd, path));
    else { mkdirSync(join(ws.cwd, path)); if (kind === 'nonempty-directory') put(ws, `${path}/x`); }
    refuse(ws, oid, 'type-conflict', path);
  });
  it('restores a degraded acceptance failure before opening its retry on the same clean checkpoint', () => {
    const ws = makeRepo(); const oid = mint(ws); const { contract } = openThread(ws, oid);
    put(ws, BASE, CHANGED); returnThread(ws, contract, 'acceptance-failure'); closeThread(ws);
    const proof = prove(ws, oid); assertClean(ws, oid);
    const { result } = openThread(ws, oid, { retry: true, rationale: proof.trimEnd() });
    assert.match(result.stdout, new RegExp(`baseline CLEAN against checkpoint ${oid}`));
  });
  it('opens a CLEAN checkpoint baseline even when uncommitted bytes are DIRTY against HEAD', () => {
    const ws = makeRepo(); put(ws, BASE, CHANGED); const oid = mint(ws);
    assert.notEqual(sh(ws, ['diff', 'HEAD', '--', BASE]), '');
    assert.match(openThread(ws, oid).result.stdout, new RegExp(`baseline CLEAN against checkpoint ${oid}`));
  });
});
