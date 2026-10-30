import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, cpSync, readdirSync,
  readFileSync, writeFileSync, existsSync, lstatSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeStampAtomic, LINEAGE_HEAD } from './stamp-takeover.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(SKILL_ROOT, 'references', 'templates');
const ENFORCEMENT = join(SKILL_ROOT, 'references', 'scripts');

const WORKFLOW_COMMENT_LINE = /^\s*<!--\s*workflow:/;
const CAP_FOOTER = /≤\s*\d+\s*lines/;
const SKILL_HOME_ONLY = new Set(['AGENTS.md', 'adr-record.md', 'SPEC_TEMPLATE.md']);
const KIT = join('scripts', 'agent-workflow');
const CHECKER_FILE = 'docs-size/check-docs-size.mjs';
const ROTATOR_FILE = 'archives/archive-decisions.mjs';
const STORE_ROOT = 'docs/ai/specs/index.md';
const SEED_DATE = '2026-08-23';
const FLAT_RUNNABLE = ['archive-caps.mjs', 'archive-changelog.mjs', 'archive-decisions.mjs', 'archive-issues.mjs', 'check-docs-size.mjs', 'install-git-hooks.mjs', 'markdown-blocks.mjs', 'migrate-gates.mjs', 'spec-schema.mjs'];
const hasSkipLine = (stdout) => stdout.split('\n').some((line) => line.includes('package.json') && FLAT_RUNNABLE.every((name) => line.includes(name)));
const makeChildEnv = (project, inherited = process.env) => ({
  ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key) && key !== 'NODE_TEST_CONTEXT')),
  HOME: project, XDG_CONFIG_HOME: project, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
});
const execute = (command, args, project, inherited = process.env) => execFileSync(command, args, {
  cwd: project, env: makeChildEnv(project, inherited), encoding: 'utf8', stdio: 'pipe',
});
const runScript = (project, flags = [], ambient = {}) => spawnSync(process.execPath,
  [join(SKILL_ROOT, 'scripts', 'kit-folder.mjs'), '--project', project, ...flags],
  { cwd: project, env: { ...makeChildEnv(project), ...ambient }, encoding: 'utf8' });
const assertCompleted = (result) => {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
};
const VALID_SPEC = '---\ntype: spec\nlastUpdated: 2026-08-23\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: 150\nkind: spec\nstatus: draft\nrevision: 1\n---\n\n# Spec: login\n\n## Contract\n\nc\n\n## Scenarios\n\n- S1 a :: test/login.test.mjs :: spec:login/S1\n\n## Out of scope\n\n- b\n\n## Module\n\n- src/login/\n';

const tempDirs = [];
const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-bootstrap-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true }); });

const bootstrap = (project) => {
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  symlinkSync('AGENTS.md', join(project, 'CLAUDE.md'));

  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (SKILL_HOME_ONLY.has(entry)) continue;
    cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }

  execute('git', ['init', '-q'], project);
  assertCompleted(runScript(project, ['--enforcement']));
  execute(process.execPath, ['scripts/agent-workflow/run.mjs', 'install-git-hooks'], project);

  return docsAi;
};

describe('standalone substrate bootstrap (end-to-end, real temp project)', () => {
  it('deploys docs/ai + entry point and installs the pre-commit hook', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(project, 'AGENTS.md')), 'entry point exists');
    assert.ok(existsSync(docsAi), 'docs/ai exists');
    assert.ok(existsSync(join(docsAi, 'agent_rules.md')), 'a representative docs/ai file landed');

    const hook = join(project, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(hook), 'pre-commit hook installed');
    assert.match(readFileSync(hook, 'utf8'), /install-git-hooks\.mjs/, 'hook carries the installer marker');
  });

  it('seeds the ADR store (decisions.md + adr/log.md, no stray adr-record.md) and --check is green', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(docsAi, 'decisions.md')), 'the HOT ADR window is seeded');
    assert.ok(existsSync(join(docsAi, 'adr', 'log.md')), 'the seed ADR navigator is deployed under adr/');
    assert.ok(!existsSync(join(docsAi, 'adr-record.md')), 'the authoring reference is NOT deployed (skill-home only)');
    assert.ok(!existsSync(join(docsAi, 'adr', 'adr-record.md')), 'the authoring reference is NOT placed in the adr/ store');

    const check = execute(process.execPath, [join(project, KIT, 'archives', 'archive-decisions.mjs'), '--check'], project);
    assert.match(check, /OK — HOT within cap, store integrity intact, navigator fresh/, 'fresh-bootstrap --check is green');
  });

  it('deploys docs/ai/specs/index.md, never SPEC_TEMPLATE.md; ONE specs/ navigator row; the installed hook exits 0 over a seeded spec', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    assert.ok(existsSync(join(docsAi, 'specs', 'index.md')), 'the store root navigator is deployed');
    assert.ok(!existsSync(join(docsAi, 'SPEC_TEMPLATE.md')), 'the authoring reference is NOT deployed (skill-home only)');
    assert.ok(!existsSync(join(docsAi, 'specs', 'SPEC_TEMPLATE.md')), 'nor placed in the store');
    writeFileSync(join(docsAi, 'specs', 'login.md'), VALID_SPEC);
    const checker = join(project, KIT, CHECKER_FILE);
    execute(process.execPath, [checker, '--write-index', `--root=${project}`], project);
    const navigator = readFileSync(join(docsAi, 'index.md'), 'utf8');
    const specsRows = navigator.split('\n').filter((line) => line.includes('](./specs/index.md)'));
    assert.equal(specsRows.length, 1, 'exactly one specs/ row');
    assert.match(specsRows[0], /\| 1 specs \| 0 parts · 1 indexes \|/, 'the row carries live counts');
    assert.ok(!navigator.includes('specs/login.md'), 'the spec itself is collapsed, not listed');
    execute('bash', [join(project, '.git', 'hooks', 'pre-commit')], project);
  });

  it('stamps .memory-version (lineage head) ONLY — no second stamp', async () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    await writeStampAtomic(join(docsAi, '.memory-version'), LINEAGE_HEAD);

    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD);
    assert.ok(!existsSync(join(docsAi, '.workflow-version')), 'no composition-root stamp in a standalone bootstrap');
  });

  it('ships an entry point with no workflow comment line (no kit block, no pointer pair) and no line-cap footer', () => {
    const project = makeProject();
    bootstrap(project);

    const lines = readFileSync(join(project, 'AGENTS.md'), 'utf8').split('\n');
    assert.deepEqual(lines.filter((line) => WORKFLOW_COMMENT_LINE.test(line) || CAP_FOOTER.test(line)), []);
  });

  it('seeds docs/ai/orchestration.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'orchestration.json');
    assert.ok(existsSync(seeded), 'the orchestration.json config is seeded into docs/ai');
    assert.equal(readFileSync(seeded, 'utf8'), readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'), 'the seeded config is byte-identical to the template');
    const config = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof config._README, 'string', 'an onboarding _README is present');
    assert.equal(config['plan-authoring'].review, 'solo', 'default review recipe is solo');
  });

  it('seeds docs/ai/gates.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'gates.json');
    assert.ok(existsSync(seeded), 'the gates.json declaration is seeded into docs/ai');
    assert.equal(readFileSync(seeded, 'utf8'), readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'), 'the seeded declaration is byte-identical to the template');
    const declaration = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof declaration._README, 'string', 'an onboarding _README is present');
    assert.deepEqual(declaration.gates, [], 'ships an empty gates list');
  });

  it('the upgrade ensure preserves an edited gates.json and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'gates.json');
    const ensureGates = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'gates.json'), dest);
    };

    const authored = '{ "gates": [{ "id": "unit-tests", "title": "Unit tests", "cmd": "node --test" }] }\n';
    writeFileSync(dest, authored);
    ensureGates(); // an equal-head upgrade re-runs the ensure
    assert.equal(readFileSync(dest, 'utf8'), authored, 'an authored declaration is preserved byte-for-byte');

    rmSync(dest);
    ensureGates();
    assert.ok(existsSync(dest), 'a missing declaration is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'));
  });

  it('real git: a plain script run places a missing archive-decisions rotator and writes an older copy over', () => {
    const project = makeProject();
    bootstrap(project);
    const rotator = join(project, KIT, ROTATOR_FILE);
    const bundled = readFileSync(join(ENFORCEMENT, ROTATOR_FILE));
    rmSync(rotator);
    assertCompleted(runScript(project));
    assert.deepEqual(readFileSync(rotator), bundled);
    writeFileSync(rotator, '// older copy\n');
    assertCompleted(runScript(project));
    assert.deepEqual(readFileSync(rotator), bundled);
  });

  it('real git: bootstrap and the script keep the project identities, visibility and hooks under ambient git redirection', () => {
    const project = makeProject();
    bootstrap(project);
    const foreign = makeProject();
    execute('git', ['init', '-q'], foreign);
    writeFileSync(join(foreign, '.gitignore'), 'scripts/agent-workflow/\n');
    const foreignHook = join(foreign, '.git', 'hooks', 'pre-commit');
    writeFileSync(foreignHook, '#!/bin/sh\nexit 42\n');
    const ambient = {
      GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git'),
      GIT_INDEX_FILE: join(foreign, '.git', 'index'), GIT_PREFIX: 'foreign/',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=foreign-hooks'", GIT_EXEC_PATH: join(foreign, 'no-git'), gIt_DIR: foreign,
    };
    const inherited = { ...process.env, ...ambient, NODE_TEST_CONTEXT: 'child-v8', HOME: foreign, XDG_CONFIG_HOME: foreign };
    const environment = makeChildEnv(project, inherited);
    for (const key of [...Object.keys(ambient), 'NODE_TEST_CONTEXT']) assert.equal(environment[key], undefined, key);
    assert.equal(environment.HOME, project);
    assert.equal(environment.XDG_CONFIG_HOME, project);
    for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', PATH: process.env.PATH })) assert.equal(environment[key], value, key);
    for (const flag of ['--absolute-git-dir', '--git-common-dir', '--show-toplevel']) {
      const actual = execute('git', ['rev-parse', flag], project, inherited).trim();
      assert.equal(resolve(project, actual), flag === '--show-toplevel' ? project : join(project, '.git'));
      assert.equal(actual, execute('git', ['rev-parse', flag], project).trim());
    }
    const hook = join(project, '.git', 'hooks', 'pre-commit');
    const managed = readFileSync(hook, 'utf8').split('\n').filter((line) => !line.includes('node scripts/agent-workflow/run.mjs docs-size')).join('\n');
    writeFileSync(hook, managed);
    rmSync(join(project, KIT, ROTATOR_FILE));
    const result = runScript(project, [], ambient);
    assertCompleted(result);
    const commitLine = result.stdout.split('\n').find((line) => line.includes('one change'));
    assert.ok(commitLine, result.stdout);
    for (const token of ['scripts/agent-workflow/', 'package.json', 'merge', 'branch']) assert.ok(commitLine.includes(token), token);
    assert.ok(result.stdout.includes('node scripts/agent-workflow/run.mjs install-git-hooks'));
    assert.equal(readFileSync(hook, 'utf8'), managed, 'the script only reports the hook switch');
    assert.equal(readFileSync(foreignHook, 'utf8'), '#!/bin/sh\nexit 42\n');
    assert.equal(existsSync(join(foreign, KIT)), false);
  });

  it('real git: the upgrade seeds a missing store root only after script exit 0 without its skip line, never in delegated mode', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const root = join(project, STORE_ROOT);
    const checker = join(project, KIT, CHECKER_FILE);
    const scriptRuns = [];
    const ensureStoreRoot = (target, { delegated = false, run = () => runScript(target) } = {}) => {
      if (delegated) return `docs/ai/specs/index.md: the composition root's upgrade owns the store root`;
      const result = run();
      scriptRuns.push(result);
      if (result.error || result.signal || result.status !== 0) return `stopped${result.stdout ? `: ${result.stdout}` : ''}`;
      if (hasSkipLine(result.stdout)) return 'skipped-no-node-evidence';
      const destination = join(target, STORE_ROOT);
      try {
        lstatSync(destination);
        return `${STORE_ROOT}: already present`;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(TEMPLATES, 'specs', 'index.md'), 'utf8').replaceAll('{{DATE}}', SEED_DATE), { flag: 'wx' });
      return 'seeded';
    };
    rmSync(root);
    for (const status of [1, 2, 3, null]) {
      assert.equal(ensureStoreRoot(project, { run: () => ({ status, stdout: '' }) }), 'stopped');
      assert.equal(existsSync(root), false);
    }
    const noNode = makeProject();
    execute('git', ['init', '-q'], noNode);
    assert.equal(ensureStoreRoot(noNode), 'skipped-no-node-evidence');
    assertCompleted(scriptRuns.at(-1));
    assert.equal(existsSync(join(noNode, 'package.json')), false);
    assert.equal(existsSync(join(noNode, 'scripts')), false);
    assert.equal(existsSync(join(noNode, STORE_ROOT)), false);
    const runsBeforeDelegation = scriptRuns.length;
    assert.match(ensureStoreRoot(project, { delegated: true, run: () => assert.fail('delegated mode must not run the script') }), /composition root's upgrade/);
    assert.equal(scriptRuns.length, runsBeforeDelegation);
    assert.equal(existsSync(root), false);
    for (const kind of ['dangling link', 'link', 'directory']) {
      const target = join(project, 'root-target.md');
      if (kind === 'link') writeFileSync(target, '# untouched\n');
      if (kind === 'directory') mkdirSync(root);
      else symlinkSync(target, root);
      assert.ok(ensureStoreRoot(project).includes(STORE_ROOT), `${kind} is named`);
      assert.equal(lstatSync(root).isSymbolicLink(), kind !== 'directory');
      if (kind === 'directory') assert.deepEqual(readdirSync(root), []);
      else if (kind === 'link') assert.equal(readFileSync(target, 'utf8'), '# untouched\n');
      else assert.equal(existsSync(target), false);
      rmSync(root, { recursive: true });
    }
    assert.equal(ensureStoreRoot(project), 'seeded');
    assertCompleted(scriptRuns.at(-1));
    assert.equal(hasSkipLine(scriptRuns.at(-1).stdout), false);
    assert.equal(readFileSync(root, 'utf8'), readFileSync(join(TEMPLATES, 'specs', 'index.md'), 'utf8').replaceAll('{{DATE}}', SEED_DATE));
    writeFileSync(join(docsAi, 'specs', 'login.md'), VALID_SPEC);
    execute(process.execPath, [checker, '--write-index', `--root=${project}`], project);
    execute('bash', [join(project, '.git', 'hooks', 'pre-commit')], project);
    writeFileSync(root, '# mine\n');
    assert.ok(ensureStoreRoot(project).includes(STORE_ROOT), 'an existing root is named');
    assert.equal(readFileSync(root, 'utf8'), '# mine\n');
  });

  it('the upgrade ensure preserves an edited config and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'orchestration.json');
    const ensureConfig = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'orchestration.json'), dest);
    };

    writeFileSync(dest, '{ "plan-authoring": { "review": "council" } }\n');
    ensureConfig(); // an equal-head upgrade re-runs the ensure
    assert.match(readFileSync(dest, 'utf8'), /council/, 'an edited config is preserved (never clobbered)');

    rmSync(dest);
    ensureConfig();
    assert.ok(existsSync(dest), 'a missing config is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'));
  });

});

const SKILL_MD = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8');
const FINALIZER_RE = /node \$\{CLAUDE_SKILL_DIR\}\/(references\/scripts\/(?:[a-z-]+\/)?[A-Za-z0-9_.-]+) --ensure-index --root=<[a-z-]+>/;
const UPGRADE_HEADING = '### Mode: upgrade';
const EQUAL_HEAD_ANCHOR = '**Then**, if the stamp **equals** the head';
const RESTAMP_ANCHOR = '7. **Re-stamp**';
const ENFORCEMENT_STEP_ANCHORS = ['8. **', '10. **'];
const ENFORCEMENT_OFFER_LITERALS = ["the only skip condition is that the agent host cannot run them", "a committer without `node` on PATH gets the hook's own loud failure", 'preview-first'];
const LEGACY_ENFORCEMENT_PROXIES = ['(Node projects)', 'No Node runtime'];
const GOTCHAS_HEADING = '## Gotchas';
const ENFORCEMENT_TOKEN = /enforcement/i;
const STEP_EIGHT_REFERENCE = 'step 8';

const enforcementStepRegion = (text) => {
  const start = text.indexOf(ENFORCEMENT_STEP_ANCHORS[0]);
  assert.notEqual(start, -1, `SKILL.md: missing region anchor "${ENFORCEMENT_STEP_ANCHORS[0]}"`);
  const end = text.indexOf(ENFORCEMENT_STEP_ANCHORS[1], start);
  assert.notEqual(end, -1, `SKILL.md: missing region anchor "${ENFORCEMENT_STEP_ANCHORS[1]}"`);
  return text.slice(start, end).replace(/\s+/g, ' ');
};

const documentedFinalizer = (prose) => {
  const match = prose.match(FINALIZER_RE);
  assert.ok(match, 'the bootstrap prose must document the navigator finalizer command — a deploy with no finalizer line leaves the entry point pointing at a file nothing writes');
  return join(SKILL_ROOT, match[1]);
};

const runFinalizer = (project) =>
  execute(process.execPath, [documentedFinalizer(SKILL_MD), '--ensure-index', `--root=${project}`], project);

describe('standalone bootstrap — the navigator the entry point declares always-loaded', () => {
  it('the documented finalizer materializes docs/ai/index.md, and the generator agrees it is fresh', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    assert.equal(existsSync(join(docsAi, 'index.md')), false, 'no template ships the navigator — it is generated');

    const out = runFinalizer(project);
    assert.match(out, /ensure-index: (regenerated|already-current)/);
    assert.ok(existsSync(join(docsAi, 'index.md')), 'the finalizer wrote the navigator');
    execute(process.execPath, [documentedFinalizer(SKILL_MD), '--check-index', `--root=${project}`], project);
  });

  it('a No-Node target gets its navigator from the skill-home generator alone', () => {
    const project = makeProject();
    cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
    const docsAi = join(project, 'docs', 'ai');
    mkdirSync(docsAi, { recursive: true });
    for (const entry of readdirSync(TEMPLATES)) {
      if (SKILL_HOME_ONLY.has(entry)) continue;
      cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
    }
    assert.equal(existsSync(join(project, 'scripts')), false, 'the No-Node lane copies no enforcement scripts');
    assert.equal(existsSync(join(project, 'package.json')), false, 'and has no Node project at all');

    runFinalizer(project);
    assert.ok(existsSync(join(docsAi, 'index.md')), 'the navigator landed without a single project-side script');
    execute(process.execPath, [documentedFinalizer(SKILL_MD), '--check-index', `--root=${project}`], project);
  });

  it('standalone bootstrap \u2014 SKILL.md offers the enforcement scripts and the hook on every project', () => {
    const steps = enforcementStepRegion(SKILL_MD);
    for (const literal of ENFORCEMENT_OFFER_LITERALS) assert.equal(steps.split(literal).length - 1, 1, literal);
    for (const proxy of LEGACY_ENFORCEMENT_PROXIES) assert.equal(steps.split(proxy).length - 1, 0, proxy);
    const gotchasAt = SKILL_MD.indexOf(GOTCHAS_HEADING);
    assert.notEqual(gotchasAt, -1, 'SKILL.md: missing Gotchas anchor');
    const gotcha = SKILL_MD
      .slice(gotchasAt + GOTCHAS_HEADING.length)
      .split('\n- ')
      .find((bullet) => ENFORCEMENT_TOKEN.test(bullet))
      ?.replace(/\s+/g, ' ');
    assert.ok(gotcha, 'SKILL.md: missing enforcement gotcha');
    assert.ok(gotcha.includes(STEP_EIGHT_REFERENCE), 'the enforcement gotcha points at step 8');
  });

  it('spec:standalone-scripts/S6 the upgrade flow documents the store-root seed after script success without its skip line and no seed in delegated mode', () => {
    const upgrade = SKILL_MD.slice(SKILL_MD.indexOf(UPGRADE_HEADING));
    const script = upgrade.indexOf('scripts/kit-folder.mjs');
    assert.ok(script > 0, 'upgrade step 2 runs the script');
    const storeRoot = upgrade.indexOf('docs/ai/specs/index.md', script);
    const navigator = upgrade.indexOf('ensure the NAVIGATOR');
    assert.ok(storeRoot > script && storeRoot < navigator && navigator < upgrade.indexOf(EQUAL_HEAD_ANCHOR), 'script -> store root -> navigator -> equal-head exit');
    const block = upgrade.slice(storeRoot, navigator).replace(/\s+/g, ' ');
    for (const token of ['if missing', 'date filled', 'exited 0 without its', 'no-Node-evidence skip line', 'a link or any other node', 'named', 'skipped', 'delegated mode', 'the script does not run', 'memory seeds no store root', "the composition root's upgrade", 'owner']) assert.ok(block.includes(token), token);
  });

  it('the upgrade flow documents the finalizer at BOTH positions the deploy needs it', () => {
    const upgrade = SKILL_MD.slice(SKILL_MD.indexOf(UPGRADE_HEADING));
    const equalHead = upgrade.indexOf(EQUAL_HEAD_ANCHOR);
    const restamp = upgrade.indexOf(RESTAMP_ANCHOR);
    assert.ok(equalHead > 0 && restamp > equalHead, 'the upgrade flow must still carry both anchors, in order');

    const positions = [...upgrade.matchAll(/--ensure-index/g)].map((m) => m.index);
    assert.ok(positions.some((at) => at < equalHead), 'a deployment already at the head must gain the navigator too — the finalizer runs BEFORE the equal-head short-circuit');
    assert.ok(positions.some((at) => at > equalHead && at < restamp), 'the migrations may change docs/ai — the finalizer runs again AFTER them and BEFORE the re-stamp');
  });
});
