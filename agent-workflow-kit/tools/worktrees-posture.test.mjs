// worktrees-posture.test.mjs — the dependency-free install posture: `no install needed` is a PROOF
// the tool grants only on evidence it actually read, never a default. The evidence is the
// WORKTREE'S OWN CHECKOUT (never MAIN's mutable working tree, which can diverge from the HEAD the
// worktree was created at), and the dangerous direction is a FALSE "nothing to install" — so
// everything the tool cannot enumerate leaves the posture UNKNOWN and keeps the honest advice.
// A `workspaces` field of ANY shape is UNKNOWN outright: a workspace install materializes member
// links and `.bin` shims even with zero dependencies, so a workspace tree is never provably
// install-free.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, runCli, parseProvisionRecord, handoffBasename } from './worktrees.mjs';
// Authored WITH the fixtures below: imported dynamically so this spec LOADS against the pre-fix
// tree and each fixture fails on its OWN assertion (the red-first doctrine).
const { NO_DEPENDENCIES_POSTURE, NODE_MODULES_NONE, INSTALL_LIFECYCLE_SCRIPTS, DEPENDENCY_FIELDS, EXTERNAL_WORKSPACE_MANIFESTS } = await import('./worktrees.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREES_MODE_DOC = join(HERE, '..', 'references', 'modes', 'worktrees.md');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-posture-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const HEAD = '4444444444444444444444444444444444444444';

after(() => rmSync(TMP, { recursive: true, force: true }));

// `worktree add` materializes the HEAD checkout: headFiles is what the satellite receives, which
// is NOT necessarily what main's working tree holds — the divergence the posture must respect.
const makeGit = (main, headFiles) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    [`worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  return (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const canonical = join(realpathSync(dirname(args[4])), basename(args[4]));
      mkdirSync(canonical, { recursive: true });
      for (const [rel, body] of Object.entries(headFiles)) {
        mkdirSync(dirname(join(canonical, rel)), { recursive: true });
        writeFileSync(join(canonical, rel), body);
      }
      entries.push({ path: canonical, branch: args[3] });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
};

// pkg/extras describe the committed content (main working tree AND the checkout, like a clean
// tree); `head` overrides what the checkout materializes when the test needs the two to diverge.
// pkg === null leaves the checkout without a package.json at all (the "unknown posture" case).
const makeRepo = (name, { pkg = { name: 'fixture', version: '0.0.0' }, extras = {}, head = null } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  const asBody = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
  if (pkg !== null) writeFileSync(join(main, 'package.json'), asBody(pkg));
  for (const [rel, body] of Object.entries(extras)) {
    mkdirSync(dirname(join(main, rel)), { recursive: true });
    writeFileSync(join(main, rel), body);
  }
  const headFiles = head ?? {
    ...(pkg === null ? {} : { 'package.json': asBody(pkg) }),
    ...extras,
  };
  return { main, headFiles: Object.fromEntries(Object.entries(headFiles).map(([rel, body]) => [rel, asBody(body)])) };
};

const provisionOk = ({ main, headFiles }, slug, extra = []) => {
  const out = [];
  const err = [];
  const code = runCli(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra], {
    cwd: main,
    git: makeGit(main, headFiles),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  });
  assert.equal(code, EXIT.ok, err.join('\n'));
  const worktree = join(dirname(main), `${basename(main)}--${slug}`);
  const text = readFileSync(join(worktree, 'docs/plans', handoffBasename(slug)), 'utf8');
  return {
    worktree,
    record: parseProvisionRecord(text),
    nodeModulesLine: out.find((line) => line.startsWith('  node_modules:')),
  };
};

const notProof = (name, opts, slug = 'alpha') => {
  const r = provisionOk(makeRepo(name, opts), slug);
  assert.doesNotMatch(r.nodeModulesLine, /no install needed/, `${name}: unprovable evidence is never proof`);
  assert.notEqual(r.record.install, NO_DEPENDENCIES_POSTURE, `${name}: the record keeps the honest advice`);
  return r;
};

describe('a provably dependency-free checkout records the no-install posture', () => {
  it('a single-package root with no deps, no hooks, no native build IS proof', () => {
    const { record, nodeModulesLine } = provisionOk(makeRepo('proof-clean'), 'depfree');
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE);
    assert.equal(record.nodeModules, NODE_MODULES_NONE, 'the recorded node_modules mode states the same verdict');
    assert.equal(NODE_MODULES_NONE, 'no-dependencies', 'the recorded mode is a pinned stable token');
    assert.equal(nodeModulesLine, `  node_modules: ${NO_DEPENDENCIES_POSTURE}`, 'the WHOLE line, pinned');
    assert.doesNotMatch(nodeModulesLine, /install there|re-run|--resume/, 'no install or re-run instruction may ride a "nothing to install" verdict');
  });

  it('the verdict reads the CHECKOUT: a dirty main manifest with deps does not revoke the proof', () => {
    const repo = makeRepo('proof-dirty-main', {
      pkg: { name: 'r', dependencies: { left: '^1.0.0' } },
      head: { 'package.json': { name: 'r', version: '1.0.0' } },
    });
    const { record } = provisionOk(repo, 'dirtymain');
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE, 'the satellite holds the HEAD content, not the dirty edit');
  });

  it('an EMPTY-string lifecycle value is a no-op, not a trigger', () => {
    const repo = makeRepo('proof-empty-hook', { pkg: { name: 'r', scripts: { postinstall: '' } } });
    const { record } = provisionOk(repo, 'emptyhook');
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE);
  });

  it('--install stays an EXPLICIT request: the report answers it, the record still states the posture', () => {
    const { record, nodeModulesLine } = provisionOk(makeRepo('proof-explicit'), 'explicit', ['--install']);
    assert.match(nodeModulesLine, /install it yourself/, 'the explicit request is answered with the install command');
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE, 'the recorded posture is a fact about the project, not about the request');
  });

  it('the mode doc states the dependency-free posture verbatim', () => {
    assert.ok(readFileSync(WORKTREES_MODE_DOC, 'utf8').includes(NO_DEPENDENCIES_POSTURE));
  });

  // A green spec-pin (the sentence lands with the spec-first doc edit, before the code flip):
  // a silent rewording of the advice-source contract goes red here.
  it('the mode doc states the advice-source contract verbatim', () => {
    const ADVICE_SOURCE_CONTRACT = 'All manifest/lockfile install evidence — the dependency-free proof AND the package-manager selection (the `packageManager` field, lockfiles) — is read from the worktree\'s own LIVE files at the moment the posture is resolved (on `--resume` too, where a dirty tree is then refused by the clean-tree verify); MAIN\'s mutable working tree never steers manager selection.';
    assert.ok(readFileSync(WORKTREES_MODE_DOC, 'utf8').includes(ADVICE_SOURCE_CONTRACT));
  });

  // The evidence is the satellite's LIVE content — what an install run there would actually read
  // at the moment the posture is resolved; on --resume it follows the session's own edits, in
  // BOTH directions: gained dependencies revoke the proof, shed dependencies grant it. The mock
  // git status stays clean by construction — the deliberate seam modeling the refresh lane;
  // dirty-tree refusal is pinned against real git in worktrees-posture-integration.test.mjs.
  it('the posture follows the LIVE checkout on --resume: gained dependencies revoke the proof', () => {
    const { main, headFiles } = makeRepo('resume-gain-deps');
    const git = makeGit(main, headFiles);
    const first = runCli(['provision', 'regain', ...PLAN_ARGS, '--as', 'feature-regain.md'], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(first, EXIT.ok);
    const worktree = join(dirname(main), `${basename(main)}--regain`);
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'r', dependencies: { left: '^1.0.0' } }));
    const code = runCli(['provision', 'regain', '--resume', ...PLAN_ARGS, '--as', 'feature-regain.md'], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(code, EXIT.ok);
    const record = parseProvisionRecord(readFileSync(join(worktree, 'docs/plans', handoffBasename('regain')), 'utf8'));
    assert.notEqual(record.install, NO_DEPENDENCIES_POSTURE, 'an install here would read the live manifest and fetch');
  });

  it('the posture follows the LIVE checkout on --resume: shed dependencies grant the proof', () => {
    const { main, headFiles } = makeRepo('resume-shed-deps', {
      pkg: { name: 'r', dependencies: { left: '^1.0.0' } },
    });
    const git = makeGit(main, headFiles);
    const first = runCli(['provision', 'reshed', ...PLAN_ARGS, '--as', 'feature-reshed.md'], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(first, EXIT.ok);
    const worktree = join(dirname(main), `${basename(main)}--reshed`);
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    const code = runCli(['provision', 'reshed', '--resume', ...PLAN_ARGS, '--as', 'feature-reshed.md'], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(code, EXIT.ok);
    const record = parseProvisionRecord(readFileSync(join(worktree, 'docs/plans', handoffBasename('reshed')), 'utf8'));
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE, 'an install here would read the live manifest and fetch nothing');
  });

  // Live state wins over MAIN state too: a node ALREADY at the worktree is reported as present —
  // recording `absent` (MAIN's state) beside an existing node would contradict record.install.
  const resumeWithLiveNode = (name, slug, placeNode) => {
    const { main, headFiles } = makeRepo(name, { pkg: { name: 'r', dependencies: { left: '^1.0.0' } } });
    const git = makeGit(main, headFiles);
    const first = runCli(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(first, EXIT.ok);
    const worktree = join(dirname(main), `${basename(main)}--${slug}`);
    placeNode(main, worktree);
    const code = runCli(['provision', slug, '--resume', ...PLAN_ARGS, '--as', `feature-${slug}.md`], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(code, EXIT.ok);
    return parseProvisionRecord(readFileSync(join(worktree, 'docs/plans', handoffBasename(slug)), 'utf8'));
  };

  it('a live node_modules DIRECTORY beats an absent MAIN node_modules: mode present, never absent', () => {
    const record = resumeWithLiveNode('resume-live-dir', 'redir', (main, worktree) => {
      mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    });
    assert.equal(record.nodeModules, 'present', 'the node that exists is the node the record states');
  });

  it('a live node_modules SYMLINK beats an absent MAIN node_modules: mode present, never absent', () => {
    const record = resumeWithLiveNode('resume-live-link', 'relink', (main, worktree) => {
      symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'));
    });
    assert.equal(record.nodeModules, 'present', 'a symlink is a live node too, even dangling');
    assert.match(record.install, /writes into MAIN/, 'and the install posture states its hazard');
  });

  // The posture is a verdict about MANIFESTS; a LIVE node_modules is state, and state wins the
  // report: a symlink into MAIN left by an earlier provision must never be hidden behind
  // "no install needed" on --resume — an install through it writes into MAIN.
  it('a live symlinked node_modules on --resume is never hidden by the posture', () => {
    const { main, headFiles } = makeRepo('resume-symlink');
    const git = makeGit(main, headFiles);
    const first = runCli(['provision', 'resym', ...PLAN_ARGS, '--as', 'feature-resym.md'], {
      cwd: main, git, log: () => {}, logError: () => {},
    });
    assert.equal(first, EXIT.ok);
    const worktree = join(dirname(main), `${basename(main)}--resym`);
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'));
    const err = [];
    const code = runCli(['provision', 'resym', '--resume', ...PLAN_ARGS, '--as', 'feature-resym.md'], {
      cwd: main, git, log: () => {}, logError: (line) => err.push(line),
    });
    assert.equal(code, EXIT.ok, err.join('\n'));
    const record = parseProvisionRecord(readFileSync(join(worktree, 'docs/plans', handoffBasename('resym')), 'utf8'));
    assert.notEqual(record.nodeModules, NODE_MODULES_NONE, 'a live node exists — the mode must state what is there');
    assert.match(record.install, /writes into MAIN/, 'the hazard is stated, not implied');
    assert.match(record.install, /remove it first: rm /, 'the unlink-first form survives the posture');
    assert.notEqual(record.install, NO_DEPENDENCIES_POSTURE);
  });
});

describe('dependency-free is a PROOF, never a default', () => {
  it('the verdict reads the CHECKOUT: a dependency-free dirty main never vouches for a checkout with deps', () => {
    notProof('diverge-deps', {
      pkg: { name: 'r', version: '1.0.0' },
      head: { 'package.json': { name: 'r', dependencies: { left: '^1.0.0' } } },
    });
  });

  it('a `workspaces` field of ANY shape leaves the posture unknown — a workspace install materializes links', () => {
    notProof('ws-literal', { pkg: { name: 'r', workspaces: ['pkg-a'], }, extras: { 'pkg-a/package.json': '{"name":"a","version":"1.0.0"}' } });
    notProof('ws-empty', { pkg: { name: 'r', workspaces: [] } });
    notProof('ws-glob', { pkg: { name: 'r', workspaces: ['packages/*'] } });
    notProof('ws-extglob', { pkg: { name: 'r', workspaces: ['+(pkg-a|pkg-b)'] } });
    notProof('ws-object', { pkg: { name: 'r', workspaces: { packages: ['pkg-a'] } } });
  });

  // The closed dependency-field set is pinned BOTH directions (a dropped member fails the
  // deepEqual, an added one too) AND every member is exercised behaviorally.
  const EXPECTED_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  it('the dependency-field set is exactly the expected closed set', () => {
    assert.deepEqual([...DEPENDENCY_FIELDS].sort(), [...EXPECTED_DEPENDENCY_FIELDS].sort());
  });
  for (const field of EXPECTED_DEPENDENCY_FIELDS) {
    it(`a declared ${field} entry keeps the install advice`, () => {
      const r = notProof(`dep-${field.toLowerCase()}`, { pkg: { name: 'r', [field]: { left: '^1.0.0' } } });
      assert.match(r.nodeModulesLine, /install/, 'the honest advice survives');
    });
  }

  it('a dependency field of the wrong SHAPE is unknown, never proof', () => {
    notProof('shape-string', { pkg: { name: 'r', dependencies: 'left-pad' } });
    notProof('shape-array', { pkg: { name: 'r', devDependencies: ['left-pad'] } });
    notProof('shape-null', { pkg: { name: 'r', dependencies: null } });
  });

  it('an absent or unparseable checkout package.json leaves the posture unknown', () => {
    notProof('pkg-absent', { pkg: null });
    const r = notProof('pkg-bad', { pkg: '{ not json' });
    assert.match(r.nodeModulesLine, /install/, 'an unreadable manifest keeps the honest advice');
  });

  // The closed external-manifest set is pinned BOTH directions and every member is exercised.
  it('the external workspace manifest set is exactly the expected closed set', () => {
    assert.deepEqual([...EXTERNAL_WORKSPACE_MANIFESTS].sort(), ['lerna.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml']);
  });
  it('an EXTERNAL workspace manifest in the checkout makes the inventory unknowable', () => {
    notProof('ext-pnpm-yaml', { pkg: { name: 'r' }, extras: { 'pnpm-workspace.yaml': "packages:\n  - 'pkg/*'\n" } });
    notProof('ext-pnpm-yml', { pkg: { name: 'r' }, extras: { 'pnpm-workspace.yml': "packages:\n  - 'pkg/*'\n" } });
    notProof('ext-lerna', { pkg: { name: 'r' }, extras: { 'lerna.json': '{"packages":["pkg/*"]}' } });
  });
});

describe('dependency-free is NOT install-free — the lifecycle and native-build hooks', () => {
  // The install-lifecycle set is PINNED to an independent expected list AND every member is
  // exercised — dropping a hook from the code array fails the pin, not silently.
  const EXPECTED_INSTALL_HOOKS = [
    'preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'pnpm:devPreinstall',
  ];
  it('the install-lifecycle set is exactly the expected closed set', () => {
    assert.deepEqual([...INSTALL_LIFECYCLE_SCRIPTS].sort(), [...EXPECTED_INSTALL_HOOKS].sort());
  });
  for (const hook of EXPECTED_INSTALL_HOOKS) {
    it(`the ${hook} lifecycle script counts as an install hook`, () => {
      notProof(`hook-${hook.replace(/[^a-z0-9]+/gi, '-')}`, { pkg: { name: 'r', scripts: { [hook]: 'node x.js' } } });
    });
  }

  it('a lifecycle key with a non-string value is malformed, never "no hook" (fail-closed)', () => {
    notProof('hook-nonstring', { pkg: { name: 'r', scripts: { postinstall: 42 } } });
  });

  it('a malformed scripts field is unknown, never "no hook" (fail-closed)', () => {
    notProof('scripts-bad', { pkg: { name: 'r', scripts: 'oops' } });
  });

  it('a native-addon manifest (binding.gyp) in the checkout is a mandatory install', () => {
    notProof('gyp-root', { pkg: { name: 'r' }, extras: { 'binding.gyp': '{ "targets": [] }\n' } });
  });
});
