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
  refreshPlacedBridges,
  main,
  proactiveReviewOffer,
  SETUP_STOP,
} from './setup-backends.mjs';

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

// ── fixtures ────────────────────────────────────────────────────────────────

const CODEX_ROLES = {
  execute: { cmd: 'codex-exec', source: 'bin/codex-exec.sh' },
  review: { cmd: 'codex-review', source: 'bin/codex-review.sh' },
};
const manifestOf = (name, roles, version = '1.0.0') => ({
  family: 'agent-workflow', schema: 1, name, kind: 'execution-backend', version,
  provides: Object.keys(roles), roles,
});

// A bundle SKILL.md the REAL validator accepts (it now validates the bundle): metadata.version must
// match the manifest version (default 1.0.0). The frontmatter `name` is decorative — validateManifest
// reads the name from capability.json.
const skillMd = (name, version = '1.0.0') => `---\nname: ${name}\nmetadata:\n  version: '${version}'\n---\n# ${name} (bundled)\n`;

// Write a fake bundle at <root>/<name>/ with SKILL.md + capability.json + the wrapper scripts.
// extra.version sets BOTH stamps (they must match for the real validator).
const writeBundle = (root, name = 'codex-cli-bridge', roles = CODEX_ROLES, extra = {}) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), extra.skill ?? skillMd(name, extra.version));
  writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifestOf(name, roles, extra.version), null, 2));
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

  it('antigravity 2.0.0: review→agy-review, probe→agy-run → two managed links, in role order', () => {
    const roles = { review: { cmd: 'agy-review', source: 'bin/agy-review.sh' }, probe: { cmd: 'agy-run', source: 'bin/agy.sh' } };
    const links = deriveLinks(manifestOf('antigravity-cli-bridge', roles), SK);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.cmd), ['agy-review', 'agy-run']);
    assert.deepEqual(links.map((l) => l.sourceRel), ['bin/agy-review.sh', 'bin/agy.sh']);
  });

  it('dedupes a cmd shared by two roles with the SAME source (general feature)', () => {
    const roles = { a: { cmd: 'shared-wrapper', source: 'bin/x.sh' }, b: { cmd: 'shared-wrapper', source: 'bin/x.sh' } };
    const links = deriveLinks(manifestOf('codex-cli-bridge', roles), SK);
    assert.equal(links.length, 1);
    assert.equal(links[0].cmd, 'shared-wrapper');
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

  it('always closes with the /agent-workflow-kit status pointer', () => {
    writeBundle(join(tmp, 'bundles'));
    const { text } = capturedMain(['codex', '--dry-run'], baseDeps({ skillDir: join(tmp, 'skill') }));
    assert.match(text, /\/agent-workflow-kit status/);
  });
});

// ── §1.4 version surfacing — 4 render states on the skill line ─────────────────
describe('setup — bridge version surfacing (4 states)', () => {
  // An installed, proven-managed skill dir carrying a chosen SKILL.md (for readAuthoritativeVersion).
  const installSkill = (skillContent) => {
    const skillDir = join(tmp, 'skill');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skillContent);
    writeFileSync(join(skillDir, 'capability.json'), '{}');
    return skillDir;
  };

  it('place / no prior → "(vX)" no arrow (never "vnull → ...")', () => {
    writeBundle(join(tmp, 'bundles')); // bundle version 1.0.0
    const { text } = capturedMain(['codex', '--dry-run'], baseDeps({ skillDir: join(tmp, 'skill') }));
    assert.match(text, /will place \(v1\.0\.0\)/);
    assert.ok(!/→ v/.test(text), 'a place shows no version arrow');
  });

  it('refresh, equal version → "(vX)" no arrow', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = installSkill(skillMd('codex-cli-bridge')); // metadata.version 1.0.0 == bundle
    const { text } = capturedMain(['codex', '--dry-run'], baseDeps({ skillDir, validate: okValidate() }));
    assert.match(text, /will refresh \(v1\.0\.0\)/);
    assert.ok(!/v1\.0\.0 → /.test(text));
  });

  it('refresh, differing version → "(vOld → vNew)"', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = installSkill('# installed\n');
    const deps = baseDeps({ skillDir, validate: okValidate(), rest: { readVersion: () => ({ version: '0.9.0' }) } });
    const { text } = capturedMain(['codex', '--dry-run'], deps);
    assert.match(text, /will refresh \(v0\.9\.0 → v1\.0\.0\)/);
  });

  it('refresh, prior version null → "(vX)" no arrow (never "vnull → vX")', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = installSkill('# installed\n'); // SKILL.md without frontmatter → version null
    const { text } = capturedMain(['codex', '--dry-run'], baseDeps({ skillDir, validate: okValidate() }));
    assert.match(text, /will refresh \(v1\.0\.0\)/);
    assert.ok(!/vnull/.test(text));
  });
});

// ── §1.7 proactive set-recipe offer (re-detect AFTER apply; true readiness flip only) ──
describe('setup — proactive review-recipe offer', () => {
  it('proactiveReviewOffer is a pure flip-gated helper (both review slots; council ≥2, reviewed =1)', () => {
    const reviewed = proactiveReviewOffer(0, 1);
    assert.match(reviewed, /plan-authoring\.review=reviewed/);
    assert.match(reviewed, /plan-execution\.review=reviewed/, 'never offers only plan-execution');
    const council = proactiveReviewOffer(1, 2);
    assert.match(council, /plan-authoring\.review=council/);
    assert.match(council, /or =reviewed/);
    assert.equal(proactiveReviewOffer(1, 1), null, 'no flip → no offer');
    assert.equal(proactiveReviewOffer(null, 2), null, 'detection failure → no offer');
    assert.equal(proactiveReviewOffer(2, 1), null, 'a decrease never offers');
  });

  // A stateful multi-backend detector: returns `counts[i]` READY backends on the i-th call (before then
  // after the apply). reviewReadyCount filters readiness === 'ready'.
  const flippingDetectAll = (counts) => {
    let i = 0;
    return () => {
      const c = counts[Math.min(i, counts.length - 1)];
      i += 1;
      return [
        { name: 'codex-cli-bridge', readiness: c >= 1 ? 'ready' : 'needs-skill' },
        { name: 'antigravity-cli-bridge', readiness: c >= 2 ? 'ready' : 'needs-skill' },
      ];
    };
  };

  it('a real apply that flips a review backend to ready prints the offer', () => {
    writeBundle(join(tmp, 'bundles'));
    const deps = baseDeps({ skillDir: join(tmp, 'skill'), bindir: join(tmp, 'bin'), rest: { detectAll: flippingDetectAll([0, 1]) } });
    const { code, text } = capturedMain(['codex'], deps);
    assert.equal(code, 0);
    assert.match(text, /set-recipe --set plan-authoring\.review=reviewed/);
    assert.match(text, /set-recipe --set plan-execution\.review=reviewed/);
  });

  it('no readiness flip → NO offer', () => {
    writeBundle(join(tmp, 'bundles'));
    const deps = baseDeps({ skillDir: join(tmp, 'skill'), bindir: join(tmp, 'bin'), rest: { detectAll: flippingDetectAll([1, 1]) } });
    const { text } = capturedMain(['codex'], deps);
    assert.ok(!/set-recipe/.test(text), 'a stable readiness count makes no offer');
  });

  it('a DRY-RUN never offers (no apply happened)', () => {
    writeBundle(join(tmp, 'bundles'));
    const deps = baseDeps({ skillDir: join(tmp, 'skill'), bindir: join(tmp, 'bin'), rest: { detectAll: flippingDetectAll([0, 2]) } });
    const { text } = capturedMain(['codex', '--dry-run'], deps);
    assert.ok(!/set-recipe/.test(text));
  });
});

// ── §2.1 INV-D — the bridge refresh NEVER downgrades (plain setup AND the driver) ──

// A proven-managed placed bridge NEWER than the kit-bundled mirror (an older npx runner / a kit
// downgrade). Every refresh path must be a stated skip naming the kit update — never a copy.
// Seed a placed dir the REAL validator accepts (SKILL.md + capability.json versions in lockstep +
// the roles' wrapper sources present) — the same shape writeBundle produces, at a chosen version.
const seedPlaced = (version) => {
  const skillDir = join(tmp, 'skill');
  mkdirSync(join(skillDir, 'bin'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd('codex-cli-bridge', version));
  writeFileSync(join(skillDir, 'capability.json'), JSON.stringify(manifestOf('codex-cli-bridge', CODEX_ROLES, version), null, 2));
  for (const r of Object.values(CODEX_ROLES)) writeFileSync(join(skillDir, r.source), '#!/bin/sh\necho placed\n');
  return skillDir;
};

const seedNewerPlaced = () => {
  writeBundle(join(tmp, 'bundles'), 'codex-cli-bridge', CODEX_ROLES, { version: '2.1.0' });
  return seedPlaced('2.2.0');
};

describe('INV-D — never downgrade a placed bridge (placed 2.2.0 vs bundled 2.1.0)', () => {
  it('plain setup: stated skip + the kit-update recovery, NO copy, nonzero exit', () => {
    const skillDir = seedNewerPlaced();
    const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const bindir = join(tmp, 'bin');
    const { code, text } = capturedMain(['codex'], baseDeps({ skillDir, bindir }));
    assert.notEqual(code, 0);
    assert.match(text, /refusing to downgrade/i);
    assert.match(text, /v2\.2\.0/), assert.match(text, /v2\.1\.0/);
    assert.match(text, /npx @sabaiway\/agent-workflow-kit@latest init/, 'the recovery names the kit update');
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), before, 'the newer placed bridge is untouched');
    assert.equal(existsSync(bindir), false, 'no wrapper mutation either');
  });

  it('plain setup --dry-run predicts the same STOP (faithful plan)', () => {
    const skillDir = seedNewerPlaced();
    const plan = planFor('codex', baseDeps({ skillDir }));
    assert.equal(plan.outcome, 'stop');
    assert.match(plan.reason, /downgrade/i);
    assert.match(plan.reason, /@latest init/);
  });

  it('placeSkill (the mutating primitive) refuses too — belt at write time', () => {
    const skillDir = seedNewerPlaced();
    const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    assert.throws(() => placeSkill('codex', baseDeps({ skillDir })), (e) => e.code === SETUP_STOP && /downgrade/i.test(e.message));
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), before);
  });

  it('the refresh driver: stated skip naming the kit update, NO copy', () => {
    const skillDir = seedNewerPlaced();
    const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'kept-newer');
    assert.match(res.line, /skipped/i);
    assert.match(res.line, /npx @sabaiway\/agent-workflow-kit@latest init/);
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), before, 'never copied');
  });
});

// ── §2.1 the refresh-only driver (the init/upgrade delivery hook) ──────────────────

describe('refreshPlacedBridges — refresh-only driver', () => {
  // A proven-managed placed bridge older than the bundle (versions consistent for the real validator).
  const seedOlderPlaced = (placedVersion = '0.9.0') => {
    writeBundle(join(tmp, 'bundles'));
    return seedPlaced(placedVersion);
  };

  it('proven-managed older bridge → refreshed with the (vOld → vNew) arrow + wrappers re-linked', () => {
    const skillDir = seedOlderPlaced();
    const bindir = join(tmp, 'bin');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir, bindir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'refreshed');
    assert.match(res.line, /refreshed \(v0\.9\.0 → v1\.0\.0\)/);
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), skillMd('codex-cli-bridge'), 'placed copy now IS the bundle');
    assert.equal(readlinkSync(join(bindir, 'codex-exec')), join(skillDir, 'bin', 'codex-exec.sh'), 'a newer bridge can add a wrapper — re-linked');
  });

  it('equal version → "already current (vX)" that STATES the re-sync, and the copy ran (repair-on-rerun)', () => {
    const skillDir = seedOlderPlaced('1.0.0');
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd('codex-cli-bridge').replace('# codex-cli-bridge (bundled)', '# locally edited'));
    const [res] = refreshPlacedBridges(baseDeps({ skillDir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'already-current');
    assert.match(res.line, /already current \(v1\.0\.0\) — files re-synced from the bundled copy/,
      'the line states the copy that ran — never a mutation-free-sounding "already current"');
    assert.ok(!/→ v/.test(res.line), 'no version arrow on an equal refresh');
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), skillMd('codex-cli-bridge'), 'a locally-edited file is repaired');
  });

  it('absent bridge + a FOREIGN same-named wrapper in bindir → still "not placed", never "could not refresh"', () => {
    // The shared planFor stops on the wrapper conflict, but the refresh-only driver skips an
    // unplaced bridge BEFORE the wrapper axis matters — it must not claim a failure on a backend
    // it would never touch.
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill'); // absent
    const bindir = join(tmp, 'bin');
    mkdirSync(bindir, { recursive: true });
    writeFileSync(join(bindir, 'codex-exec'), 'someone else\'s real file'); // conflict for planFor
    const [res] = refreshPlacedBridges(baseDeps({ skillDir, bindir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'not-placed');
    assert.match(res.line, /skipped — not placed/);
    assert.ok(!/could not refresh/.test(res.line));
    assert.equal(existsSync(skillDir), false, 'still never placed');
    assert.equal(readFileSync(join(bindir, 'codex-exec'), 'utf8'), 'someone else\'s real file', 'the foreign wrapper is untouched');
  });

  it('a NEWER version landing between plan and apply → typed downgrade skip at the write boundary, no copy', () => {
    const skillDir = seedOlderPlaced('0.9.0');
    // Stateful version reader: the plan sees 0.9.0 (refresh allowed), the apply-time re-read sees
    // 99.0.0 — the write-boundary guard must turn that into the same stated skip, never a copy.
    let reads = 0;
    const readVersion = () => {
      reads += 1;
      return { version: reads === 1 ? '0.9.0' : '99.0.0' };
    };
    const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir, rest: { readVersion } }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'kept-newer');
    assert.match(res.line, /refusing to downgrade/);
    assert.match(res.line, /npx @sabaiway\/agent-workflow-kit@latest init/);
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), before, 'no copy after the race');
    assert.ok(reads >= 2, 'the write boundary really re-read the placed version (non-vacuous)');
  });

  it('unparseable placed version → refresh proceeds, stated with no arrow (legacy repair)', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# legacy, no frontmatter\n');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir, validate: okValidate() }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'refreshed');
    assert.match(res.line, /refreshed \(v1\.0\.0\)/);
    assert.ok(!/vnull|→/.test(res.line));
  });

  it('absent bridge → stated skip, NEVER placed (AD-009/AD-011 placement stays opt-in)', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'not-placed');
    assert.match(res.line, /skipped — not placed/);
    assert.match(res.line, /opt-in/), assert.match(res.line, /\/agent-workflow-kit setup/);
    assert.equal(existsSync(skillDir), false, 'the driver must NEVER place an absent bridge');
  });

  it('foreign/invalid placed dir → a reported failure with a recovery, never a crash, dir untouched', () => {
    writeBundle(join(tmp, 'bundles'));
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# present\n');
    writeFileSync(join(skillDir, 'capability.json'), 'not json');
    const [res] = refreshPlacedBridges(baseDeps({ skillDir }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'failed');
    assert.match(res.line, /could not refresh/);
    assert.match(res.line, /\/agent-workflow-kit setup/, 'the failure line carries a recovery');
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), '# present\n');
  });

  it('TOCTOU: plan says refresh, dir gone absent at apply → reported skip, NOTHING placed', () => {
    const skillDir = seedOlderPlaced('1.0.0');
    const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    // The skill dir "vanishes" AFTER the plan and BEFORE the apply: the 2nd lstat of the skill dir
    // itself reports ENOENT; every other path stays the real filesystem.
    let dirLstats = 0;
    const lstat = (p) => {
      if (p === skillDir) {
        dirLstats += 1;
        if (dirLstats > 1) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return lstatSync(p);
    };
    const [res] = refreshPlacedBridges(baseDeps({ skillDir, rest: { lstat } }), ['codex-cli-bridge']);
    assert.equal(res.outcome, 'not-placed');
    assert.match(res.line, /skipped — not placed/);
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), before, 'the re-inspection must stop the copy, never place');
    assert.ok(dirLstats > 1, 'the apply really re-inspected the dir (non-vacuous)');
  });
});

// ── §2.1 --refresh-placed CLI mode ────────────────────────────────────────────────

describe('main --refresh-placed — CLI contract', () => {
  const AGY_ROLES = { review: { cmd: 'agy-review', source: 'bin/agy-review.sh' }, probe: { cmd: 'agy-run', source: 'bin/agy.sh' } };
  const bothBundles = () => {
    writeBundle(join(tmp, 'bundles'));
    writeBundle(join(tmp, 'bundles'), 'antigravity-cli-bridge', AGY_ROLES);
  };

  it('refreshes the placed bridge, states the absent one, exit 0, and never offers set-recipe', () => {
    bothBundles();
    const skillDir = seedPlaced('0.9.0');
    const { code, text } = capturedMain(['--refresh-placed'], baseDeps({ skillDir }));
    assert.equal(code, 0);
    assert.match(text, /codex-cli-bridge: refreshed \(v0\.9\.0 → v1\.0\.0\)/);
    assert.match(text, /antigravity-cli-bridge: skipped — not placed/);
    assert.ok(!/set-recipe/.test(text), 'a refresh never flips readiness, so no recipe offer');
  });

  it('a failed backend → exit 1 (the line still carries the reason + recovery)', () => {
    bothBundles();
    const skillDir = join(tmp, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# present\n');
    writeFileSync(join(skillDir, 'capability.json'), 'not json');
    const { code, text } = capturedMain(['--refresh-placed'], baseDeps({ skillDir }));
    assert.equal(code, 1);
    assert.match(text, /could not refresh/);
  });

  it('composes with a single named backend', () => {
    writeBundle(join(tmp, 'bundles'));
    const { code, text } = capturedMain(['codex', '--refresh-placed'], baseDeps({ skillDir: join(tmp, 'skill') }));
    assert.equal(code, 0);
    assert.match(text, /codex-cli-bridge: skipped — not placed/);
    assert.ok(!/antigravity/.test(text), 'only the named backend is touched');
  });

  it('--refresh-placed --dry-run → usage error (no silent flag-swallowing)', () => {
    const { code, text } = capturedMain(['--refresh-placed', '--dry-run']);
    assert.equal(code, 2);
    assert.match(text, /usage: setup-backends/);
  });

  it('--help lists --refresh-placed', () => {
    const { text } = capturedMain(['--help']);
    assert.match(text, /--refresh-placed/);
  });
});
