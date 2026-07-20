import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main,
  probeSandboxAvailability,
  probeHarnessVersion,
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

  it('network=deny DEGRADES LOUDLY (this render expresses no hard block); network=ask is a note, not a degrade', () => {
    const deny = renderAutonomySettings(resolvedWith({ redlines: { network: 'deny' } }), AVAILABLE);
    assert.match(degradesText(deny), /network=deny .*no HARD egress block/);
    const ask = renderAutonomySettings(resolvedWith({ redlines: { network: 'ask' } }), AVAILABLE);
    assert.ok(!/network=ask/.test(degradesText(ask)), 'network=ask is not a degrade');
    assert.ok(ask.notes.some((n) => /network=ask/.test(n)), 'network=ask is a note');
  });

  // An UNPROBED caller is treated exactly like a failed probe: a stated unknown. The old form of
  // this test asserted an unconditional degrade naming a fixed version — it pinned the false claim
  // in place, which is why the defect survived. What is worth pinning is the DIRECTION of failure.
  it('credentials DEGRADES LOUDLY for BOTH ask and deny when the version was never probed', () => {
    for (const v of ['ask', 'deny']) {
      const r = renderAutonomySettings(resolvedWith({ redlines: { credentials: v } }), AVAILABLE);
      assert.match(degradesText(r), new RegExp(`credentials=${v}.*could not be determined`));
      assert.match(degradesText(r), /2\.1\.187/, 'names the threshold the capability arrived in');
      assert.equal(r.sandbox.credentials, undefined, 'nothing is rendered on an unknown');
    }
  });

  it('fs_outside_repo=ask DEGRADES LOUDLY to the deny form; =deny is a note', () => {
    const ask = renderAutonomySettings(resolvedWith({ redlines: { fs_outside_repo: 'ask' } }), AVAILABLE);
    assert.match(degradesText(ask), /fs_outside_repo=ask .*no prompt-on-outside-write mode .*deny form/);
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
  // The harness probe is injected by DEFAULT, never left to the host: without this the probe walks
  // the real PATH, so the suite would pass or fail depending on whether the machine running it has
  // the harness installed — and would keep passing for the wrong reason after the logic broke.
  const UNKNOWN_HARNESS = { findOnPath: () => ({ bin: 'claude', state: 'missing', path: null }) };
  const runMain = (argv, extraDeps = {}) => {
    let out = '';
    const code = main(['--autonomy', ...argv, '--cwd', cwd], { ...LINUX_OK, ...UNKNOWN_HARNESS, ...extraDeps, log: (s) => { out += `${s}\n`; }, errlog: (s) => { out += `${s}\n`; } });
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

  // The render is not the delivery. A credentials block that exists only in the render object
  // protects nothing: --apply must WRITE it and --check must notice when it is missing, or the
  // profile reports a protection the settings file never carries.
  const SUPPORTED_HARNESS = {
    findOnPath: () => ({ bin: 'claude', state: 'present', path: '/home/u/.local/share/claude/versions/2.1.215' }),
  };

  it('credentials-render-reaches-the-settings-file-on-apply', () => {
    seedPolicy(DOGFOOD);
    const r = runMain(['--apply'], SUPPORTED_HARNESS);
    assert.equal(r.code, 0, r.out);
    const c = readSettings().sandbox.credentials;
    assert.ok(c, 'the rendered credentials block must land in settings.json, not only in the render');
    assert.ok(c.envVars.some((e) => e.name === 'NPM_TOKEN' && e.mode === 'deny'));
  });

  it('a hand-removed credentials block is DRIFT, never a silent in-sync', () => {
    seedPolicy(DOGFOOD);
    runMain(['--apply'], SUPPORTED_HARNESS);
    const s = readSettings();
    delete s.sandbox.credentials;
    writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify(s, null, 2));
    const r = main(['--autonomy', '--check', '--cwd', cwd], { ...LINUX_OK, ...SUPPORTED_HARNESS, log() {}, errlog() {} });
    assert.equal(r, 1, 'a removed protection must fail the drift check');
  });

  // The degrade tells the user to declare file credentials themselves. A render that then wipes them
  // would instruct and destroy in the same breath — and merge-don't-clobber is this writer's whole
  // contract everywhere else in the sandbox block.
  it('a hand-declared credentials.files survives an apply and does not trip --check', () => {
    seedPolicy(DOGFOOD);
    runMain(['--apply'], SUPPORTED_HARNESS);
    const s = readSettings();
    s.sandbox.credentials.files = [{ path: '~/.ssh', mode: 'deny' }];
    s.sandbox.credentials.envVars.push({ name: 'MY_OWN_TOKEN', mode: 'mask' });
    writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify(s, null, 2));
    const again = runMain(['--apply'], SUPPORTED_HARNESS);
    assert.equal(again.code, 0, again.out);
    const after = readSettings().sandbox.credentials;
    assert.deepEqual(after.files, [{ path: '~/.ssh', mode: 'deny' }], 'a foreign sub-key is preserved');
    assert.ok(after.envVars.some((e) => e.name === 'MY_OWN_TOKEN'), 'a foreign envVar entry is preserved');
    assert.ok(after.envVars.some((e) => e.name === 'NPM_TOKEN' && e.mode === 'deny'), 'the owned entry still lands');
    const check = main(['--autonomy', '--check', '--cwd', cwd], { ...LINUX_OK, ...SUPPORTED_HARNESS, log() {}, errlog() {} });
    assert.equal(check, 0, 'following the tool\'s own advice must not read as drift');
  });

  // "In sync" only says the file matches the render. It says nothing about what the render could not
  // protect — so an unknown or too-old harness must still say so on a PASSING check.
  it('a passing --check still states the degrades — IN SYNC is not a clean bill of health', () => {
    seedPolicy(DOGFOOD);
    runMain(['--apply']);
    const r = runMain(['--check']);
    assert.equal(r.code, 0, 'the file matches the render');
    assert.match(r.out, /IN SYNC/);
    assert.match(r.out, /DEGRADE/, 'the lost protection is named even when nothing drifted');
    assert.match(r.out, /could not be determined/, 'and it names the cause');
  });

  it('a settings.local.json that weakens an owned credentials entry is a LOUD mask', () => {
    seedPolicy(DOGFOOD);
    writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({
      sandbox: { credentials: { envVars: [{ name: 'NPM_TOKEN', mode: 'mask' }] } },
    }, null, 2));
    const r = runMain(['--apply'], SUPPORTED_HARNESS);
    assert.match(r.out, /MASKS/, 'a local file that weakens a rendered protection must be reported');
    assert.match(r.out, /credentials/);
  });

  it('--check reads settings.local.json too — a local weakening is DRIFT, never IN SYNC', () => {
    seedPolicy(DOGFOOD);
    runMain(['--apply'], SUPPORTED_HARNESS);
    writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({
      sandbox: { credentials: { envVars: [{ name: 'NPM_TOKEN', mode: 'mask' }] } },
    }, null, 2));
    const r = runMain(['--check'], SUPPORTED_HARNESS);
    assert.equal(r.code, 1, 'a local override that defeats the rendered protection must fail the check');
    assert.match(r.out, /masks/, 'and the check names it');
  });

  it('a settings.local.json adding ONLY foreign credentials entries is not a mask', () => {
    seedPolicy(DOGFOOD);
    writeFileSync(join(cwd, SETTINGS_LOCAL_FILE), JSON.stringify({
      sandbox: { credentials: { envVars: [{ name: 'NPM_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' }, { name: 'MY_TOKEN', mode: 'mask' }] } },
    }, null, 2));
    const r = runMain(['--apply'], SUPPORTED_HARNESS);
    assert.ok(!/sandbox\.credentials.*MASKS/.test(r.out), 'adding your own entries is not masking ours');
  });

  it('a hand-written entry with the keys in the other order is NOT drift', () => {
    seedPolicy(DOGFOOD);
    runMain(['--apply'], SUPPORTED_HARNESS);
    const s = readSettings();
    s.sandbox.credentials.envVars = s.sandbox.credentials.envVars.map((e) => ({ mode: e.mode, name: e.name }));
    writeFileSync(join(cwd, SETTINGS_FILE), JSON.stringify(s, null, 2));
    const check = main(['--autonomy', '--check', '--cwd', cwd], { ...LINUX_OK, ...SUPPORTED_HARNESS, log() {}, errlog() {} });
    assert.equal(check, 0, 'key order is not policy — warning about nothing trains the reader to ignore the loud channel');
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

// A version literal frozen in code is a documentation claim: it goes stale by default and nothing
// reports it. The probe does not make the tool right — no one can guarantee another vendor's
// version format, install layout or settings shape. It makes being WRONG loud, which is the only
// invariant available here. So the degrade names the version it OBSERVED, or states the unknown.
describe('velocity --autonomy — the degrade text names only what was observed', () => {
  const HARNESS_SUPPORTS = { version: '2.1.215', source: 'installed-cli', reason: 'resolved from the installed CLI path' };
  const HARNESS_TOO_OLD = { version: '2.1.186', source: 'installed-cli', reason: 'resolved from the installed CLI path' };
  const HARNESS_UNKNOWN = { version: null, source: null, reason: 'no claude CLI resolved on PATH' };
  const render = (redlines, harness) => renderAutonomySettings(resolvedWith({ redlines }), AVAILABLE, harness);

  // What must vanish is the FABRICATED limit, not every mention of credentials: the render still
  // states the limits it really has (no ask mode, files uncovered). Asserting "no degrade at all"
  // would forbid honest degrades and reward the quiet-success failure mode instead.
  it('credentials-degrade-absent-when-installed-version-supports-it', () => {
    for (const v of ['ask', 'deny']) {
      const t = degradesText(render({ credentials: v }, HARNESS_SUPPORTS));
      assert.ok(!/NO sandbox credential denial/.test(t), 'the fabricated platform limit is gone');
      assert.ok(!/could not be determined/.test(t), 'an observed version is never reported as unknown');
    }
  });

  it('credentials=ask DEGRADES LOUDLY — the installed schema has no ask mode to render', () => {
    const t = degradesText(render({ credentials: 'ask' }, HARNESS_SUPPORTS));
    assert.match(t, /credentials=ask .*no ask mode/, 'ask is never quietly upgraded to deny');
  });

  it('credentials coverage is stated PARTIAL — file credentials are not rendered', () => {
    const t = degradesText(render({ credentials: 'deny' }, HARNESS_SUPPORTS));
    assert.match(t, /coverage is PARTIAL/, 'partial protection reported as success is the same defect');
    assert.match(t, /~\/\.ssh/, 'the degrade names what stays readable');
  });

  it('credentials-key-rendered-when-installed-version-supports-it', () => {
    const c = render({ credentials: 'deny' }, HARNESS_SUPPORTS).sandbox.credentials;
    assert.ok(c, 'a supported capability is rendered, never withheld');
    assert.ok(c.envVars.some((e) => e.name === 'NPM_TOKEN' && e.mode === 'deny'));
    assert.ok(c.envVars.some((e) => e.name === 'GITHUB_TOKEN' && e.mode === 'deny'));
  });

  it('credentials still degrades when the OBSERVED version predates the capability', () => {
    const r = render({ credentials: 'deny' }, HARNESS_TOO_OLD);
    assert.match(degradesText(r), /2\.1\.186/, 'the degrade names the version it observed');
    assert.equal(r.sandbox.credentials, undefined, 'unsupported stays unrendered');
  });

  it('network-degrade-text-names-only-the-observed-version', () => {
    const t = degradesText(render({ network: 'deny' }, HARNESS_SUPPORTS));
    assert.match(t, /network=deny/);
    assert.match(t, /2\.1\.215/, 'names the observed version');
    assert.ok(!/2\.1\.185/.test(t), 'never names a version the tool did not observe');
  });

  it('fs-outside-repo-degrade-text-names-only-the-observed-version', () => {
    const t = degradesText(render({ fs_outside_repo: 'ask' }, HARNESS_SUPPORTS));
    assert.match(t, /fs_outside_repo=ask/);
    assert.match(t, /2\.1\.215/, 'names the observed version');
    assert.ok(!/2\.1\.185/.test(t), 'never names a version the tool did not observe');
  });

  it('version-probe-failure-degrades-loudly-and-states-the-unknown', () => {
    const r = render({ credentials: 'deny' }, HARNESS_UNKNOWN);
    const t = degradesText(r);
    assert.match(t, /could not be determined/i, 'the unknown is stated, never resolved by assumption');
    assert.match(t, /no claude CLI resolved on PATH/, 'the degrade carries the probe reason');
    assert.equal(r.sandbox.credentials, undefined, 'never render what could not be confirmed');
  });
});

// Every case injects findOnPath — the ONE seam. Injecting a lower-level dep instead lets the probe
// fall through to the real PATH of the host running the suite, which passes for the wrong reason
// and would keep passing after the logic broke.
describe('velocity --autonomy — probeHarnessVersion (read-only, no spawn)', () => {
  const located = (path) => ({ findOnPath: () => ({ bin: 'claude', state: 'present', path }) });
  // An EXPECTED walk failure: no package.json at that ancestor. It carries an fs error code, which
  // is exactly what the probe is allowed to skip — unlike a defect, which must rethrow.
  const throwingRead = () => { throw Object.assign(new Error('ENOENT: no package.json'), { code: 'ENOENT' }); };

  it('resolves the version from a version-named install path', () => {
    const p = probeHarnessVersion(located('/home/u/.local/share/claude/versions/2.1.215'));
    assert.equal(p.version, '2.1.215');
    assert.match(p.reason, /2\.1\.215/, 'the reason names where the answer came from');
  });

  it('resolves the version from an npm install package.json', () => {
    const p = probeHarnessVersion({
      ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      readFile: () => JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.215' }),
    });
    assert.equal(p.version, '2.1.215');
  });

  // A false "supported" is strictly worse than an unknown: it renders a protection that is not
  // there, while an unknown at least degrades loudly. So identity is matched exactly, both ways.
  it('a third-party wrapper whose package name merely CONTAINS claude resolves to unknown', () => {
    const p = probeHarnessVersion({
      ...located('/usr/lib/node_modules/my-claude-wrapper/bin/claude'),
      readFile: () => JSON.stringify({ name: 'my-claude-wrapper', version: '9.0.0' }),
    });
    assert.equal(p.version, null, 'a name that merely contains "claude" is not the harness');
  });

  it('a bare executable with a semver basename is NOT read as a native install', () => {
    const p = probeHarnessVersion({ ...located('/opt/tools/2.1.215'), readFile: throwingRead });
    assert.equal(p.version, null, 'the native layout requires the versions/ parent, not just a semver name');
  });

  it('a CODED programming defect is still rethrown — a code is not a licence to swallow', () => {
    assert.throws(
      () => probeHarnessVersion({
        ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
        readFile: () => { throw Object.assign(new TypeError('bad arg'), { code: 'ERR_INVALID_ARG_TYPE' }); },
      }),
      TypeError,
      'Node attaches codes to defects too, so a bare code check would hide this one',
    );
  });

  // EACCES is deliberately absent from the skip list: an unreadable package.json means we CANNOT
  // CONFIRM, which must surface rather than quietly read as "not the harness here, keep walking".
  it('an UNREADABLE package.json surfaces — "cannot confirm" is never folded into "not found"', () => {
    assert.throws(
      () => probeHarnessVersion({
        ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
        readFile: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
      }),
      /permission denied/,
    );
  });

  it('an EACCES at an ancestor visited AFTER the answer never aborts a succeeded probe', () => {
    const p = probeHarnessVersion({
      ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      readFile: (path) => {
        if (path === '/usr/lib/node_modules/@anthropic-ai/claude-code/package.json') {
          return JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.215' });
        }
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    assert.equal(p.version, '2.1.215', 'the walk stops at the confirmed package');
  });

  it('a versions/ layout under a FOREIGN parent is not the harness', () => {
    const p = probeHarnessVersion({ ...located('/opt/my-wrapper/versions/9.0.0'), readFile: throwingRead });
    assert.equal(p.version, null, 'the full claude/versions/<version> segment must match, not just versions/');
  });

  it('a PRERELEASE package version is unknown, never rounded down to the stable release', () => {
    const p = probeHarnessVersion({
      ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      readFile: () => JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.187-beta.0' }),
    });
    assert.equal(p.version, null, 'a prerelease is not the stable release that carries the capability');
  });

  it('a decorated version segment is unknown, never a prefix-parsed guess', () => {
    const p = probeHarnessVersion({ ...located('/home/u/.local/share/claude/versions/2.1.215-tampered'), readFile: throwingRead });
    assert.equal(p.version, null);
  });

  it('a programming defect inside the walk is rethrown, never reported as an unknown layout', () => {
    assert.throws(
      () => probeHarnessVersion({
        ...located('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
        readFile: () => { throw new TypeError('a real defect'); },
      }),
      TypeError,
      'swallowing this would make the probe misattribute its own failure',
    );
  });

  it('an unrecognised install layout is a STATED unknown, never a guess in either direction', () => {
    const p = probeHarnessVersion({ ...located('/opt/claude/bin/claude'), readFile: throwingRead });
    assert.equal(p.version, null);
    assert.match(p.reason, /install layout/, 'the unknown names its own cause');
  });

  it('no claude on PATH → a stated unknown', () => {
    const p = probeHarnessVersion({ findOnPath: () => ({ bin: 'claude', state: 'missing', path: null }) });
    assert.equal(p.version, null);
    assert.match(p.reason, /PATH/);
  });
});
