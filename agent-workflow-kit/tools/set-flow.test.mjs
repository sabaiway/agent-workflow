import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, mergeFlowBlock, evaluateArmingFloors, FLOW_BOOKKEEPING_FLOOR_RESIDUAL } from './set-flow.mjs';
import { CONFIG_REL, FLOW_SCHEMA_VERSION, FLOW_SCHEMA_1_FIXTURE, loadConfig } from './orchestration-config.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-set-flow-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
// A repo with docs/ai (the writer's deployment gate) and the two canonical bookkeeping files TRACKED.
const makeRepo = ({ tracked = true } = {}) => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'docs', 'debt.md'), '# debt\n');
  writeFileSync(join(root, 'docs', 'convergence.md'), '# convergence\n');
  if (tracked) {
    sh(['add', 'docs/debt.md', 'docs/convergence.md'], root);
    sh(['commit', '-q', '-m', 'bookkeeping files'], root);
  }
  return root;
};

// kitVersion is injected (host-independent); a spy writeConfig proves the no-write lanes.
const run = (argv, { cwd, kitVersion = '9.9.9', writes = null } = {}) =>
  main(argv, { cwd, kitVersion, ...(writes === null ? {} : { writeConfig: (c, config) => { writes.push(config); return { writtenPath: join(c, CONFIG_REL) }; } }) });

const mergedOf = (r) => {
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout).merged;
};

describe('set-flow — usage refusals (exit 2)', () => {
  const usage = (argv) => {
    const r = run(argv, { cwd: makeRepo() });
    assert.equal(r.code, 2, `expected usage failure for ${argv.join(' ')}`);
    return r.stderr;
  };

  it('schema is pinned by the kit — never an op', () => {
    assert.match(usage(['--set', 'schema=2']), /"schema" is pinned by the kit/);
    assert.match(usage(['--unset', 'schema']), /"schema" is pinned by the kit/);
  });

  it('unknown keys, bad values, duplicates, unknown presets, and a bare --write refuse', () => {
    assert.match(usage(['--set', 'mystery=1']), /unknown flow key "mystery"/);
    assert.match(usage(['--set', 'councilRounds=x']), /councilRounds must be a positive integer/);
    assert.match(usage(['--set', 'councilRounds=0']), /councilRounds must be a positive integer/);
    assert.match(usage(['--set', 'debtQueueExcluded=yes']), /must be true or false/);
    assert.match(usage(['--set', 'candidates=codexreview']), /comma-separated <name>:<class> pairs/);
    assert.match(usage(['--set', 'candidates=codex:judge']), /candidate class must be one of/);
    assert.match(usage(['--set', 'councilRounds=3', '--unset', 'councilRounds']), /duplicate op/);
    assert.match(usage(['--preset', 'council', '--preset', 'reviewed']), /duplicate --preset/);
    assert.match(usage(['--preset', 'mystery']), /unknown preset "mystery"/);
    assert.match(usage(['--write']), /nothing to write/);
    assert.match(usage(['--frobnicate']), /unknown flag/);
    assert.match(usage(['stray']), /unexpected argument/);
  });
});

describe('set-flow — merge (#30: existing < preset seed < explicit ops; schema pinned)', () => {
  it('the council preset seeds the schema-1 literal fixture verbatim, candidates excepted (P20)', () => {
    const merged = mergedOf(run(['--preset', 'council', '--json'], { cwd: makeRepo() }));
    assert.deepEqual(merged, {
      schema: FLOW_SCHEMA_VERSION,
      preset: 'council',
      councilRounds: FLOW_SCHEMA_1_FIXTURE.councilRounds,
      debtQueue: FLOW_SCHEMA_1_FIXTURE.debtQueue,
      convergenceSummary: FLOW_SCHEMA_1_FIXTURE.convergenceSummary,
      debtQueueExcluded: FLOW_SCHEMA_1_FIXTURE.debtQueueExcluded,
      convergenceSummaryExcluded: FLOW_SCHEMA_1_FIXTURE.convergenceSummaryExcluded,
      pregateExclude: [...FLOW_SCHEMA_1_FIXTURE.pregateExclude],
      kitMinVersion: FLOW_SCHEMA_1_FIXTURE.kitMinVersion,
    }, 'the seed IS the fixture — the arming path consumes the SAME literal the structural validator pins');
    assert.equal('candidates' in merged, false, 'candidates are never seeded — they name the project\'s real backends');
  });

  it('explicit --set keys win over the preset seed', () => {
    const merged = mergedOf(run(['--preset', 'council', '--set', 'councilRounds=5', '--json'], { cwd: makeRepo() }));
    assert.equal(merged.councilRounds, 5);
    assert.equal(merged.preset, 'council');
  });

  it('the preset seed wins over the existing block; keys outside the seed are preserved', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, CONFIG_REL), JSON.stringify({
      flow: { schema: 1, councilRounds: 9, candidates: [{ name: 'codex', class: 'review' }] },
    }));
    const merged = mergedOf(run(['--preset', 'council', '--json'], { cwd }));
    assert.equal(merged.councilRounds, FLOW_SCHEMA_1_FIXTURE.councilRounds, 'a re-preset re-seeds preset-owned keys (previewed)');
    assert.deepEqual(merged.candidates, [{ name: 'codex', class: 'review' }], 'an existing key outside the seed survives');
  });

  it('--set candidates parses typed {name, class} objects; --unset drops a key', () => {
    const merged = mergedOf(run(['--preset', 'council', '--set', 'candidates=codex:review,agy:review', '--unset', 'kitMinVersion', '--json'], { cwd: makeRepo() }));
    assert.deepEqual(merged.candidates, [{ name: 'codex', class: 'review' }, { name: 'agy', class: 'review' }]);
    assert.equal('kitMinVersion' in merged, false);
  });

  it('mergeFlowBlock always pins schema even against an existing foreign value', () => {
    assert.equal(mergeFlowBlock({ existing: { schema: 1, councilRounds: 2 }, preset: null, sets: {}, unsets: new Set() }).schema, FLOW_SCHEMA_VERSION);
  });
});

describe('set-flow — preview-first (#30) and the no-op lane', () => {
  it('a preview writes NOTHING', () => {
    const writes = [];
    const r = run(['--preset', 'council'], { cwd: makeRepo(), writes });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /set-flow — preview \(nothing written\)/);
    assert.match(r.stdout, /merged flow block:/);
    assert.match(r.stdout, /arming floors: PASS/);
    assert.match(r.stdout, /would write .* re-run with --write to apply/);
    assert.deepEqual(writes, []);
  });

  it('a no-op --write writes nothing (the merged block equals the current one)', () => {
    const cwd = makeRepo();
    const first = run(['--preset', 'council', '--write'], { cwd });
    assert.equal(first.code, 0, first.stderr);
    const writes = [];
    const again = run(['--preset', 'council', '--write'], { cwd, writes });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /set-flow — nothing written \(the merged flow block equals the current one\)/, 'a --write no-op says NOTHING WRITTEN, never "preview"');
    assert.ok(!again.stdout.includes('re-run with --write'), 'a satisfied --write never instructs a re-run');
    assert.ok(!again.stdout.includes('would write'), 'a no-op never promises a write');
    assert.deepEqual(writes, []);
  });

  it('the read-only invocation (no ops) shows the current flow state and writes nothing', () => {
    const cwd = makeRepo();
    const empty = run([], { cwd });
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /no flow block .* the flow is config-unarmed/);
  });

  it('the read-only invocation honors --json — a machine-readable status object, never human text', () => {
    const cwd = makeRepo();
    const empty = run(['--json'], { cwd });
    assert.equal(empty.code, 0);
    assert.deepEqual(JSON.parse(empty.stdout), { flow: null, noop: true });
  });
});

describe('set-flow — the kitMinVersion floor (Decision 6 — the FLOW-VERSION-FLOORS guarded shape)', () => {
  it('a kit meeting the floor passes; a kit below it refuses', () => {
    const cwd = makeRepo();
    assert.equal(run(['--preset', 'council'], { cwd, kitVersion: FLOW_SCHEMA_1_FIXTURE.kitMinVersion }).code, 0, 'the floor itself meets the floor');
    const below = run(['--preset', 'council'], { cwd, kitVersion: '5.0.9' });
    assert.equal(below.code, 1);
    assert.match(below.stdout, /FLOOR REFUSED — flow\.kitMinVersion/);
    assert.match(below.stderr, /arming floors refused — nothing written/);
  });

  it('an unparseable version on EITHER side never passes — the bare `>= 0` fail-open shape is banned', () => {
    const cwd = makeRepo();
    const unknownKit = run(['--preset', 'council'], { cwd, kitVersion: null });
    assert.equal(unknownKit.code, 1, 'an unknown kit version never meets a floor (null-guard)');
    assert.match(unknownKit.stdout, /null-guarded/);
    const unparseableFloor = run(['--preset', 'council', '--set', 'kitMinVersion=not-a-version'], { cwd, kitVersion: '9.9.9' });
    assert.equal(unparseableFloor.code, 1, 'an unparseable floor never passes (null-guard)');
  });
});

describe('set-flow — the bookkeeping floors (#37/#69: decidable set only, loud residual)', () => {
  const floorFail = (argv, opts) => {
    const r = run(argv, opts);
    assert.equal(r.code, 1, `expected a floor refusal; got code ${r.code}: ${r.stdout}`);
    return r.stdout;
  };

  it('tracked single regular files pass; an untracked path refuses by name', () => {
    const cwd = makeRepo({ tracked: false });
    const out = floorFail(['--preset', 'council'], { cwd });
    assert.match(out, /flow\.debtQueue "docs\/debt.md": not tracked/);
    assert.match(out, /track it as a single regular file, or declare it excluded loudly \(debtQueueExcluded: true\)/);
  });

  it('a symlink or a directory at the declared path refuses', () => {
    const cwd = makeRepo();
    rmSync(join(cwd, 'docs', 'debt.md'));
    symlinkSync(join(cwd, 'docs', 'convergence.md'), join(cwd, 'docs', 'debt.md'));
    assert.match(floorFail(['--preset', 'council'], { cwd }), /a symlink — never a bookkeeping path/);
    const cwd2 = makeRepo();
    rmSync(join(cwd2, 'docs', 'convergence.md'));
    mkdirSync(join(cwd2, 'docs', 'convergence.md'));
    assert.match(floorFail(['--preset', 'council'], { cwd: cwd2 }), /a directory — never a bookkeeping path/);
  });

  it('a path under docs/ai/ refuses', () => {
    const out = floorFail(['--preset', 'council', '--set', 'debtQueue=docs/ai/debt.md'], { cwd: makeRepo() });
    assert.match(out, /never lives under docs\/ai\//);
  });

  it('a non-repo-relative path refuses lexically', () => {
    const out = floorFail(['--preset', 'council', '--set', 'debtQueue=../outside.md'], { cwd: makeRepo() });
    assert.match(out, /must be lexically repo-relative/);
  });

  it('a dot-segment spelling never dodges the docs/ai ban or the other floors — segments refuse explicitly', () => {
    const out = floorFail(['--preset', 'council', '--set', 'debtQueue=docs/plans/../ai/debt.md', '--set', 'debtQueueExcluded=true'], { cwd: makeRepo() });
    assert.match(out, /without "\." or "\.\." segments/);
  });

  it('a symlinked ancestor component refuses by name — the class walk is no-follow over the whole chain', () => {
    const cwd = makeRepo();
    mkdirSync(join(cwd, 'real'), { recursive: true });
    writeFileSync(join(cwd, 'real', 'debt.md'), '# debt\n');
    symlinkSync(join(cwd, 'real'), join(cwd, 'docs', 'linkdir'));
    const out = floorFail(['--preset', 'council', '--set', 'debtQueue=docs/linkdir/debt.md', '--set', 'debtQueueExcluded=true'], { cwd });
    assert.match(out, /ancestor "docs\/linkdir" is a symlink/);
  });

  it('a schema-invalid gates.json is an undecidable gate-cmd floor — structural errors fail closed', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: {} }));
    const out = floorFail(['--preset', 'council'], { cwd });
    assert.match(out, /"gates" must be an array[\s\S]*the gate-cmd floor is undecidable \(fail closed\)/);
  });

  it('a dangling-symlink gates.json is PRESENT-but-unreadable — never a silently absent declaration', () => {
    const cwd = makeRepo();
    symlinkSync(join(cwd, 'docs', 'ai', 'missing-target.json'), join(cwd, 'docs', 'ai', 'gates.json'));
    const out = floorFail(['--preset', 'council'], { cwd });
    assert.match(out, /gates\.json: unreadable[\s\S]*the gate-cmd floor is undecidable \(fail closed\)/);
  });

  it('a backslash byte in a declared path refuses — forward-slash is the only separator the floors judge', () => {
    const out = floorFail(['--preset', 'council', '--set', 'debtQueue=docs\\ai\\debt.md', '--set', 'debtQueueExcluded=true'], { cwd: makeRepo() });
    assert.match(out, /backslash/);
  });

  it('a tracked path deleted from the worktree refuses — the bookkeeping file must exist on disk', () => {
    const cwd = makeRepo();
    rmSync(join(cwd, 'docs', 'debt.md'));
    const out = floorFail(['--preset', 'council'], { cwd });
    assert.match(out, /absent from the worktree/);
  });

  it('a literal substring of a declared gate cmd refuses naming the gate', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'debt-lint', title: 't', cmd: 'node lint.mjs docs/debt.md' }] }));
    const out = floorFail(['--preset', 'council'], { cwd });
    assert.match(out, /a literal substring of declared gate "debt-lint"/);
  });

  it('a malformed gates.json is an undecidable gate-cmd floor — fail closed', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), '{ not json');
    assert.match(floorFail(['--preset', 'council'], { cwd }), /gates\.json: malformed JSON[\s\S]*the gate-cmd floor is undecidable \(fail closed\)/);
  });

  it('declared-excluded waives ONLY tracked-ness, loudly; the class floors still hold', () => {
    const cwd = makeRepo({ tracked: false });
    const r = run(['--preset', 'council', '--set', 'debtQueueExcluded=true', '--set', 'convergenceSummaryExcluded=true'], { cwd });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /DECLARED-EXCLUDED — the tracked-file floor is waived by the explicit declaration/);
    rmSync(join(cwd, 'docs', 'debt.md'));
    mkdirSync(join(cwd, 'docs', 'debt.md'));
    const still = run(['--preset', 'council', '--set', 'debtQueueExcluded=true'], { cwd });
    assert.equal(still.code, 1, 'a directory refuses even when declared-excluded — the class floor is never waived');
  });

  it('outside a git work tree the tracked-ness floor is undecidable — fail closed', () => {
    const cwd = join(TMP, `no-git-${seq += 1}`);
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'debt.md'), '# debt\n');
    writeFileSync(join(cwd, 'docs', 'convergence.md'), '# c\n');
    assert.match(floorFail(['--preset', 'council'], { cwd }), /not inside a git work tree .* undecidable \(fail closed\)/);
  });

  it('floors hold on the --write lane — nothing is written past a failing floor', () => {
    const writes = [];
    const r = run(['--preset', 'council', '--write'], { cwd: makeRepo({ tracked: false }), writes });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /set-flow — nothing written \(arming floors refused\)/, 'a refused --write says NOTHING WRITTEN, never "preview"');
    assert.match(r.stdout, /nothing will be written until every floor passes/);
    assert.ok(!r.stdout.includes('re-run with --write'), 'a refused --write never instructs a re-run');
    assert.ok(!r.stdout.includes('would write'), 'a refusal never promises a write');
    assert.deepEqual(writes, []);
  });

  it('the disclosed residual prints on every floor evaluation — the honest boundary, never a pretended rule', () => {
    assert.ok(FLOW_BOOKKEEPING_FLOOR_RESIDUAL.includes('not a pretended rule'));
    const r = run(['--preset', 'council'], { cwd: makeRepo() });
    assert.ok(r.stdout.includes(`residual: ${FLOW_BOOKKEEPING_FLOOR_RESIDUAL}`));
    const failing = run(['--preset', 'council'], { cwd: makeRepo({ tracked: false }) });
    assert.ok(failing.stdout.includes(`residual: ${FLOW_BOOKKEEPING_FLOOR_RESIDUAL}`));
    assert.ok(!failing.stdout.includes('re-run with --write'), 'a floor-failing preview never instructs a re-run it would refuse');
  });
});

describe('set-flow — the write lane', () => {
  it('--write lands the merged block through the hardened writer; untouched activities survive', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, CONFIG_REL), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const r = run(['--preset', 'council', '--set', 'candidates=codex:review,agy:review', '--write'], { cwd });
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, new RegExp(`wrote ${CONFIG_REL}`));
    assert.match(r.stdout, /the CONFIG half is armed — the chain half arms at plan adoption/);
    const { config } = loadConfig(cwd);
    assert.equal(config['plan-execution'].review, 'council', 'untouched activities survive the write');
    assert.equal(config.flow.schema, FLOW_SCHEMA_VERSION);
    assert.deepEqual(config.flow.candidates, [{ name: 'codex', class: 'review' }, { name: 'agy', class: 'review' }]);
  });

  it('a malformed existing config refuses loudly and stays untouched', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, CONFIG_REL), '{ not json');
    const r = run(['--preset', 'council', '--write'], { cwd });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /malformed JSON/);
    assert.equal(readFileSync(join(cwd, CONFIG_REL), 'utf8'), '{ not json', 'an unparseable config is never clobbered');
  });
});

describe('set-flow — coverage characterizations (green pins)', () => {
  it('--set candidates= (empty) declares an empty typed list; the inline --preset= form parses; a duplicate inline preset refuses', () => {
    const merged = mergedOf(run(['--preset=council', '--set', 'candidates=', '--json'], { cwd: makeRepo() }));
    assert.deepEqual(merged.candidates, []);
    const dup = run(['--preset=council', '--preset=reviewed'], { cwd: makeRepo() });
    assert.equal(dup.code, 2);
    assert.match(dup.stderr, /duplicate --preset/);
    const unknown = run(['--preset=mystery'], { cwd: makeRepo() });
    assert.equal(unknown.code, 2);
  });

  it('preset is settable as an ordinary key too (--set preset=…, incl. the inline --set= form)', () => {
    const merged = mergedOf(run(['--preset=council', '--set=preset=reviewed', '--set', 'councilRounds=4', '--unset=kitMinVersion', '--json'], { cwd: makeRepo() }));
    assert.equal(merged.preset, 'reviewed', 'the explicit key wins over the seed');
    assert.equal(merged.councilRounds, 4);
    assert.equal('kitMinVersion' in merged, false, 'the inline --unset= form drops the key');
    const bad = run(['--set', 'preset=mystery'], { cwd: makeRepo() });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /preset must be one of/);
  });

  it('an unstatable bookkeeping LEAF is an undecidable disk class (fail closed)', () => {
    const dirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    const r = evaluateArmingFloors({ schema: 1, debtQueue: 'docs/debt.md' }, {
      cwd: '/nowhere',
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      lstat: (p) => {
        if (p.endsWith('debt.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        if (p.endsWith('gates.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return dirStat;
      },
      runGit: (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: Buffer.from('/nowhere\n') } : { status: 0, stdout: Buffer.from('') }),
      kitVersion: '9.9.9',
    });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /unstatable \(EACCES\) — the disk class is undecidable \(fail closed\)/);
  });

  it('an unstatable ancestor in the class walk is an undecidable floor (fail closed)', () => {
    const r = evaluateArmingFloors({ schema: 1, debtQueue: 'docs/debt.md' }, {
      cwd: '/nowhere',
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      lstat: (p) => { throw Object.assign(new Error(p.endsWith('docs') ? 'EACCES' : 'ENOENT'), { code: p.endsWith('docs') ? 'EACCES' : 'ENOENT' }); },
      runGit: (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: Buffer.from('/nowhere\n') } : { status: 0, stdout: Buffer.from('') }),
      kitVersion: '9.9.9',
    });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /unstatable ancestor "docs" \(EACCES\) — the class walk is undecidable \(fail closed\)/);
  });

  it('the CLI entry runs as a child process (--help, exit 0)', () => {
    const tool = new URL('./set-flow.mjs', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Deep arming floors run HERE only/);
  });
});

describe('set-flow — evaluateArmingFloors is pure over injected io', () => {
  it('a hermetic run needs no real repo (all io injected)', () => {
    const io = {
      cwd: '/nowhere',
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      runGit: () => ({ status: 0, stdout: Buffer.from('/nowhere\n') }),
      kitVersion: '9.9.9',
    };
    const clean = evaluateArmingFloors({ schema: 1, kitMinVersion: '1.0.0', debtQueueExcluded: true, debtQueue: 'docs/debt.md' }, {
      ...io,
      runGit: (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: Buffer.from('/nowhere\n') } : { status: 0, stdout: Buffer.from('') }),
    });
    assert.deepEqual(clean.failures, []);
    assert.equal(clean.notes.length, 1);
  });
});
