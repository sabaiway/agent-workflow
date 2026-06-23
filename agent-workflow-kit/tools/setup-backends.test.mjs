import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, readFileSync, existsSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindirOnPath,
  deriveLinks,
  placeSkill,
  linkWrappers,
  planFor,
  main,
  SETUP_STOP,
} from './setup-backends.mjs';

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

// ── fixtures ────────────────────────────────────────────────────────────────

const CODEX_ROLES = {
  execute: { cmd: 'codex-exec', source: 'bin/codex-exec.sh' },
  review: { cmd: 'codex-review', source: 'bin/codex-review.sh' },
};
const manifestOf = (name, roles) => ({
  family: 'agent-workflow', schema: 1, name, kind: 'execution-backend', version: '1.0.0',
  provides: Object.keys(roles), roles,
});

// A bundle SKILL.md the REAL validator accepts (it now validates the bundle): metadata.version must
// match the manifest version (1.0.0). The frontmatter `name` is decorative — validateManifest reads
// the name from capability.json.
const skillMd = (name) => `---\nname: ${name}\nmetadata:\n  version: '1.0.0'\n---\n# ${name} (bundled)\n`;

// Write a fake bundle at <root>/<name>/ with SKILL.md + capability.json + the wrapper scripts.
const writeBundle = (root, name = 'codex-cli-bridge', roles = CODEX_ROLES, extra = {}) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), extra.skill ?? skillMd(name));
  writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifestOf(name, roles), null, 2));
  for (const r of Object.values(roles)) writeFileSync(join(dir, r.source), '#!/bin/sh\necho hi\n');
  if (extra.newFile) writeFileSync(join(dir, extra.newFile), 'bundled-only\n');
  return dir;
};

const okValidate = (name = 'codex-cli-bridge') => () => ({ result: 'valid', name, kind: 'execution-backend', available: true });
const fakeDetect = (over = {}) => () => ({
  name: 'codex-cli-bridge',
  manifestState: 'ok',
  cli: { bin: 'codex', state: 'present', path: '/usr/bin/codex' },
  credentials: { state: 'present', path: '/c/auth.json' },
  wrappers: [], readiness: 'ready', setupHint: { url: 'u' }, skillDir: '/s',
  ...over,
});

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'awf-setup-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Build a deps object that points the codex backend at controllable skill/bundle/bindir dirs.
const baseDeps = (over = {}) => {
  const bundleRoot = over.bundleRoot ?? join(tmp, 'bundles');
  const skillDir = over.skillDir ?? join(tmp, 'skill');
  return {
    platform: 'linux',
    home: join(tmp, 'home'),
    getenv: { CODEX_CLI_BRIDGE_DIR: skillDir, PATH: '', ...(over.getenv ?? {}) },
    bundleRoot,
    bindir: over.bindir ?? join(tmp, 'bin'),
    validate: over.validate,
    detect: over.detect ?? fakeDetect(),
    ...over.rest,
  };
};

// ── bindirOnPath ────────────────────────────────────────────────────────────

describe('bindirOnPath', () => {
  it('true when the dir is a PATH member (posix, normalised)', () => {
    assert.equal(bindirOnPath('/home/u/.local/bin', { PATH: '/usr/bin:/home/u/.local/bin/' }, 'linux'), true);
  });
  it('false when absent', () => {
    assert.equal(bindirOnPath('/home/u/.local/bin', { PATH: '/usr/bin:/bin' }, 'linux'), false);
  });
  it('win32 is case-insensitive and uses ; + Path', () => {
    assert.equal(bindirOnPath('C:\\Tools\\Bin', { Path: 'c:\\tools\\bin;C:\\Windows' }, 'win32'), true);
  });
});

// ── deriveLinks (pure manifest → links, untrusted-string validation) ──────────

describe('deriveLinks', () => {
  const SK = '/skills/codex-cli-bridge';

  it('dedupes a cmd shared by two roles with the SAME source (agy-run case)', () => {
    const roles = { review: { cmd: 'agy-run', source: 'bin/agy.sh' }, probe: { cmd: 'agy-run', source: 'bin/agy.sh' } };
    const links = deriveLinks(manifestOf('antigravity-cli-bridge', roles), SK);
    assert.equal(links.length, 1);
    assert.equal(links[0].cmd, 'agy-run');
  });

  it('two distinct cmds → two links', () => {
    assert.equal(deriveLinks(manifestOf('codex-cli-bridge', CODEX_ROLES), SK).length, 2);
  });

  for (const bad of ['../evil', 'a/b', 'ab', '', 'a b']) {
    it(`rejects cmd ${JSON.stringify(bad)} (allowlist)`, () => {
      const roles = { execute: { cmd: bad, source: 'bin/x.sh' } };
      assert.throws(() => deriveLinks(manifestOf('codex-cli-bridge', roles), SK), (e) => e.code === SETUP_STOP);
    });
  }

  it('STOPs when one cmd maps to two different sources', () => {
    const roles = { execute: { cmd: 'dup', source: 'bin/a.sh' }, review: { cmd: 'dup', source: 'bin/b.sh' } };
    assert.throws(() => deriveLinks(manifestOf('codex-cli-bridge', roles), SK), /two sources/);
  });

  it('STOPs when a source escapes the skill dir', () => {
    const roles = { execute: { cmd: 'codex-exec', source: '../escape.sh' } };
    assert.throws(() => deriveLinks(manifestOf('codex-cli-bridge', roles), SK), /escapes/);
  });

  it('STOPs when there are no wrapper roles', () => {
    assert.throws(() => deriveLinks(manifestOf('codex-cli-bridge', {}), SK), /no wrapper roles/);
  });

  for (const reserved of ['.', '..']) {
    it(`rejects the reserved cmd ${JSON.stringify(reserved)} (would resolve to bindir / its parent)`, () => {
      const roles = { execute: { cmd: reserved, source: 'bin/x.sh' } };
      assert.throws(() => deriveLinks(manifestOf('codex-cli-bridge', roles), SK), /reserved path name/);
    });
  }
});

// ── planFor: action selection by axes (read-only, no mutation) ────────────────

describe('planFor — action selection', () => {
  it('not-installed (absent skill dir) → place + link, no fs mutation', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    const plan = planFor('codex', baseDeps({ skillDir }));
    assert.equal(plan.outcome, 'ok');
    assert.equal(plan.place.action, 'place');
    assert.deepEqual(plan.links.map((l) => l.dstState).sort(), ['absent', 'absent']);
    assert.equal(existsSync(skillDir), false, 'planFor must not create the skill dir');
    assert.equal(existsSync(plan.bindir), false, 'planFor must not create the bindir');
  });

  it('ok + proven-managed, one wrapper linked → refresh + relink the missing one', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# installed\n');
    writeFileSync(join(skillDir, 'capability.json'), '{}');
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    symlinkSync(join(skillDir, 'bin', 'codex-exec.sh'), join(bindir, 'codex-exec')); // ours
    const plan = planFor('codex', baseDeps({ skillDir, bindir, validate: okValidate() }));
    assert.equal(plan.place.action, 'refresh');
    const byCmd = Object.fromEntries(plan.links.map((l) => [l.cmd, l.dstState]));
    assert.equal(byCmd['codex-exec'], 'ours');
    assert.equal(byCmd['codex-review'], 'absent');
  });

  it('ok + all wrappers linked + cli missing → outcome ok with a cli guide', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# installed\n');
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    symlinkSync(join(skillDir, 'bin', 'codex-exec.sh'), join(bindir, 'codex-exec'));
    symlinkSync(join(skillDir, 'bin', 'codex-review.sh'), join(bindir, 'codex-review'));
    const detect = fakeDetect({ cli: { bin: 'codex', state: 'missing', path: null } });
    const plan = planFor('codex', baseDeps({ skillDir, bindir, validate: okValidate(), detect }));
    assert.equal(plan.outcome, 'ok');
    assert.deepEqual(plan.links.map((l) => l.dstState), ['ours', 'ours']);
    assert.ok(plan.guides.some((g) => g.need === 'cli'));
  });

  for (const state of ['stub', 'foreign', 'invalid-manifest', 'unsupported-schema']) {
    it(`${state} manifest → STOP, no mutation`, () => {
      writeBundle(join(tmp, 'bundles'));
      const skillDir = join(tmp, 'skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# present\n');
      const validate = () => ({
        stub: { result: 'valid', name: 'codex-cli-bridge', kind: 'execution-backend', available: false },
        foreign: { result: 'valid', name: 'other', kind: 'execution-backend', available: true },
        'invalid-manifest': { result: 'invalid', errors: ['x'] },
        'unsupported-schema': { result: 'unsupported', errors: ['x'] },
      }[state]);
      const plan = planFor('codex', baseDeps({ skillDir, validate }));
      assert.equal(plan.outcome, 'stop');
      assert.match(plan.reason, new RegExp(state));
    });
  }

  it('marker unknown (EACCES on SKILL.md) → STOP, no write', () => {
    writeBundle(join(tmp, 'bundles')); // a real, valid bundle (now validated); the skill dir is mocked
    const skillDir = join(tmp, 'skill');
    const deps = baseDeps({
      skillDir,
      rest: {
        exists: () => true, // bundle marker + skill marker both "exist"
        lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true }),
        stat: () => { throw eacces(); }, // probing the marker fails non-ENOENT → unknown
      },
    });
    const plan = planFor('codex', deps);
    assert.equal(plan.outcome, 'stop');
    assert.match(plan.reason, /cannot determine bridge skill state/);
  });

  it('a foreign same-named wrapper elsewhere on PATH does NOT count as linked (per-bindir)', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# installed\n');
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'codex-exec'), 'foreign'); // same name, different dir on PATH
    const bindir = join(tmp, 'bin');
    const plan = planFor('codex', baseDeps({ skillDir, bindir, validate: okValidate(), getenv: { CODEX_CLI_BRIDGE_DIR: skillDir, PATH: elsewhere } }));
    const exec = plan.links.find((l) => l.cmd === 'codex-exec');
    assert.equal(exec.dstState, 'absent'); // judged at bindir/codex-exec, not PATH-wide
  });
});

// ── placeSkill (mutating) ─────────────────────────────────────────────────────

describe('placeSkill', () => {
  it('refreshes a proven-managed dir (overwrites + adds bundled files)', () => {
    writeBundle(join(tmp, 'bundles'), 'codex-cli-bridge', CODEX_ROLES, { newFile: 'NEW.txt' });
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'OLD\n');
    writeFileSync(join(skillDir, 'capability.json'), '{}');
    placeSkill('codex', baseDeps({ skillDir, validate: okValidate() }));
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), skillMd('codex-cli-bridge')); // overwritten
    assert.ok(existsSync(join(skillDir, 'NEW.txt'))); // bundled-only file delivered
  });

  it('refuses a foreign bundle (valid JSON, wrong name) — corrupt kit, no place', () => {
    const bundleRoot = join(tmp, 'bundles');
    writeBundle(bundleRoot, 'codex-cli-bridge'); // create the expected slot…
    const dir = join(bundleRoot, 'codex-cli-bridge'); // …then claim a foreign name in it
    writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifestOf('not-codex', CODEX_ROLES), null, 2));
    writeFileSync(join(dir, 'SKILL.md'), skillMd('not-codex'));
    const skillDir = join(tmp, 'skill');
    assert.throws(() => placeSkill('codex', baseDeps({ skillDir, bundleRoot })), /bundled bridge manifest/);
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), false); // never placed the foreign bridge
  });

  it('refuses a non-empty foreign dir (no SKILL.md marker)', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'random.txt'), 'someone elses files\n');
    assert.throws(() => placeSkill('codex', baseDeps({ skillDir })), (e) => e.code === SETUP_STOP);
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), false); // untouched
  });

  it('refuses to write through a symlinked skill dir', () => {
    writeBundle(join(tmp, 'bundles'));
    const real = join(tmp, 'real');
    mkdirSync(real, { recursive: true });
    const skillDir = join(tmp, 'skill-link');
    symlinkSync(real, skillDir);
    assert.throws(() => placeSkill('codex', baseDeps({ skillDir })), /symlink/i);
  });

  it('fails loud when the bundle is missing (corrupt kit)', () => {
    const skillDir = join(tmp, 'skill');
    assert.throws(() => placeSkill('codex', baseDeps({ skillDir, bundleRoot: join(tmp, 'no-bundles') })), /bundled bridge missing/);
  });
});

// ── linkWrappers (mutating, preflight-then-mutate) ────────────────────────────

const placedSkill = (roles = CODEX_ROLES) => {
  const skillDir = join(tmp, 'skill');
  mkdirSync(join(skillDir, 'bin'), { recursive: true });
  for (const r of Object.values(roles)) writeFileSync(join(skillDir, r.source), '#!/bin/sh\n');
  return skillDir;
};

describe('linkWrappers', () => {
  it('creates an absent bindir and links each wrapper (mkdir -p)', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'newbin', 'nested');
    const res = linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir });
    assert.deepEqual(res.links.map((l) => l.action).sort(), ['linked', 'linked']);
    assert.equal(readlinkSync(join(bindir, 'codex-exec')), join(skillDir, 'bin', 'codex-exec.sh'));
  });

  it('links into a SYMLINKED bindir (common dotfiles setup) instead of refusing it', () => {
    const skillDir = placedSkill();
    const realBin = join(tmp, 'real-bin');
    mkdirSync(realBin, { recursive: true });
    const bindir = join(tmp, 'link-bin');
    symlinkSync(realBin, bindir); // ~/.local/bin → elsewhere
    const res = linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir });
    assert.deepEqual(res.links.map((l) => l.action).sort(), ['linked', 'linked']);
    // the wrapper lands in the real dir, reachable through the symlinked bindir, pointing at our source
    assert.equal(readlinkSync(join(realBin, 'codex-exec')), join(skillDir, 'bin', 'codex-exec.sh'));
    assert.equal(readlinkSync(join(bindir, 'codex-exec')), join(skillDir, 'bin', 'codex-exec.sh'));
  });

  it('is idempotent — a re-run is all noop', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'bin');
    linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir });
    const res = linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir });
    assert.deepEqual(res.links.map((l) => l.action), ['noop', 'noop']);
  });

  it('STOPs on a non-symlink dest (and does not clobber it)', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    writeFileSync(join(bindir, 'codex-exec'), 'real file');
    assert.throws(() => linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir }), (e) => e.code === SETUP_STOP);
    assert.equal(readFileSync(join(bindir, 'codex-exec'), 'utf8'), 'real file');
  });

  it('STOPs on a foreign symlink dest', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    symlinkSync(join(tmp, 'somewhere-else'), join(bindir, 'codex-exec'));
    assert.throws(() => linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir }), /foreign symlink/);
  });

  it('preflight conflict on the 2nd wrapper → ZERO mutations (1st not linked)', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    symlinkSync(join(tmp, 'elsewhere'), join(bindir, 'codex-review')); // 2nd wrapper conflicts
    assert.throws(() => linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir }), (e) => e.code === SETUP_STOP);
    assert.equal(existsSync(join(bindir, 'codex-exec')), false, '1st wrapper must not be linked');
  });

  it('STOPs when a source is a symlink (never links through a symlinked source)', () => {
    const skillDir = join(tmp, 'skill');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    writeFileSync(join(skillDir, 'bin', 'real.sh'), '#!/bin/sh\n');
    symlinkSync(join(skillDir, 'bin', 'real.sh'), join(skillDir, 'bin', 'codex-exec.sh'));
    const roles = { execute: { cmd: 'codex-exec', source: 'bin/codex-exec.sh' } };
    assert.throws(() => linkWrappers(skillDir, manifestOf('codex-cli-bridge', roles), { bindir: join(tmp, 'bin') }), /symlink/i);
  });

  it('STOPs when a source is missing (skill not placed)', () => {
    const skillDir = join(tmp, 'skill'); // no bin/*.sh
    mkdirSync(skillDir, { recursive: true });
    assert.throws(() => linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir: join(tmp, 'bin') }), /is missing/);
  });

  it('win32 → no mutation (POSIX-only wrappers)', () => {
    const skillDir = placedSkill();
    const bindir = join(tmp, 'bin');
    const res = linkWrappers(skillDir, manifestOf('codex-cli-bridge', CODEX_ROLES), { bindir, platform: 'win32' });
    assert.equal(res.skipped, true);
    assert.equal(existsSync(bindir), false);
  });
});

// ── dry-run plan correctness before the skill is placed ───────────────────────

describe('planFor --dry-run shape (skill not placed yet)', () => {
  it('derives links from the bundled manifest with dst/source set, mutates nothing', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    const bindir = join(tmp, 'bin');
    const plan = planFor('codex', baseDeps({ skillDir, bindir }));
    assert.equal(plan.place.action, 'place');
    const exec = plan.links.find((l) => l.cmd === 'codex-exec');
    assert.equal(exec.dst, join(bindir, 'codex-exec'));
    assert.equal(exec.source, join(skillDir, 'bin', 'codex-exec.sh'));
    assert.equal(existsSync(skillDir), false);
    assert.equal(existsSync(bindir), false);
  });

  it('a dry-run STOPs if a bundle wrapper source is a symlink (validates, but not linkable) — faithful plan', () => {
    const bundleDir = writeBundle(join(tmp, 'bundles')); // valid bundle…
    // …then replace a wrapper source with a symlink (validateManifest follows it → still "valid",
    // but linkWrappers would refuse it, so the dry-run must predict the STOP, not report ok).
    const target = join(bundleDir, 'bin', 'real-exec.sh');
    writeFileSync(target, '#!/bin/sh\n');
    const src = join(bundleDir, 'bin', 'codex-exec.sh');
    rmSync(src);
    symlinkSync(target, src);
    const plan = planFor('codex', baseDeps({ skillDir: join(tmp, 'skill') }));
    assert.equal(plan.outcome, 'stop');
    assert.match(plan.reason, /symlink/i);
  });
});

// ── main(): CLI contract + exit matrix ────────────────────────────────────────

const capturedMain = (argv, deps = {}) => {
  const out = [];
  const code = main(argv, { ...deps, log: (s) => out.push(s), errlog: (s) => out.push(s) });
  return { code, text: out.join('\n') };
};

describe('main — CLI contract + exit matrix', () => {
  it('--help → 0 + usage', () => {
    const { code, text } = capturedMain(['--help']);
    assert.equal(code, 0);
    assert.match(text, /usage: setup-backends/);
  });

  it('unknown flag → 2 + usage', () => {
    assert.equal(capturedMain(['--bogus']).code, 2);
  });

  it('unknown backend → 2 + usage', () => {
    const { code, text } = capturedMain(['nope']);
    assert.equal(code, 2);
    assert.match(text, /unknown backend: nope/);
  });

  it('--bindir with a flag-like or missing value → 2 (never swallows --dry-run into a mutating run)', () => {
    assert.equal(capturedMain(['--bindir', '--dry-run']).code, 2); // would have mutated into "./--dry-run"
    assert.equal(capturedMain(['codex', '--bindir']).code, 2); // trailing --bindir
  });

  it('dry-run on an ok plan with guides → 0 (guides never fail the command)', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    const detect = fakeDetect({ cli: { bin: 'codex', state: 'missing', path: null } });
    const { code, text } = capturedMain(['codex', '--dry-run'], baseDeps({ skillDir, detect }));
    assert.equal(code, 0);
    assert.match(text, /DRY RUN/);
    assert.match(text, /cli:/);
  });

  it('STOP (foreign skill dir) → non-zero, no mutation', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# present\n');
    const bindir = join(tmp, 'bin');
    const validate = () => ({ result: 'valid', name: 'other', kind: 'execution-backend', available: true });
    const { code } = capturedMain(['codex'], baseDeps({ skillDir, bindir, validate }));
    assert.notEqual(code, 0);
    assert.equal(existsSync(bindir), false); // refused before any write
  });

  it('missing bundle → non-zero with the bundle path in the message', () => {
    const { code, text } = capturedMain(['codex'], baseDeps({ skillDir: join(tmp, 'skill'), bundleRoot: join(tmp, 'gone') }));
    assert.notEqual(code, 0);
    assert.match(text, /bundled bridge missing/);
  });

  it('native fs error preserves the underlying reason (EIO)', () => {
    writeBundle(join(tmp, 'bundles')); // real valid bundle; the skill-dir lstat is what throws EIO
    const deps = baseDeps({
      skillDir: join(tmp, 'skill'),
      rest: {
        exists: () => true,
        lstat: () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); },
      },
    });
    const { code, text } = capturedMain(['codex'], deps);
    assert.notEqual(code, 0);
    assert.match(text, /EIO/);
  });

  it('win32 → 0, prints unsupported / WSL, mutates nothing', () => {
    writeBundle(join(tmp, 'bundles'));
    const bindir = join(tmp, 'bin');
    const { code, text } = capturedMain(['codex'], baseDeps({ skillDir: join(tmp, 'skill'), bindir, rest: { platform: 'win32' } }));
    assert.equal(code, 0);
    assert.match(text, /unsupported|WSL/i);
    assert.equal(existsSync(bindir), false);
  });

  it('real run: places the skill + links both wrappers, idempotent on re-run', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    const bindir = join(tmp, 'bin');
    const deps = baseDeps({ skillDir, bindir });
    const first = capturedMain(['codex'], deps);
    assert.equal(first.code, 0);
    assert.ok(existsSync(join(skillDir, 'SKILL.md')), 'skill placed');
    assert.equal(readlinkSync(join(bindir, 'codex-exec')), join(skillDir, 'bin', 'codex-exec.sh'));
    assert.equal(readlinkSync(join(bindir, 'codex-review')), join(skillDir, 'bin', 'codex-review.sh'));
    // re-run: proven-managed refresh + all links already ours → still 0, no breakage
    const second = capturedMain(['codex'], { ...deps, validate: okValidate() });
    assert.equal(second.code, 0);
    assert.match(second.text, /already linked/);
  });
});
