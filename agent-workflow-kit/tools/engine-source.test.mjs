import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  resolveEngineDir,
  detectEngine,
  readEngineFragment,
  ENGINE_ENV,
  EXPECTED_ENGINE_NAME,
  ENGINE_FRAGMENT_REL,
  ORCHESTRATION_FRAGMENT_REL,
} from './engine-source.mjs';

// A valid engine dir = it exists (dir), the fragment file exists, and the validator reports a
// VALID methodology-engine with the right name. The deps below let every branch be exercised
// in-process without touching the real filesystem.
const ENGINE_DIR = '/home/u/.claude/skills/agent-workflow-engine';

// statType stub: ENGINE_DIR → 'dir', the fragment → 'file', everything else → null.
const okStatType = (path) =>
  path === ENGINE_DIR ? 'dir' : path === join(ENGINE_DIR, ENGINE_FRAGMENT_REL) ? 'file' : null;

const okReport = {
  result: 'valid',
  kind: 'methodology-engine',
  name: EXPECTED_ENGINE_NAME,
  available: true,
};

const deps = (overrides = {}) => ({
  validate: () => okReport,
  statType: okStatType,
  ...overrides,
});

describe('resolveEngineDir — env override vs the ~/.claude default', () => {
  it('uses AGENT_WORKFLOW_ENGINE_DIR when set, tagging source=env', () => {
    const out = resolveEngineDir({ env: { [ENGINE_ENV]: '/custom/engine' }, home: '/home/u' });
    assert.deepEqual(out, { dir: '/custom/engine', source: 'env' });
  });
  it('falls back to ~/.claude/skills/agent-workflow-engine, tagging source=default', () => {
    const out = resolveEngineDir({ env: {}, home: '/home/u' });
    assert.equal(out.source, 'default');
    assert.equal(out.dir, join('/home/u', '.claude/skills/agent-workflow-engine'));
  });
  it('treats an empty env value as unset (source=default)', () => {
    const out = resolveEngineDir({ env: { [ENGINE_ENV]: '' }, home: '/home/u' });
    assert.equal(out.source, 'default');
  });
});

describe('detectEngine — happy path + each distinct failure reason', () => {
  it('ok when dir exists, manifest VALID methodology-engine, right name, fragment present', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps());
    assert.equal(out.ok, true);
    assert.equal(out.dir, ENGINE_DIR);
    assert.match(out.reason, /methodology-engine/);
  });

  it('env-set-but-missing: dir absent AND source=env → distinct reason', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'env' }, deps({ statType: () => null }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /env-set-but-missing/);
  });

  it('not-installed: dir absent AND source=default → not an env-set reason', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ statType: () => null }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /not installed/i);
    assert.doesNotMatch(out.reason, /env-set-but-missing/);
  });

  it('invalid manifest → reason names the validator result', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ validate: () => ({ ...okReport, result: 'invalid' }) }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /invalid/);
  });

  it('wrong kind → reason names the kind', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ validate: () => ({ ...okReport, kind: 'memory-substrate' }) }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /kind/);
  });

  it('wrong name → reason names the name mismatch', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ validate: () => ({ ...okReport, name: 'something-else' }) }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /name/);
  });

  it('declared stub (available:false) → reason names the stub', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ validate: () => ({ ...okReport, available: false }) }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /stub|available:false/);
  });

  it('missing fragment → reason names the fragment path', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ statType: (p) => (p === ENGINE_DIR ? 'dir' : null) }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /fragment/);
  });

  it('a validator that THROWS (corrupt engine, e.g. EISDIR) → ok:false, no raw error escapes', () => {
    const out = detectEngine(
      ENGINE_DIR,
      { source: 'default' },
      deps({
        validate: () => {
          throw new Error('EISDIR: illegal operation on a directory, read');
        },
      }),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason, /invalid/);
  });
});

describe('readEngineFragment — live read or loud throw', () => {
  it('returns the fragment bytes on the happy path', () => {
    const out = readEngineFragment(ENGINE_DIR, deps({ source: 'default', readFileSync: () => 'FRAGMENT BODY' }));
    assert.equal(out, 'FRAGMENT BODY');
  });

  it('throws naming the dir + the exact install command when the engine is absent', () => {
    assert.throws(
      () => readEngineFragment(ENGINE_DIR, deps({ source: 'env', statType: () => null })),
      (err) => {
        assert.match(err.message, /methodology engine not found\/invalid/);
        assert.match(err.message, new RegExp(ENGINE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, /npx @sabaiway\/agent-workflow-engine@latest init/);
        assert.match(err.message, new RegExp(ENGINE_ENV));
        return true;
      },
    );
  });

  it('throws when the manifest is invalid (never falls back)', () => {
    assert.throws(
      () => readEngineFragment(ENGINE_DIR, deps({ source: 'default', validate: () => ({ ...okReport, result: 'invalid' }) })),
      /methodology engine not found\/invalid/,
    );
  });

  it('a THROWING validator still yields the stable install message (no raw fs error escapes)', () => {
    assert.throws(
      () =>
        readEngineFragment(
          ENGINE_DIR,
          deps({
            source: 'default',
            validate: () => {
              throw new Error('EISDIR: illegal operation on a directory, read');
            },
          }),
        ),
      (err) => {
        assert.match(err.message, /methodology engine not found\/invalid/);
        assert.match(err.message, /npx @sabaiway\/agent-workflow-engine@latest init/);
        return true;
      },
    );
  });

  it('throws with the install command when the fragment file is unreadable', () => {
    assert.throws(
      () =>
        readEngineFragment(
          ENGINE_DIR,
          deps({
            source: 'default',
            readFileSync: () => {
              throw new Error('EISDIR');
            },
          }),
        ),
      (err) => {
        assert.match(err.message, /fragment unreadable: EISDIR/);
        assert.match(err.message, /npx @sabaiway\/agent-workflow-engine@latest init/);
        return true;
      },
    );
  });
});

// The orchestration fragment is a SECOND bounded fragment (Plan 4), selected via deps.rel /
// detectEngine({ rel }) — non-breaking: the default rel stays the methodology fragment so every
// existing methodology call site is unchanged.
describe('detectEngine / readEngineFragment — orchestration fragment via rel', () => {
  // statType that knows both fragments live in the engine (a current >=1.2.0 engine).
  const bothPresent = (path) =>
    path === ENGINE_DIR
      ? 'dir'
      : path === join(ENGINE_DIR, ENGINE_FRAGMENT_REL) || path === join(ENGINE_DIR, ORCHESTRATION_FRAGMENT_REL)
        ? 'file'
        : null;

  it('verifies the orchestration fragment when rel is the orchestration path', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default', rel: ORCHESTRATION_FRAGMENT_REL }, deps({ statType: bothPresent }));
    assert.equal(out.ok, true);
  });

  it('an older engine (no orchestration fragment) → detect not-ok, the reason names that fragment', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default', rel: ORCHESTRATION_FRAGMENT_REL }, deps()); // okStatType: only the methodology fragment is a file
    assert.equal(out.ok, false);
    assert.match(out.reason, /orchestration-slot\.md/);
  });

  it('the methodology read is unaffected by the new rel default (back-compat)', () => {
    const out = detectEngine(ENGINE_DIR, { source: 'default' }, deps({ statType: bothPresent }));
    assert.equal(out.ok, true);
  });

  it('readEngineFragment reads the orchestration fragment bytes when deps.rel is set', () => {
    const out = readEngineFragment(
      ENGINE_DIR,
      deps({ source: 'default', rel: ORCHESTRATION_FRAGMENT_REL, statType: bothPresent, readFileSync: () => 'ORCH BODY' }),
    );
    assert.equal(out, 'ORCH BODY');
  });

  it('readEngineFragment STOPs loudly when the orchestration fragment is absent (older engine)', () => {
    assert.throws(
      () => readEngineFragment(ENGINE_DIR, deps({ source: 'default', rel: ORCHESTRATION_FRAGMENT_REL })),
      (err) => {
        assert.match(err.message, /methodology engine not found\/invalid/);
        assert.match(err.message, /orchestration-slot\.md/);
        assert.match(err.message, /npx @sabaiway\/agent-workflow-engine@latest init/);
        return true;
      },
    );
  });
});
