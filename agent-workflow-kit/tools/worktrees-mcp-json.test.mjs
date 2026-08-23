// worktrees-mcp-json.test.mjs — `/.mcp.json` is in the hidden-mode registry but must never be
// provisioned into a worktree: an MCP registration names an absolute machine path and its consent is
// per checkout. The registry is read at three worktree sites and each one needs the exclusion for a
// DIFFERENT reason — the copy set would copy a machine-local launcher, the containment sweep would
// STOP the provision on an ESCAPING SYMLINK at that path (a device-node mask realpaths inside the
// repo and reaches the later special-file refusal instead), and cleanup ownership would DELETE a
// satellite's own file instead of refusing. One frozen set, three call sites, one arm here per site.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
// Dynamic import so this spec LOADS against the pre-fix tree (the red-first doctrine).
const { EXIT, runCli, provisionCopySet, rebaseAbsolutePins } = await import('./worktrees.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-mcp-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/.mcp.json', '/node_modules', ''];

// MAIN carries a registered typed channel: the launcher plus the settings half that enables it.
const makeRepo = (name, { mcpJson = 'file', pin = true } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), EXCLUDES.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude/settings.json'), JSON.stringify({
    enabledMcpjsonServers: ['agent-workflow', 'someone-elses-server'],
    permissions: { allow: ['mcp__agent-workflow__path_inventory', 'mcp__agent-workflow__repo_search', 'Bash(ls:*)'] },
    // An absolute MAIN-root pin makes rebasePins rewrite the copy, which is what the REBASED branch
    // of isMainCopy needs. WITHOUT it the copy stays byte-equal to MAIN — the other branch. A repo
    // carrying the pin can therefore never exercise the exact-match branch at all.
    ...(pin ? { pinned: `${main}/agent-workflow-kit/tools/mcp-server.mjs` } : {}),
  }, null, 2));
  const entry = { mcpServers: { 'agent-workflow': { type: 'stdio', command: 'node', args: [`${main}/kit/mcp-server.mjs`] } } };
  if (mcpJson === 'file') writeFileSync(join(main, '.mcp.json'), JSON.stringify(entry, null, 2));
  // The escaping mask form: realpath leaves the repo, which is what the containment sweep STOPs on.
  if (mcpJson === 'escaping-symlink') symlinkSync('/dev/null', join(main, '.mcp.json'));
  return main;
};

const run = (argv, cwd) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out: out.join('\n'), errText: err.join('\n') };
};

const provision = (repo, slug) =>
  run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`], repo);
const wtPath = (repo, slug) => join(dirname(repo), `${basename(repo)}--${slug}`);

describe('worktrees — /.mcp.json is registry-known but never provisioned', () => {
  it('the copy set omits it even though the registry carries it and the file is present', () => {
    const main = makeRepo('copyset');
    const set = provisionCopySet(main);
    assert.ok(set.includes('/AGENTS.md'), 'the fixture really is a footprint-carrying repo');
    assert.ok(!set.includes('/.mcp.json'), 'a machine-local launcher is never copied into a worktree');
  });

  it('the containment sweep never inspects it, so a node that resolves OUTSIDE the repo cannot STOP a provision', () => {
    const main = makeRepo('sweep', { mcpJson: 'escaping-symlink' });
    const r = provision(main, 'sweepy');
    assert.equal(r.code, EXIT.ok, `provision must not stop on .mcp.json: ${r.errText}`);
    assert.doesNotMatch(r.errText, /\.mcp\.json/, 'the sweep never names it');
  });

  it('the provisioned worktree has no .mcp.json and no enable for a server it does not declare', () => {
    const main = makeRepo('settings');
    assert.equal(provision(main, 'sat').code, EXIT.ok);
    const wt = wtPath(main, 'sat');
    assert.ok(!existsIn(wt, '.mcp.json'), 'no launcher was copied');
    const settings = JSON.parse(readFileSync(join(wt, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(settings.enabledMcpjsonServers, ['someone-elses-server'], 'ours dropped, foreign kept');
    assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)'], 'our two derived rules dropped, foreign kept');
  });

  // The set is absent from reservedRels precisely BECAUSE provision skips it, so the overlap arm
  // cannot see it — --include is the one door that would copy AND own the launcher.
  it('--include cannot smuggle it in through the one door that bypasses the copy set', () => {
    const main = makeRepo('include');
    const r = run(['provision', 'inc', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-inc.md',
      '--include', '.mcp.json'], main);
    assert.notEqual(r.code, EXIT.ok, 'the include is refused');
    assert.match(r.errText, /never gets and never owns/u);
    assert.ok(!existsIn(wtPath(main, 'inc'), '.mcp.json'), 'and nothing was copied');
  });

  it('a TRACKED settings file keeps its bytes and the orphaned enable is reported, never fixed', () => {
    const main = makeRepo('tracked');
    sh(['add', '-f', '.claude/settings.json'], main);
    sh(['commit', '-q', '-m', 'team tracks its settings'], main);
    const before = readFileSync(join(main, '.claude/settings.json'), 'utf8');
    const r = provision(main, 'trk');
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(readFileSync(join(wtPath(main, 'trk'), '.claude/settings.json'), 'utf8'), before, 'byte-identical');
    assert.match(r.out, /tracked — carries registration tokens/u, 'and the orphan is named');
  });

  // ── the settings strip: CONDITION COVERAGE over the admission ──────────────────────────
  //
  // Three review rounds each found one more sub-state an exclusion list had not enumerated, and
  // every miss failed OPEN (tokens removed from a file that still had a live declaration). So the
  // write is admitted by ONE conjunction of proven facts, and these rows are the success case plus
  // each conjunct negated ON ITS OWN — condition coverage, deliberately NOT the full cross-product.
  // Every row that is not a WRITE row must leave our tokens untouched.
  //
  // Conjuncts: settings untracked? · bytes still MAIN's (or rebased)? · launcher proven ABSENT?
  const SETTINGS_STATES = [
    // No pin in the fixture, so nothing rebases and the copy stays byte-equal to MAIN — the ONLY
    // way the exact-match branch of isMainCopy is reached.
    { name: 'untracked, exact MAIN bytes, no launcher', pin: false, strips: true },
    // The OTHER admitted byte-form: rebasePins already rewrote the copy's MAIN-root pins, so the
    // bytes equal rebased-MAIN rather than MAIN. Without this row that branch never executes.
    { name: 'untracked, REBASED-MAIN bytes, no launcher', rebased: true, strips: true },
    { name: 'tracked', tracked: true, why: /tracked —/u },
    // The same conjunct also covers an ABSENT or unreadable MAIN settings file, so the report says
    // what is actually known — not proven to match — rather than blaming the user for an edit.
    { name: 'bytes not proven to match MAIN', edit: true, why: /not proven to match MAIN —/u },
    { name: 'launcher present WITH our entry', launcher: { mcpServers: { 'agent-workflow': { type: 'stdio' } } }, why: /is present or unreadable/u },
    { name: 'launcher present WITHOUT our entry', launcher: { mcpServers: { other: {} } }, why: /is present or unreadable/u },
    { name: 'launcher is a symlink (unreadable, never followed)', symlink: true, why: /is present or unreadable/u },
    // Not a conjunct — the rewrite itself refuses, because a JSON round-trip would collapse the
    // duplicate key and destroy foreign data. It must SAY so rather than skip silently.
    {
      name: 'the rewrite would lose foreign data',
      seedText: `{"dup":1,"dup":2,"enabledMcpjsonServers":["agent-workflow","someone-elses-server"]}`,
      why: /duplicate key would be collapsed/u,
    },
    // Invalid UTF-8 decodes lossily to U+FFFD. The fixture ALSO carries a MAIN-root pin, so both
    // lanes that would rewrite it — the pin rebase and the token strip — must each refuse on their
    // own; a lossy decode in either one silently destroys those bytes.
    {
      name: 'the settings copy is not valid UTF-8',
      seedBytes: (main) => Buffer.concat([
        Buffer.from(`{"pinned":"${main}/x","note":"`), Buffer.from([0xff, 0xfe]),
        Buffer.from('","enabledMcpjsonServers":["agent-workflow"]}'),
      ]),
      why: /not valid UTF-8 — left untouched, pins not rebased/u,
      alsoWhy: /not valid UTF-8 — left untouched, and no registration claim/u,
      tokensUnreadable: true,
    },
    // MAIN carries a BOM, the copy does not. A BOM-stripping decoder maps both to the SAME string,
    // so a string-equality proof would authorise a rewrite of a file that is not MAIN's bytes.
    { name: 'MAIN carries a BOM and the copy does not', mainBom: true, why: /not proven to match MAIN —/u },
  ];

  for (const state of SETTINGS_STATES) {
    it(`settings strip — ${state.name} → ${state.strips ? 'STRIPPED' : 'left untouched'}`, () => {
      const slug = 'st';
      const main = makeRepo(`state-${SETTINGS_STATES.indexOf(state)}`, { pin: state.pin !== false });
      if (state.tracked) {
        sh(['add', '-f', '.claude/settings.json'], main);
        sh(['commit', '-q', '-m', 'tracked settings'], main);
      }
      assert.equal(provision(main, slug).code, EXIT.ok);
      const wt = wtPath(main, slug);
      const wtSettings = join(wt, '.claude/settings.json');
      // Restore MAIN's registration tokens so every row starts from the same settings content.
      const mainSettings = join(main, '.claude/settings.json');
      // The BOM goes on MAIN only — the worktree copy below is seeded from the BOM-LESS text, so the
      // two files differ by exactly those three bytes.
      const mainBytes = readFileSync(mainSettings, 'utf8');
      if (state.mainBom) writeFileSync(mainSettings, `﻿${mainBytes}`);
      const seed = state.seedText ?? (state.edit ? JSON.stringify({ enabledMcpjsonServers: ['agent-workflow'], mine: true }, null, 2)
        : state.rebased ? rebaseAbsolutePins(mainBytes, main, wt).text
          : mainBytes);
      if (state.rebased) assert.notEqual(seed, mainBytes, 'sanity: the rebase really changed the bytes');
      const seedBytes = typeof state.seedBytes === 'function' ? state.seedBytes(main) : state.seedBytes;
      writeFileSync(wtSettings, seedBytes ?? seed);
      if (state.launcher) writeFileSync(join(wt, '.mcp.json'), JSON.stringify(state.launcher, null, 2));
      if (state.symlink) symlinkSync('/dev/null', join(wt, '.mcp.json'));
      const before = readFileSync(wtSettings, 'utf8');
      const r = run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, '--resume'], main);
      assert.equal(r.code, EXIT.ok, r.errText);
      const after = readFileSync(wtSettings, 'utf8');
      if (state.strips) {
        const parsed = JSON.parse(after);
        assert.ok(!parsed.enabledMcpjsonServers.includes('agent-workflow'), 'ours dropped');
        assert.match(r.out, /dropped our registration tokens/u);
        if (state.rebased) assert.equal(parsed.pinned, `${wt}/agent-workflow-kit/tools/mcp-server.mjs`, 'the rebased pin survives the strip');
        return;
      }
      // The invariant is that EVERY one of our tokens survives, not that the bytes are frozen:
      // rebasePins may still rewrite a MAIN-root pin in the same file, and that is its lane, not
      // ours. Compared as a full projection — an "at least one survived" check would pass a
      // partial removal, which is the same defect one token quieter.
      assert.match(r.out, state.why);
      if (state.alsoWhy) assert.match(r.out, state.alsoWhy, 'BOTH rewriting lanes refuse on their own');
      if (state.tokensUnreadable) {
        assert.deepEqual(readFileSync(wtSettings), seedBytes, 'the bytes are returned untouched');
        return;
      }
      assert.deepEqual(ourTokens(after), ourTokens(seed), 'an unproven state removes NO registration token');
      assert.match(r.out, /carries registration tokens/u, 'neutral wording — no enable is claimed');
      assert.doesNotMatch(r.out, /dropped our registration tokens/u);
    });
  }
});

// Every agent-workflow token a settings text carries, as a comparable projection.
const ourTokens = (text) => {
  const s = JSON.parse(text);
  return {
    enabled: (s.enabledMcpjsonServers ?? []).filter((n) => n === 'agent-workflow'),
    allow: (s.permissions?.allow ?? []).filter((r) => r.startsWith('mcp__agent-workflow__')),
  };
};

const existsIn = (dir, rel) => {
  try { readFileSync(join(dir, rel)); return true; } catch { return false; }
};
