import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, visibleLength } from './renderers.mjs';
import { toViewModel } from './view-model.mjs';

// A full 4-block envelope exercising every branch the replaced formatStatus+formatSettings had:
// members behind/current/absent/other-tool/uncheckable; a behind member with a note; bridges with
// present/missing/unknown wrappers; a deployed project with stamps + visibility; settings with all
// three areas populated.
const fullEnvelope = () => ({
  deploymentHead: '1.3.0',
  installed: [
    { member: 'agent-workflow-kit', display: 'kit', version: '1.19.0', state: 'installed', refresh: { behind: false, recommend: null } },
    { member: 'agent-workflow-memory', display: 'memory', version: '1.0.0', state: 'installed', notes: ['the memory installed here is behind — run `npx @sabaiway/agent-workflow-memory@latest init`'], refresh: { behind: true, recommend: 'npx @sabaiway/agent-workflow-memory@latest init' } },
    { member: 'agent-workflow-engine', display: 'engine', version: null, state: 'absent', refresh: { behind: false, recommend: null } },
    { member: 'codex-cli-bridge', display: 'codex-bridge', version: null, state: 'other-tool' },
    { member: 'antigravity-cli-bridge', display: 'antigravity-bridge', version: null, state: 'uncheckable' },
  ],
  bridges: [
    { member: 'codex-cli-bridge', display: 'codex-bridge', readiness: 'ready', wrappers: [{ cmd: 'codex-exec', state: 'present' }, { cmd: 'codex-review', state: 'missing' }] },
    { member: 'antigravity-cli-bridge', display: 'antigravity-bridge', readiness: 'needs-skill', wrappers: [{ cmd: 'agy-review', state: 'unknown' }, { cmd: 'agy-run', state: 'unknown' }] },
  ],
  project: {
    dir: '/proj', deployed: true, docsAi: true,
    deployStamps: [{ display: 'kit', version: '1.3.0' }, { display: 'memory', version: '1.0.0' }],
    visibility: { state: 'hidden' },
    settings: {
      recipes: { configSource: 'docs/ai/orchestration.json', activities: { 'plan-authoring': { review: { recipe: 'reviewed' } }, 'plan-execution': { execute: { recipe: 'delegated' }, review: { recipe: 'council' } } } },
      attribution: { project: false, local: null, effective: false },
      velocity: { defaultMode: 'acceptEdits', allowEntries: { project: 1, local: 2 } },
    },
  },
});

// The byte-exact plain golden for the full 4-block envelope (a backtick in the note is escaped).
const PLAIN_GOLDEN = `agent-workflow family — installed members (skill axis)

  kit                 v1.19.0
  memory              v1.0.0
      ↳ the memory installed here is behind — run \`npx @sabaiway/agent-workflow-memory@latest init\`
  engine              —           not installed
  codex-bridge        —           a different tool occupies that skill slot
  antigravity-bridge  —           couldn't be checked (a permission error)
  1 member(s) need a refresh (see the ↳ notes above).

execution backends (host)

  codex-bridge        ready         wrappers: codex-exec ✓, codex-review ✗
  antigravity-bridge  needs-skill   wrappers: agy-review ?, agy-run ?

project deployment (/proj)

  kit                       1.3.0
  memory                    1.0.0
  docs/ai present           yes
  visibility                hidden (git-ignored, local-only)

settings
  recipes       plan-authoring.review=reviewed · plan-execution.execute=delegated · plan-execution.review=council
  attribution   includeCoAuthoredBy effective=false
  velocity      defaultMode=acceptEdits · allow project/local=1/2`;

describe('renderers — plain (byte-exact golden)', () => {
  it('renders the full 4-block envelope byte-for-byte', () => {
    const out = render(toViewModel(fullEnvelope()), { mode: 'plain', width: 80, color: false, ascii: false });
    assert.equal(out, PLAIN_GOLDEN);
  });

  it('emits ZERO ANSI escape sequences in plain mode', () => {
    const out = render(toViewModel(fullEnvelope()), { mode: 'plain', width: 80, color: false, ascii: false });
    assert.ok(!/\x1b/.test(out), 'plain output must contain no SGR codes');
  });
});

describe('renderers — ansi structural invariants', () => {
  // A small envelope so every content line fits inside width 80 (and thus pads to exactly 80).
  const smallEnvelope = () => ({
    deploymentHead: '1.3.0',
    installed: [{ member: 'agent-workflow-kit', display: 'kit', version: '1.19.0', state: 'installed', refresh: { behind: false, recommend: null } }],
    bridges: [{ member: 'codex-cli-bridge', display: 'codex-bridge', readiness: 'ready', wrappers: [{ cmd: 'codex-exec', state: 'present' }] }],
  });

  it('pads every non-empty line to the surface width (by visible length)', () => {
    const out = render(toViewModel(smallEnvelope()), { mode: 'ansi', width: 80, color: true, ascii: false });
    for (const line of out.split('\n')) {
      if (line === '') continue;
      assert.equal(visibleLength(line), 80, `line not padded to width: ${JSON.stringify(line)}`);
    }
  });

  it('balances every SGR open with a reset', () => {
    const out = render(toViewModel(smallEnvelope()), { mode: 'ansi', width: 80, color: true, ascii: false });
    const total = (out.match(/\x1b\[/g) ?? []).length;
    const resets = (out.match(/\x1b\[0m/g) ?? []).length;
    assert.ok(total > 0, 'color:true should emit SGR');
    assert.equal(total, resets * 2, 'each styled span is one open + one reset (balanced)');
  });

  it('emits NO SGR when color is off, even in ansi mode', () => {
    const out = render(toViewModel(smallEnvelope()), { mode: 'ansi', width: 80, color: false, ascii: false });
    assert.ok(!/\x1b/.test(out), 'color:false must suppress all SGR');
    // still padded to width
    for (const line of out.split('\n')) if (line !== '') assert.equal(visibleLength(line), 80);
  });

  it('pads short lines UP to width but preserves a long content line INTACT (never truncates — data integrity)', () => {
    // width is a MIN target, not a hard max: a long verbatim caveat must survive in full (it carries the
    // recovery command) — truncating it would be a no-silent-failure violation.
    const longNote = 'memory is behind — run `npx @sabaiway/agent-workflow-memory@latest init` to refresh it and then restart your session so the agent reloads the new files';
    const env = {
      deploymentHead: '1.3.0',
      installed: [{ member: 'agent-workflow-memory', display: 'memory', version: '1.0.0', state: 'installed', notes: [longNote], refresh: { behind: true, recommend: 'npx @sabaiway/agent-workflow-memory@latest init' } }],
    };
    const lines = render(toViewModel(env), { mode: 'ansi', width: 80, color: false, ascii: false }).split('\n');
    assert.ok(lines.some((l) => l.includes(longNote)), 'the long caveat is preserved in full, not truncated');
    assert.ok(lines.some((l) => l.includes('memory') && visibleLength(l) === 80), 'a short line still pads up to width');
    assert.ok(lines.some((l) => visibleLength(l) > 80), 'the long line is left over-width rather than cut');
  });
});

describe('renderers — ASCII glyph fallback', () => {
  it('uses ASCII note + wrapper marks when ascii:true', () => {
    const out = render(toViewModel(fullEnvelope()), { mode: 'plain', width: 80, color: false, ascii: true });
    assert.match(out, /-> the memory installed here is behind/);
    assert.match(out, /codex-exec \+/);
    assert.match(out, /codex-review x/);
    assert.match(out, /agy-review \?/);
    assert.match(out, /agy-run \?/);
    assert.ok(!out.includes('↳') && !out.includes('✓') && !out.includes('✗'), 'no unicode glyphs in ASCII mode');
  });
});

describe('renderers — branch coverage (every replaced-function branch)', () => {
  const renderPlain = (env) => render(toViewModel(env), { mode: 'plain', width: 80, color: false, ascii: false });

  it('an undeployed project shows the no-deployment line, no stamps', () => {
    const out = renderPlain({ installed: [], project: { dir: '/empty', deployed: false, deployStamps: [] } });
    assert.match(out, /project deployment \(\/empty\)/);
    assert.match(out, /no agent-workflow deployment detected here/);
  });

  it('a member with TWO notes (engine missing both fragments) prints both as ↳ sub-lines', () => {
    const out = renderPlain({
      installed: [{ member: 'agent-workflow-engine', display: 'engine', version: '1.1.0', state: 'installed', notes: ['engine present but does not supply the recipes pointer', 'engine present but does not ship the activity-procedures canon'], refresh: { behind: true, recommend: 'npx @sabaiway/agent-workflow-engine@latest init' } }],
    });
    assert.match(out, /↳ engine present but does not supply the recipes pointer/);
    assert.match(out, /↳ engine present but does not ship the activity-procedures canon/);
    assert.match(out, /1 member\(s\) need a refresh/);
  });

  it('settings: each area error renders loudly', () => {
    const out = renderPlain({
      installed: [],
      project: { dir: '/p', deployed: true, deployStamps: [], settings: { recipes: { error: 'docs/ai/orchestration.json: bad json' }, attribution: { error: '.claude/settings.json: bad json' }, velocity: { error: '.claude/settings.local.json: bad json' } } },
    });
    assert.match(out, /recipes\s+error: docs\/ai\/orchestration\.json: bad json/);
    assert.match(out, /attribution\s+error: \.claude\/settings\.json: bad json/);
    assert.match(out, /velocity\s+error: \.claude\/settings\.local\.json: bad json/);
  });

  it('settings: a recipes detectError floors with a sub-line', () => {
    const out = renderPlain({
      installed: [],
      project: { dir: '/p', deployed: true, deployStamps: [], settings: { recipes: { activities: { 'plan-authoring': { review: { recipe: 'solo' } } }, detectError: 'corrupt bridge manifest' } } },
    });
    assert.match(out, /couldn't check backends \(corrupt bridge manifest\); recipes floored at solo/);
  });

  it('settings: a real local attribution override is flagged', () => {
    const out = renderPlain({ installed: [], project: { dir: '/p', deployed: true, deployStamps: [], settings: { attribution: { project: true, local: false, effective: false } } } });
    assert.match(out, /includeCoAuthoredBy effective=false \(local override\)/);
  });

  it('a bridge unknown wrapper state renders as the unknown glyph, distinct from missing', () => {
    const out = renderPlain({ installed: [], bridges: [{ display: 'antigravity-bridge', readiness: 'needs-skill', wrappers: [{ cmd: 'agy-review', state: 'unknown' }, { cmd: 'agy-run', state: 'missing' }] }] });
    assert.match(out, /agy-review \?/, 'unknown → ?');
    assert.match(out, /agy-run ✗/, 'missing → ✗ (distinct from unknown)');
  });

  it('a member with no refresh object renders without a headline behind-count', () => {
    const out = renderPlain({ installed: [{ member: 'agent-workflow-kit', display: 'kit', version: '1.19.0', state: 'installed' }] });
    assert.ok(!/need a refresh/.test(out));
  });
});
