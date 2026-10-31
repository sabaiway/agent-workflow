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
    mkdirSync(join(templates, 'specs'), { recursive: true }); // the seed specs/index.md subdir entry
    for (const rel of MIRROR_TEMPLATE_FILES) writeFileSync(join(templates, rel), `template ${rel}\n`);
    for (const rel of TEMPLATE_HARD_EXCLUDES) writeFileSync(join(templates, rel), `${side} divergent ${rel}\n`);
    writeFileSync(join(templates, 'local-extra.md'), `${side} extra outside the manifest\n`);
  }
  for (const rel of ['agent-workflow-memory/bin/payload-prune.mjs', 'agent-workflow-kit/tools/payload-prune.mjs']) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'export const prunePayload = () => ({});\n');
    chmodSync(join(root, rel), 0o644);
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
  it('reports one plan per bridge + reference-scripts + templates, and no root-scripts family (the family retires with the flat copies, spec script-family)', () => {
    const root = makeRoot();
    seedFamily(root);
    const families = planAllMirrors(root).map((plan) => plan.family);
    assert.deepEqual(families, [`bridge:${BRIDGE_DIRS[0]}`, `bridge:${BRIDGE_DIRS[1]}`, 'reference-scripts', 'templates', 'payload-prune']);
  });
});

// The script family is one nested tree: the kit mirror is the canon tree file for file, and the
// basename-keyed copy into this repository's flat scripts/ retired. The temp root's scripts/ stands
// in for that flat folder: a file of it whose basename the canon also carries is drifted and
// unreadable, so a sync that read it fails and a sync that wrote it changes its bytes.
describe('spec:script-family/S6 the reference-scripts tree syncs whole and leaves the flat scripts/ alone', () => {
  const MODULE_FILE = 'shared/markdown-blocks.mjs';
  const seedTree = (root) => {
    const canon = join(root, 'agent-workflow-memory', 'references', 'scripts');
    const mirror = join(root, 'agent-workflow-kit', 'references', 'scripts');
    for (const dir of [join(canon, 'shared'), join(canon, 'archives'), join(mirror, 'stale')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(canon, 'family.json'), '{"schema":1,"entries":[]}\n');
    writeFileSync(join(mirror, 'family.json'), '{"schema":1,"entries":[]}\n');
    writeFileSync(join(canon, 'family.mjs'), 'export const FAMILY_FILE = "family.json";\n');
    writeFileSync(join(mirror, 'family.mjs'), 'export const FAMILY_FILE = "stale";\n');
    writeFileSync(join(canon, MODULE_FILE), 'export const blocks = 1;\n');
    writeFileSync(join(canon, 'archives', 'archive-decisions.mjs'), '#!/usr/bin/env node\n');
    chmodSync(join(canon, 'archives', 'archive-decisions.mjs'), 0o755);
    writeFileSync(join(mirror, 'archive-decisions.mjs'), '// the old flat copy\n');
    writeFileSync(join(mirror, 'stale', 'old.mjs'), '// a module the canon dropped\n');
    const flat = join(root, 'scripts');
    mkdirSync(flat, { recursive: true });
    const standIns = { 'family.mjs': '// flat stand-in, drifted\n', 'tool.mjs': '// flat stand-in, drifted\n', 'sync-mirrors.mjs': '// root-only tool\n' };
    for (const [name, body] of Object.entries(standIns)) writeFileSync(join(flat, name), body);
    return { canon, mirror, flat, standIns };
  };

  it('copies a changed or absent canon file, deletes an extraneous mirror file, and reads and writes no file of the flat scripts/', () => {
    const root = makeRoot();
    seedFamily(root);
    const { canon, mirror, flat, standIns } = seedTree(root);
    const sealed = Object.keys(standIns).map((name) => join(flat, name));
    for (const path of sealed) chmodSync(path, 0o000);
    let check;
    let apply;
    try {
      check = run(['--check'], root);
      apply = run([], root);
    } finally {
      for (const path of sealed) chmodSync(path, 0o644);
    }
    assert.equal(check.errText, '', 'the check read nothing it could not');
    for (const rel of ['family.mjs', MODULE_FILE, 'archives/archive-decisions.mjs']) {
      assert.match(check.text, new RegExp(`^reference-scripts: would copy agent-workflow-kit/references/scripts/${rel}$`, 'm'));
    }
    for (const rel of ['archive-decisions.mjs', 'stale/old.mjs']) {
      assert.match(check.text, new RegExp(`^reference-scripts: would delete agent-workflow-kit/references/scripts/${rel}$`, 'm'));
    }
    assert.doesNotMatch(`${check.text}\n${apply.text}`, /root-scripts|(?:copy|copied|delete|deleted) scripts\//, 'no flat scripts/ path is planned');
    assert.equal(apply.code, 0, `the sync failed:\n${apply.text}\n${apply.errText}`);
    for (const rel of ['family.json', 'family.mjs', MODULE_FILE, 'archives/archive-decisions.mjs']) {
      assert.ok(readFileSync(join(mirror, rel)).equals(readFileSync(join(canon, rel))), `${rel} is the canon's bytes`);
    }
    assert.notEqual(statSync(join(mirror, 'archives', 'archive-decisions.mjs')).mode & 0o111, 0, 'the nested copy keeps the exec bit');
    assert.ok(!existsSync(join(mirror, 'archive-decisions.mjs')) && !existsSync(join(mirror, 'stale', 'old.mjs')), 'the extraneous mirror files are gone');
    for (const [name, body] of Object.entries(standIns)) assert.equal(readFileSync(join(flat, name), 'utf8'), body, `scripts/${name} is untouched`);
    assert.ok(!existsSync(join(flat, 'shared')) && !existsSync(join(flat, 'markdown-blocks.mjs')), 'no canon file is added to the flat scripts/');
  });

  it('a missing memory canon scripts dir fails loud (never treats a missing canon as empty)', () => {
    const root = makeRoot();
    seedFamily(root);
    rmSync(join(root, 'agent-workflow-memory', 'references', 'scripts'), { recursive: true });
    assert.throws(() => planAllMirrors(root), /canon dir is missing: agent-workflow-memory\/references\/scripts/);
  });
});

describe('spec:upgrade-delivery/S20 payload-prune mirror', () => {
  const CANON = 'agent-workflow-memory/bin/payload-prune.mjs';
  const COPY = 'agent-workflow-kit/tools/payload-prune.mjs';
  for (const absent of [false, true]) {
    it(`${absent ? 'an absent copy' : 'an edited canon'} is reported without writes and restored by a run`, () => {
      const root = makeRoot();
      seedFamily(root);
      const before = readFileSync(join(root, COPY));
      if (absent) rmSync(join(root, COPY));
      else writeFileSync(join(root, CANON), 'export const prunePayload = () => ({ ok: true });\n');
      const check = run(['--check'], root);
      assert.equal(check.code, 1);
      assert.ok(check.out.includes(`payload-prune: would copy ${COPY}`), check.text);
      if (absent) assert.equal(existsSync(join(root, COPY)), false);
      else assert.deepEqual(readFileSync(join(root, COPY)), before);
      const apply = run([], root);
      assert.equal(apply.code, 0, apply.errText);
      assert.ok(apply.out.includes(`payload-prune: copied ${COPY}`), apply.text);
      assert.deepEqual(readFileSync(join(root, COPY)), readFileSync(join(root, CANON)));
    });
  }
  it('detects and restores exec-bit drift with identical bytes', () => {
    const root = makeRoot();
    seedFamily(root);
    chmodSync(join(root, CANON), 0o755);
    const check = run(['--check'], root);
    assert.equal(check.code, 1);
    assert.equal(statSync(join(root, COPY)).mode & 0o111, 0);
    assert.equal(run([], root).code, 0);
    assert.equal(statSync(join(root, COPY)).mode & 0o111, 0o111);
  });
  it('fails loud when the canon is missing and writes nothing', () => {
    const root = makeRoot();
    seedFamily(root);
    const before = readFileSync(join(root, COPY));
    rmSync(join(root, CANON));
    const result = run(['--check'], root);
    assert.equal(result.code, 1);
    assert.match(result.errText, /canon file is missing: agent-workflow-memory\/bin\/payload-prune\.mjs/);
    assert.deepEqual(readFileSync(join(root, COPY)), before);
    assert.equal(existsSync(join(root, CANON)), false);
  });
});

describe('the real tree', () => {
  it('the current repo is fully in sync (release invariant): --check exits 0', () => {
    const { code, errText, text } = run(['--check'], REPO_ROOT);
    assert.equal(code, 0, `real tree mirrors out of sync:\n${text}\n${errText}`);
  });
});
