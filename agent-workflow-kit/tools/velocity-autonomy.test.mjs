import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main,
  probeSandboxAvailability,
  effectiveAutonomyLevel,
  renderAutonomySettings,
  mergeAutonomySettings,
  writeAutonomyProfile,
  checkAutonomyProfile,
  RENDER_OWNED_REDLINE_RULES,
  EXPECTED_WORKFLOW_VERSION,
  WORKFLOW_STAMP,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VELOCITY_NO_POLICY,
} from './velocity-profile.mjs';
import { resolveAutonomy, serializeAutonomy, AUTONOMY_REL } from './autonomy-config.mjs';

// ── probe stubs (Step 3.1 degrade rule) ──────────────────────────────────────────────
const LINUX_OK = { platform: 'linux', hasBinary: () => true };
const LINUX_NO_SOCAT = { platform: 'linux', hasBinary: (n) => n !== 'socat' };
const MAC = { platform: 'darwin' };
const WIN = { platform: 'win32' };
const AVAILABLE = probeSandboxAvailability(LINUX_OK);

// Build a resolved policy from sparse parts (defaults fill the rest).
const resolvedWith = ({ redlines = {}, authoring = 'sandbox', execution = 'sandbox' } = {}) =>
  resolveAutonomy({ redlines, 'plan-authoring': { autonomy: authoring }, 'plan-execution': { autonomy: execution } });

const degradesText = (r) => r.degrades.join(' | ');

// ── the sandbox-availability probe (Step 3.3 degrade rule) ──
describe('velocity --autonomy — sandbox-availability probe', () => {
  it('linux with bwrap + socat → available', () => {
    const p = probeSandboxAvailability(LINUX_OK);
    assert.equal(p.available, true);
    assert.deepEqual(p.missing, []);
  });

  it('linux missing socat → UNAVAILABLE (the whole sandbox degrades, not just network)', () => {
    const p = probeSandboxAvailability(LINUX_NO_SOCAT);
    assert.equal(p.available, false);
    assert.deepEqual(p.missing, ['socat']);
    assert.match(p.reason, /falls back to unsandboxed/);
  });

  it('macOS → available (Seatbelt built-in, no bwrap/socat)', () => {
    const p = probeSandboxAvailability(MAC);
    assert.equal(p.available, true);
    assert.match(p.reason, /Seatbelt/);
  });

  it('native Windows → unavailable (WSL2)', () => {
    const p = probeSandboxAvailability(WIN);
    assert.equal(p.available, false);
    assert.match(p.reason, /WSL2/);
  });

  it('default hasBinary scans PATH via injectable env + isExecutable (no spawn)', () => {
    const env = { PATH: '/opt/bin:/usr/bin' };
    const isExecutable = (p) => p === '/usr/bin/bwrap' || p === '/usr/bin/socat';
    const p = probeSandboxAvailability({ platform: 'linux', env, isExecutable });
    assert.equal(p.available, true);
    const p2 = probeSandboxAvailability({ platform: 'linux', env: { PATH: '/opt/bin' }, isExecutable });
    assert.equal(p2.available, false);
    assert.deepEqual(p2.missing, ['bwrap', 'socat']);
  });

  it('a NON-executable file (or a dir) named socat does NOT count — the loud degrade still fires (review-autonomy-r01-major-01)', () => {
    const env = { PATH: '/usr/bin' };
    // bwrap is an executable regular file; "socat" exists on PATH but is not an executable regular file
    // (a directory, or a 0644 file) → isExecutable returns false for it.
    const isExecutable = (p) => p === '/usr/bin/bwrap';
    const p = probeSandboxAvailability({ platform: 'linux', env, isExecutable });
    assert.equal(p.available, false, 'a non-executable socat must not be treated as the binary');
    assert.deepEqual(p.missing, ['socat']);
  });
});

// ── effective level collapse (per-activity → one global settings value) ──
describe('velocity --autonomy — effectiveAutonomyLevel (conservative unanimity)', () => {
  it('every activity sandbox → sandbox', () => {
    assert.equal(effectiveAutonomyLevel(resolvedWith({ authoring: 'sandbox', execution: 'sandbox' })), 'sandbox');
  });
  it('any activity prompt → prompt (a mixed policy keeps the global prompt floor)', () => {
    assert.equal(effectiveAutonomyLevel(resolvedWith({ authoring: 'prompt', execution: 'sandbox' })), 'prompt');
    assert.equal(effectiveAutonomyLevel(resolvedWith({ authoring: 'prompt', execution: 'prompt' })), 'prompt');
  });
});

// ── Decision-6 render shape ──
describe('velocity --autonomy — Decision-6 render shape', () => {
  it('autonomy=sandbox → sandbox enabled + auto-allow + defaultMode acceptEdits', () => {
    const r = renderAutonomySettings(resolvedWith({ execution: 'sandbox', authoring: 'sandbox' }), AVAILABLE);
    assert.equal(r.level, 'sandbox');
    assert.equal(r.sandbox.enabled, true);
    assert.equal(r.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(r.defaultMode, 'acceptEdits');
  });

  it('autonomy=prompt → sandbox enabled (confine) + auto-allow OFF + defaultMode default', () => {
    const r = renderAutonomySettings(resolvedWith({ authoring: 'prompt', execution: 'prompt' }), AVAILABLE);
    assert.equal(r.level, 'prompt');
    assert.equal(r.sandbox.enabled, true, 'sandbox stays enabled — the Decision-1 floor');
    assert.equal(r.sandbox.autoAllowBashIfSandboxed, false);
    assert.equal(r.defaultMode, 'default');
  });
});

// ── red-lines: BOTH values of ALL six render per Decision 6 ──
describe('velocity --autonomy — red-lines render for both ask AND deny (Decision 6)', () => {
  it('command red-lines =ask land under permissions.ask (argument-matching :* forms)', () => {
    const r = renderAutonomySettings(resolvedWith({ redlines: { commit: 'ask', push: 'ask', publish: 'ask' } }), AVAILABLE);
    assert.deepEqual(r.ask, ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npm publish:*)']);
    assert.deepEqual(r.deny, []);
  });

  it('command red-lines =deny land under permissions.deny', () => {
    const r = renderAutonomySettings(resolvedWith({ redlines: { commit: 'deny', push: 'deny', publish: 'deny' } }), AVAILABLE);
    assert.deepEqual(r.deny, ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npm publish:*)']);
    assert.deepEqual(r.ask, []);
  });

  it('the rule shape covers argument-bearing forms (the :* wildcard, not an exact Bash(cmd))', () => {
    for (const rule of RENDER_OWNED_REDLINE_RULES) assert.match(rule, /:\*\)$/, `${rule} must end in :*) to match args`);
    // an exact form would be Bash(git commit) — assert we did NOT emit that
    const r = renderAutonomySettings(resolvedWith({ redlines: { commit: 'ask' } }), AVAILABLE);
    assert.ok(!r.ask.includes('Bash(git commit)'), 'must not emit the args-blind exact form');
  });

  it('network=deny DEGRADES LOUDLY (no hard-block in 2.1.185); network=ask is a note, not a degrade', () => {
    const deny = renderAutonomySettings(resolvedWith({ redlines: { network: 'deny' } }), AVAILABLE);
    assert.match(degradesText(deny), /network=deny .*cannot HARD-BLOCK/);
    const ask = renderAutonomySettings(resolvedWith({ redlines: { network: 'ask' } }), AVAILABLE);
    assert.ok(!/network=ask/.test(degradesText(ask)), 'network=ask is not a degrade');
    assert.ok(ask.notes.some((n) => /network=ask/.test(n)), 'network=ask is a note');
  });

  it('credentials DEGRADES LOUDLY for BOTH ask and deny (2.1.185 has no sandbox.credentials)', () => {
    for (const v of ['ask', 'deny']) {
      const r = renderAutonomySettings(resolvedWith({ redlines: { credentials: v } }), AVAILABLE);
      assert.match(degradesText(r), new RegExp(`credentials=${v}.*NO sandbox credential denial`));
      assert.match(degradesText(r), /2\.1\.187/, 'names the upgrade pointer');
    }
  });

  it('fs_outside_repo=ask DEGRADES LOUDLY to the deny form; =deny is a note', () => {
    const ask = renderAutonomySettings(resolvedWith({ redlines: { fs_outside_repo: 'ask' } }), AVAILABLE);
    assert.match(degradesText(ask), /fs_outside_repo=ask .*no prompt-on-outside-write .*deny form/);
    const deny = renderAutonomySettings(resolvedWith({ redlines: { fs_outside_repo: 'deny' } }), AVAILABLE);
    assert.ok(!/fs_outside_repo/.test(degradesText(deny)), 'fs_outside_repo=deny is not a degrade');
    assert.ok(deny.notes.some((n) => /fs_outside_repo=deny/.test(n)));
  });

  it('sandbox-unavailable → a LOUD degrade caveat (ad-hoc still prompts); available → no availability degrade', () => {
    const degraded = renderAutonomySettings(resolvedWith({}), probeSandboxAvailability(LINUX_NO_SOCAT));
    assert.match(degradesText(degraded), /sandbox UNAVAILABLE.*still PROMPT/);
    // AD-044 Plan 2 drift guard: the degrade names the CONCRETE doctor invocation (the shipped
    // remediation), never a plan-number promise.
    assert.match(degradesText(degraded), /\/agent-workflow-kit autonomy-doctor/);
    assert.ok(!/Plan 2/.test(degradesText(degraded)), 'no plan-number promise in the shipped degrade');
    // red-lines + defaultMode still land on the degraded branch
    assert.equal(degraded.defaultMode, 'acceptEdits');
    assert.deepEqual(degraded.ask, ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npm publish:*)']);
    const ok = renderAutonomySettings(resolvedWith({}), AVAILABLE);
    assert.ok(!/sandbox UNAVAILABLE/.test(degradesText(ok)), 'no availability degrade when available');
  });
});

// ── merge-don't-clobber ──
describe('velocity --autonomy — mergeAutonomySettings (policy-only, merge-don\'t-clobber)', () => {
  const render = renderAutonomySettings(resolvedWith({ redlines: { commit: 'ask' } }), AVAILABLE);

  it('leaves permissions.allow untouched as a VALUE (no entries added/removed)', () => {
    const base = { permissions: { allow: ['Bash(git status:*)', 'Bash(ls:*)'] } };
    const merged = mergeAutonomySettings(base, render);
    assert.deepEqual(merged.permissions.allow, ['Bash(git status:*)', 'Bash(ls:*)']);
  });

  it('preserves foreign top-level keys (the gate-hook hooks block) + foreign ask/deny entries', () => {
    const base = {
      permissions: { allow: ['Bash(ls:*)'], ask: ['Bash(echo hi:*)'], deny: ['Bash(rm -rf /:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash' }] },
    };
    const merged = mergeAutonomySettings(base, render);
    assert.deepEqual(merged.hooks, { PreToolUse: [{ matcher: 'Bash' }] });
    assert.ok(merged.permissions.ask.includes('Bash(echo hi:*)'), 'foreign ask preserved');
    assert.ok(merged.permissions.deny.includes('Bash(rm -rf /:*)'), 'foreign deny preserved');
  });

  it('a policy flip (commit ask→deny) MOVES the render-owned rule, never duplicates it', () => {
    const askRender = renderAutonomySettings(resolvedWith({ redlines: { commit: 'ask', push: 'ask', publish: 'ask' } }), AVAILABLE);
    const denyRender = renderAutonomySettings(resolvedWith({ redlines: { commit: 'deny', push: 'ask', publish: 'ask' } }), AVAILABLE);
    const afterAsk = mergeAutonomySettings({}, askRender);
    const afterFlip = mergeAutonomySettings(afterAsk, denyRender);
    assert.ok(!afterFlip.permissions.ask.includes('Bash(git commit:*)'), 'commit removed from ask on flip');
    assert.ok(afterFlip.permissions.deny.includes('Bash(git commit:*)'), 'commit now under deny');
    // idempotent: no duplicate on a repeat merge
    const twice = mergeAutonomySettings(afterFlip, denyRender);
    assert.equal(twice.permissions.deny.filter((e) => e === 'Bash(git commit:*)').length, 1, 'no duplicate');
  });

  it('sets defaultMode + the sandbox block; preserves foreign sandbox sub-keys', () => {
    const base = { sandbox: { network: { allowedDomains: ['registry.npmjs.org'] } } };
    const merged = mergeAutonomySettings(base, render);
    assert.equal(merged.sandbox.enabled, true);
    assert.equal(merged.sandbox.autoAllowBashIfSandboxed, true);
    assert.deepEqual(merged.sandbox.network, { allowedDomains: ['registry.npmjs.org'] }, 'foreign sandbox sub-key preserved');
    assert.equal(merged.permissions.defaultMode, 'acceptEdits');
  });
});

// ── write-path integration (main / writeAutonomyProfile) ──
describe('velocity --autonomy — write path', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'velocity-autonomy-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const seedPolicy = (config) => writeFileSync(join(cwd, AUTONOMY_REL), serializeAutonomy(config));
  const DOGFOOD = { 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'sandbox' } };
  const readSettings = () => JSON.parse(readFileSync(join(cwd, SETTINGS_FILE), 'utf8'));
  const runMain = (argv, extraDeps = {}) => {
    let out = '';
    const code = main(['--autonomy', ...argv, '--cwd', cwd], { ...LINUX_OK, ...extraDeps, log: (s) => { out += `${s}\n`; }, errlog: (s) => { out += `${s}\n`; } });
    return { code, out };
  };

  it('absent policy → loud STOP (VELOCITY_NO_POLICY), exit 1, seed guidance', () => {
    const r = runMain([]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no docs\/ai\/autonomy\.json to render/);
    assert.match(r.out, /set-autonomy/);
  });

  it('--apply writes the render into settings.json; preserves existing allow + foreign hooks; leaves allow untouched', () => {
    seedPolicy(DOGFOOD);
    writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify({
      permissions: { allow: ['Bash(git status:*)', 'Bash(ls:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    }, null, 2));
    const r = runMain(['--apply']);
    assert.equal(r.code, 0, r.out);
    const s = readSettings();
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(s.permissions.defaultMode, 'acceptEdits');
    assert.deepEqual(s.permissions.allow, ['Bash(git status:*)', 'Bash(ls:*)'], 'allow untouched');
    assert.ok(s.permissions.ask.includes('Bash(git commit:*)'));
    assert.deepEqual(s.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [] }] }, 'foreign hooks preserved');
  });

  it('never writes settings.local.json', () => {
    seedPolicy(DOGFOOD);
    writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(foo:*)'] } }, null, 2));
    const localBefore = readFileSync(join(cwd, SETTINGS_LOCAL_FILE), 'utf8');
    runMain(['--apply']);
    assert.equal(readFileSync(join(cwd, SETTINGS_LOCAL_FILE), 'utf8'), localBefore, 'settings.local.json untouched');
  });

  it('local-mask honesty: a settings.local.json value masking ANY render-owned key is reported loudly — defaultMode + sandbox.enabled + autoAllow (codex final major)', () => {
    seedPolicy(DOGFOOD); // render: defaultMode acceptEdits, sandbox.enabled true, autoAllowBashIfSandboxed true
    const localOut = (local) => {
      writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify(local, null, 2));
      return runMain([]).out;
    };
    assert.match(localOut({ permissions: { defaultMode: 'plan' } }), /settings\.local\.json sets permissions\.defaultMode="plan", which MASKS/);
    assert.match(localOut({ sandbox: { enabled: false } }), /settings\.local\.json sets sandbox\.enabled=false, which MASKS this render's sandbox\.enabled=true/);
    assert.match(localOut({ sandbox: { autoAllowBashIfSandboxed: false } }), /sandbox\.autoAllowBashIfSandboxed=false, which MASKS/);
    // a LOCAL value equal to the rendered one is NOT a mask (no false positive)
    assert.doesNotMatch(localOut({ permissions: { defaultMode: 'acceptEdits' }, sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }), /MASKS/);
  });

  it('degraded branch (socat missing) still writes red-lines + defaultMode + sandbox block; caveat emitted', () => {
    seedPolicy(DOGFOOD);
    const r = runMain(['--apply'], LINUX_NO_SOCAT);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sandbox UNAVAILABLE.*still PROMPT/);
    const s = readSettings();
    assert.equal(s.permissions.defaultMode, 'acceptEdits', 'defaultMode still lands on the degraded branch');
    assert.ok(s.permissions.ask.includes('Bash(git commit:*)'), 'red-lines still land');
    assert.equal(s.sandbox.enabled, true, 'the sandbox block is still written (forward-looking)');
  });

  it('stamp gate on apply: wrong stamp + --apply → STOP', () => {
    seedPolicy(DOGFOOD);
    writeFileSync(join(cwd, WORKFLOW_STAMP), '0.0.1\n');
    const r = runMain(['--apply']);
    assert.equal(r.code, 1);
    assert.match(r.out, /not a deployed agent-workflow project at lineage/);
  });

  it('mode-mixing is a loud usage error', () => {
    assert.equal(main(['--autonomy', '--accept-edits', '--cwd', cwd], { log() {}, errlog() {} }), 2);
    assert.equal(main(['--autonomy', '--kit-tools', '--cwd', cwd], { log() {}, errlog() {} }), 2);
    assert.equal(main(['--check', '--cwd', cwd], { log() {}, errlog() {} }), 2);
    assert.equal(main(['--autonomy', '--check', '--apply', '--cwd', cwd], { log() {}, errlog() {} }), 2);
  });

  it('writeAutonomyProfile throws the typed VELOCITY_NO_POLICY on an absent policy', () => {
    assert.throws(() => writeAutonomyProfile({ cwd }, LINUX_OK), (e) => e.code === VELOCITY_NO_POLICY);
  });

  it('a pre-existing allow entry matching a red-line is a LOUD bypass warning (review-autonomy-r01-major-02 + review-autonomy-r02-major-01), in either file', () => {
    seedPolicy(DOGFOOD); // renders commit/push under permissions.ask
    const bypassOut = (allow, file = SETTINGS_FILE) => {
      writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify({ permissions: { allow: file === SETTINGS_FILE ? allow : [] } }, null, 2));
      if (file === SETTINGS_LOCAL_FILE) writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({ permissions: { allow } }, null, 2));
      else rmSync(join(cwd, SETTINGS_LOCAL_FILE), { force: true });
      return runMain([]).out;
    };
    // exact render-owned wildcard form
    assert.match(bypassOut(['Bash(git commit:*)', 'Bash(ls:*)']), /pre-existing allow entry Bash\(git commit:\*\) that would BYPASS the rendered red-line\(s\) commit/);
    assert.match(bypassOut(['Bash(git commit:*)']), /settings\.json has a pre-existing allow entry/);
    // BROAD wildcard `Bash(git:*)` subsumes commit AND push
    assert.match(bypassOut(['Bash(git:*)']), /Bash\(git:\*\) that would BYPASS the rendered red-line\(s\) commit\/push/);
    // BROAD `Bash(npm:*)` subsumes publish
    assert.match(bypassOut(['Bash(npm:*)']), /Bash\(npm:\*\) that would BYPASS the rendered red-line\(s\) publish/);
    // EXACT no-arg form `Bash(git commit)` (no wildcard) bypasses the no-arg commit
    assert.match(bypassOut(['Bash(git commit)']), /Bash\(git commit\) that would BYPASS the rendered red-line\(s\) commit/);
    // GLOBAL OPTIONS between tool and subcommand — still a bypass
    assert.match(bypassOut(['Bash(git -c user.name=x commit:*)']), /BYPASS the rendered red-line\(s\) commit/);
    assert.match(bypassOut(['Bash(npm --registry=https://r publish:*)']), /BYPASS the rendered red-line\(s\) publish/);
    // a local-file allow entry is flagged too
    assert.match(bypassOut(['Bash(npm publish:*)'], SETTINGS_LOCAL_FILE), /settings\.local\.json has a pre-existing allow entry Bash\(npm publish:\*\)/);
    // NO false positive for read-only / non-red-line commands (incl. bare exact `Bash(git)` and commit-tree plumbing)
    assert.doesNotMatch(bypassOut(['Bash(git status:*)', 'Bash(npm view:*)', 'Bash(ls:*)', 'Bash(git)', 'Bash(git commit-tree:*)']), /BYPASS the rendered red-line/);
  });

  it('foreign sandbox sub-keys that weaken a red-line get a LOUD warning, preserved not clobbered (review-autonomy-r03-major-01)', () => {
    seedPolicy(DOGFOOD); // network=deny, fs_outside_repo=deny by default
    const sbOut = (sandbox, file = SETTINGS_FILE) => {
      writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify(file === SETTINGS_FILE ? { permissions: { allow: [] }, sandbox } : { permissions: { allow: [] } }, null, 2));
      if (file === SETTINGS_LOCAL_FILE) writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({ permissions: { allow: [] }, sandbox }, null, 2));
      else rmSync(join(cwd, SETTINGS_LOCAL_FILE), { force: true });
      return runMain([]).out;
    };
    assert.match(sbOut({ network: { allowedDomains: ['evil.com'] } }), /sandbox\.network\.allowedDomains.*WEAKENS the rendered network red-line/);
    assert.match(sbOut({ filesystem: { allowWrite: ['/etc'] } }), /sandbox\.filesystem\.allowWrite.*WEAKENS the rendered fs_outside_repo red-line/);
    assert.match(sbOut({ allowUnsandboxedCommands: true }), /sandbox\.allowUnsandboxedCommands.*WEAKENS/);
    assert.match(sbOut({ network: { allowedDomains: ['x'] } }, SETTINGS_LOCAL_FILE), /settings\.local\.json has sandbox\.network\.allowedDomains/);
    // deniedDomains STRENGTHENS → no warning
    assert.doesNotMatch(sbOut({ network: { deniedDomains: ['evil.com'] } }), /WEAKENS/);
    // on --apply the foreign weakening sub-key is PRESERVED (merge-don't-clobber), never silently clobbered
    writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify({ permissions: { allow: [] }, sandbox: { network: { allowedDomains: ['keep.me'] } } }, null, 2));
    rmSync(join(cwd, SETTINGS_LOCAL_FILE), { force: true });
    runMain(['--apply']);
    assert.deepEqual(readSettings().sandbox.network, { allowedDomains: ['keep.me'] }, 'foreign sandbox sub-key preserved on apply');
  });

  it('the render reflects ask/deny placement; the residual notice never hardcodes "still asks" (review-autonomy-r01-minor-01)', () => {
    // a policy that DENIES commit renders it under permissions.deny (placement reflected in the output),
    // and the residual notice must not claim commit "still asks"
    seedPolicy({ redlines: { commit: 'deny' }, 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'sandbox' } });
    const r = runMain([]);
    assert.match(r.out, /permissions\.deny \(render-owned red-lines\): Bash\(git commit:\*\)/);
    assert.doesNotMatch(r.out, /still ASKs/);
  });

  it('the residual notice states the prefix-rule limit HONESTLY — best-effort checkpoint, not a boundary, names the real backstops, absence≠safety (AD-044 R4 residual, NOT enumerated away)', () => {
    seedPolicy(DOGFOOD);
    const out = runMain([]).out;
    assert.match(out, /best-effort checkpoint, NOT a security boundary/);
    assert.match(out, /global-option spelling/, 'names the exact residual form rather than pretending to enumerate it');
    assert.match(out, /ABSENCE is not proof no bypass exists/, 'the bypass/weakening warnings are framed best-effort');
    assert.match(out, /SANDBOX \(a genuine OS boundary/, 'names the real backstop');
    assert.match(out, /approval process/);
  });
});

// ── --check drift-guard (Phase 4.1) ──
describe('velocity --autonomy --check — drift-guard', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'velocity-check-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(join(cwd, AUTONOMY_REL), serializeAutonomy({ 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'sandbox' } }));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const apply = () => main(['--autonomy', '--apply', '--cwd', cwd], { ...LINUX_OK, log() {}, errlog() {} });
  const check = () => main(['--autonomy', '--check', '--cwd', cwd], { ...LINUX_OK, log() {}, errlog() {} });
  const settings = () => JSON.parse(readFileSync(join(cwd, SETTINGS_FILE), 'utf8'));
  const writeSettings = (s) => writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify(s, null, 2));

  it('seeded policy → render --apply → --check exits 0 (byte-parity in sync)', () => {
    assert.equal(apply(), 0);
    assert.equal(check(), 0);
    assert.equal(checkAutonomyProfile({ cwd }, LINUX_OK).inSync, true);
  });

  it('mutate one rendered key → --check exits 1 naming it', () => {
    apply();
    const s = settings();
    s.sandbox.autoAllowBashIfSandboxed = false; // hand-edit INSIDE a render-owned block
    writeSettings(s);
    assert.equal(check(), 1);
    const c = checkAutonomyProfile({ cwd }, LINUX_OK);
    assert.equal(c.inSync, false);
    assert.ok(c.drift.some((d) => /autoAllowBashIfSandboxed/.test(d)), 'names the drifted key');
  });

  it('a hand-edit OUTSIDE the render-owned blocks never flags (merge-don\'t-clobber boundary)', () => {
    apply();
    const s = settings();
    s.permissions.allow = [...(s.permissions.allow ?? []), 'Bash(cat:*)']; // foreign allow entry
    s.customField = 'hi';
    writeSettings(s);
    assert.equal(check(), 0, 'edits outside render-owned blocks do not drift');
  });

  it('--check with an absent policy → loud STOP', () => {
    rmSync(join(cwd, AUTONOMY_REL));
    const r = main(['--autonomy', '--check', '--cwd', cwd], { ...LINUX_OK, log() {}, errlog() {} });
    assert.equal(r, 1);
  });
});
