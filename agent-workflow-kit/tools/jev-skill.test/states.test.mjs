import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The facts leaf is loaded dynamically, so the suite loads on a tree without its new names and each cell fails at its first call.
const facts = await import('../jev-facts.mjs').catch(() => ({}));
const absent = (name) => () => { throw new Error(`${name} is absent`); };
const skillState = facts.skillState ?? absent('skillState');
const skillTargets = facts.skillTargets ?? absent('skillTargets');
const claudeDirOf = facts.claudeDirOf ?? absent('claudeDirOf');
const skillLine = facts.skillLine ?? absent('skillLine');
const printable = facts.printable ?? absent('printable');
const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'vendor', 'typesafe-ai');
const TAG = 'v0.5.7';
const COMMIT = '65a39f393687675ce170e6094757de20370365b9';
const SKILL_DIGEST = '71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52';
const LICENSE_DIGEST = '835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02';
const AFTER_INSTALL = 'After an install, quit the agent and start it again from a new terminal.';
const NO_APPLY_LINE = 'the apply line cannot be printed here: a path holds a control character';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The current pair is the kit's own vendored bytes; an earlier pin is a pair of other bytes placed after it in an injected list.
// The vendored pair is read guarded, so the suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };
const CURRENT = { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') };
const OLDER = { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') };
const pinOf = (tag, pair) => ({ tag, commit: tag, digests: { 'SKILL.md': digest(pair['SKILL.md']), LICENSE: digest(pair.LICENSE) } });
const PINS = [pinOf(TAG, CURRENT), pinOf('v0.5.6', OLDER)];

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-states-'));
  made.push(root);
  return root;
};
const put = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const fill = (dir, pair) => {
  for (const [name, bytes] of Object.entries(pair)) put(join(dir, name), bytes);
};
const linkAt = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};
// A home with the Codex target; the cell builds what it needs below it. `base` is the home.
const codexOf = (home) => ({ agent: 'Codex', base: home, root: join(home, '.agents', 'skills'), path: join(home, '.agents', 'skills', 'typesafe-ai') });
// The real primitives, every call recorded; a cell overrides one of them to inject a failure.
const ioOf = (overrides = {}) => {
  const calls = [];
  const record = (name, fn) => (path, ...rest) => { calls.push([name, path]); return fn(path, ...rest); };
  return { calls, pins: PINS, lstat: record('lstat', overrides.lstat ?? lstatSync), readdir: record('readdir', overrides.readdir ?? readdirSync),
    readFile: record('readFile', overrides.readFile ?? readFileSync) };
};
const failing = (code, at) => (path) => {
  if (path === at) throw Object.assign(new Error(`${code}: ${path}`), { code });
  return lstatSync(path);
};
const failingWith = (fn, code, at) => (path) => {
  if (path === at) throw Object.assign(new Error(`${code}: ${path}`), { code });
  return fn(path);
};
const ABSENT = { state: 'absent', tag: null, reason: null };
const foreign = (reason) => ({ state: 'foreign', tag: null, reason });

const CELLS = {
  'an absent root': (home) => [codexOf(home), ioOf(), ABSENT],
  'an absent target (ENOENT)': (home) => {
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    return [codexOf(home), ioOf(), ABSENT];
  },
  'an absent target (ENOTDIR)': (home) => {
    const target = codexOf(home);
    return [target, ioOf({ lstat: failing('ENOTDIR', join(home, '.agents')) }), ABSENT];
  },
  'a linked root': (home) => {
    mkdirSync(join(home, 'elsewhere'));
    linkAt(join(home, 'elsewhere'), join(home, '.agents', 'skills'));
    return [codexOf(home), ioOf(), foreign(`a link at ${join(home, '.agents', 'skills')}`)];
  },
  "a linked ancestor (the home's .gemini a link)": (home) => {
    fill(join(home, 'real-gemini', 'config', 'skills', 'typesafe-ai'), CURRENT);
    linkAt(join(home, 'real-gemini'), join(home, '.gemini'));
    const root = join(home, '.gemini', 'config', 'skills');
    return [{ agent: 'Antigravity CLI', base: home, root, path: join(root, 'typesafe-ai') }, ioOf(),
      foreign(`a link at ${join(home, '.gemini')}`)];
  },
  'a regular file as an ancestor': (home) => {
    put(join(home, '.agents'), 'not a directory\n');
    return [codexOf(home), ioOf(), foreign(`${join(home, '.agents')} is not a directory`)];
  },
  'a linked target': (home) => {
    fill(join(home, 'copy'), CURRENT);
    linkAt(join(home, 'copy'), codexOf(home).path);
    return [codexOf(home), ioOf(), foreign(`a link at ${codexOf(home).path}`)];
  },
  'a regular file at the target': (home) => {
    put(codexOf(home).path, 'a file\n');
    return [codexOf(home), ioOf(), foreign('not a directory')];
  },
  'an extra entry (an OS metafile)': (home) => {
    fill(codexOf(home).path, { ...CURRENT, '.DS_Store': 'meta\n' });
    return [codexOf(home), ioOf(), foreign('holds .DS_Store, LICENSE, SKILL.md')];
  },
  'a missing LICENSE': (home) => {
    fill(codexOf(home).path, { 'SKILL.md': CURRENT['SKILL.md'] });
    return [codexOf(home), ioOf(), foreign('holds SKILL.md')];
  },
  'an empty target directory': (home) => {
    mkdirSync(codexOf(home).path, { recursive: true });
    return [codexOf(home), ioOf(), foreign('holds no entry')];
  },
  'a linked SKILL.md': (home) => {
    put(join(home, 'skill.md'), CURRENT['SKILL.md']);
    fill(codexOf(home).path, { LICENSE: CURRENT.LICENSE });
    linkAt(join(home, 'skill.md'), join(codexOf(home).path, 'SKILL.md'));
    return [codexOf(home), ioOf(), foreign('SKILL.md is not a regular file')];
  },
  'a directory named SKILL.md': (home) => {
    fill(codexOf(home).path, { LICENSE: CURRENT.LICENSE });
    mkdirSync(join(codexOf(home).path, 'SKILL.md'));
    return [codexOf(home), ioOf(), foreign('SKILL.md is not a regular file')];
  },
  'digests of the first pin': (home) => {
    fill(codexOf(home).path, CURRENT);
    return [codexOf(home), ioOf(), { state: 'current', tag: TAG, reason: null }];
  },
  'digests of a second pin placed after it': (home) => {
    fill(codexOf(home).path, OLDER);
    return [codexOf(home), ioOf(), { state: 'earlier', tag: 'v0.5.6', reason: null }];
  },
  'a mixed pair (SKILL.md of one pin, LICENSE of the other)': (home) => {
    fill(codexOf(home).path, { 'SKILL.md': CURRENT['SKILL.md'], LICENSE: OLDER.LICENSE });
    return [codexOf(home), ioOf(), foreign('matches no pin')];
  },
  'digests of no pin': (home) => {
    fill(codexOf(home).path, { 'SKILL.md': '# edited by the user\n', LICENSE: CURRENT.LICENSE });
    return [codexOf(home), ioOf(), foreign('matches no pin')];
  },
  'a readdir throwing EACCES': (home) => {
    fill(codexOf(home).path, CURRENT);
    return [codexOf(home), ioOf({ readdir: failingWith(readdirSync, 'EACCES', codexOf(home).path) }), foreign('EACCES')];
  },
  'a readFile throwing EACCES': (home) => {
    fill(codexOf(home).path, CURRENT);
    return [codexOf(home), ioOf({ readFile: failingWith(readFileSync, 'EACCES', join(codexOf(home).path, 'LICENSE')) }), foreign('EACCES')];
  },
  'a record carrying overlaps': (home) => {
    fill(codexOf(home).path, CURRENT);
    const other = join(home, 'outer', 'typesafe-ai');
    return [{ ...codexOf(home), overlaps: other }, ioOf(), foreign(`overlaps ${other}`)];
  },
  'a base outside the home that is a link to a directory': (home) => {
    const real = `${home}-claude-real`;
    fill(join(real, 'skills', 'typesafe-ai'), CURRENT);
    const base = `${home}-claude-link`;
    symlinkSync(real, base);
    return [{ agent: 'Claude Code', base, root: join(base, 'skills'), path: join(base, 'skills', 'typesafe-ai') }, ioOf(),
      { state: 'current', tag: TAG, reason: null }];
  },
};

describe('spec:jev-guide/S30 the state table by proof over skillState', () => {
  for (const [name, build] of Object.entries(CELLS)) {
    it(name, () => {
      const home = join(tempRoot(), 'home');
      mkdirSync(home);
      const [target, io, expected] = build(home);
      assert.deepEqual(skillState(target, io), expected);
      if (name === 'a record carrying overlaps') assert.deepEqual(io.calls, [], 'nothing read');
      if (expected.reason?.startsWith('a link at ')) {
        assert.deepEqual(io.calls.filter(([kind]) => kind !== 'lstat'), [], 'no link below a base is followed');
      }
    });
  }

  it('injects no pins: io.pins absent judges against SKILL_PINS', () => {
    const home = join(tempRoot(), 'home');
    fill(codexOf(home).path, CURRENT);
    const { pins, ...io } = ioOf();
    assert.ok(pins.length > 1, 'the injected list is the one this cell leaves out');
    assert.deepEqual(skillState(codexOf(home), io), { state: 'current', tag: TAG, reason: null });
  });

  it('printable turns each byte below U+0020 and U+007F into ?', () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('') + String.fromCharCode(127);
    assert.equal(printable(`a${controls}b \u00e9`), `a${'?'.repeat(33)}b \u00e9`);
  });

  it('the pin: SKILL_PINS carries the tag, commit and digests, SKILL_FILES the shipped names, and the vendored files digest to it', () => {
    assert.deepEqual(facts.SKILL_PINS, [{ tag: TAG, commit: COMMIT, digests: { 'SKILL.md': SKILL_DIGEST, LICENSE: LICENSE_DIGEST } }]);
    assert.ok(Object.isFrozen(facts.SKILL_PINS) && Object.isFrozen(facts.SKILL_PINS[0]));
    assert.deepEqual(facts.SKILL_FILES, { 'SKILL.md': 'SKILL.md.pinned', LICENSE: 'LICENSE' });
    assert.deepEqual([digest(CURRENT['SKILL.md']), digest(CURRENT.LICENSE)], [SKILL_DIGEST, LICENSE_DIGEST]);
  });
});

describe('spec:jev-guide/S31 the targets and the apply line by proof', () => {
  const HOME = '/h/user';
  it('skillTargets: three records in their order, base the home or an outside claude dir, none for an empty home', () => {
    assert.deepEqual(skillTargets({ home: HOME, claudeDir: '/h/user/.claude' }), [
      { agent: 'Codex', base: HOME, root: '/h/user/.agents/skills', path: '/h/user/.agents/skills/typesafe-ai' },
      { agent: 'Claude Code', base: HOME, root: '/h/user/.claude/skills', path: '/h/user/.claude/skills/typesafe-ai' },
      { agent: 'Antigravity CLI', base: HOME, root: '/h/user/.gemini/config/skills', path: '/h/user/.gemini/config/skills/typesafe-ai' },
    ]);
    assert.equal(skillTargets({ home: HOME, claudeDir: '/opt/cc' })[1].base, '/opt/cc');
    assert.equal(skillTargets({ home: HOME, claudeDir: '/h/user-other/cc' })[1].base, '/h/user-other/cc', 'a sibling prefix is not under the home');
    assert.deepEqual(skillTargets({ home: '', claudeDir: '/opt/cc' }), []);
  });

  it('a claude dir of <home>/.agents merges into the Codex record; one inside the Codex target carries overlaps', () => {
    const merged = skillTargets({ home: HOME, claudeDir: '/h/user/.agents' });
    assert.deepEqual(merged.map(({ agent, path }) => [agent, path]), [
      ['Codex and Claude Code', '/h/user/.agents/skills/typesafe-ai'], ['Antigravity CLI', '/h/user/.gemini/config/skills/typesafe-ai']]);
    const nested = skillTargets({ home: HOME, claudeDir: '/h/user/.agents/skills/typesafe-ai' });
    assert.equal(nested.length, 3);
    assert.equal(nested[0].overlaps, undefined);
    assert.equal(nested[1].overlaps, '/h/user/.agents/skills/typesafe-ai');
  });

  it('claudeDirOf: an absolute CLAUDE_CONFIG_DIR for the platform, else <home>/.claude, the note only for a relative value', () => {
    const note = (value) => `CLAUDE_CONFIG_DIR is set to ${value}, not an absolute path: the Claude Code target is /h/user/.claude`;
    assert.deepEqual(claudeDirOf({ CLAUDE_CONFIG_DIR: '/cc' }, HOME, 'linux'), { dir: '/cc', fromEnv: true, note: '' });
    assert.deepEqual(claudeDirOf({ CLAUDE_CONFIG_DIR: 'C:\\cc' }, 'C:\\Users\\o', 'win32'), { dir: 'C:\\cc', fromEnv: true, note: '' });
    for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }]) {
      assert.deepEqual(claudeDirOf(env, HOME, 'linux'), { dir: '/h/user/.claude', fromEnv: false, note: '' }, JSON.stringify(env));
    }
    for (const value of ['rel/cc', 'C:\\cc']) {
      assert.deepEqual(claudeDirOf({ CLAUDE_CONFIG_DIR: value }, HOME, 'linux'), { dir: '/h/user/.claude', fromEnv: false, note: note(value) });
    }
    assert.deepEqual(claudeDirOf({}, '', 'linux'), { dir: '', fromEnv: false, note: '' });
    assert.deepEqual(claudeDirOf({ CLAUDE_CONFIG_DIR: '/cc' }, '', 'linux'), { dir: '/cc', fromEnv: true, note: '' });
  });

  it('skillLine: always --claude-dir, quoted as the connect line, PowerShell on win32, empty for a control byte', () => {
    assert.equal(skillLine('/kit/tools', 'linux', '/h/user/.claude'), 'node /kit/tools/jev-skill.mjs --apply --claude-dir /h/user/.claude');
    assert.equal(skillLine('/kit tools/dir', 'linux', "/h/O'B cc"),
      "node '/kit tools/dir/jev-skill.mjs' --apply --claude-dir '/h/O'\\''B cc'");
    assert.equal(skillLine("C:\\Users\\O'Brien\\kit tools", 'win32', "C:\\Users\\O'Brien\\.claude"),
      "node 'C:\\Users\\O''Brien\\kit tools\\jev-skill.mjs' --apply --claude-dir 'C:\\Users\\O''Brien\\.claude'");
    for (const control of [String.fromCharCode(9), String.fromCharCode(127)]) {
      assert.equal(skillLine(`/kit${control}tools`, 'linux', '/cc'), '');
      assert.equal(skillLine('/kit/tools', 'linux', `/c${control}c`), '');
    }
  });

  it('AFTER_INSTALL and NO_APPLY_LINE are the part sentences byte for byte', () => {
    assert.equal(facts.AFTER_INSTALL, AFTER_INSTALL);
    assert.equal(facts.NO_APPLY_LINE, NO_APPLY_LINE);
  });
});
