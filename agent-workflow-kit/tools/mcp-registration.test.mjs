// mcp-registration.test.mjs — the READ-ONLY registration leaf: what does THIS project's
// .mcp.json + .claude/settings.json say about the kit's stdio MCP server?
//
// The module is loaded by DYNAMIC import in every test. Two reasons, both load-bearing: the suite is
// authored before the module exists, and `core-evidence red-proof` REFUSES a test file that cannot
// LOAD — a static import would make the observed red a module-resolution error instead of a failing
// assertion. It also keeps each arm's failure local to the arm.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_NAME, TOOLS } from './mcp-server.mjs';
import { CLAUDE_DIR, SETTINGS_FILE } from './velocity-profile.mjs';

const load = () => import('./mcp-registration.mjs');

const SERVER_PATH = '/opt/kit/agent-workflow-kit/tools/mcp-server.mjs';
const io = { serverPath: SERVER_PATH };

const withRoot = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const writeJson = (abs, value, eol = '\n') => {
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2).replaceAll('\n', eol)}${eol}`, 'utf8');
};

// The never-committable classes are INJECTED rather than created: a real one needs a privilege this
// suite must not assume (mknod), a socket bind is refused outright under an OS sandbox, and a
// conditional arm would go vacuously green exactly where the masks actually happen. The
// classification is lstat-keyed BY DESIGN, so an injected stat exercises the whole decision.
//
// What the injected `open` proves is bounded, and the bound is the honest part: for a path whose
// class is DECIDED, no open happens. It cannot speak for a path SWAPPED between the lstat and the
// open — see the residual in the module header, which this arm deliberately does not claim to close.
const NEVER_COMMITTABLE = ['isCharacterDevice', 'isBlockDevice', 'isFIFO', 'isSocket'];
const maskStat = (kind) =>
  Object.fromEntries(
    [...NEVER_COMMITTABLE, 'isSymbolicLink', 'isDirectory', 'isFile'].map((probe) => [probe, () => probe === kind]),
  );
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('readRegistration — the registration facts of one project', () => {
  it('derives the allow rules from the SERVER\'s own TOOLS, never a re-typed list', async () => {
    const { allowRulesFor, SERVER_NAME: reExported } = await load();
    assert.equal(reExported, SERVER_NAME, 'the leaf re-exports the server name rather than re-typing it');
    assert.deepEqual(allowRulesFor(), TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`));
    // Non-vacuity from the other side: a DIFFERENT tool list produces different rules, so the
    // derivation really reads its argument instead of returning a constant.
    assert.deepEqual(allowRulesFor([{ name: 'zzz' }]), [`mcp__${SERVER_NAME}__zzz`]);
  });

  it('builds the stdio entry from the RUNNING kit\'s server path', async () => {
    const { buildServerEntry, DEFAULT_SERVER_PATH } = await load();
    assert.deepEqual(buildServerEntry(SERVER_PATH), { type: 'stdio', command: 'node', args: [SERVER_PATH] });
    assert.match(DEFAULT_SERVER_PATH, /tools[/\\]mcp-server\.mjs$/u, 'the default is this kit copy\'s own absolute server path');
  });

  it('the settings paths match the velocity writer\'s — the leaf may not import that writer, so the literals are pinned equal here', async () => {
    const { SETTINGS_REL, CLAUDE_DIR_REL } = await load();
    assert.equal(SETTINGS_REL, SETTINGS_FILE);
    assert.equal(CLAUDE_DIR_REL, CLAUDE_DIR);
  });

  // ── the .mcp.json arms ────────────────────────────────────────────────────────────────

  it('absent: both targets missing reads as absent, registered=false, and nothing throws', async () => {
    const { readRegistration, STATE } = await load();
    withRoot((root) => {
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.state, STATE.ABSENT);
      assert.equal(r.settings.state, STATE.ABSENT);
      assert.equal(r.mcpJson.existing, null);
      assert.equal(r.mcpJson.differs, false);
      assert.deepEqual(r.settings.allowMissing, r.allowRules);
      assert.equal(r.registered, false);
    });
  });

  it('same: our exact entry plus the enabled key and both rules reads as registered', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, SETTINGS_REL, ENABLED_KEY, SERVERS_KEY, allowRulesFor } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER_PATH] } } });
      writeJson(join(root, SETTINGS_REL), { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } });
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.state, STATE.PRESENT);
      assert.equal(r.mcpJson.matches, true);
      assert.equal(r.mcpJson.differs, false);
      assert.equal(r.settings.enabled, true);
      assert.deepEqual(r.settings.allowMissing, []);
      assert.equal(r.registered, true);
    });
  });

  it('differs: a same-NAME entry with different bytes is reported as differing, never as registered', async () => {
    const { readRegistration, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: ['/somewhere/else/mcp-server.mjs'] } } });
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.matches, false);
      assert.equal(r.mcpJson.differs, true);
      assert.deepEqual(r.mcpJson.existing.args, ['/somewhere/else/mcp-server.mjs']);
      assert.equal(r.registered, false);
    });
  });

  it('differs: an entry carrying an EXTRA key differs even with the same command and args', async () => {
    const { readRegistration, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER_PATH], env: { A: '1' } } } });
      assert.equal(readRegistration(root, io).mcpJson.differs, true);
    });
  });

  // The presence test is hasOwnProperty, NOT `value !== null`: a key that is THERE is a declaration
  // we may refuse but never overwrite, whatever it holds. Using null as the absence sentinel let a
  // literal `"agent-workflow": null` be silently replaced — the DIFFERING refusal skipped entirely.
  it('fold: a same-NAME entry holding null, or any non-matching value, is DIFFERING — never absent', async () => {
    const { readRegistration, MCP_JSON_REL, SERVERS_KEY } = await load();
    for (const value of [null, 'a-string', 42, [], {}, false]) {
      withRoot((root) => {
        writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: value } });
        const r = readRegistration(root, io);
        const label = JSON.stringify(value) ?? 'null';
        assert.equal(r.mcpJson.matches, false, label);
        assert.equal(r.mcpJson.differs, true, `${label}: the KEY is present, so the entry is ours to refuse, never ours to replace`);
      });
    }
  });

  // A managed key of the wrong TYPE was read as an empty container and then merged over, which
  // DESTROYED whatever it held. The kit already answers this class one way (gate-hook STOPs on a
  // malformed `hooks` shape rather than merging through it) — this is that same posture.
  it('fold: a MANAGED key of the wrong type is MALFORMED — foreign data is never merged away', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, SETTINGS_REL, SERVERS_KEY, ENABLED_KEY } = await load();
    const cases = [
      [MCP_JSON_REL, { [SERVERS_KEY]: [{ mine: true }] }],
      [MCP_JSON_REL, { [SERVERS_KEY]: 'everything' }],
      [SETTINGS_REL, { [ENABLED_KEY]: 'all' }],
      [SETTINGS_REL, { permissions: 'none' }],
      [SETTINGS_REL, { permissions: { allow: { a: 1 } } }],
    ];
    for (const [rel, body] of cases) {
      withRoot((root) => {
        writeJson(join(root, rel), body);
        const target = rel === MCP_JSON_REL ? readRegistration(root, io).mcpJson : readRegistration(root, io).settings;
        assert.equal(target.state, STATE.MALFORMED, JSON.stringify(body));
        assert.ok(target.reason.length > 0, `${JSON.stringify(body)}: the refusal names what it could not accept`);
      });
    }
  });

  it('fold: a FOREIGN key of ANY shape is never judged — only the four managed keys are', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: {}, whatever: [1, 2, 3], other: 'text', nested: { deep: null } });
      assert.equal(readRegistration(root, io).mcpJson.state, STATE.PRESENT, 'a foreign key is data, not a shape this mode owns');
    });
  });

  it('a FOREIGN server name in .mcp.json is preserved as foreign data and does not register us', async () => {
    const { readRegistration, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { other: { type: 'stdio', command: 'node', args: ['x.mjs'] } } });
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.existing, null);
      assert.equal(r.mcpJson.differs, false);
      assert.deepEqual(Object.keys(r.mcpJson.data[SERVERS_KEY]), ['other']);
    });
  });

  it('masked: every never-committable dirent is a NAMED state — never read, never parsed, never absent', async () => {
    const { readRegistration, STATE, MCP_JSON_REL } = await load();
    withRoot((root) => {
      for (const kind of NEVER_COMMITTABLE) {
        const masked = {
          ...io,
          lstat: (path) => {
            if (path === join(root, MCP_JSON_REL)) return maskStat(kind);
            throw enoent();
          },
          open: () => assert.fail(`${kind}: a target whose class was DECIDED must not be opened`),
        };
        const r = readRegistration(root, masked);
        assert.equal(r.mcpJson.state, STATE.MASKED, kind);
        assert.equal(r.mcpJson.data, undefined, `${kind}: a masked target is never parsed`);
        assert.equal(r.registered, false, kind);
      }
    });
  });

  // Path resolution follows an INTERMEDIATE symlink — `O_NOFOLLOW` guards the final component only —
  // so reading the leaf before classifying its container pulled a file from outside the work tree
  // into memory, and into a verdict. The container is classified FIRST for exactly that reason.
  it('fold: a symlinked .claude is classified BEFORE settings is read — nothing outside the tree is read', async () => {
    const { readRegistration, STATE, CLAUDE_DIR_REL, ENABLED_KEY, allowRulesFor } = await load();
    const outside = mkdtempSync(join(tmpdir(), 'mcp-outside-'));
    try {
      // A PERFECT registration, sitting outside the project. Following the link would report it.
      writeJson(join(outside, 'settings.json'), { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } });
      withRoot((root) => {
        symlinkSync(outside, join(root, CLAUDE_DIR_REL));
        const r = readRegistration(root, io);
        assert.equal(r.claudeDir.state, STATE.FOREIGN);
        assert.equal(r.settings.state, STATE.UNREADABLE, 'a file inside a foreign container is never read');
        assert.match(r.settings.reason, /refusing to read through it/u, 'and the refusal names why');
        assert.equal(r.settings.enabled, false, 'so it never contributes a verdict');
        assert.equal(r.settings.complete, false);
        assert.equal(r.registered, false);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('unreadable: a non-ENOENT lstat failure is a NAMED state on either surface — fail closed, never "absent"', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, CLAUDE_DIR_REL } = await load();
    withRoot((root) => {
      for (const rel of [MCP_JSON_REL, CLAUDE_DIR_REL]) {
        const denied = {
          ...io,
          lstat: (path) => {
            if (path === join(root, rel)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            throw enoent();
          },
        };
        const r = readRegistration(root, denied);
        const surface = rel === MCP_JSON_REL ? r.mcpJson : r.claudeDir;
        assert.equal(surface.state, STATE.UNREADABLE, rel);
        assert.equal(surface.reason, 'EACCES', `${rel}: the refusal carries the real cause`);
        assert.equal(r.registered, false, rel);
      }
    });
  });

  it('symlink: a symlinked target is FOREIGN and is never followed', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      const real = join(root, 'real.json');
      writeJson(real, { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER_PATH] } } });
      symlinkSync(real, join(root, MCP_JSON_REL));
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.state, STATE.FOREIGN);
      assert.equal(r.mcpJson.className, 'symlink');
      // The link TARGET is a perfect registration; following it would report registered over a file
      // the writer must refuse to touch.
      assert.equal(r.mcpJson.matches, false);
      assert.equal(r.registered, false);
    });
  });

  it('malformed: unparseable or non-object JSON is a named state, never an empty object', async () => {
    const { readRegistration, STATE, MCP_JSON_REL, SETTINGS_REL } = await load();
    withRoot((root) => {
      writeFileSync(join(root, MCP_JSON_REL), '{ not json', 'utf8');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, SETTINGS_REL), '[]', 'utf8');
      const r = readRegistration(root, io);
      assert.equal(r.mcpJson.state, STATE.MALFORMED);
      assert.equal(r.settings.state, STATE.MALFORMED);
      assert.ok(r.mcpJson.reason.length > 0, 'the refusal carries its own reason');
      assert.equal(r.registered, false);
    });
  });

  it('a CRLF file keeps its EOL in the read result (the writer re-serializes with it)', async () => {
    const { readRegistration, MCP_JSON_REL, SERVERS_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: {} }, '\r\n');
      assert.equal(readRegistration(root, io).mcpJson.eol, '\r\n');
    });
  });

  // ── the settings arms ─────────────────────────────────────────────────────────────────

  it('a settings file with the enabled key but only ONE rule reports the missing rule by name', async () => {
    const { readRegistration, SETTINGS_REL, ENABLED_KEY, allowRulesFor } = await load();
    withRoot((root) => {
      const [first, second] = allowRulesFor();
      writeJson(join(root, SETTINGS_REL), { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: [first] } });
      const r = readRegistration(root, io);
      assert.equal(r.settings.enabled, true);
      assert.deepEqual(r.settings.allowPresent, [first]);
      assert.deepEqual(r.settings.allowMissing, [second]);
      assert.equal(r.settings.complete, false);
      assert.equal(r.registered, false);
    });
  });

  // The SCOPE limit as a mechanism rather than only as prose. `disabledMcpjsonServers` was honoured
  // during review and then subtracted — see the module header for why — so what must not drift is the
  // claim that goes with it: `registered` means "what this mode writes is in place", and a deny list
  // in ANY scope is simply not consulted. A future reader who re-adds the check will fail here first
  // and go read the reason.
  it('fold: a server named in disabledMcpjsonServers is NOT detected — the limit is stated, not enforced', async () => {
    const { readRegistration, SETTINGS_REL, MCP_JSON_REL, SERVERS_KEY, ENABLED_KEY, DISABLED_KEY, allowRulesFor } = await load();
    assert.equal(DISABLED_KEY, undefined, 'the key is not part of this leaf surface');
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER_PATH] } } });
      writeJson(join(root, SETTINGS_REL), {
        [ENABLED_KEY]: [SERVER_NAME],
        disabledMcpjsonServers: [SERVER_NAME],
        permissions: { allow: allowRulesFor() },
      });
      assert.equal(readRegistration(root, io).registered, true, 'the deny list changes nothing here — that is the documented scope, not an oversight');
    });
  });

  it('fold: a LOCAL deny vetoes NOTHING — settings.local.json is out of scope, by name', async () => {
    const { readRegistration, SETTINGS_REL, SETTINGS_LOCAL_REL, MCP_JSON_REL, SERVERS_KEY, ENABLED_KEY, allowRulesFor } = await load();
    assert.equal(SETTINGS_LOCAL_REL, undefined, 'the local path is not part of this leaf surface at all');
    withRoot((root) => {
      writeJson(join(root, MCP_JSON_REL), { [SERVERS_KEY]: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER_PATH] } } });
      writeJson(join(root, SETTINGS_REL), { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } });
      writeJson(join(root, '.claude/settings.local.json'), { disabledMcpjsonServers: [SERVER_NAME] });
      const r = readRegistration(root, io);
      assert.equal(r.registered, true, 'registered means what this mode WRITES is in place — never that the client will load it');
      assert.equal(r.settings.disabled, undefined, 'no deny fact is computed anywhere');
    });
  });

  it('the enabled key is read as a LIST membership — a foreign server there never enables ours', async () => {
    const { readRegistration, SETTINGS_REL, ENABLED_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, SETTINGS_REL), { [ENABLED_KEY]: ['someone-else'] });
      assert.equal(readRegistration(root, io).settings.enabled, false);
    });
  });

  it('settings.local.json is NEVER read — a rule that lives only there does not register us', async () => {
    const { readRegistration, allowRulesFor, ENABLED_KEY } = await load();
    withRoot((root) => {
      writeJson(join(root, '.claude/settings.local.json'), { [ENABLED_KEY]: [SERVER_NAME], permissions: { allow: allowRulesFor() } });
      const r = readRegistration(root, io);
      assert.equal(r.settings.enabled, false);
      assert.deepEqual(r.settings.allowMissing, r.allowRules);
    });
  });

  // ── the paste-ready fragments (the masked arm's whole output, and uninstall's edit text) ──

  // The two fragments are DIFFERENT shapes on purpose — the settings body is a merge over content
  // that was read, while the .mcp.json fragment is the ENTRY ALONE, because behind a mask nobody
  // here knows what that file already declares.
  it('renderFragments hands over the ENTRY for .mcp.json and a full merge body for settings', async () => {
    const { readRegistration, renderFragments, ENABLED_KEY, SERVERS_KEY, allowRulesFor } = await load();
    withRoot((root) => {
      const fragments = renderFragments(readRegistration(root, io));
      assert.deepEqual(JSON.parse(fragments.mcpEntry), { type: 'stdio', command: 'node', args: [SERVER_PATH] });
      assert.equal(fragments.mcpEntry.includes(SERVERS_KEY), false, 'never a whole-file body — that is what deletes a foreign server');
      const settings = JSON.parse(fragments.settings);
      assert.deepEqual(settings[ENABLED_KEY], [SERVER_NAME]);
      assert.deepEqual(settings.permissions.allow, allowRulesFor());
    });
  });

  it('renderFragments over an EXISTING settings file merges rather than proposing a clobber', async () => {
    const { readRegistration, renderFragments, SETTINGS_REL } = await load();
    withRoot((root) => {
      writeJson(join(root, SETTINGS_REL), { permissions: { allow: ['Bash(ls:*)'] }, includeCoAuthoredBy: false });
      const settings = JSON.parse(renderFragments(readRegistration(root, io)).settings);
      assert.equal(settings.includeCoAuthoredBy, false, 'a foreign key survives the proposed fragment');
      assert.equal(settings.permissions.allow[0], 'Bash(ls:*)', 'and so does a foreign allow rule, in place');
    });
  });
});

// withoutRegistration is the token-removal COMPLEMENT of mergeSettings — not its exact inverse: a
// merge into an empty file leaves managed containers a removal does not take back. For a settings
// copy separated from its launcher. It may remove only our own tokens — never add, never repair.
describe('withoutRegistration — removing exactly our own tokens', () => {
  const rules = (t = TOOLS) => t.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`);
  const pick = (r) => ({ changed: r.changed, hasTokens: r.hasTokens, unreadable: /not readable/u.test(r.reason ?? '') });

  it('drops our enable and our rules, keeps foreign values, keys and NON-INDEX key order', async () => {
    const { withoutRegistration } = await load();
    const before = JSON.stringify({
      includeCoAuthoredBy: false,
      enabledMcpjsonServers: ['someone-else', SERVER_NAME],
      permissions: { defaultMode: 'ask', allow: [rules()[0], 'Bash(ls:*)', rules()[1]] },
    }, null, 2);
    const { text, changed } = withoutRegistration(`${before}\n`);
    assert.equal(changed, true);
    const after = JSON.parse(text);
    assert.deepEqual(after.enabledMcpjsonServers, ['someone-else']);
    assert.deepEqual(after.permissions.allow, ['Bash(ls:*)']);
    assert.equal(after.permissions.defaultMode, 'ask', 'a sibling permission value survives');
    assert.equal(after.includeCoAuthoredBy, false, 'a foreign key survives');
    assert.deepEqual(Object.keys(after), Object.keys(JSON.parse(before)), 'non-index key order is unchanged');
  });

  // The stated exception, pinned so it is a KNOWN limit rather than a surprise: any JSON round-trip
  // hoists integer-like keys to the front — JS object semantics, not something this function does.
  // The fixture is literal TEXT with "zeta" ahead of "7", and the move is asserted in the OUTPUT
  // TEXT: re-parsing the output would hoist the key itself and prove nothing.
  it('an integer-like key is hoisted by the round-trip — the limit is pinned, not claimed away', async () => {
    const { withoutRegistration } = await load();
    const before = `{\n  "zeta": 1,\n  "7": "seven",\n  "enabledMcpjsonServers": ["${SERVER_NAME}"]\n}\n`;
    assert.ok(before.indexOf('"zeta"') < before.indexOf('"7"'), 'sanity: the source really has zeta first');
    const out = withoutRegistration(before).text;
    assert.ok(out.indexOf('"7"') < out.indexOf('"zeta"'), 'the integer-like key moved to the front');
    assert.match(out, /"7": "seven"/u, 'and its VALUE is untouched — only the position moves');
  });

  // Each way a JSON round-trip can LOSE foreign data refuses the rewrite whole — and says so, since
  // the caller must tell "nothing of ours" apart from "ours is here and I refused to touch it".
  const LOSSY = [
    ['a number past double precision', `{"limit":9007199254740993,"enabledMcpjsonServers":["${SERVER_NAME}"]}`, /number would not survive/u],
    ['a duplicate key at the top level', `{"a":1,"a":2,"enabledMcpjsonServers":["${SERVER_NAME}"]}`, /duplicate key/u],
    ['a duplicate key nested deeper', `{"x":{"b":1,"b":2},"enabledMcpjsonServers":["${SERVER_NAME}"]}`, /duplicate key/u],
    ['a duplicate key inside an array element', `{"x":[{"c":1,"c":2}],"enabledMcpjsonServers":["${SERVER_NAME}"]}`, /duplicate key/u],
  ];
  for (const [name, body, reason] of LOSSY) {
    it(`${name} refuses the rewrite entirely, and names why`, async () => {
      const { withoutRegistration } = await load();
      const r = withoutRegistration(body);
      assert.equal(r.text, body, 'untouched, not corrupted');
      assert.equal(r.changed, false);
      assert.equal(r.hasTokens, true, 'the caller can still tell ours IS present');
      assert.match(r.reason, reason);
    });
  }

  it('a quoted digit run and a quoted colon never trip the guards', async () => {
    const { withoutRegistration } = await load();
    const body = `{"note":"9007199254740993","q":"a\\":b","enabledMcpjsonServers":["${SERVER_NAME}"]}`;
    const r = withoutRegistration(body);
    assert.equal(r.changed, true, 'string CONTENT is never read as a number or a key');
    assert.equal(JSON.parse(r.text).note, '9007199254740993');
  });

  it('the four outcomes are distinguishable by hasTokens and reason', async () => {
    const { withoutRegistration } = await load();
    assert.deepEqual(pick(withoutRegistration('not json')), { changed: false, hasTokens: false, unreadable: true });
    assert.deepEqual(pick(withoutRegistration('{}')), { changed: false, hasTokens: false, unreadable: false });
    assert.deepEqual(pick(withoutRegistration(`{"enabledMcpjsonServers":["${SERVER_NAME}"]}`)),
      { changed: true, hasTokens: true, unreadable: false });
  });

  it('never synthesises an allow array the file did not have', async () => {
    const { withoutRegistration } = await load();
    const { text } = withoutRegistration(JSON.stringify({
      enabledMcpjsonServers: [SERVER_NAME], permissions: { defaultMode: 'ask' },
    }, null, 2));
    assert.equal('allow' in JSON.parse(text).permissions, false, 'removing ours never adds foreign content');
  });

  it('keeps CRLF, and returns the input untouched when there is nothing of ours', async () => {
    const { withoutRegistration } = await load();
    const crlf = JSON.stringify({ enabledMcpjsonServers: [SERVER_NAME] }, null, 2).replaceAll('\n', '\r\n');
    assert.match(withoutRegistration(`${crlf}\r\n`).text, /\r\n/u);
    for (const inert of ['not json at all', JSON.stringify({ enabledMcpjsonServers: ['other'] }), '{}']) {
      const r = withoutRegistration(inert);
      assert.equal(r.text, inert, inert.slice(0, 20));
      assert.equal(r.changed, false, inert.slice(0, 20));
      assert.equal(r.hasTokens, false, inert.slice(0, 20));
    }
  });

  it('a wrong-typed managed key is left alone — this never repairs what it did not understand', async () => {
    const { withoutRegistration } = await load();
    const wrong = JSON.stringify({ enabledMcpjsonServers: 'all', permissions: { allow: [rules()[0]] } });
    const r = withoutRegistration(wrong);
    assert.equal(r.text, wrong);
    assert.equal(r.changed, false);
    assert.equal(r.hasTokens, false, 'a malformed managed key is not "ours is here" — it is unreadable');
  });
});
