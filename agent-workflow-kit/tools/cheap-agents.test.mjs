import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_DIR,
  WORKFLOW_STAMP,
  EXPECTED_WORKFLOW_VERSION,
  BUNDLED_AGENTS_DIR,
  readBundledAgents,
  writeCheapAgents,
  formatResult,
  parseArgs,
  main,
  CHEAP_AGENTS_STAMP,
  CHEAP_AGENTS_SYMLINK,
  FALLBACK_LENS_ADDITIONAL_ONLY,
  EXECUTOR_VEHICLE,
  EXECUTOR_VEHICLE_REL,
  surveyExecutorVehicle,
  CLAUDE_DIR,
} from './cheap-agents.mjs';

const tempDirs = [];
const makeProject = ({ stamp = EXPECTED_WORKFLOW_VERSION } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cheap-agents-'));
  tempDirs.push(dir);
  if (stamp !== null) {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_STAMP), `${stamp}\n`);
  }
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const BUNDLE = readBundledAgents();
const EXPECTED_VEHICLES = ['changelog-skeleton.md', 'executor.md', 'gate-triage.md', 'mechanical-sweep.md', 'review-lens.md'];
// The CHEAP subset is model-pinned to haiku/low. `review-lens` is deliberately NOT in it: it exists
// so a read-only REVIEW has a vehicle at all, and a review on the cheap model would be theatre.
const CHEAP_VEHICLES = new Set(['changelog-skeleton.md', 'gate-triage.md', 'mechanical-sweep.md']);
const READ_ONLY_BUNDLE = BUNDLE.filter((template) => template.name !== EXECUTOR_VEHICLE);
const EXECUTOR = BUNDLE.find((template) => template.name === EXECUTOR_VEHICLE);

// ── the bundled vehicles: content pins (bounded read-only tools; cheap subset model-pinned) ────

describe('bundled vehicles — frontmatter pins', () => {
  it('ships exactly the documented vehicles', () => {
    assert.deepEqual(BUNDLE.map((t) => t.name), EXPECTED_VEHICLES);
  });

  // THE invariant that closes the recurring prompt-flood class: a read-only fan-out vehicle grants
  // no shell, so it CANNOT reach for one no matter what it is asked to do. It holds for EVERY
  // vehicle including the review lens — that is what makes the lens a safe place to send a review.
  it('NO read-only vehicle grants Bash — the property that makes a read-only fan-out structurally quiet', () => {
    for (const template of READ_ONLY_BUNDLE) {
      const tools = template.content.match(/^tools: (.+)$/m);
      assert.ok(tools, `${template.name} declares a tools list`);
      const toolList = tools[1].split(',').map((t) => t.trim());
      assert.ok(!toolList.includes('Bash'), `${template.name} must not grant Bash`);
      assert.ok(toolList.length > 0, `${template.name} grants at least one tool`);
    }
  });

  it('EXACTLY ONE bundled vehicle omits the tools list — executor, the full-tool one, on a frontier model', () => {
    const fullTool = BUNDLE.filter((template) => !/^tools: /m.test(template.content));
    assert.deepEqual(fullTool.map((t) => t.name), [EXECUTOR_VEHICLE]);
    assert.match(EXECUTOR.content, /^model: opus$/m, 'the executor is pinned to a frontier model');
    assert.match(EXECUTOR.content, /^effort: high$/m);
    assert.match(EXECUTOR.content, /^description: .{40,}/m, 'carries a routing description');
    assert.match(EXECUTOR.content, /never dispatched for read-only work/i, 'the description scopes it away from read-only fan-out');
  });

  const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
  for (const template of READ_ONLY_BUNDLE) {
    it(`${template.name}: bounded read-only tools, name matches file, non-trivial prompt`, () => {
      const fm = template.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      assert.ok(fm, 'has YAML frontmatter');
      const [, frontmatter, body] = fm;
      // EVERY vehicle pins an EXACT model. A `doesNotMatch(/haiku/)` was vacuous: a vehicle with no
      // `model:` line at all passed it while INHERITING the caller's model — so a review lens driven
      // from a cheap session would have been a cheap review wearing a review-capable label.
      const model = frontmatter.match(/^model: (\S+)$/m);
      assert.ok(model, `${template.name} must PIN a model, never inherit the caller's`);
      if (CHEAP_VEHICLES.has(template.name)) {
        assert.equal(model[1], 'haiku', 'a cheap-lane vehicle is pinned to the cheap model');
        assert.match(frontmatter, /^effort: low$/m, 'a cheap-lane vehicle is pinned to low effort');
      } else {
        assert.equal(model[1], 'sonnet', 'the review lens is pinned to a review-capable model');
        assert.match(frontmatter, /^effort: high$/m, 'and to an effort that can actually review');
      }
      const name = frontmatter.match(/^name: (\S+)$/m);
      assert.equal(`${name?.[1]}.md`, template.name, 'frontmatter name matches the filename');
      const tools = frontmatter.match(/^tools: (.+)$/m);
      assert.ok(tools, 'declares a bounded tools list');
      const toolList = tools[1].split(',').map((t) => t.trim());
      for (const tool of toolList) {
        assert.ok(READ_ONLY_TOOLS.has(tool), `${tool} must be one of the bounded read-only tools (Read/Grep/Glob)`);
      }
      assert.ok(body.trim().length > 200, 'carries a substantive task-scoped prompt');
      assert.match(frontmatter, /^description: .{40,}/m, 'carries a routing description');
    });
  }

  // The read-prompt-economy honesty line (AD-055 Part II, reconciled by council B9) — CONTENT, not
  // just placement: the vehicle grants NO Bash (consistent with `tools: Read, Grep, Glob`), so a
  // missing Grep/Glob falls back to the READ tool (never a shelled-out command); only IF a harness
  // routes reads through Bash does the plain-single + read-lane guidance apply. This reconciles the
  // "never run commands" rule with the Bash-fallback note codex B9 flagged as self-contradictory.
  it('every read-only vehicle carries the reconciled read-lane honesty line (no Bash grant → Read fallback → conditional read-lane)', () => {
    for (const template of READ_ONLY_BUNDLE) {
      assert.match(template.content, /no `Bash`/u, `${template.name} states the vehicle grants no Bash`);
      assert.match(template.content, /fall back to the `Read` tool/u, `${template.name} directs the missing-Grep/Glob fallback to the Read tool`);
      assert.match(template.content, /plain single read-only command/u, `${template.name} pins plain single reads for a harness-forced Bash read`);
      assert.match(template.content, /never `node -e`/u, `${template.name} bans node -e`);
      assert.match(template.content, /read-lane/u, `${template.name} names the read-lane mechanism`);
    }
  });
});

// The fallback-lens additional-only sentence is an EXPORTED constant (flow-orchestration #15/#3,
// Phase 4.3): the internal-attestation evaluation consumes it, and the apply report renders it —
// one home, two consumers, no drift.
describe('FALLBACK_LENS_ADDITIONAL_ONLY — the formalized fallback-lens contract', () => {
  it('the constant is the exact additional-only sentence and the report renders it verbatim', () => {
    assert.equal(
      FALLBACK_LENS_ADDITIONAL_ONLY,
      'review-lens is an ADDITIONAL read-only review opinion, not a replacement for your configured review recipe.',
    );
    const project = makeProject();
    const out = formatResult(writeCheapAgents({ cwd: project, dryRun: true }));
    assert.ok(out.includes(FALLBACK_LENS_ADDITIONAL_ONLY), 'the report line consumes the one-home constant');
  });
});

const VIRTUAL_PROJECT = join(tmpdir(), 'cheap-agents-virtual');
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

const surveyWith = (existing, { kind = 'file', readFileError = null } = {}) => {
  const target = join(VIRTUAL_PROJECT, AGENTS_DIR, EXECUTOR_VEHICLE);
  return surveyExecutorVehicle(VIRTUAL_PROJECT, {
    lstat: (path) => {
      if (String(path) !== target || existing === null) throw enoent();
      return {
        isSymbolicLink: () => kind === 'symlink',
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'dir',
      };
    },
    readFile: (path, encoding) => {
      if (String(path) !== target) return readFileSync(path, encoding);
      if (readFileError) throw new Error(readFileError);
      return existing;
    },
  });
};

describe('surveyExecutorVehicle — the subagent carrier readiness (spec:carriers/S8)', () => {
  it('the executor prompt states it never commits and lists the writes it refuses', () => {
    assert.match(EXECUTOR.content, /You never commit/u);
    assert.match(EXECUTOR.content, /never hand an implementation file to `node --test`/u);
    assert.match(EXECUTOR.content, /names as your DELIVERABLE/u, 'an authoring or routine slice may write the file the brief names');
    for (const gitWrite of ['add', 'commit', 'push', 'stash', 'reset', 'checkout', 'tag']) {
      assert.match(EXECUTOR.content, new RegExp(`\`${gitWrite}\``, 'u'), `names ${gitWrite} among the refused git writes`);
    }
    assert.match(EXECUTOR.content, /docs\/ai\/specs\//u, 'the contracts stay the orchestrator\'s');
    assert.match(EXECUTOR.content, /language and encoding rules come from its `AGENTS\.md` and the brief/u, 'a portable vehicle takes the project\'s rules, never this repo\'s');
    assert.doesNotMatch(EXECUTOR.content, /English only|ASCII letters only/u, 'no repo-local language rule is baked into the vehicle');
  });

  it('an unreadable deployment stamp reads as no stamp — the preflight reports it, never throws', () => {
    const project = makeProject();
    const stampPath = join(project, WORKFLOW_STAMP);
    const result = writeCheapAgents({ cwd: project, dryRun: true }, {
      exists: () => true,
      readFile: (path, encoding) => {
        if (String(path) === stampPath) throw new Error('EACCES');
        return readFileSync(path, encoding);
      },
    });
    assert.equal(result.stamp, null);
    assert.equal(result.stampOk, false);
  });

  it('the bundled bytes at the placed path → placed', () => {
    assert.deepEqual(surveyWith(EXECUTOR.content), { state: 'placed', reason: null, rel: EXECUTOR_VEHICLE_REL });
    assert.equal(EXECUTOR_VEHICLE_REL, '.claude/agents/executor.md');
  });

  it('no file at the placed path → missing', () => {
    assert.deepEqual(surveyWith(null), { state: 'missing', reason: null, rel: EXECUTOR_VEHICLE_REL });
  });

  it('a customization naming executor with NO tools line still grants every tool → customized', () => {
    assert.deepEqual(
      surveyWith('---\nname: executor\nmodel: opus\n---\nmy own dispatch form\n'),
      { state: 'customized', reason: null, rel: EXECUTOR_VEHICLE_REL },
    );
  });

  it('the closing marker is a whole line: a `---junk` line never closes the frontmatter early', () => {
    assert.equal(surveyWith('---\nname: executor\n---junk\ntools: Read, Bash\n---\nmine\n').state, 'customized');
    const open = surveyWith('---\nname: executor\n---junk\ntools: Read, Bash\nmine\n');
    assert.equal(open.state, 'unusable', 'no full closing line → no frontmatter → not an executor');
    assert.match(open.reason, /name: executor/u);
  });

  it('--help names the executor as the three-slice full-tool vehicle', () => {
    const out = [];
    assert.equal(main(['--help'], { log: (line) => out.push(line) }), 0);
    assert.match(out.join('\n'), /bounded execution,\s+authoring, or write-capable routine slice/u);
  });

  it('a duplicated name: or tools: key is unusable in either order — the parser never picks one silently', () => {
    for (const fm of ['name: executor\nname: other\ntools: Bash', 'name: other\nname: executor\ntools: Bash', 'name: executor\ntools: Bash\ntools: Read', 'name: executor\ntools: Read\ntools: Bash']) {
      const survey = surveyWith(`---\n${fm}\n---\nmine\n`);
      assert.equal(survey.state, 'unusable', fm);
      assert.match(survey.reason, /duplicate `(name|tools):` key/u, fm);
    }
  });

  it('the YAML subset: a quoted name with trailing blanks, a trailing comment, and commented block items', () => {
    assert.equal(surveyWith('---\nname: "executor"  \ntools: Read, Bash # note\n---\nmine\n').state, 'customized');
    const quotedReadOnly = surveyWith("---\nname: executor\ntools: 'Read'  # ro\n---\nmine\n");
    assert.equal(quotedReadOnly.state, 'unusable');
    assert.equal(quotedReadOnly.reason, 'tools: Read is read-only');
    assert.equal(surveyWith('---\nname: executor\ntools: # list\n  - Read # r\n  - "Bash"\n---\nmine\n').state, 'customized');
  });

  it('a YAML flow sequence and quoted tokens are read as a list: [Read, Bash] → customized, ["Read", "Grep"] → unusable', () => {
    assert.equal(surveyWith('---\nname: executor\ntools: [Read, Bash]\n---\nmine\n').state, 'customized');
    const readOnly = surveyWith('---\nname: executor\ntools: ["Read", "Grep"]\n---\nmine\n');
    assert.equal(readOnly.state, 'unusable');
    assert.match(readOnly.reason, /is read-only/u);
  });

  it('a customization whose tools list grants Bash → customized', () => {
    assert.deepEqual(
      surveyWith('---\nname: executor\ntools: Read, Edit, Bash\n---\nmine\n'),
      { state: 'customized', reason: null, rel: EXECUTOR_VEHICLE_REL },
    );
  });

  it('a CRLF-saved customization is judged like its LF twin (Windows/WSL editors) → customized', () => {
    assert.deepEqual(
      surveyWith('---\r\nname: executor\r\ntools: Read, Edit, Bash\r\n---\r\nmine\r\n'),
      { state: 'customized', reason: null, rel: EXECUTOR_VEHICLE_REL },
    );
  });

  it('a quoted YAML tools value granting Bash → customized (the quotes are not part of a tool name)', () => {
    for (const tools of ['"Read, Edit, Bash"', "'Bash, Read'"]) {
      assert.deepEqual(
        surveyWith(`---\nname: executor\ntools: ${tools}\n---\nmine\n`),
        { state: 'customized', reason: null, rel: EXECUTOR_VEHICLE_REL },
        tools,
      );
    }
  });

  it('a nested tools: key under another key never stands in for the root key', () => {
    const nested = surveyWith('---\nname: executor\nmetadata:\n  tools:\n    - Bash\ntools:\n  - Read\n---\nmine\n');
    assert.equal(nested.state, 'unusable', 'the root list (Read) decides, never the nested one (Bash)');
    assert.equal(nested.reason, 'tools: Read is read-only');
    assert.equal(surveyWith('---\nname: executor\nmetadata:\n  tools: [Bash]\n---\nmine\n').state, 'customized', 'no root tools: key → every tool, whatever a nested key says');
  });

  it('a block list survives a comment or a blank line between items, ends at the next key, and needs a deeper indent', () => {
    assert.equal(surveyWith('---\nname: executor\ntools:\n  - Read\n  # a comment\n\n  - Bash\n---\nmine\n').state, 'customized');
    const ended = surveyWith('---\nname: executor\ntools:\n  - Read\nmodel: opus\n  - Bash\n---\nmine\n');
    assert.equal(ended.state, 'unusable', 'the list ends at the next key — the later dash is not an item');
    assert.equal(ended.reason, 'tools: Read is read-only');
    assert.equal(surveyWith('---\nname: executor\ntools:\n- Bash\n---\nmine\n').state, 'unusable', 'a same-indent dash is not an item of the key');
  });

  it('a YAML block-sequence tools list is read as a list: read-only → unusable, Bash → customized', () => {
    const readOnly = surveyWith('---\nname: executor\ntools:\n  - Read\n  - Grep\n---\nmine\n');
    assert.equal(readOnly.state, 'unusable');
    assert.equal(readOnly.reason, 'tools: Read, Grep is read-only');
    assert.equal(surveyWith('---\nname: executor\ntools:\n  - Read\n  - Bash\n---\nmine\n').state, 'customized');
  });

  it('a customization whose tools list is read-only → unusable, the reason quoting the list', () => {
    const survey = surveyWith('---\nname: executor\ntools: Read, Grep, Glob\n---\nmine\n');
    assert.equal(survey.state, 'unusable');
    assert.equal(survey.reason, 'tools: Read, Grep, Glob is read-only');
  });

  it('a customization whose frontmatter names another vehicle → unusable', () => {
    const survey = surveyWith('---\nname: review-lens\ntools: Read, Bash\n---\nmine\n');
    assert.equal(survey.state, 'unusable');
    assert.match(survey.reason, /name: executor/u);
  });

  it('an explicit but EMPTY tools: key → unusable (only an absent key means every tool)', () => {
    for (const line of ['tools:', 'tools:   ']) {
      const survey = surveyWith(`---\nname: executor\n${line}\n---\nmine\n`);
      assert.equal(survey.state, 'unusable', line);
      assert.match(survey.reason, /tools: is empty/u);
    }
  });

  it('a symlinked .claude or .claude/agents ancestor → unusable with the writer\'s own refusal, never read through', () => {
    for (const rel of [CLAUDE_DIR, AGENTS_DIR]) {
      const linked = join(VIRTUAL_PROJECT, rel);
      const survey = surveyExecutorVehicle(VIRTUAL_PROJECT, {
        lstat: (path) => (String(path) === linked
          ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
          : { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true }),
        readFile: () => EXECUTOR.content,
      });
      assert.equal(survey.state, 'unusable', rel);
      assert.match(survey.reason, /symlink/u, rel);
    }
  });

  it('a symlinked vehicle → unusable carrying the refusal message, never an exception', () => {
    const survey = surveyWith('whatever', { kind: 'symlink' });
    assert.equal(survey.state, 'unusable');
    assert.match(survey.reason, /refusing to touch it/u);
  });

  it('an unreadable vehicle → unusable carrying the thrown message, never an exception', () => {
    const survey = surveyWith('whatever', { readFileError: 'EACCES: permission denied' });
    assert.equal(survey.state, 'unusable');
    assert.equal(survey.reason, 'EACCES: permission denied');
  });
});

// ── the writer: velocity discipline ────────────────────────────────────────────────────

describe('writeCheapAgents — preview-then-mutate', () => {
  it('dry-run (the default) previews the placement and writes NOTHING', () => {
    const project = makeProject();
    const result = writeCheapAgents({ cwd: project, dryRun: true });
    assert.equal(result.wrote, false);
    assert.deepEqual(result.plan.map((p) => p.action), EXPECTED_VEHICLES.map(() => 'place'));
    assert.ok(!existsSync(join(project, AGENTS_DIR)), 'no directory created on dry-run');
  });

  // The advisor renders this dry-run as an item's apply one-liner, and that consent flow's contract
  // is «run the printed command, no improvisation». A bare "re-run with --apply" would leave the
  // caller to reconstruct --cwd and its quoting — so the preview must print the EXACT follow-up.
  it('the preview prints the exact runnable --apply follow-up, with --cwd, not a bare hint', () => {
    const project = makeProject();
    const out = formatResult(writeCheapAgents({ cwd: project, dryRun: true }));
    assert.match(out, /to apply, run exactly: node .*cheap-agents\.mjs.* --apply --cwd /u);
    assert.ok(out.includes(project), 'the printed command pins the SAME project dir the preview ran against');
    assert.doesNotMatch(out, /re-run with --apply/u, 'the vague hint is gone');
  });

  it('a converged project prints NO apply follow-up (nothing to place)', () => {
    const project = makeProject();
    writeCheapAgents({ cwd: project, dryRun: false });
    const out = formatResult(writeCheapAgents({ cwd: project, dryRun: true }));
    assert.doesNotMatch(out, /to apply, run exactly/u, 'no follow-up when there is nothing to do');
  });

  it('apply places exactly the bundled set, byte-identical', () => {
    const project = makeProject();
    const result = writeCheapAgents({ cwd: project, dryRun: false });
    assert.equal(result.wrote, true);
    assert.deepEqual(readdirSync(join(project, AGENTS_DIR)).sort(), EXPECTED_VEHICLES);
    for (const template of BUNDLE) {
      assert.equal(readFileSync(join(project, AGENTS_DIR, template.name), 'utf8'), template.content);
    }
  });

  it('a re-run is idempotent: everything already current, nothing rewritten', () => {
    const project = makeProject();
    writeCheapAgents({ cwd: project, dryRun: false });
    const writes = [];
    const again = writeCheapAgents(
      { cwd: project, dryRun: false },
      { writeFile: (path, content) => writes.push(path) },
    );
    assert.equal(again.wrote, false);
    assert.deepEqual(again.plan.map((p) => p.action), EXPECTED_VEHICLES.map(() => 'already-current'));
    assert.deepEqual(writes, [], 'no write call on an already-current set');
  });

  it('NEVER overwrites a diverged existing file — customization reported with its path, others still place', () => {
    const project = makeProject();
    mkdirSync(join(project, AGENTS_DIR), { recursive: true });
    const customized = '---\nname: gate-triage\nmodel: opus\n---\nmy own prompt\n';
    writeFileSync(join(project, AGENTS_DIR, 'gate-triage.md'), customized);
    const result = writeCheapAgents({ cwd: project, dryRun: false });
    const byName = Object.fromEntries(result.plan.map((p) => [p.name, p.action]));
    assert.equal(byName['gate-triage.md'], 'customized-preserved');
    assert.equal(byName['mechanical-sweep.md'], 'place');
    assert.equal(readFileSync(join(project, AGENTS_DIR, 'gate-triage.md'), 'utf8'), customized, 'the customization is untouched');
    const out = [];
    const code = main(['--apply', '--cwd', project], { log: (l) => out.push(l), errlog: (l) => out.push(l) });
    assert.equal(code, 0, 'a preserved customization is a report, not an error');
    assert.match(out.join('\n'), /gate-triage\.md: customized — preserved/);
  });

  it('writes ONLY under .claude/agents/ — never settings*.json (capture every write)', () => {
    const project = makeProject();
    const writes = [];
    writeCheapAgents(
      { cwd: project, dryRun: false },
      { writeFile: (path, content) => writes.push(String(path).replace(/\\/g, '/')) },
    );
    assert.equal(writes.length, EXPECTED_VEHICLES.length);
    for (const path of writes) {
      assert.ok(path.includes(`/${AGENTS_DIR}/`), `write outside ${AGENTS_DIR}: ${path}`);
      assert.ok(!path.includes('settings'), `must never touch settings files: ${path}`);
    }
  });
});

describe('writeCheapAgents — preconditions (STOPs)', () => {
  it('apply without a current deployment stamp → STOP (dry-run still previews)', () => {
    const project = makeProject({ stamp: null });
    assert.doesNotThrow(() => writeCheapAgents({ cwd: project, dryRun: true }));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_STAMP);
  });

  it('a wrong-lineage stamp → STOP on apply', () => {
    const project = makeProject({ stamp: '9.9.9' });
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_STAMP);
  });

  it('a symlinked .claude → STOP (both modes — a dry-run never promises what apply refuses)', () => {
    const project = makeProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'cheap-agents-elsewhere-'));
    tempDirs.push(elsewhere);
    symlinkSync(elsewhere, join(project, '.claude'));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: true }), (e) => e.code === CHEAP_AGENTS_SYMLINK);
  });

  it('a symlinked target file → STOP, never written through', () => {
    const project = makeProject();
    mkdirSync(join(project, AGENTS_DIR), { recursive: true });
    const elsewhere = join(project, 'elsewhere.md');
    writeFileSync(elsewhere, 'x');
    symlinkSync(elsewhere, join(project, AGENTS_DIR, 'mechanical-sweep.md'));
    assert.throws(() => writeCheapAgents({ cwd: project, dryRun: false }), (e) => e.code === CHEAP_AGENTS_SYMLINK);
  });

  it('an empty bundle dir → loud BUNDLE stop (an incomplete kit install is never a silent no-op)', () => {
    const emptyBundle = mkdtempSync(join(tmpdir(), 'cheap-agents-bundle-'));
    tempDirs.push(emptyBundle);
    assert.throws(() => writeCheapAgents({ cwd: makeProject(), dryRun: true }, { bundleDir: emptyBundle }), /no bundled agent templates/);
  });
});

describe('parseArgs / main', () => {
  it('--dry-run is the default; --dry-run with --apply is a usage error', () => {
    assert.equal(parseArgs([]).dryRun, true);
    assert.equal(parseArgs(['--apply']).dryRun, false);
    assert.throws(() => parseArgs(['--dry-run', '--apply']), (e) => e.exitCode === 2);
    assert.throws(() => parseArgs(['--frobnicate']), (e) => e.exitCode === 2);
  });

  it('main dry-run on a fresh project → exit 0 with a would-place preview', () => {
    const project = makeProject();
    const out = [];
    const code = main(['--cwd', project], { log: (l) => out.push(l) });
    assert.equal(code, 0);
    assert.match(out.join('\n'), /DRY RUN/);
    assert.match(out.join('\n'), /mechanical-sweep\.md: would place/);
  });
});
