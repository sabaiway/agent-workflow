// direct-run.test.mjs — the shared direct-run predicate and the library-only registry.
//
// The class this closes: a LEXICAL entry-point comparison (`import.meta.url === pathToFileURL(
// process.argv[1]).href`) is FALSE whenever the module is invoked through a symlink, so a guard built
// on it silently does nothing there. Every assertion below that matters is therefore run BOTH ways —
// direct and through a link — and the link arm is the one that would go green on the broken form.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DIRECT_RUN_USAGE_EXIT,
  LIBRARY_ONLY_MODULES,
  isDirectRun,
  libraryOnlyLine,
  refuseDirectRun,
  sameFile,
} from './direct-run.mjs';
import { COMMANDS } from './commands.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const MODES = join(TOOLS, '..', 'references', 'modes');
// A module HAS a CLI when it really COMPUTES the direct-run predicate. The WORD alone is not
// evidence: a header comment mentioning the idiom would otherwise excuse a library module from the
// registry (a round-1 council finding, on this very test). Three spellings exist in this tree today —
// the shared leaf's call, the legacy lexical comparison, and dispatch.mjs's own realpath predicate —
// and the sharpened form immediately surfaced the third, which the word-match had been hiding.
const HAS_CLI_ENTRY = /isDirectRun\(import\.meta\.url\)|import\.meta\.url === pathToFileURL\(|isEntryPoint\(process\.argv\[1\]/;
const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-run-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('isDirectRun — compared by REAL path', () => {
  it('is true for the module itself and false for another file', () => {
    const self = join(TOOLS, 'direct-run.mjs');
    assert.equal(isDirectRun(pathToFileURL(self).href, self), true);
    assert.equal(isDirectRun(pathToFileURL(self).href, join(TOOLS, 'commands.mjs')), false);
  });

  it('is true when the entry point is a SYMLINK to the module (the false-green the lexical form has)', () => {
    withTmp((dir) => {
      const self = join(TOOLS, 'direct-run.mjs');
      const link = join(dir, 'linked-entry.mjs');
      symlinkSync(self, link);
      assert.equal(isDirectRun(pathToFileURL(self).href, link), true, 'realpath compare sees through the link');
      // And the lexical comparison this replaced does NOT — stated here so the difference is a fact of
      // the suite, not a claim in a comment.
      assert.equal(pathToFileURL(self).href === pathToFileURL(link).href, false);
    });
  });

  it('is false when argv[1] is absent (an import, not a run)', () => {
    assert.equal(isDirectRun(pathToFileURL(join(TOOLS, 'direct-run.mjs')).href, undefined), false);
  });

  it('sameFile answers false for an unresolvable path instead of throwing', () => {
    assert.equal(sameFile(join(TOOLS, 'no-such-file.mjs'), join(TOOLS, 'direct-run.mjs')), false);
  });
});

describe('the library-only registry', () => {
  it('is non-empty and every member points at an EXISTING kit command', () => {
    const invocations = new Set(COMMANDS.map((c) => c.invocation));
    const entries = Object.entries(LIBRARY_ONLY_MODULES);
    assert.ok(entries.length > 0, 'an empty registry would make every assertion below vacuous');
    for (const [name, command] of entries) {
      assert.ok(invocations.has(command), `${name} points at "${command}", which is not a command of the catalog`);
    }
  });

  it('every member is a real tools module that CARRIES the guard', () => {
    for (const name of Object.keys(LIBRARY_ONLY_MODULES)) {
      const source = readFileSync(join(TOOLS, name), 'utf8');
      assert.ok(source.includes('refuseDirectRun(import.meta.url)'), `${name} is registered but does not call the guard`);
    }
  });

  it('refuses to compose a line for an unregistered module (registering IS the way in)', () => {
    assert.throws(() => libraryOnlyLine('not-registered.mjs'), /register it before guarding it/);
  });

  it('refuseDirectRun is a no-op when the module was imported, and loud when it was run', () => {
    const self = pathToFileURL(join(TOOLS, 'orchestration-config.mjs')).href;
    const said = [];
    let exitCode = null;
    assert.equal(refuseDirectRun(self, { argv1: join(TOOLS, 'commands.mjs'), errlog: (l) => said.push(l) }), 0);
    assert.deepEqual(said, [], 'an import prints nothing');
    const code = refuseDirectRun(self, {
      argv1: join(TOOLS, 'orchestration-config.mjs'),
      errlog: (l) => said.push(l),
      setExitCode: (c) => { exitCode = c; },
    });
    assert.equal(code, DIRECT_RUN_USAGE_EXIT);
    assert.equal(exitCode, DIRECT_RUN_USAGE_EXIT);
    assert.deepEqual(said, ['orchestration-config.mjs: library module — no CLI; use /agent-workflow-kit set-recipe']);
  });
});

describe('a registered module invoked as a command refuses — directly AND through a link', () => {
  for (const [name, command] of Object.entries(LIBRARY_ONLY_MODULES)) {
    it(`${name}: direct invocation exits non-zero and names ${command}`, () => {
      const r = spawnSync(process.execPath, [join(TOOLS, name)], { encoding: 'utf8' });
      assert.equal(r.status, DIRECT_RUN_USAGE_EXIT);
      assert.equal(r.stderr.trim(), libraryOnlyLine(name));
      assert.equal(r.stdout, '', 'a refusal says nothing on stdout that a caller could paste as an outcome');
    });

    it(`${name}: invocation THROUGH A SYMLINK refuses too`, () => {
      withTmp((dir) => {
        const link = join(dir, `linked-${name}`);
        symlinkSync(join(TOOLS, name), link);
        const r = spawnSync(process.execPath, [link], { encoding: 'utf8' });
        assert.equal(r.status, DIRECT_RUN_USAGE_EXIT, 'a lexical guard would exit 0 here, having done nothing');
        assert.equal(r.stderr.trim(), libraryOnlyLine(name));
      });
    });
  }
});

describe('registry completeness — a library module a MODE DOC names must be registered', () => {
  // The membership rule (direct-run.mjs header): reachable by name. A module the docs point at is one
  // an agent can try to run; this walk is what keeps the registry from lagging the docs.
  it('every tools/*.mjs named in references/modes/*.md either has a CLI or is registered', () => {
    const named = new Map();
    for (const file of readdirSync(MODES)) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(MODES, file), 'utf8');
      for (const m of text.matchAll(/tools\/([A-Za-z0-9._-]+\.mjs)/g)) {
        if (!named.has(m[1])) named.set(m[1], file);
      }
    }
    assert.ok(named.size > 0, 'the mode docs must name tools — an empty walk would pass vacuously');
    const unguarded = [];
    for (const [name, mode] of named) {
      const path = join(TOOLS, name);
      let source;
      try {
        source = readFileSync(path, 'utf8');
      } catch {
        continue; // a doc may name a path outside tools/ shapes; the doc-parity suite owns that
      }
      const hasCli = HAS_CLI_ENTRY.test(source);
      if (!hasCli && !(name in LIBRARY_ONLY_MODULES)) unguarded.push(`${name} (named by ${mode})`);
    }
    assert.deepEqual(unguarded, [], 'a mode doc names a library-only module with no pointer — add it to LIBRARY_ONLY_MODULES');
  });
});

describe('the guard leaves an ordinary import alone', () => {
  it('importing a registered module runs nothing and sets no exit code', async () => {
    const before = process.exitCode;
    const mod = await import('./orchestration-config.mjs');
    assert.equal(process.exitCode, before, 'an import must not set an exit code');
    assert.equal(typeof mod.loadConfig, 'function');
  });
});

// A fixture the two spawn arms share: a file that is NOT a tools module must never be classified as
// one by the walk above (non-vacuity from the other side).
describe('the walk is not vacuous', () => {
  it('a mode doc naming a module WITH a CLI is not demanded to register', () => {
    withTmp((dir) => {
      const doc = join(dir, 'fake-mode.md');
      writeFileSync(doc, 'run `node ${CLAUDE_SKILL_DIR}/tools/run-gates.mjs --cwd .`\n');
      const source = readFileSync(join(TOOLS, 'run-gates.mjs'), 'utf8');
      assert.ok(/\bisDirectRun\b/.test(source), 'run-gates has a CLI, so the walk skips it');
      assert.equal('run-gates.mjs' in LIBRARY_ONLY_MODULES, false);
    });
  });
});
