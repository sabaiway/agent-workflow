import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACKS_FILE, factFingerprint } from '../ack-store.mjs';
import { buildRecommendations, formatRecommendations, main, SEVERITY_OPTIONAL } from '../recommendations.mjs';
import { shellQuoteArg as q } from '../review-state.mjs';
import { hermeticGitEnv } from '../git-env.mjs';

// The probe and the facts leaf are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const loaded = await import('../recommendations.mjs');
const probeJevConnect = loaded.probeJevConnect ?? (() => { throw new Error('probeJevConnect is absent'); });
const probeJevSkill = loaded.probeJevSkill ?? (() => { throw new Error('probeJevSkill is absent'); });
const facts = await import('../jev-facts.mjs').catch(() => ({}));
const lanes = await import('../write-lanes.mjs').catch(() => ({}));
const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userStep = () => `your own step — it asks for the key in your terminal and the key never goes into the chat — run in a terminal of your own: node ${facts.quoteArg(join(TOOLS, 'jev-connect.mjs'))}`;
const skillSlot = (variant, root, dir) => {
  const check = ['node', ...[join(TOOLS, 'apply-danger-check.mjs'), '--variant', variant, '--cwd', root, '--claude-dir', dir]
    .map((arg) => facts.quoteArg(arg))].join(' ');
  return { check, apply: `${check} --apply --expect <digest>` };
};
const assertSkillSlot = (item, root, home, env = KEYS.set) => {
  const dir = facts.claudeDirOf(env, home).dir;
  const slot = skillSlot(item.variant, root, dir);
  assert.equal(item.lane, 'harness');
  assert.deepEqual({ check: item.check, apply: item.apply }, slot);
  assert.deepEqual(need(lanes, 'applySlot')(item.variant, { toolsDir: TOOLS, root, env, home, claudeDir: dir }), slot);
  assert.notEqual(item.apply, facts.skillLine(TOOLS, undefined, dir));
  assert.deepEqual(need(lanes, 'consoleArgv')(item.variant, { toolsDir: TOOLS, root, env, home, claudeDir: dir }), {
    preview: ['node', join(TOOLS, 'jev-skill.mjs'), '--claude-dir', dir],
    apply: ['node', join(TOOLS, 'jev-skill.mjs'), '--apply', '--claude-dir', dir],
  });
};
const KEY = 'TYPESAFE_API_KEY';
const LANE = 'jev-connect';
const DECLINE = factFingerprint('jev-connect:declined');
const OTHER = factFingerprint('jev-connect:another-fact');
const WHAT = "Jev (TypeSafe) is not connected: TYPESAFE_API_KEY is not in the environment the agent's commands run in";
const BENEFIT = "decisions — a typed choice with a confidence in under a second for your code and the agent's scripts, once for every project here";
const CANARIES = ['tsk-G7h8', 'Vs6_a-longer-canary-value-for-the-advisor.k'];
const KEYS = { set: { [KEY]: CANARIES[0] }, absent: {}, empty: { [KEY]: '' }, 'whitespace-only': { [KEY]: ' \t ' } };
const ACKS = { absent: null, declined: DECLINE, 'another fingerprint': OTHER, unreadable: null };

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const projectOf = (ack = null) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-offer-'));
  made.push(root);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (ack !== null) writeFileSync(join(root, ACKS_FILE), `${JSON.stringify({ jevConnectAck: ack })}\n`);
  return root;
};
// Every path deps.lstat is given is recorded; the unreadable ack throws EACCES at the root's docs/ai/acks.json.
const recordingLstat = (root, unreadable, seen) => (path) => {
  seen.push(path);
  if (unreadable && path === join(root, ACKS_FILE)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
  return lstatSync(path);
};
const alone = (root, deps = {}) => buildRecommendations({ cwd: root, deps: { probes: [probeJevConnect], ...deps } });
// HOME at a temp dir and CLAUDE_CONFIG_DIR unset for a main with no ctx.deps, so the default route never reads the real skill roots.
const withHome = (fn) => {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = mkdtempSync(join(tmpdir(), 'jev-offer-home-'));
  made.push(process.env.HOME);
  delete process.env.CLAUDE_CONFIG_DIR;
  try { return fn(); } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};
const withKey = (value, fn) => {
  const saved = Object.hasOwn(process.env, KEY) ? process.env[KEY] : undefined;
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
};
const advisorRun = (root, argv = []) => {
  const result = withHome(() => main(['--cwd', root, ...argv]));
  assert.equal(result.code, 0, result.stderr);
  return result;
};
const offersIn = (result) => JSON.parse(result.stdout).items.filter(({ key }) => key === LANE);
// A probe span: from the comment block directly above export const <name> to its closing `};`.
const probeSpan = (source, name = 'probeJevConnect') => {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`export const ${name} = `));
  assert.ok(at > 0, `export const ${name}`);
  const first = at - [...lines.slice(0, at)].reverse().findIndex((line) => !line.startsWith('//'));
  return lines.slice(first, lines.findIndex((line, index) => index > at && line === '};') + 1).join('\n');
};

describe('spec:jev-guide/S17 the state table: key × ack, one conjunction admits the item', () => {
  for (const [keyName, env] of Object.entries(KEYS)) {
    for (const [ackName, ack] of Object.entries(ACKS)) {
      it(`key ${keyName} × ack ${ackName}`, () => {
        const root = projectOf(ack);
        const seen = [];
        const { items, skips } = alone(root, { getenv: env, lstat: recordingLstat(root, ackName === 'unreadable', seen) });
        const notSet = keyName !== 'set';
        const offered = notSet && ['absent', 'another fingerprint'].includes(ackName);
        const skipped = notSet && ackName === 'unreadable';
        assert.deepEqual(items.map(({ key }) => key), offered ? [LANE] : []);
        assert.deepEqual(skips.map(({ key }) => key), skipped ? [LANE] : []);
        if (!notSet) assert.ok(!seen.includes(join(root, ACKS_FILE)), 'the key-set row never reads the ack');
      });
    }
  }
});

describe('spec:jev-guide/S18 the item and the decline round trip', () => {
  it('renders the exact optional user item and apply-only argv; only the decline fingerprint hides it after the recipe round trip', () => {
    const root = projectOf();
    const { items, skips } = alone(root, { getenv: {} });
    assert.deepEqual(need(lanes, 'applySlot')(LANE, { toolsDir: TOOLS }), { check: null, apply: userStep() });
    assert.deepEqual(need(lanes, 'consoleArgv')(LANE, { toolsDir: TOOLS }), { preview: null, apply: ['node', join(TOOLS, 'jev-connect.mjs')] });
    assert.equal(skips.length, 0);
    assert.deepEqual(items, [{ key: LANE, variant: LANE, severity: SEVERITY_OPTIONAL, lane: 'user', what: WHAT, benefit: BENEFIT,
      check: null, apply: userStep(),
      detail: `HAND-APPLY alternative (instead of the apply, never after it): decline the offer by recording it — node ${q(join(TOOLS, 'ack-write.mjs'))} --lane ${LANE} --fingerprint ${DECLINE} --cwd ${q(root)}` }]);
    assert.ok(formatRecommendations({ items, skips }).includes(WHAT));
    assert.doesNotMatch(items[0].apply, /applies at your next|restart the agent/);
    const command = items[0].detail.slice(items[0].detail.indexOf('— ') + '— '.length);
    const env = hermeticGitEnv({ PATH: process.env.PATH }, root);
    const wrong = spawnSync('sh', ['-c', `${command.replace(DECLINE, OTHER)} --apply`], { encoding: 'utf8', cwd: root, env });
    assert.equal(wrong.error, undefined);
    assert.equal(wrong.signal, null);
    assert.equal(wrong.status, 0, wrong.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ACKS_FILE), 'utf8')), { jevConnectAck: OTHER });
    assert.equal(alone(root, { getenv: {} }).items.length, 1);
    const written = spawnSync('sh', ['-c', `${command} --apply`], { encoding: 'utf8', cwd: root, env });
    assert.equal(written.error, undefined);
    assert.equal(written.signal, null);
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ACKS_FILE), 'utf8')), { jevConnectAck: DECLINE });
    assert.deepEqual(alone(root, { getenv: {} }), { root, items: [], skips: [] });
  });

  it('opens the recipe line only with the injected container place and keeps the apply byte-equal to the user slot', () => {
    const root = projectOf();
    const [plain] = alone(root, { getenv: {} }).items;
    const { items, skips } = alone(root, { getenv: {}, jevHost: { container: true } });
    assert.equal(skips.length, 0);
    assert.deepEqual(items.map(({ apply }) => apply), [userStep()]);
    assert.deepEqual(need(lanes, 'applySlot')(LANE, { toolsDir: TOOLS }), { check: null, apply: userStep() });
    assert.equal(items[0].detail, `run the apply in a terminal inside this container; ${plain.detail}`);
    assert.ok(plain.detail.startsWith('HAND-APPLY alternative'), plain.detail);
  });

});

describe('spec:jev-guide/S20 the hermetic seam and the canary', () => {
  it('buildRecommendations with deps lacking getenv renders the item under a canary key in process.env', () => {
    withKey(CANARIES[0], () => assert.deepEqual(alone(projectOf()).items.map(({ key }) => key), [LANE]));
  });

  it('main with no ctx.deps renders no item under either canary and the item with the variable absent', () => {
    const root = projectOf();
    for (const canary of CANARIES) withKey(canary, () => assert.deepEqual(offersIn(advisorRun(root, ['--json'])), [], canary));
    withKey(undefined, () => assert.equal(offersIn(advisorRun(root, ['--json'])).length, 1));
  });

  it('under both canaries no plain or --json output of the advisor carries either value', () => {
    const root = projectOf();
    for (const canary of CANARIES) {
      withKey(canary, () => {
        for (const result of [advisorRun(root), advisorRun(root, ['--json'])]) {
          for (const value of CANARIES) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), `${canary}: ${value}`);
        }
      });
    }
  });
});

describe('spec:jev-guide/S21 one key rule, one leaf: the facts leaf exports it, the probes and the guide import it', () => {
  const importLine = (source) => source.split('\n').find((item) => /^import \{[^}]*\} from '\.\/jev-facts\.mjs';$/.test(item));
  const namesOf = (line) => line.match(/\{([^}]*)\}/)[1].split(',').map((name) => name.trim()).filter(Boolean).sort();

  it('each probe span calls keySet( and carries no .trim( and no key name; the connect span carries no connectLine(, the skill span calls skillLine(', () => {
    const source = readFileSync(join(TOOLS, 'recommendations.mjs'), 'utf8');
    for (const name of ['probeJevConnect', 'probeJevSkill']) {
      const span = probeSpan(source, name);
      assert.ok(span.includes('keySet('), span);
      assert.ok(!span.includes('.trim(') && !span.includes(KEY), span);
    }
    assert.ok(!probeSpan(source).includes('connectLine('), probeSpan(source));
    assert.ok(probeSpan(source, 'probeJevSkill').includes('skillLine('), probeSpan(source, 'probeJevSkill'));
  });

  it('the advisor imports exactly its nine names from ./jev-facts.mjs and nothing from the guide', () => {
    const source = readFileSync(join(TOOLS, 'recommendations.mjs'), 'utf8');
    assert.deepEqual(namesOf(importLine(source)), ['NO_APPLY_LINE', 'SKILL_PINS', 'claudeDirOf', 'keySet', 'placeOf',
      'printable', 'skillLine', 'skillState', 'skillTargets'].sort());
    assert.doesNotMatch(source, /from '\.\/jev-guide\.mjs'/);
  });

  it('the guide imports exactly the thirteen names of S7; the facts leaf imports join, posix and win32 and createHash only', () => {
    const guide = readFileSync(join(TOOLS, 'jev-guide.mjs'), 'utf8');
    assert.deepEqual(namesOf(importLine(guide)), ['AFTER_INSTALL', 'KEY_VARIABLE', 'NO_APPLY_LINE', 'RESTART_STEP', 'SKILL_PINS',
      'claudeDirOf', 'connectLine', 'keySet', 'placeOf', 'printable', 'skillLine', 'skillState', 'skillTargets'].sort());
    const facts = readFileSync(join(TOOLS, 'jev-facts.mjs'), 'utf8');
    assert.deepEqual(facts.match(/^import .*$/gm).sort(), ["import { createHash } from 'node:crypto';", "import { join, posix, win32 } from 'node:path';"]);
  });
});

// ── the jev-skill item (part jev-offer, revision 5) ──────────────────────────────────────────────────
const SKILL_LANE = 'jev-skill';
const VENDOR = resolve(TOOLS, '..', 'references', 'vendor', 'typesafe-ai');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The vendored pair is read guarded, so the suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };
const pairs = {
  current: { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') },
  older: { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') },
  oldest: { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.5\n'), LICENSE: Buffer.from('MIT at v0.5.5\n') },
};
const pinOf = (tag, pair) => ({ tag, commit: tag, digests: { 'SKILL.md': digest(pair['SKILL.md']), LICENSE: digest(pair.LICENSE) } });
const PINS = [pinOf('v0.5.7', pairs.current), pinOf('v0.5.6', pairs.older), pinOf('v0.5.5', pairs.oldest)];
const SKILL_DECLINE = factFingerprint('jev-skill:declined:v0.5.7');
const SKILL_WHAT = "Jev's vendor skill is not installed for every agent here: a skill root the kit fills is absent or behind the kit's pin";
const SKILL_BENEFIT = 'the TypeSafe skill for Claude Code, Codex and Antigravity CLI, one pinned verified copy per agent root, from one command you run';
const earlierWhat = (old) => `Jev's vendor skill in the agent skill roots is at ${old}, behind the kit's pin v0.5.7; only copies matching a kit pin change`;
const fillPair = (dir, pair) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pair)) writeFileSync(join(dir, name), bytes);
};
const homeTargets = (home, claude = join(home, '.claude')) => [join(home, '.agents', 'skills', 'typesafe-ai'),
  join(claude, 'skills', 'typesafe-ai'), join(home, '.gemini', 'config', 'skills', 'typesafe-ai')];
// A home whose three targets hold the given pairs (null: absent, 'foreign': a copy holding an extra entry).
const homeOf = (states) => {
  const home = mkdtempSync(join(tmpdir(), 'jev-offer-skill-'));
  made.push(home);
  homeTargets(home).forEach((path, index) => {
    const state = states[index];
    if (state === 'foreign') fillPair(path, { ...pairs.current, 'notes.txt': 'mine\n' });
    else if (state) fillPair(path, pairs[state]);
  });
  return home;
};
const skillAlone = (root, deps) => buildRecommendations({ cwd: root, deps: { probes: [probeJevSkill], jevPins: PINS, ...deps } });
const skillAckRoot = (ack) => {
  const root = projectOf();
  if (ack !== null) writeFileSync(join(root, ACKS_FILE), `${JSON.stringify({ jevSkillAck: ack })}\n`);
  return root;
};
const TARGET_ROWS = {
  'all current': ['current', 'current', 'current'],
  'one absent': [null, 'current', 'current'],
  'one earlier': ['current', 'older', 'current'],
  'one foreign only': ['foreign', 'current', 'current'],
  'absent and earlier mixed': [null, 'older', 'current'],
};
const SKILL_ACKS = { absent: null, declined: SKILL_DECLINE, 'another fingerprint': OTHER, unreadable: null };
const recordFor = (root) => `HAND-APPLY alternative (instead of the apply, never after it): decline the offer by recording it — node ${q(join(TOOLS, 'ack-write.mjs'))} --lane ${SKILL_LANE} --fingerprint ${SKILL_DECLINE} --cwd ${q(root)}`;

describe('spec:jev-guide/S35 the jev-skill item through deps.probes alone', () => {
  for (const [keyName, env] of Object.entries(KEYS)) {
    for (const [rowName, states] of Object.entries(TARGET_ROWS)) {
      for (const [ackName, ack] of Object.entries(SKILL_ACKS)) {
        it(`key ${keyName} × ${rowName} × ack ${ackName}`, () => {
          const root = skillAckRoot(ack);
          const home = homeOf(states);
          const seen = [];
          const { items, skips } = skillAlone(root, { getenv: env, jevHost: { home }, lstat: recordingLstat(root, ackName === 'unreadable', seen) });
          const needs = states.some((state) => state === null || state === 'older');
          const judged = keyName === 'set' && needs;
          const offered = judged && ['absent', 'another fingerprint'].includes(ackName);
          assert.deepEqual(items.map(({ key }) => key), offered ? [SKILL_LANE] : []);
          assert.deepEqual(skips.map(({ key }) => key), judged && ackName === 'unreadable' ? [SKILL_LANE] : []);
          if (!judged) assert.ok(!seen.includes(join(root, ACKS_FILE)), 'the ack is read only when some target needs the install');
          if (offered) assert.equal(items[0].variant, states.includes('older') ? 'jev-skill.earlier' : SKILL_LANE);
        });
      }
    }
  }

  it('renders the exact optional harness slot and argv with --claude-dir; the recipe records the decline and hides the next offer', () => {
    const root = projectOf();
    const home = homeOf([null, 'current', 'current']);
    const deps = { getenv: KEYS.set, jevHost: { home } };
    const { items, skips } = skillAlone(root, deps);
    assertSkillSlot(items[0], root, home);
    assert.equal(skips.length, 0);
    assert.deepEqual(items, [{ key: SKILL_LANE, variant: SKILL_LANE, severity: SEVERITY_OPTIONAL, lane: 'harness', what: SKILL_WHAT, benefit: SKILL_BENEFIT,
      ...skillSlot(SKILL_LANE, root, join(home, '.claude')), detail: recordFor(root) }]);
    const command = items[0].detail.slice(items[0].detail.lastIndexOf('— ') + '— '.length);
    const env = hermeticGitEnv({ PATH: process.env.PATH }, home);
    const written = spawnSync('sh', ['-c', `${command} --apply`], { encoding: 'utf8', cwd: root, env });
    assert.equal(written.error, undefined);
    assert.equal(written.signal, null);
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ACKS_FILE), 'utf8')), { jevSkillAck: SKILL_DECLINE });
    assert.deepEqual(skillAlone(root, deps), { root, items: [], skips: [] });
  });

  it('the earlier harness slot names the earliest tag and the injected pins\' first tag through all three filesystem seams', () => {
    const root = projectOf();
    const home = homeOf(['current', 'older', 'current']);
    const two = skillAlone(root, { getenv: KEYS.set, jevHost: { home } }).items;
    assert.deepEqual(two.map(({ variant, what }) => [variant, what]), [['jev-skill.earlier', earlierWhat('v0.5.6')]]);
    assertSkillSlot(two[0], root, home);
    const injected = homeOf(['current', 'current', 'current']);
    const targets = homeTargets(injected);
    const pins = [pinOf('v9.0.0', pairs.current), pinOf('v8.0.0', pairs.older), pinOf('v7.0.0', pairs.oldest)];
    const seen = { lstat: [], readdir: [], readFile: [] };
    const three = skillAlone(root, { getenv: KEYS.set, jevHost: { home: injected }, jevPins: pins,
      lstat: (path) => {
        seen.lstat.push(path);
        return lstatSync(path);
      },
      readdir: (path) => {
        seen.readdir.push(path);
        return readdirSync(path);
      },
      readFile: (path, ...args) => {
        seen.readFile.push(path);
        const at = targets.findIndex((target) => dirname(path) === target);
        if (at > 0) return pairs[at === 1 ? 'older' : 'oldest'][path.endsWith('LICENSE') ? 'LICENSE' : 'SKILL.md'];
        return readFileSync(path, ...args);
      } }).items;
    assert.equal(three[0].variant, 'jev-skill.earlier');
    assert.equal(three[0].what, "Jev's vendor skill in the agent skill roots is at v7.0.0, behind the kit's pin v9.0.0; only copies matching a kit pin change");
    assertSkillSlot(three[0], root, injected);
    for (const target of targets) {
      assert.ok(seen.lstat.includes(target), target);
      assert.ok(seen.readdir.includes(target), target);
      for (const name of ['SKILL.md', 'LICENSE']) assert.ok(seen.readFile.includes(join(target, name)), target);
    }
    assert.ok(three[0].detail.includes(factFingerprint('jev-skill:declined:v9.0.0')));
  });

  it('renders nothing for a deps without jevHost.home and nothing, no skip, for a foreign-only home', () => {
    const root = projectOf();
    assert.deepEqual(skillAlone(root, { getenv: KEYS.set }), { root, items: [], skips: [] });
    assert.deepEqual(skillAlone(root, { getenv: KEYS.set, jevHost: { home: homeOf(['foreign', 'foreign', 'foreign']) } }),
      { root, items: [], skips: [] });
  });

  it('an absolute CLAUDE_CONFIG_DIR moves the judged target and harness slot; a relative one keeps <home>/.claude and the recipe note', () => {
    const root = projectOf();
    const home = homeOf(['current', 'current', 'current']);
    const cc = join(home, 'elsewhere', 'cc');
    const absoluteEnv = { ...KEYS.set, CLAUDE_CONFIG_DIR: cc };
    const relativeEnv = { ...KEYS.set, CLAUDE_CONFIG_DIR: 'rel/cc' };
    const [moved] = skillAlone(root, { getenv: absoluteEnv, jevHost: { home } }).items;
    assertSkillSlot(moved, root, home, absoluteEnv);
    assert.deepEqual(need(lanes, 'consoleArgv')(SKILL_LANE, { toolsDir: TOOLS, env: absoluteEnv, home }).apply, ['node', join(TOOLS, 'jev-skill.mjs'), '--apply', '--claude-dir', cc]);
    assert.equal(moved.detail, recordFor(root));
    const note = `CLAUDE_CONFIG_DIR is set to rel/cc, not an absolute path: the Claude Code target is ${join(home, '.claude')}`;
    assert.deepEqual(skillAlone(root, { getenv: relativeEnv, jevHost: { home } }).items, []);
    rmSync(homeTargets(home)[1], { recursive: true });
    const [relative] = skillAlone(root, { getenv: relativeEnv, jevHost: { home } }).items;
    assertSkillSlot(relative, root, home, relativeEnv);
    assert.deepEqual(need(lanes, 'consoleArgv')(SKILL_LANE, { toolsDir: TOOLS, env: relativeEnv, home }).apply, ['node', join(TOOLS, 'jev-skill.mjs'), '--apply', '--claude-dir', join(home, '.claude')]);
    assert.equal(relative.detail, `${note}; ${recordFor(root)}`);
  });

  it('a claude dir holding a tab renders no item and one stated skip whose reason is NO_APPLY_LINE', () => {
    const root = projectOf();
    const home = homeOf(['current', 'current', 'current']);
    const { items, skips } = skillAlone(root, { getenv: { ...KEYS.set, CLAUDE_CONFIG_DIR: join(home, `c${String.fromCharCode(9)}c`) }, jevHost: { home } });
    assert.deepEqual(items, []);
    assert.deepEqual(skips, [{ key: SKILL_LANE, reason: facts.NO_APPLY_LINE }]);
  });

  it('the harness slot keeps the recipe place, every foreign target through printable, the note and the decline tail', () => {
    const root = projectOf();
    const home = homeOf(['foreign', null, 'foreign']);
    const odd = join(home, `odd${String.fromCharCode(7)}`);
    const env = { ...KEYS.set, CLAUDE_CONFIG_DIR: 'rel/cc' };
    const [item] = skillAlone(root, { getenv: env, jevHost: { home, container: true } }).items;
    assertSkillSlot(item, root, home, env);
    const note = `CLAUDE_CONFIG_DIR is set to rel/cc, not an absolute path: the Claude Code target is ${join(home, '.claude')}`;
    assert.equal(item.detail, `run the apply in a terminal inside this container; left untouched: ${homeTargets(home)[0]} — holds LICENSE, SKILL.md, notes.txt; left untouched: ${homeTargets(home)[2]} — holds LICENSE, SKILL.md, notes.txt; ${note}; ${recordFor(root)}`);
    fillPair(join(odd, '.agents', 'skills', 'typesafe-ai'), { ...pairs.current, 'notes.txt': 'mine\n' });
    const clean = join(home, 'cc');
    const [shown] = skillAlone(root, { getenv: { ...KEYS.set, CLAUDE_CONFIG_DIR: clean }, jevHost: { home: odd } }).items;
    assertSkillSlot(shown, root, odd, { ...KEYS.set, CLAUDE_CONFIG_DIR: clean });
    assert.ok(shown.detail.startsWith(`left untouched: ${join(home, 'odd?', '.agents', 'skills', 'typesafe-ai')} — holds `), shown.detail);
    assert.ok(!shown.detail.includes(String.fromCharCode(7)));
  });

});
