import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  BRIDGE_DIRS,
  MIRROR_TEMPLATE_FILES,
  TEMPLATE_HARD_EXCLUDES,
  planAllMirrors,
  planRootSubsetSync,
  syncBridgeMirror,
  runCli,
} from './sync-mirrors.mjs';

const tempDirs = [];
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-mirrors-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Seed a fully in-sync fixture family: two bridge canons + mirrors, the reference-scripts pair,
// and the templates pair (every manifest file identical; the hard-excluded files DIVERGENT by
// construction — that divergence is legitimate and must never trip the sync).
const seedFamily = (root) => {
  for (const bridge of BRIDGE_DIRS) {
    for (const base of [join(root, bridge), join(root, 'agent-workflow-kit', 'bridges', bridge)]) {
      mkdirSync(join(base, 'bin'), { recursive: true });
      writeFileSync(join(base, 'SKILL.md'), `# ${bridge}\n`);
      writeFileSync(join(base, 'capability.json'), `{"name":"${bridge}","version":"1.0.0"}\n`);
      writeFileSync(join(base, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
      chmodSync(join(base, 'bin', 'run.sh'), 0o755);
    }
  }
  for (const side of ['agent-workflow-memory', 'agent-workflow-kit']) {
    const scripts = join(root, side, 'references', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'tool.mjs'), 'export const tool = 1;\n');
    const templates = join(root, side, 'references', 'templates');
    mkdirSync(join(templates, 'pages'), { recursive: true });
    mkdirSync(join(templates, 'adr'), { recursive: true }); // the seed adr/log.md subdir entry
    for (const rel of MIRROR_TEMPLATE_FILES) writeFileSync(join(templates, rel), `template ${rel}\n`);
    for (const rel of TEMPLATE_HARD_EXCLUDES) writeFileSync(join(templates, rel), `${side} divergent ${rel}\n`);
    writeFileSync(join(templates, 'local-extra.md'), `${side} extra outside the manifest\n`);
  }
};

const run = (argv, root) => {
  const out = [];
  const err = [];
  const code = runCli([...argv, '--root', root], { log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

describe('in-sync tree', () => {
  it('--check exits 0 with zero would-be changes despite the hard-excluded divergence', () => {
    const root = makeRoot();
    seedFamily(root);
    const { code, text } = run(['--check'], root);
    assert.equal(code, 0);
    assert.match(text, /all mirrors in sync — nothing to do/);
    assert.doesNotMatch(text, /would (copy|delete)/);
  });

  it('a real run on an in-sync tree is a stated no-op', () => {
    const root = makeRoot();
    seedFamily(root);
    const excludedBefore = readFileSync(join(root, 'agent-workflow-kit', 'references', 'templates', TEMPLATE_HARD_EXCLUDES[0]), 'utf8');
    const { code, text } = run([], root);
    assert.equal(code, 0);
    assert.match(text, /all mirrors in sync — nothing to do/);
    assert.equal(
      readFileSync(join(root, 'agent-workflow-kit', 'references', 'templates', TEMPLATE_HARD_EXCLUDES[0]), 'utf8'),
      excludedBefore,
      'the excluded file is untouched',
    );
  });
});

describe('canon drift → sync restores byte-identity (all three families)', () => {
  it('bridge canon edit is copied to the mirror', () => {
    const root = makeRoot();
    seedFamily(root);
    writeFileSync(join(root, BRIDGE_DIRS[0], 'SKILL.md'), '# edited canon\n');
    const { code, text } = run([], root);
    assert.equal(code, 0);
    assert.match(text, new RegExp(`bridge:${BRIDGE_DIRS[0]}: copied .*SKILL\\.md`));
    assert.equal(readFileSync(join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'SKILL.md'), 'utf8'), '# edited canon\n');
  });

  it('reference-scripts canon edit is copied to the kit fallback', () => {
    const root = makeRoot();
    seedFamily(root);
    writeFileSync(join(root, 'agent-workflow-memory', 'references', 'scripts', 'tool.mjs'), 'export const tool = 2;\n');
    const { code } = run([], root);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'agent-workflow-kit', 'references', 'scripts', 'tool.mjs'), 'utf8'), 'export const tool = 2;\n');
  });

  it('a manifest template edit is copied; --check reports it with exit 1 first', () => {
    const root = makeRoot();
    seedFamily(root);
    writeFileSync(join(root, 'agent-workflow-memory', 'references', 'templates', 'gates.json'), '{"edited":true}\n');
    const check = run(['--check'], root);
    assert.equal(check.code, 1, '--check exits 1 on a would-be change');
    assert.match(check.text, /templates: would copy .*gates\.json/);
    const apply = run([], root);
    assert.equal(apply.code, 0);
    assert.equal(readFileSync(join(root, 'agent-workflow-kit', 'references', 'templates', 'gates.json'), 'utf8'), '{"edited":true}\n');
  });
});

describe('set-equality (full-tree families)', () => {
  it('an extraneous bridge-mirror file is DELETED', () => {
    const root = makeRoot();
    seedFamily(root);
    const stray = join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[1], 'leftover.md');
    writeFileSync(stray, 'stale mirror-only file\n');
    const { code, text } = run([], root);
    assert.equal(code, 0);
    assert.match(text, /deleted .*leftover\.md/);
    assert.ok(!existsSync(stray), 'the extraneous mirror file is gone');
  });

  it('node_modules/.git on the canon side never enter the mirror (walk exclusions)', () => {
    const root = makeRoot();
    seedFamily(root);
    mkdirSync(join(root, BRIDGE_DIRS[0], 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, BRIDGE_DIRS[0], 'node_modules', 'dep', 'index.js'), 'stray\n');
    mkdirSync(join(root, BRIDGE_DIRS[0], '.git'), { recursive: true });
    writeFileSync(join(root, BRIDGE_DIRS[0], '.git', 'HEAD'), 'ref\n');
    const { code } = run([], root);
    assert.equal(code, 0);
    assert.ok(!existsSync(join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'node_modules')), 'node_modules never copied');
    assert.ok(!existsSync(join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], '.git')), '.git never copied');
  });
});

describe('template exclusions (D1)', () => {
  it('hard-excluded divergence is NEVER copied — a run leaves both sides as they were', () => {
    const root = makeRoot();
    seedFamily(root);
    const kitSide = join(root, 'agent-workflow-kit', 'references', 'templates');
    const before = TEMPLATE_HARD_EXCLUDES.map((rel) => readFileSync(join(kitSide, rel), 'utf8'));
    const { code } = run([], root);
    assert.equal(code, 0);
    TEMPLATE_HARD_EXCLUDES.forEach((rel, i) => {
      assert.equal(readFileSync(join(kitSide, rel), 'utf8'), before[i], `${rel} stays divergent (deliberate)`);
    });
  });

  it('a template file OUTSIDE the manifest is untouched even when divergent', () => {
    const root = makeRoot();
    seedFamily(root);
    const kitExtra = join(root, 'agent-workflow-kit', 'references', 'templates', 'local-extra.md');
    const before = readFileSync(kitExtra, 'utf8');
    const { code } = run([], root);
    assert.equal(code, 0);
    assert.equal(readFileSync(kitExtra, 'utf8'), before);
  });

  it('a manifest template missing on the canon side fails LOUD naming the file', () => {
    const root = makeRoot();
    seedFamily(root);
    rmSync(join(root, 'agent-workflow-memory', 'references', 'templates', 'gates.json'));
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(errText, /missing on the canon side: agent-workflow-memory\/references\/templates\/gates\.json/);
  });
});

describe('--check never writes', () => {
  it('with injected drift + an extraneous file, --check exits 1 and mutates nothing', () => {
    const root = makeRoot();
    seedFamily(root);
    writeFileSync(join(root, BRIDGE_DIRS[0], 'SKILL.md'), '# drifted\n');
    const stray = join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'stray.md');
    writeFileSync(stray, 'stray\n');
    const mirrorSkill = join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'SKILL.md');
    const before = readFileSync(mirrorSkill, 'utf8');
    const { code, text } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(text, /would copy/);
    assert.match(text, /would delete/);
    assert.equal(readFileSync(mirrorSkill, 'utf8'), before, 'no copy happened');
    assert.ok(existsSync(stray), 'no delete happened');
  });
});

describe('mode preservation (D2)', () => {
  it('a canon-executable file synced into a NEW mirror path keeps the executable bit', () => {
    const root = makeRoot();
    seedFamily(root);
    const newTool = join(root, BRIDGE_DIRS[0], 'bin', 'new-tool.sh');
    writeFileSync(newTool, '#!/bin/sh\necho new\n');
    chmodSync(newTool, 0o755);
    const { code } = run([], root);
    assert.equal(code, 0);
    const mirrored = join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'bin', 'new-tool.sh');
    assert.ok(existsSync(mirrored));
    assert.notEqual(statSync(mirrored).mode & 0o111, 0, 'the executable bit survives the copy');
  });

  it('an exec-bit drift alone (same bytes) is detected and repaired', () => {
    const root = makeRoot();
    seedFamily(root);
    const mirrorTool = join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'bin', 'run.sh');
    chmodSync(mirrorTool, 0o644);
    const check = run(['--check'], root);
    assert.equal(check.code, 1, 'mode drift is a would-be change');
    const apply = run([], root);
    assert.equal(apply.code, 0);
    assert.notEqual(statSync(mirrorTool).mode & 0o111, 0, 'the executable bit is restored');
  });
});

describe('syncBridgeMirror — the root-parameterized --bump hook (D5)', () => {
  it('re-syncs exactly the named bridge and returns the applied changes', () => {
    const root = makeRoot();
    seedFamily(root);
    writeFileSync(join(root, BRIDGE_DIRS[0], 'capability.json'), '{"version":"9.9.9"}\n');
    writeFileSync(join(root, BRIDGE_DIRS[1], 'capability.json'), '{"version":"8.8.8"}\n');
    const changes = syncBridgeMirror(root, BRIDGE_DIRS[0]);
    assert.equal(changes.length, 1);
    assert.equal(
      readFileSync(join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[0], 'capability.json'), 'utf8'),
      '{"version":"9.9.9"}\n',
      'the named bridge mirror is byte-identical again',
    );
    assert.notEqual(
      readFileSync(join(root, 'agent-workflow-kit', 'bridges', BRIDGE_DIRS[1], 'capability.json'), 'utf8'),
      '{"version":"8.8.8"}\n',
      'the OTHER bridge mirror is untouched',
    );
  });

  it('rejects a non-bridge dir loudly', () => {
    assert.throws(() => syncBridgeMirror(makeRoot(), 'agent-workflow-kit'), /not a bridge dir/);
  });
});

describe('planAllMirrors covers every family', () => {
  it('reports one plan per bridge + reference-scripts + templates + root-scripts', () => {
    const root = makeRoot();
    seedFamily(root);
    const families = planAllMirrors(root).map((plan) => plan.family);
    assert.deepEqual(families, [`bridge:${BRIDGE_DIRS[0]}`, `bridge:${BRIDGE_DIRS[1]}`, 'reference-scripts', 'templates', 'root-scripts']);
  });
});

// Decision 12 — the root-scripts subset is DIRECTIONAL: memory canon → this repo's root scripts/.
// A canon script whose basename is also at root is kept byte+exec-identical; root-only tooling
// (sync-mirrors*, release/*, any non-canon script) is never flagged or deleted; a canon file absent
// from root is never added. It is NOT planTreeSync set-equality (which would delete release/*).
describe('root-scripts subset (Decision 12) — directional, never destructive to root-only tooling', () => {
  const seedRoot = (root) => {
    // A canon whose members are: tool.mjs (present at root, drifted) + canon-only.mjs (absent at root).
    const canon = join(root, 'agent-workflow-memory', 'references', 'scripts');
    writeFileSync(join(canon, 'canon-only.mjs'), 'export const x = 1;\n');
    // The root subset the consumer dogfoods, plus root-ONLY tooling that must be immune.
    const rootScripts = join(root, 'scripts', 'release');
    mkdirSync(rootScripts, { recursive: true });
    writeFileSync(join(root, 'scripts', 'tool.mjs'), 'export const tool = 999; // drifted at root\n');
    writeFileSync(join(root, 'scripts', 'sync-mirrors.mjs'), '// root-only tool\n');
    writeFileSync(join(rootScripts, 'dispatch-publish.mjs'), '// root-only release tool\n');
  };

  it('--check flags a drifted root subset file but NEVER touches release/* or sync-mirrors.mjs', () => {
    const root = makeRoot();
    seedFamily(root);
    seedRoot(root);
    const { code, text } = run(['--check'], root);
    assert.equal(code, 1, 'a drifted root subset file is a would-be change');
    assert.match(text, /root-scripts: would copy scripts\/tool\.mjs/);
    assert.doesNotMatch(text, /release/, 'release/* is never a root-scripts change');
    assert.doesNotMatch(text, /root-scripts: would (copy|delete) scripts\/sync-mirrors\.mjs/, 'sync-mirrors.mjs is never flagged');
  });

  it('a missing memory canon scripts dir fails loud (never treats a missing canon as empty)', () => {
    const root = makeRoot();
    assert.throws(() => planRootSubsetSync(root), /canon dir is missing/);
  });

  it('apply COPIES the canon into the root subset, never adds a canon-only file, never deletes root-only tooling', () => {
    const root = makeRoot();
    seedFamily(root);
    seedRoot(root);
    const { code } = run([], root);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'scripts', 'tool.mjs'), 'utf8'), 'export const tool = 1;\n', 'the root subset file is now the canon version');
    assert.ok(!existsSync(join(root, 'scripts', 'canon-only.mjs')), 'a canon file absent from root is NOT added');
    assert.ok(existsSync(join(root, 'scripts', 'release', 'dispatch-publish.mjs')), 'root-only release/* is never deleted');
    assert.ok(existsSync(join(root, 'scripts', 'sync-mirrors.mjs')), 'root-only sync-mirrors.mjs is never deleted');
  });
});

describe('the real tree', () => {
  it('the current repo is fully in sync (release invariant): --check exits 0', () => {
    const { code, errText, text } = run(['--check'], REPO_ROOT);
    assert.equal(code, 0, `real tree mirrors out of sync:\n${text}\n${errText}`);
  });
});
