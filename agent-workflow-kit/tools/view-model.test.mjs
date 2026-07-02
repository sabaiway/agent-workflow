import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toViewModel } from './view-model.mjs';
import { INTERNAL_RENDER_FORBIDDEN } from './labels.mjs';

// A full 4-block envelope (the buildEnvelope shape, incl. the additive installed[].refresh from Phase 3).
const fullEnvelope = () => ({
  deploymentHead: '1.3.0',
  installed: [
    { member: 'agent-workflow-kit', display: 'kit', version: '1.19.0', state: 'installed', refresh: { behind: false, recommend: null, freshness: 'not-checked' } },
    {
      member: 'agent-workflow-memory',
      display: 'memory',
      version: '1.0.0',
      state: 'installed',
      notes: ['the memory installed here is behind — run `npx @sabaiway/agent-workflow-memory@latest init`'],
      refresh: { behind: true, recommend: 'npx @sabaiway/agent-workflow-memory@latest init', freshness: 'behind' },
    },
    { member: 'agent-workflow-engine', display: 'engine', version: null, state: 'absent', refresh: { behind: false, recommend: null, freshness: 'not-checked' } },
    { member: 'codex-cli-bridge', display: 'codex-bridge', version: null, state: 'other-tool' },
    { member: 'antigravity-cli-bridge', display: 'antigravity-bridge', version: null, state: 'uncheckable' },
  ],
  bridges: [
    { member: 'codex-cli-bridge', display: 'codex-bridge', readiness: 'ready', wrappers: [{ cmd: 'codex-exec', state: 'present' }, { cmd: 'codex-review', state: 'missing' }] },
    { member: 'antigravity-cli-bridge', display: 'antigravity-bridge', readiness: 'needs-skill', wrappers: [{ cmd: 'agy-review', state: 'unknown' }, { cmd: 'agy-run', state: 'unknown' }] },
  ],
  project: {
    dir: '/proj',
    deployed: true,
    docsAi: true,
    deployStamps: [
      { member: 'agent-workflow-kit', display: 'kit', version: '1.3.0' },
      { member: 'agent-workflow-memory', display: 'memory', version: '1.0.0' },
    ],
    visibility: { state: 'hidden' },
    settings: {
      recipes: { configSource: 'docs/ai/orchestration.json', activities: { 'plan-authoring': { review: { recipe: 'reviewed' } }, 'plan-execution': { execute: { recipe: 'delegated' }, review: { recipe: 'council' } } } },
      attribution: { project: false, local: null, effective: false },
      velocity: { defaultMode: 'acceptEdits', allowEntries: { project: 1, local: 2 } },
    },
  },
});

describe('view-model — members', () => {
  it('maps display/version/state, resolves the state phrase, carries notes + the refresh fields', () => {
    const vm = toViewModel(fullEnvelope());
    const kit = vm.members[0];
    assert.equal(kit.display, 'kit');
    assert.equal(kit.version, '1.19.0');
    assert.equal(kit.statePhrase, null, 'installed → null (show the version)');
    assert.equal(kit.behind, false);

    const memory = vm.members[1];
    assert.equal(memory.behind, true);
    assert.equal(memory.recommend, 'npx @sabaiway/agent-workflow-memory@latest init');
    assert.deepEqual(memory.notes.length, 1);

    const engine = vm.members[2];
    assert.equal(engine.version, null);
    assert.equal(engine.statePhrase, 'not installed');

    assert.equal(vm.members[3].statePhrase, 'a different tool occupies that skill slot');
    assert.equal(vm.members[4].statePhrase, "couldn't be checked (a permission error)");
  });

  it('headline counts total + behind + the INV-C verdict scope (checked vs unknown)', () => {
    const vm = toViewModel(fullEnvelope());
    // memory carries freshness 'behind' → it is both the behind count and the only checked member here.
    assert.deepEqual(vm.headline, { total: 5, behind: 1, checked: 1, unknown: 0 });
  });

  it('an unknown freshness is counted separately from checked (INV-B never collapses)', () => {
    const vm = toViewModel({
      installed: [
        { member: 'agent-workflow-memory', display: 'memory', version: '1.7.0', state: 'installed', refresh: { behind: false, recommend: null, freshness: 'current' } },
        { member: 'codex-cli-bridge', display: 'codex-bridge', version: '2.1.0', state: 'installed', refresh: { behind: false, recommend: null, freshness: 'unknown' } },
      ],
    });
    assert.deepEqual(vm.headline, { total: 2, behind: 0, checked: 1, unknown: 1 });
  });

  it('a member without a refresh object defaults to not-behind + not-checked (additive back-compat)', () => {
    const vm = toViewModel({ installed: [{ member: 'agent-workflow-kit', display: 'kit', version: '1.19.0', state: 'installed' }] });
    assert.equal(vm.members[0].behind, false);
    assert.equal(vm.members[0].recommend, null);
    assert.deepEqual(vm.members[0].notes, []);
    assert.equal(vm.members[0].freshness, 'not-checked');
    // a legacy refresh WITHOUT the freshness field: behind stays behind, current is never assumed.
    const legacy = toViewModel({ installed: [{ member: 'x', display: 'x', version: '1.0.0', state: 'installed', refresh: { behind: true, recommend: 'cmd' } }] });
    assert.equal(legacy.members[0].freshness, 'behind');
  });
});

describe('view-model — bridges / project / settings', () => {
  it('bridges keep the three-state wrapper status', () => {
    const vm = toViewModel(fullEnvelope());
    assert.equal(vm.bridges.length, 2);
    assert.deepEqual(vm.bridges[0].wrappers, [{ cmd: 'codex-exec', state: 'present' }, { cmd: 'codex-review', state: 'missing' }]);
    assert.deepEqual(vm.bridges[1].wrappers, [{ cmd: 'agy-review', state: 'unknown' }, { cmd: 'agy-run', state: 'unknown' }]);
  });

  it('project stamps carry display/version only (never the internal filename); visibility → phrase', () => {
    const vm = toViewModel(fullEnvelope());
    assert.deepEqual(vm.project.deployStamps, [{ display: 'kit', version: '1.3.0' }, { display: 'memory', version: '1.0.0' }]);
    assert.equal(vm.project.visibility.phrase, 'hidden (git-ignored, local-only)');
  });

  it('settings: recipe pairs flatten activity.slot=recipe; attribution override is presence-and-differ; velocity counts', () => {
    const vm = toViewModel(fullEnvelope());
    assert.deepEqual(vm.project.settings.recipes.pairs, [
      { key: 'plan-authoring.review', recipe: 'reviewed' },
      { key: 'plan-execution.execute', recipe: 'delegated' },
      { key: 'plan-execution.review', recipe: 'council' },
    ]);
    assert.equal(vm.project.settings.attribution.override, false, 'local null → project value stands, not an override');
    assert.deepEqual(vm.project.settings.velocity, { defaultMode: 'acceptEdits', allow: { project: 1, local: 2 } });
  });

  it('a real local override is flagged (local set AND differs from project)', () => {
    const vm = toViewModel({ installed: [], project: { dir: '/p', deployed: true, settings: { attribution: { project: true, local: false, effective: false } } } });
    assert.equal(vm.project.settings.attribution.override, true);
  });

  it('per-area settings errors survive as { error }', () => {
    const vm = toViewModel({
      installed: [],
      project: { dir: '/p', deployed: true, settings: { recipes: { error: 'orchestration.json: bad' }, attribution: { error: 'settings.json: bad' }, velocity: { error: 'settings.local.json: bad' } } },
    });
    assert.match(vm.project.settings.recipes.error, /orchestration\.json/);
    assert.match(vm.project.settings.attribution.error, /settings\.json/);
    assert.match(vm.project.settings.velocity.error, /settings\.local\.json/);
  });

  it('a recipes detectError survives onto the VM', () => {
    const vm = toViewModel({ installed: [], project: { dir: '/p', deployed: true, settings: { recipes: { activities: {}, detectError: 'corrupt bridge' } } } });
    assert.equal(vm.project.settings.recipes.detectError, 'corrupt bridge');
  });

  it('an undeployed / no-extras envelope yields null bridges/project (omitted blocks)', () => {
    const vm = toViewModel({ deploymentHead: '1.3.0', installed: [] });
    assert.equal(vm.bridges, null);
    assert.equal(vm.project, null);
  });
});

describe('view-model — no-leak inheritance', () => {
  it('a VM built from a no-leak envelope carries no internal term', () => {
    const blob = JSON.stringify(toViewModel(fullEnvelope()));
    for (const term of INTERNAL_RENDER_FORBIDDEN) {
      assert.ok(!blob.includes(term), `the VM leaks internal term "${term}"`);
    }
  });
});
