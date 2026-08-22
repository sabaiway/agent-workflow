// mcp.test.mjs — the guarded registration WRITER: `.mcp.json` first, then `.claude/settings.json`,
// merge-don't-clobber, and a refusal wherever consent could slide past something unexamined.
//
// The module is loaded by DYNAMIC import for the same two reasons as its read-only sibling's suite:
// the tests are authored first, and `core-evidence red-proof` refuses a test file that cannot LOAD.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENABLED_KEY, MCP_JSON_REL, SERVERS_KEY, SERVER_NAME, SETTINGS_REL, allowRulesFor, readRegistration } from './mcp-registration.mjs';

const load = () => import('./mcp.mjs');

const SERVER_PATH = '/opt/kit/agent-workflow-kit/tools/mcp-server.mjs';
const ENTRY = { type: 'stdio', command: 'node', args: [SERVER_PATH] };
const io = { serverPath: SERVER_PATH };

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-writer-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const writeJson = (abs, value, eol = '\n') => {
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2).replaceAll('\n', eol)}${eol}`, 'utf8');
};
const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'));
const mcpAbs = (root) => join(root, MCP_JSON_REL);
const settingsAbs = (root) => join(root, SETTINGS_REL);
const registeredEntry = { [SERVERS_KEY]: { [SERVER_NAME]: ENTRY } };
const registeredSettings = { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } };

// writeContainedFileAtomic publishes by rename, so the destination order IS the write order.
// `failOn` injects the failure that matters: settings dying after `.mcp.json` already stands.
// Injected rather than created: a real device node needs mknod, and a conditional arm would go
// vacuously green exactly where masks happen.
const STAT_PROBES = ['isCharacterDevice', 'isBlockDevice', 'isFIFO', 'isSocket', 'isSymbolicLink', 'isDirectory', 'isFile'];
const maskedStat = () => Object.fromEntries(STAT_PROBES.map((probe) => [probe, () => probe === 'isCharacterDevice']));

// assert.throws never hands back the error, and these arms are about WHICH refusal fired.
const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const recorder = (failOn = null) => {
  const order = [];
  const rename = (tmp, dst) => {
    order.push(dst);
    if (failOn !== null && dst.endsWith(failOn)) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    renameSync(tmp, dst);
  };
  return { order, rename };
};

describe('writeMcp — the guarded registration writer', () => {
  it('dry-run is the DEFAULT and writes nothing at all', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const r = writeMcp({ cwd: root }, io);
      assert.equal(r.dryRun, true);
      assert.equal(r.wrote, false);
      assert.equal(existsSync(mcpAbs(root)), false);
      assert.equal(existsSync(join(root, '.claude')), false, 'the preflight is READ-ONLY — it never creates .claude/');
    });
  });

  it('the dry-run report prints the EXACT entry, so consent is given over what will be written', async () => {
    const { writeMcp, formatResult } = await load();
    await withRoot((root) => {
      const report = formatResult(writeMcp({ cwd: root }, io));
      assert.match(report, /DRY RUN/u);
      assert.ok(report.includes(SERVER_PATH), 'the report carries the absolute server path');
      assert.ok(report.includes('"type": "stdio"'), 'and the entry itself, not a description of it');
      for (const rule of allowRulesFor()) assert.ok(report.includes(rule), `the report names the allow rule ${rule}`);
    });
  });

  it('apply creates the .mcp.json entry and both settings keys', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const r = writeMcp({ cwd: root, dryRun: false }, io);
      assert.equal(r.wrote, true);
      assert.deepEqual(readJson(mcpAbs(root))[SERVERS_KEY][SERVER_NAME], ENTRY);
      const settings = readJson(settingsAbs(root));
      assert.deepEqual(settings[ENABLED_KEY], [SERVER_NAME]);
      assert.deepEqual(settings.permissions.allow, allowRulesFor());
      assert.equal(readRegistration(root, io).registered, true);
    });
  });

  it('apply writes .mcp.json BEFORE .claude/settings.json', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const rec = recorder();
      writeMcp({ cwd: root, dryRun: false }, { ...io, rename: rec.rename });
      assert.deepEqual(rec.order, [mcpAbs(root), settingsAbs(root)]);
    });
  });

  it('a settings write that fails leaves the .mcp.json write STANDING and fails loud', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const rec = recorder('settings.json');
      assert.throws(() => writeMcp({ cwd: root, dryRun: false }, { ...io, rename: rec.rename }), /EIO/u);
      assert.deepEqual(readJson(mcpAbs(root))[SERVERS_KEY][SERVER_NAME], ENTRY, 'the completed write is not rolled back');
      assert.equal(existsSync(settingsAbs(root)), false, 'and the failed one left nothing behind');
      // The next run converges: it sees .mcp.json as already-current and writes only the settings.
      const again = writeMcp({ cwd: root, dryRun: false }, io);
      assert.equal(again.wrote, true);
      assert.equal(readRegistration(root, io).registered, true);
    });
  });

  it('an existing CRLF file keeps its EOL', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      writeJson(mcpAbs(root), { [SERVERS_KEY]: {} }, '\r\n');
      writeMcp({ cwd: root, dryRun: false }, io);
      assert.ok(readFileSync(mcpAbs(root), 'utf8').includes('\r\n'), 'the CRLF file stays CRLF');
      assert.equal(readFileSync(settingsAbs(root), 'utf8').includes('\r\n'), false, 'and a NEW file gets LF');
    });
  });

  it('merge-don\'t-clobber: a foreign server, a foreign key and a foreign allow rule all survive', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      writeJson(mcpAbs(root), { [SERVERS_KEY]: { other: { type: 'stdio', command: 'node', args: ['x.mjs'] } }, note: 'mine' });
      writeJson(settingsAbs(root), { includeCoAuthoredBy: false, permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } });
      writeMcp({ cwd: root, dryRun: false }, io);
      const mcp = readJson(mcpAbs(root));
      assert.deepEqual(mcp[SERVERS_KEY].other.args, ['x.mjs']);
      assert.equal(mcp.note, 'mine');
      const settings = readJson(settingsAbs(root));
      assert.equal(settings.includeCoAuthoredBy, false);
      assert.deepEqual(settings.permissions.deny, ['Bash(rm:*)']);
      assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)', ...allowRulesFor()]);
    });
  });

  // The scope limit, pinned where the WRITER would have consulted it. The deny-list check was built
  // during review and subtracted; what must not drift is that this mode neither reads it nor claims
  // anything about it — see the leaf's header for why a half-built veto was worse than a stated one.
  it('fold: an unreadable deny list withholds certification NOWHERE — the writer never consults one', async () => {
    const { writeMcp, MCP_DISABLED } = await load();
    assert.equal(MCP_DISABLED, undefined, 'no refusal code exists for a state this mode does not detect');
    const { formatResult } = await load();
    await withRoot((root) => {
      writeJson(mcpAbs(root), registeredEntry);
      writeJson(settingsAbs(root), { ...registeredSettings, disabledMcpjsonServers: 'all' });
      const r = writeMcp({ cwd: root, dryRun: false }, io);
      assert.equal(r.wrote, false, 'everything this mode writes is in place');
      assert.match(formatResult(r), /already registered/u, 'and it says exactly that, no more');
    });
  });

  it('re-apply is idempotent — the second run writes nothing and duplicates no rule', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      writeMcp({ cwd: root, dryRun: false }, io);
      const rec = recorder();
      const again = writeMcp({ cwd: root, dryRun: false }, { ...io, rename: rec.rename });
      assert.equal(again.wrote, false);
      assert.deepEqual(rec.order, [], 'nothing was published at all');
      assert.deepEqual(readJson(settingsAbs(root)).permissions.allow, allowRulesFor());
    });
  });

  it('an already-registered project reports already-current on a flagless run', async () => {
    const { writeMcp, formatResult } = await load();
    await withRoot((root) => {
      writeJson(mcpAbs(root), registeredEntry);
      writeJson(settingsAbs(root), registeredSettings);
      const r = writeMcp({ cwd: root }, io);
      assert.equal(r.plan.writeMcpJson, false);
      assert.equal(r.plan.writeSettings, false);
      assert.match(formatResult(r), /already registered/u);
    });
  });

  it('differs: a same-NAME entry with different bytes is refused UNWRITTEN, on dry-run and on apply', async () => {
    const { writeMcp, MCP_DIFFERS } = await load();
    await withRoot((root) => {
      const foreign = { type: 'stdio', command: 'node', args: ['/elsewhere/mcp-server.mjs'] };
      writeJson(mcpAbs(root), { [SERVERS_KEY]: { [SERVER_NAME]: foreign } });
      for (const dryRun of [true, false]) {
        assert.throws(() => writeMcp({ cwd: root, dryRun }, io), (err) => err.code === MCP_DIFFERS, `dryRun=${dryRun}`);
      }
      assert.deepEqual(readJson(mcpAbs(root))[SERVERS_KEY][SERVER_NAME], foreign, 'the existing entry is untouched');
      assert.equal(existsSync(settingsAbs(root)), false);
    });
  });

  it('masked: nothing is written, BOTH paste-ready fragments are handed over, and the run succeeds', async () => {
    const { writeMcp, formatResult } = await load();
    await withRoot((root) => {
      // Delegate for every OTHER path: a blanket ENOENT would answer for the project root too.
      const masked = { ...io, lstat: (path, ...rest) => (path === mcpAbs(root) ? maskedStat() : lstatSync(path, ...rest)) };
      const r = writeMcp({ cwd: root, dryRun: false }, masked);
      assert.equal(r.masked, true);
      assert.equal(r.wrote, false);
      assert.equal(existsSync(mcpAbs(root)), false);
      const report = formatResult(r);
      assert.match(report, /HAND-APPLY/u);
      assert.ok(report.includes(SERVER_PATH) && report.includes(ENABLED_KEY), 'both fragments are in the report');
      assert.ok(report.includes(MCP_JSON_REL) && report.includes(SETTINGS_REL), 'each named with the file it belongs to');
    });
  });

  // The handoff is scoped to `.mcp.json`. Reached for either target and taken before every other
  // refusal, it turned two mandatory STOPs into a successful hand-apply.
  it('fold: a masked settings.json is a REFUSAL — the handoff is scoped to .mcp.json alone', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const masked = { ...io, lstat: (p, ...rest) => (p === settingsAbs(root) ? maskedStat() : lstatSync(p, ...rest)) };
      const err = caught(() => writeMcp({ cwd: root, dryRun: false }, masked));
      assert.ok(err, 'a file this mode cannot read and has no sanctioned handoff for is a refusal');
      assert.equal(existsSync(mcpAbs(root)), false, 'zero writes');
    });
  });

  it('fold: a mask never suppresses another surface\'s refusal — every observable STOP is decided first', async () => {
    const { writeMcp, MCP_MALFORMED, MCP_SYMLINK } = await load();
    // (a) masked settings.json beside a DIFFERING entry: the unwritable surface is decided first.
    await withRoot((root) => {
      writeJson(mcpAbs(root), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/elsewhere.mjs'] } } });
      const masked = { ...io, lstat: (p, ...rest) => (p === settingsAbs(root) ? maskedStat() : lstatSync(p, ...rest)) };
      const err = caught(() => writeMcp({ cwd: root, dryRun: false }, masked));
      assert.equal(err?.code, MCP_SYMLINK, err?.message ?? 'a masked success instead of a refusal');
    });
    // (b) a masked .mcp.json beside a MALFORMED settings.json: the handoff may not proceed over a file
    // whose content was never understood.
    await withRoot((root) => {
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(settingsAbs(root), '{ not json', 'utf8');
      const masked = { ...io, lstat: (p, ...rest) => (p === mcpAbs(root) ? maskedStat() : lstatSync(p, ...rest)) };
      const err = caught(() => writeMcp({ cwd: root, dryRun: false }, masked));
      assert.equal(err?.code, MCP_MALFORMED, err?.message ?? 'a masked success instead of a refusal');
    });
  });

  // Behind a mask the kit cannot see what the file holds, so a whole-file body pasted as instructed
  // would delete every foreign server it was never able to read.
  it('fold: the masked handoff hands over the ENTRY to merge, never a whole-file body', async () => {
    const { writeMcp, formatResult } = await load();
    await withRoot((root) => {
      const masked = { ...io, lstat: (p, ...rest) => (p === mcpAbs(root) ? maskedStat() : lstatSync(p, ...rest)) };
      const report = formatResult(writeMcp({ cwd: root, dryRun: false }, masked));
      assert.match(report, /HAND-APPLY/u);
      assert.ok(report.includes(SERVER_PATH) && report.includes(SERVER_NAME), 'the entry itself is handed over');
      assert.match(report, /merge/iu, 'the instruction is a MERGE');
      assert.match(report, /keep every other server/iu, 'and it says so about what the kit cannot see');
      assert.doesNotMatch(report, /paste into/iu, 'a paste-the-whole-file instruction IS the clobber');
    });
  });

  it('a symlinked .mcp.json is a STOP with zero writes — the link target is never followed', async () => {
    const { writeMcp, MCP_SYMLINK } = await load();
    await withRoot((root) => {
      writeJson(join(root, 'real.json'), registeredEntry);
      symlinkSync(join(root, 'real.json'), mcpAbs(root));
      assert.throws(() => writeMcp({ cwd: root, dryRun: false }, io), (err) => err.code === MCP_SYMLINK);
      assert.equal(existsSync(settingsAbs(root)), false);
    });
  });

  // Refused only by the atomic write, which runs AFTER the dir gate has already mkdir'd `.claude`
  // through the link — with `.mcp.json` current that mkdir was the FIRST mutation.
  it('fold: a symlinked project root is refused BEFORE anything is created', async () => {
    const { writeMcp, MCP_SYMLINK } = await load();
    await withRoot((real) => {
      const linkParent = mkdtempSync(join(tmpdir(), 'mcp-linked-'));
      const root = join(linkParent, 'project');
      try {
        symlinkSync(real, root);
        writeJson(join(real, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: ENTRY } });
        // The refusal must come BEFORE the registration is read: a root that is already foreign is
        // never followed, and reading through it first would contradict exactly that shipped claim.
        // The open is COUNTED rather than asserted inside — the reader wraps it in try/catch, so an
        // assertion thrown from the injected primitive is swallowed and the test passes over nothing.
        let opened = 0;
        const counting = { ...io, open: (...args) => { opened += 1; return openSync(...args); } };
        assert.throws(() => writeMcp({ cwd: root, dryRun: false }, counting), (err) => err.code === MCP_SYMLINK);
        assert.equal(opened, 0, 'no target was opened through a symlinked root');
        assert.equal(existsSync(join(real, '.claude')), false, 'no directory was created through the link');
      } finally {
        rmSync(linkParent, { recursive: true, force: true });
      }
    });
  });

  it('a --cwd that does not exist, or names a file, is refused on BOTH lanes', async () => {
    const { writeMcp, MCP_SYMLINK } = await load();
    await withRoot((root) => {
      const file = join(root, 'a-file');
      writeFileSync(file, 'x', 'utf8');
      for (const target of [join(root, 'no-such-dir'), file]) {
        for (const dryRun of [true, false]) {
          assert.throws(() => writeMcp({ cwd: target, dryRun }, io), (err) => err.code === MCP_SYMLINK, `${target} dryRun=${dryRun}`);
        }
      }
    });
  });

  it('a non-ENOENT lstat failure on the root PROPAGATES — never read as an absent project', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const denied = { ...io, lstat: (p, ...rest) => { if (p === root) throw eacces; return lstatSync(p, ...rest); } };
      assert.throws(() => writeMcp({ cwd: root }, denied), (err) => err.code === 'EACCES', 'fail closed, never "the project is not there"');
    });
  });

  it('a symlinked .claude is a STOP with zero writes', async () => {
    const { writeMcp, MCP_SYMLINK } = await load();
    await withRoot((root) => {
      mkdirSync(join(root, 'elsewhere'));
      symlinkSync(join(root, 'elsewhere'), join(root, '.claude'));
      assert.throws(() => writeMcp({ cwd: root, dryRun: false }, io), (err) => err.code === MCP_SYMLINK);
      assert.equal(existsSync(mcpAbs(root)), false, 'the STOP precedes the FIRST write, not just the settings one');
    });
  });

  it('malformed JSON in either target is a STOP with zero writes', async () => {
    const { writeMcp, MCP_MALFORMED } = await load();
    for (const rel of [MCP_JSON_REL, SETTINGS_REL]) {
      await withRoot((root) => {
        mkdirSync(join(root, '.claude'), { recursive: true });
        writeFileSync(join(root, rel), '{ not json', 'utf8');
        assert.throws(() => writeMcp({ cwd: root, dryRun: false }, io), (err) => err.code === MCP_MALFORMED, rel);
        assert.equal(existsSync(rel === MCP_JSON_REL ? settingsAbs(root) : mcpAbs(root)), false, rel);
      });
    }
  });

  it('an UNREADABLE target or .claude is a STOP — the kit never overwrites what it never read', async () => {
    const { writeMcp, MCP_MALFORMED } = await load();
    await withRoot((root) => {
      for (const rel of [MCP_JSON_REL, '.claude']) {
        const denied = {
          ...io,
          lstat: (path, ...rest) => {
            if (path === join(root, rel)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            return lstatSync(path, ...rest); // the project root must still answer for itself
          },
        };
        assert.throws(() => writeMcp({ cwd: root, dryRun: false }, denied), (err) => err.code === MCP_MALFORMED, rel);
        assert.equal(existsSync(mcpAbs(root)), false, `${rel}: zero writes`);
      }
    });
  });

  it('never settings.local.json — an apply leaves it exactly as it was', async () => {
    const { writeMcp } = await load();
    await withRoot((root) => {
      const local = join(root, '.claude/settings.local.json');
      writeJson(local, { permissions: { allow: ['Bash(git status:*)'] } });
      const before = readFileSync(local, 'utf8');
      writeMcp({ cwd: root, dryRun: false }, io);
      assert.equal(readFileSync(local, 'utf8'), before);
    });
  });

  it('usage: the two mode flags conflict, an unknown flag is rejected, --help succeeds', async () => {
    const { main } = await load();
    const sink = { log: () => {}, errlog: () => {} };
    assert.equal(main(['--dry-run', '--apply'], sink), 2);
    assert.equal(main(['--nope'], sink), 2);
    assert.equal(main(['--cwd'], sink), 2);
    assert.equal(main(['--help'], sink), 0);
    // An EMPTY --cwd passed both guards (not undefined, does not start with `-`) and resolve('')
    // silently means the process cwd — so an explicit target of "" wrote the registration into
    // whatever directory the tool happened to run in.
    assert.equal(main(['--cwd', ''], sink), 2, 'an explicitly empty target is a usage error, never the cwd');
    assert.equal(main(['--apply', '--cwd', '   '], sink), 2, 'and neither is whitespace');
  });
});

describe('acceptance — the mode end to end, through its own CLI', () => {
  it('acceptance: preview writes nothing, apply registers, and a re-run reports it registered', async () => {
    const { main } = await load();
    await withRoot((root) => {
      const out = [];
      const deps = { ...io, log: (line) => out.push(line), errlog: (line) => out.push(line) };

      assert.equal(main(['--cwd', root], deps), 0, 'the flagless preview succeeds');
      assert.equal(existsSync(mcpAbs(root)), false, 'and writes nothing');
      assert.match(out.join('\n'), /re-run with --apply/u, 'the preview names the exact next step');

      out.length = 0;
      assert.equal(main(['--apply', '--cwd', root], deps), 0);
      assert.equal(readRegistration(root, io).registered, true, 'the project is now registered');

      out.length = 0;
      assert.equal(main(['--cwd', root], deps), 0);
      assert.match(out.join('\n'), /already registered/u, 'and the re-run says so instead of offering the write again');
    });
  });
});
