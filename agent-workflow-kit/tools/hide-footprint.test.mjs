import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, basename, resolve } from 'node:path';
import {
  hideFootprint,
  inferVisibility,
  migrateFromGlobal,
  buildBlock,
  START_MARKER,
  END_MARKER,
} from './hide-footprint.mjs';
import { FOOTPRINT_STOP } from './known-footprint.mjs';

const DIR = '/repo';
const EXCLUDE = join(DIR, '.git/info/exclude');
const ENOENT = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

// ── in-memory world (absolute path → node) ───────────────────────────────────────

const makeWorld = (seed = {}) => {
  const nodes = new Map(); // abspath → { kind:'file'|'dir', content? }
  const world = {
    file: (rel, content = '') => { nodes.set(join(DIR, rel), { kind: 'file', content }); return world; },
    dir: (rel) => { nodes.set(join(DIR, rel.replace(/\/$/, '')), { kind: 'dir' }); return world; },
    abs: (p, content = '') => { nodes.set(p, { kind: 'file', content }); return world; },
    read: (rel) => nodes.get(join(DIR, rel))?.content,
    nodes,
  };
  if (seed.exclude !== undefined) world.file('.git/info/exclude', seed.exclude);
  return world;
};

const fsDeps = (world) => ({
  readFile: (p) => { const n = world.nodes.get(p); if (!n || n.kind !== 'file') throw ENOENT(p); return n.content; },
  writeFile: (p, c) => { world.nodes.set(p, { kind: 'file', content: c }); },
  stat: (p) => { const n = world.nodes.get(p); if (!n) throw ENOENT(p); return { isFile: () => n.kind === 'file' }; },
  readdir: (p) => {
    const n = world.nodes.get(p);
    if (!n || n.kind !== 'dir') throw ENOENT(p);
    const names = [];
    for (const k of world.nodes.keys()) if (dirname(k) === p) names.push(basename(k));
    return names;
  },
});

// ── mock git (asserts cwd + repo-relative probes) ────────────────────────────────

const gitDeps = (cfg, world) => (args, opts) => {
  assert.equal(opts.cwd, DIR, 'every git call runs with cwd = the project dir');
  const [cmd, ...rest] = args;
  if (cmd === 'rev-parse') return { status: 0, stdout: '.git/info/exclude\n', stderr: '' };
  if (cmd === 'config') {
    if (cfg.global == null) return { status: 1, stdout: '', stderr: '' }; // unset
    return { status: 0, stdout: `${cfg.global}\n`, stderr: '' };
  }
  const probe = rest[rest.length - 1];
  assert.ok(!probe.startsWith('/'), `probe is repo-relative, never the anchored "/" form: ${probe}`);
  if (cmd === 'ls-files') {
    if (cfg.lsFilesFails) return { status: 128, stdout: '', stderr: 'fatal: boom' };
    const hits = (cfg.tracked ?? []).filter((t) => (probe.endsWith('/') ? t.startsWith(probe) : t === probe));
    return { status: 0, stdout: hits.map((h) => `${h}\0`).join(''), stderr: '' };
  }
  if (cmd === 'check-ignore') {
    if (cfg.checkIgnoreFails) return { status: 128, stdout: '', stderr: 'fatal: bad config' };
    // Real precedence: a tracked .gitignore > .git/info/exclude > global core.excludesFile.
    const stat = (cfg.ignored ?? {})[probe];
    const fmt = (s) => ({ status: 0, stdout: `${s.source}:${s.line ?? 1}:${s.pattern ?? probe}\t${probe}\n`, stderr: '' });
    if (stat && basename(stat.source) === '.gitignore') return fmt(stat); // gitignore wins
    const content = world.nodes.get(EXCLUDE)?.content ?? '';
    const lines = content.split('\n').map((l) => l.replace(/\r$/, '')); // git is EOL-agnostic
    if (lines.includes(`/${probe}`)) return { status: 0, stdout: `.git/info/exclude:1:/${probe}\t${probe}\n`, stderr: '' };
    if (stat) return fmt(stat); // global (lower than the local exclude)
    return { status: 1, stdout: '', stderr: '' };
  }
  return { status: 128, stdout: '', stderr: 'unknown' };
};

const mk = (cfg = {}, seed = {}) => {
  const world = makeWorld(seed);
  if (seed.world) seed.world(world);
  return { world, deps: { git: gitDeps(cfg, world), ...fsDeps(world), home: '/home/u', log: () => {}, errlog: () => {} } };
};

// ── buildBlock ────────────────────────────────────────────────────────────────────

describe('buildBlock', () => {
  it('sorts + dedupes', () => {
    assert.deepEqual(buildBlock(['/b', '/a', '/b', '/c']), ['/a', '/b', '/c']);
  });
});

// ── idempotency + EOL + splice ────────────────────────────────────────────────────

describe('hide flow — idempotency & splice', () => {
  it('apply twice → byte-identical (zero diff)', () => {
    const { world, deps } = mk();
    const r1 = hideFootprint({ dir: DIR }, deps);
    assert.equal(r1.action, 'created');
    const after1 = world.read('.git/info/exclude');
    const r2 = hideFootprint({ dir: DIR }, deps);
    assert.equal(r2.action, 'noop');
    assert.equal(world.read('.git/info/exclude'), after1, 'second run leaves the file byte-for-byte');
  });

  it('one managed block, markers present, KIT_OWN hidden', () => {
    const { world, deps } = mk();
    const r = hideFootprint({ dir: DIR }, deps);
    const content = world.read('.git/info/exclude');
    assert.equal(content.split(START_MARKER).length - 1, 1, 'exactly one start marker');
    assert.equal(content.split(END_MARKER).length - 1, 1, 'exactly one end marker');
    assert.ok(r.wrote.includes('/AGENTS.md') && r.wrote.includes('/docs/ai/'));
    assert.ok(content.endsWith('\n'));
  });

  it('preserves outside boilerplate; appends the fence', () => {
    const boiler = '# git ls-files --others --exclude-from=.git/info/exclude\n# *~\n';
    const { world, deps } = mk({}, { exclude: boiler });
    hideFootprint({ dir: DIR }, deps);
    const content = world.read('.git/info/exclude');
    assert.ok(content.startsWith('# git ls-files --others'), 'boilerplate kept at the top');
    assert.ok(content.includes('# *~'), 'comment kept');
    assert.ok(content.indexOf(START_MARKER) > content.indexOf('# *~'), 'fence appended after boilerplate');
  });

  it('CRLF preserved when the file uses CRLF', () => {
    const { world, deps } = mk({}, { exclude: '# boiler\r\n' });
    hideFootprint({ dir: DIR }, deps);
    const content = world.read('.git/info/exclude');
    assert.ok(content.includes('\r\n'), 'CRLF EOL preserved');
    assert.ok(!/[^\r]\n/.test(content), 'no lone LF introduced');
  });

  it('empty/missing exclude → LF default, still idempotent', () => {
    const { world, deps } = mk(); // no exclude file at all
    hideFootprint({ dir: DIR }, deps);
    const content = world.read('.git/info/exclude');
    assert.ok(content.includes('\n') && !content.includes('\r'));
    const before = content;
    hideFootprint({ dir: DIR }, deps);
    assert.equal(world.read('.git/info/exclude'), before);
  });

  it('malformed markers (single / reversed / duplicate) → STOP, file byte-for-byte unchanged', () => {
    const cases = [
      `${START_MARKER}\n/AGENTS.md\n`, // single: start, no end
      `${END_MARKER}\n/x\n${START_MARKER}\n`, // reversed: end before start
      `${START_MARKER}\n/x\n${START_MARKER}\n/y\n${END_MARKER}\n`, // duplicate start
    ];
    for (const bad of cases) {
      const { world, deps } = mk({}, { exclude: bad });
      assert.throws(() => hideFootprint({ dir: DIR }, deps), (e) => e.code === FOOTPRINT_STOP, `STOP on: ${JSON.stringify(bad)}`);
      assert.equal(world.read('.git/info/exclude'), bad, 'left byte-for-byte');
    }
  });
});

// ── classify: tracked → ASK; order; drop; risk ───────────────────────────────────

describe('classify', () => {
  it('a tracked KIT_OWN path → ASK (excluded by default), with rm guidance', () => {
    const { deps } = mk({ tracked: ['.claude/settings.json'] });
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(!r.wrote.includes('/.claude/settings.json'), 'tracked path not written');
    assert.ok(r.asks.some((a) => a.path === '/.claude/settings.json'), 'surfaced as ASK');
  });

  it('--include opts a tracked ASK path into needsUntrack (written line + rm guidance, NOT hidden)', () => {
    const { world, deps } = mk({ tracked: ['.claude/settings.json'] });
    const r = hideFootprint({ dir: DIR, include: ['/.claude/settings.json'] }, deps);
    assert.ok(r.wrote.includes('/.claude/settings.json'), 'now written into the block');
    assert.ok(r.needsUntrack.some((n) => n.path === '/.claude/settings.json' && n.command.includes('git rm --cached')));
    assert.ok(!r.verify.some((v) => v.path === '/.claude/settings.json' && v.hidden), 'tracked → never counted hidden');
  });

  it('--include rejects a path that is not one of this run’s asks', () => {
    const { deps } = mk();
    assert.throws(() => hideFootprint({ dir: DIR, include: ['/src/'] }, deps), (e) => e.code === FOOTPRINT_STOP);
  });

  it('--include rejects traversal / globs', () => {
    const { deps } = mk({ tracked: ['.claude/settings.json'] });
    assert.throws(() => hideFootprint({ dir: DIR, include: ['../etc'] }, deps), (e) => e.code === FOOTPRINT_STOP);
    assert.throws(() => hideFootprint({ dir: DIR, include: ['/.github/copilot-*'] }, deps), (e) => e.code === FOOTPRINT_STOP);
  });

  it('untracked + covered by a tracked .gitignore → DROPPED; tracked + covered → ASK (tracked checked first)', () => {
    const { deps } = mk({
      tracked: ['.gitignore', 'AGENTS.md'],
      ignored: { 'AGENTS.md': { source: '.gitignore' }, 'docs/ai/': { source: '.gitignore' } },
    });
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(r.dropped.includes('/docs/ai/'), 'untracked + gitignore-covered → dropped as redundant');
    assert.ok(r.asks.some((a) => a.path === '/AGENTS.md'), 'tracked wins over the gitignore-drop → ASK');
    assert.ok(!r.dropped.includes('/AGENTS.md'));
  });

  it('ls-files failure → fail-closed STOP (UNKNOWN never counts as safe-to-hide)', () => {
    const { deps } = mk({ lsFilesFails: true });
    assert.throws(() => hideFootprint({ dir: DIR }, deps), (e) => e.code === FOOTPRINT_STOP);
  });

  it('check-ignore exit 128 → fail-closed STOP (the symmetric guard to ls-files)', () => {
    const { deps } = mk({ checkIgnoreFails: true });
    assert.throws(() => hideFootprint({ dir: DIR }, deps), (e) => e.code === FOOTPRINT_STOP);
  });
});

// ── present external footprint + glob ────────────────────────────────────────────

describe('external footprint', () => {
  it('a present low-risk external dir → HIDE; an absent external → not emitted', () => {
    const { deps } = mk({}, { world: (w) => w.dir('.continue') });
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(r.wrote.includes('/.continue/'), 'present external dir hidden');
    assert.ok(!r.wrote.includes('/.cursorrules'), 'absent external not emitted');
  });

  it('a present high-risk external file (generic name) → ASK, not hidden by default', () => {
    const { deps } = mk({}, { world: (w) => w.file('GEMINI.md') });
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(!r.wrote.includes('/GEMINI.md'), 'present-high-risk excluded by default');
    assert.ok(r.asks.some((a) => a.path === '/GEMINI.md'));
  });

  it('glob /.github/copilot-* expands to each present file; a tracked sibling does not pull them into ASK', () => {
    const { deps } = mk(
      { tracked: ['.github/workflows/ci.yml'] },
      { world: (w) => w.dir('.github').file('.github/copilot-instructions.md').file('.github/copilot-setup.yml').dir('.github/workflows') },
    );
    const r = hideFootprint({ dir: DIR }, deps);
    // copilot-* is falsePositiveRisk:true → present → ASK each (not hidden by default). The ASK reason
    // must be the RISK reason, NOT the tracked reason — proving each file was probed on its OWN path
    // and the tracked sibling did not leak into their classification.
    const a1 = r.asks.find((a) => a.path === '/.github/copilot-instructions.md');
    const a2 = r.asks.find((a) => a.path === '/.github/copilot-setup.yml');
    assert.ok(a1 && /generic|confirm before hiding/.test(a1.reason) && !/tracked/.test(a1.reason));
    assert.ok(a2 && /generic|confirm before hiding/.test(a2.reason));
    assert.ok(!r.wrote.some((p) => p.startsWith('/.github/copilot')));
  });

  it('a glob-expanded file consented via --include is RETAINED on re-run (zero diff, idempotent)', () => {
    const seed = { world: (w) => w.dir('.github').file('.github/copilot-instructions.md') };
    const { world, deps } = mk({}, seed);
    const r1 = hideFootprint({ dir: DIR, include: ['/.github/copilot-instructions.md'] }, deps);
    assert.ok(r1.wrote.includes('/.github/copilot-instructions.md'), 'consented glob child written');
    const c1 = world.read('.git/info/exclude');
    const r2 = hideFootprint({ dir: DIR }, deps); // no --include — consent must survive
    assert.ok(r2.wrote.includes('/.github/copilot-instructions.md'), 'glob-child consent survives re-run');
    assert.ok(!r2.asks.some((a) => a.path === '/.github/copilot-instructions.md'), 'not re-asked');
    assert.equal(r2.action, 'noop');
    assert.equal(world.read('.git/info/exclude'), c1, 'zero diff (no silent un-hide of the copilot file)');
  });
});

// ── re-run consent (D4) ──────────────────────────────────────────────────────────

describe('re-run preserves prior consent', () => {
  it('a consented present-high-risk path stays on re-run without --include (zero diff, not re-asked)', () => {
    const { world, deps } = mk({}, { world: (w) => w.file('GEMINI.md') });
    const r1 = hideFootprint({ dir: DIR, include: ['/GEMINI.md'] }, deps); // opt in once
    assert.ok(r1.wrote.includes('/GEMINI.md'));
    const c1 = world.read('.git/info/exclude');
    const r2 = hideFootprint({ dir: DIR }, deps); // no --include this time
    assert.ok(r2.wrote.includes('/GEMINI.md'), 'prior in-block consent retained');
    assert.ok(!r2.asks.some((a) => a.path === '/GEMINI.md'), 'not re-asked');
    assert.equal(r2.action, 'noop');
    assert.equal(world.read('.git/info/exclude'), c1, 'zero diff');
  });

  it('a previously-consented high-risk path that DISAPPEARED is dropped (consent does not survive)', () => {
    const { world, deps } = mk({}, { world: (w) => w.file('GEMINI.md') });
    hideFootprint({ dir: DIR, include: ['/GEMINI.md'] }, deps); // in the block now
    world.nodes.delete(join(DIR, 'GEMINI.md')); // GEMINI.md disappears from disk
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(!r.wrote.includes('/GEMINI.md'), 'disappeared high-risk path dropped');
    assert.ok(!world.read('.git/info/exclude').includes('/GEMINI.md'));
  });
});

// ── absorb (D8) — verbatim present-machine exclude ───────────────────────────────

describe('absorb pre-existing recognized local lines', () => {
  const presentMachine = [
    '# git ls-files --others --exclude-from=.git/info/exclude',
    "# Lines that start with '#' are comments.",
    '',
    '# standalone local-dev agent skills — kept out of THIS repo (project-local; visibility is a project setting)',
    '.claude/skills/',
    '',
  ].join('\n');

  it('folds the AD-013 comment + bare .claude/skills/ (dir ABSENT) into the fence, no orphan comment, apply-twice zero diff', () => {
    const { world, deps } = mk({}, { exclude: presentMachine });
    const r1 = hideFootprint({ dir: DIR }, deps);
    const c1 = world.read('.git/info/exclude');
    assert.ok(r1.wrote.includes('/.claude/skills/'), 'folded into the fence (preserved despite absent dir)');
    assert.ok(!c1.includes('# standalone local-dev agent skills'), 'orphan comment removed');
    assert.equal((c1.match(/\.claude\/skills\//g) ?? []).length, 1, 'exactly one .claude/skills/ rule, inside the fence');
    assert.ok(c1.startsWith('# git ls-files --others'), 'git boilerplate preserved');
    const r2 = hideFootprint({ dir: DIR }, deps);
    assert.equal(r2.action, 'noop');
    assert.equal(world.read('.git/info/exclude'), c1, 'apply-twice = zero diff');
  });

  it('a loose pre-existing HIGH-RISK line whose file is PRESENT is folded as consent (no report mismatch, one block)', () => {
    const { world, deps } = mk({}, { exclude: '# boiler\n/.cursorrules\n', world: (w) => w.file('.cursorrules') });
    const r = hideFootprint({ dir: DIR }, deps);
    const content = world.read('.git/info/exclude');
    assert.ok(r.wrote.includes('/.cursorrules'), 'folded into the managed block as prior consent');
    assert.ok(!r.asks.some((a) => a.path === '/.cursorrules'), 'not reported as un-consented ASK while it is in fact hidden');
    assert.equal((content.match(/\.cursorrules/g) ?? []).length, 1, 'exactly one .cursorrules rule, inside the fence');
    assert.ok(content.indexOf('/.cursorrules') > content.indexOf(START_MARKER), 'inside the fence, not loose');
    const v = r.verify.find((x) => x.path === '/.cursorrules');
    assert.ok(v && v.hidden === true, 'verified hidden');
  });

  it('a loose HIGH-RISK line whose file is ABSENT is left untouched (a pre-emptive hide is never silently removed)', () => {
    const { world, deps } = mk({}, { exclude: '# boiler\n/.cursorrules\n' }); // .cursorrules absent
    const r = hideFootprint({ dir: DIR }, deps);
    assert.ok(!r.wrote.includes('/.cursorrules'), 'absent high-risk path not folded');
    assert.ok(world.read('.git/info/exclude').includes('/.cursorrules'), 'the user’s loose line is preserved as-is');
  });
});

// ── verify (D5) ──────────────────────────────────────────────────────────────────

describe('verify', () => {
  it('a tracked path written via --include reports NOT hidden', () => {
    const { deps } = mk({ tracked: ['.claude/settings.json'] });
    const r = hideFootprint({ dir: DIR, include: ['/.claude/settings.json'] }, deps);
    const v = r.verify.find((x) => x.path === '/.claude/settings.json');
    assert.ok(v && v.tracked === true && v.hidden === false);
  });

  it('an untracked auto-HIDE path verifies hidden by our exclude source', () => {
    const { deps } = mk();
    const r = hideFootprint({ dir: DIR }, deps);
    const v = r.verify.find((x) => x.path === '/AGENTS.md');
    assert.ok(v && v.hidden === true && /info\/exclude/.test(v.source));
  });
});

// ── migrateFromGlobal (D6/D7) ────────────────────────────────────────────────────

describe('migrateFromGlobal', () => {
  const GLOBAL = '/home/u/.gitignore_global';
  const kitOld = [
    '',
    '# agent-workflow-kit hidden mode (machine-local; remove these lines to un-hide)',
    '/AGENTS.md', '/CLAUDE.md', '/docs/ai/',
    '/scripts/_expect-shim.mjs', '/scripts/install-git-hooks.mjs',
    '',
  ].join('\n');

  it('default KEEPS + reports the legacy global block; --remove-global removes it + returns a backup', () => {
    const { world, deps } = mk({ global: GLOBAL }, { world: (w) => w.abs(GLOBAL, kitOld) });
    const kept = migrateFromGlobal(deps, DIR, { home: '/home/u', removeGlobal: false, dryRun: false });
    assert.equal(kept.action, 'kept');
    assert.ok(kept.removedLines.includes('/AGENTS.md'));
    assert.equal(world.nodes.get(GLOBAL).content, kitOld, 'kept = file untouched');

    const { world: w2, deps: d2 } = mk({ global: GLOBAL }, { world: (w) => w.abs(GLOBAL, kitOld) });
    const removed = migrateFromGlobal(d2, DIR, { home: '/home/u', removeGlobal: true, dryRun: false });
    assert.equal(removed.action, 'removed');
    assert.ok(removed.backup.includes('/AGENTS.md'));
    assert.ok(!w2.nodes.get(GLOBAL).content.includes('/AGENTS.md'), 'global block removed');
  });

  it('preserves a user line interleaved with the legacy block', () => {
    const withUser = `/AGENTS.md\n/CLAUDE.md\n\n/my/own/rule\n`;
    const { world, deps } = mk({ global: GLOBAL }, { world: (w) => w.abs(GLOBAL, withUser) });
    const r = migrateFromGlobal(deps, DIR, { home: '/home/u', removeGlobal: true, dryRun: false });
    assert.equal(r.action, 'removed');
    assert.ok(world.nodes.get(GLOBAL).content.includes('/my/own/rule'), 'user line preserved');
    assert.ok(!world.nodes.get(GLOBAL).content.includes('/AGENTS.md'));
  });

  it('core.excludesFile unset (exit 1) → no-op, never a STOP', () => {
    const { deps } = mk({ global: null });
    const r = migrateFromGlobal(deps, DIR, { home: '/home/u', removeGlobal: true, dryRun: false });
    assert.equal(r.found, false);
    assert.equal(r.action, 'none');
  });

  it('a memory-old global path-set (no header) is recognized + removed', () => {
    const memOld = `/AGENTS.md\n/docs/ai/\n/docs/ai/.memory-version\n/docs/plans/\n`;
    const { world, deps } = mk({ global: GLOBAL }, { world: (w) => w.abs(GLOBAL, memOld) });
    const r = migrateFromGlobal(deps, DIR, { home: '/home/u', removeGlobal: true, dryRun: false });
    assert.equal(r.action, 'removed');
    assert.equal(world.nodes.get(GLOBAL).content, '', 'whole memory-old block recognized + removed');
  });

  it('the AD-013 standalone form as a GLOBAL block is recognized + removed (the third D7 fixture)', () => {
    const ad013 = '# standalone local-dev agent skills — kept out of THIS repo (project-local; visibility is a project setting)\n.claude/skills/\n';
    const { world, deps } = mk({ global: GLOBAL }, { world: (w) => w.abs(GLOBAL, ad013) });
    const r = migrateFromGlobal(deps, DIR, { home: '/home/u', removeGlobal: true, dryRun: false });
    assert.equal(r.action, 'removed');
    assert.ok(r.backup.includes('.claude/skills/'));
    assert.equal(world.nodes.get(GLOBAL).content, '', 'AD-013 comment + bare line removed');
  });
});

// ── --unhide (D12) ───────────────────────────────────────────────────────────────

describe('--unhide', () => {
  const GLOBAL = '/home/u/.gitignore_global';
  it('deletes the fence; default reports the residual global block; --remove-global removes it', () => {
    const exclude = `# boiler\n${START_MARKER}\n/AGENTS.md\n/docs/ai/\n${END_MARKER}\n`;
    const kitOld = '# agent-workflow-kit hidden mode (machine-local; remove these lines to un-hide)\n/AGENTS.md\n/docs/ai/\n';
    const { world, deps } = mk({ global: GLOBAL }, { exclude, world: (w) => w.abs(GLOBAL, kitOld) });
    const r = hideFootprint({ dir: DIR, unhide: true }, deps);
    assert.equal(r.action, 'unhidden');
    const content = world.read('.git/info/exclude');
    assert.ok(!content.includes(START_MARKER), 'fence removed');
    assert.ok(content.includes('# boiler'), 'user boilerplate kept');
    assert.equal(r.global.action, 'kept', 'residual global reported, not removed by default');
    assert.equal(world.nodes.get(GLOBAL).content, kitOld);

    const { world: w2, deps: d2 } = mk({ global: GLOBAL }, { exclude, world: (w) => w.abs(GLOBAL, kitOld) });
    const r2 = hideFootprint({ dir: DIR, unhide: true, removeGlobal: true }, d2);
    assert.equal(r2.global.action, 'removed');
    assert.ok(!w2.nodes.get(GLOBAL).content.includes('/AGENTS.md'));
  });
});

// ── visibility inference (D16) ───────────────────────────────────────────────────

describe('inferVisibility + --reconcile', () => {
  it('tracked anchor → visible; --reconcile writes zero bytes', () => {
    const { world, deps } = mk({ tracked: ['AGENTS.md'] }, { world: (w) => w.file('AGENTS.md') });
    assert.equal(inferVisibility(deps, DIR).visibility, 'visible');
    const r = hideFootprint({ dir: DIR, reconcile: true }, deps);
    assert.equal(r.action, 'noop');
    assert.equal(r.visibility, 'visible');
    assert.equal(world.read('.git/info/exclude'), undefined, 'no exclude file written');
  });

  it('untracked + ignored anchor → hidden; --reconcile runs the hide', () => {
    const { deps } = mk(
      { ignored: { 'AGENTS.md': { source: '/home/u/.gitignore_global' } } },
      { world: (w) => w.file('AGENTS.md') },
    );
    assert.equal(inferVisibility(deps, DIR).visibility, 'hidden');
    const r = hideFootprint({ dir: DIR, reconcile: true }, deps);
    assert.equal(r.visibility, 'hidden');
    assert.ok(r.wrote.includes('/AGENTS.md'));
  });

  it('untracked + not ignored anchor → ambiguous; --reconcile surfaces it and writes nothing', () => {
    const { world, deps } = mk({}, { world: (w) => w.file('AGENTS.md') });
    assert.equal(inferVisibility(deps, DIR).visibility, 'ambiguous');
    const r = hideFootprint({ dir: DIR, reconcile: true }, deps);
    assert.equal(r.ambiguous, true);
    assert.equal(r.action, 'noop');
    assert.equal(world.read('.git/info/exclude'), undefined);
  });

  it('a committed-but-DELETED AGENTS.md still infers VISIBLE (tracked-ness, not disk presence)', () => {
    // AGENTS.md tracked but absent from the worktree; docs/ai/ present, untracked, not ignored.
    const { deps } = mk({ tracked: ['AGENTS.md'] }, { world: (w) => w.dir('docs/ai') });
    assert.equal(inferVisibility(deps, DIR).visibility, 'visible');
  });
});
