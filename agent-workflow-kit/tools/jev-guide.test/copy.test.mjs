import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACKS_FILE, factFingerprint } from '../ack-store.mjs';
import { buildRecommendations, ITEM_LINE_CAP, probeJevSkill, SEVERITY_OPTIONAL } from '../recommendations.mjs';
import * as facts from '../jev-facts.mjs';
import * as lanes from '../write-lanes.mjs';
import { PINS, TOOLS, fillPair, homeOf, homeTargets, pairs, projectWith, recordingLstat, skillSlot, tempDir } from './harness.test.mjs';

const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const KIT = 'jev-skill.not-current';
const KIT_WHAT = (n) => `Jev's vendor skill is absent or behind the kit's pin in ${n} agent skill root(s) beside a copy at a kit pin — written with no question`;
const KIT_BENEFIT = "currency — every agent skill root the kit fills holds the vendor skill at the kit's pin once a copy is placed";
const KEYS = { set: { TYPESAFE_API_KEY: 'tsk-copy' }, 'not set': {} };
const ACKS = {
  absent: null,
  'declined at the first tag': factFingerprint(`jev-skill:declined:${PINS[0].tag}`),
  'declined at an earlier tag': factFingerprint(`jev-skill:declined:${PINS[1].tag}`),
  unreadable: null,
};
// Accepted homes (some target current or earlier): the planned targets read absent or earlier.
const ROWS = {
  'all current': ['current', 'current', 'current'],
  'one absent beside two current': [null, 'current', 'current'],
  'one earlier': ['current', 'older', 'current'],
  'absent and earlier mixed': [null, 'older', 'current'],
  'current beside foreign': ['current', 'foreign', 'foreign'],
  'earlier beside foreign and absent': ['older', 'foreign', null],
};
const planned = (states) => states.filter((state) => state === null || state === 'older').length;
const kitAlone = (root, deps) => buildRecommendations({ cwd: root, deps: { probes: [probeJevSkill], jevPins: PINS, ...deps } });
const BEL = String.fromCharCode(7);

describe('spec:jev-guide/S37 the kit arm: the acceptance and jev-skill.not-current', () => {
  it('skillAccepted is true exactly when a judged record reads current or earlier', () => {
    const skillAccepted = need(facts, 'skillAccepted');
    const recordsOf = (states) => states.map((state) => ({ agent: 'Codex', path: '/h/t', state, tag: null, reason: null }));
    const cells = [[[], false], [['absent'], false], [['foreign'], false], [['absent', 'foreign', 'absent'], false],
      [['current'], true], [['earlier'], true], [['absent', 'foreign', 'earlier'], true], [['foreign', 'current'], true]];
    for (const [states, expected] of cells) assert.equal(skillAccepted(recordsOf(states)), expected, states.join(', ') || 'no record');
  });

  it('the advisor and the danger check import skillAccepted from the facts leaf', () => {
    for (const file of ['recommendations.mjs', 'apply-danger-check.mjs']) {
      const names = readFileSync(join(TOOLS, file), 'utf8').match(/^import \{([^}]*)\} from '\.\/jev-facts\.mjs';$/m)?.[1] ?? '';
      assert.ok(names.split(',').map((name) => name.trim()).includes('skillAccepted'), `${file}: ${names}`);
    }
  });

  for (const [keyName, env] of Object.entries(KEYS)) {
    for (const [rowName, states] of Object.entries(ROWS)) {
      for (const [ackName, ack] of Object.entries(ACKS)) {
        it(`key ${keyName} × ${rowName} × ack ${ackName}`, () => {
          const root = projectWith(ack === null ? null : { jevSkillAck: ack });
          const seen = [];
          const { items, skips } = kitAlone(root, { getenv: env, jevHost: { home: homeOf(states) }, lstat: recordingLstat(root, ackName === 'unreadable', seen) });
          assert.deepEqual(items.map(({ key, variant }) => [key, variant]), planned(states) > 0 ? [['jev-skill', KIT]] : []);
          assert.deepEqual(skips, []);
          assert.ok(!seen.includes(join(root, ACKS_FILE)), 'an accepted row never reads the ack');
        });
      }
    }
  }

  it('the item: key, severity, lane kit, the WHAT at one, two and three planned targets, the benefit and applySlot\'s lines', () => {
    for (const states of [[null, 'current', 'current'], [null, 'current', 'older'], ['older', 'older', 'older']]) {
      const root = projectWith();
      const home = homeOf(states);
      const targets = homeTargets(home).filter((path, index) => states[index] !== 'current');
      const slot = skillSlot(KIT, root, join(home, '.claude'));
      const { items } = kitAlone(root, { getenv: {}, jevHost: { home } });
      assert.deepEqual(items, [{ key: 'jev-skill', variant: KIT, severity: SEVERITY_OPTIONAL, lane: 'kit', what: KIT_WHAT(targets.length),
        benefit: KIT_BENEFIT, ...slot, detail: `writes: ${targets.join(', ')}` }]);
      assert.ok(items[0].what.length <= ITEM_LINE_CAP, items[0].what);
      assert.deepEqual(need(lanes, 'applySlot')(KIT, { toolsDir: TOOLS, root, env: {}, home }), slot);
    }
  });

  it('an absolute CLAUDE_CONFIG_DIR moves the judged Claude Code target and the --claude-dir of both lines', () => {
    const root = projectWith();
    const home = homeOf(['current', null, null]);
    const cc = join(home, 'elsewhere', 'cc');
    const { items } = kitAlone(root, { getenv: { CLAUDE_CONFIG_DIR: cc }, jevHost: { home } });
    assert.deepEqual(items.map(({ variant, check, apply, detail }) => ({ variant, check, apply, detail })), [{ variant: KIT, ...skillSlot(KIT, root, cc),
      detail: `writes: ${join(cc, 'skills', 'typesafe-ai')}, ${homeTargets(home)[2]}` }]);
  });

  it('the recipe line names each foreign target and each planned path through printable, with no place prefix and no decline', () => {
    const root = projectWith();
    const cc = join(tempDir('jev-copy-cc-'), 'cc');
    fillPair(join(cc, 'skills', 'typesafe-ai'), pairs.current);
    const odd = homeOf(['foreign', null, null], join(tempDir('jev-copy-'), `odd${BEL}`));
    const [codex, , agy] = homeTargets(odd).map((path) => path.replaceAll(BEL, '?'));
    const { items } = kitAlone(root, { getenv: { CLAUDE_CONFIG_DIR: cc }, jevHost: { home: odd, container: true } });
    assert.deepEqual(items.map(({ variant, detail }) => [variant, detail]), [[KIT, `writes: ${agy}; left untouched: ${codex} — holds LICENSE, SKILL.md, notes.txt`]]);
    assert.ok(!/run the apply in|decline alternative|ack-write/.test(items[0].detail), items[0].detail);
  });

  it('a relative CLAUDE_CONFIG_DIR judges <home>/.claude and closes the recipe line with its note', () => {
    const root = projectWith();
    const home = homeOf(['current', null, null]);
    const [, claude, agy] = homeTargets(home);
    const note = `CLAUDE_CONFIG_DIR is set to rel/cc, not an absolute path: the Claude Code target is ${join(home, '.claude')}`;
    const { items } = kitAlone(root, { getenv: { CLAUDE_CONFIG_DIR: 'rel/cc' }, jevHost: { home } });
    assert.deepEqual(items.map(({ variant, detail }) => [variant, detail]), [[KIT, `writes: ${claude}, ${agy}; ${note}`]]);
  });

  it('a claude dir holding a tab gives one stated skip naming jev-skill, NO_APPLY_LINE, and no item; no jevHost.home renders nothing', () => {
    const root = projectWith();
    const home = homeOf(['current', null, null]);
    const tabbed = kitAlone(root, { getenv: { CLAUDE_CONFIG_DIR: join(home, `c${String.fromCharCode(9)}c`) }, jevHost: { home } });
    assert.deepEqual(tabbed, { root, items: [], skips: [{ key: 'jev-skill', reason: facts.NO_APPLY_LINE }] });
    assert.deepEqual(kitAlone(root, { getenv: {}, jevHost: {} }), { root, items: [], skips: [] });
  });
});
