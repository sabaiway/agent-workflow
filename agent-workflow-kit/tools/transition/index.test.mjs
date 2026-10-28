// Contract transition (docs/ai/specs/kit/transition/): the lineage migration removes the kit's old
// copies from AGENTS.md and docs/ai/agent_rules.md once, after it proves the kit block present.
// `deps` is the one bag of fs primitives the module forwards to its guards (readRegularFileNoFollow's
// io, writeContainedFileAtomic's deps), so a test can fail one read or one rename, or count writes.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as block from '../inject-methodology.mjs';

const loaded = await import('./index.mjs').catch(() => ({}));
const main = loaded.main ?? (() => {
  throw new Error('transition/index.mjs is absent');
});
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = dirname(HERE);
const KIT = dirname(TOOLS);
const { BLOCK_START, BLOCK_END, SKIP_PREFIX } = block;
const LF = '\n';
const RULES_REL = 'docs/ai/agent_rules.md';
const LENS_REL = 'docs/ai/rules/lens.md';
const FOOTER = '**Rule:** This file stays CONCISE (≤100 lines). Details go to `docs/ai/`. Never bloat this file.';
const TITLES = ['Communication (user-facing messages)', 'Story sessions', 'Planning, review & process-fidelity'];
const USAGE = 'usage: transition/index.mjs --cwd <project>';
const UPGRADE_ROUTE = 'run the upgrade again: its step 3 writes the kit block or names its malformed lines';
const ENGINE_ROUTE = 'run npx @sabaiway/agent-workflow-engine@latest init, then run the upgrade again';
const row = (theme, rest = ' When needed |') =>
  `| [\`docs/ai/rules/effective/${theme}.md\`](./docs/ai/rules/effective/${theme}.md) |${rest}`;
const pair = (name, ...body) => [`<!-- workflow:${name}:start -->`, ...body, `<!-- workflow:${name}:end -->`];
const KIT_BLOCK = [BLOCK_START, 'Kit text comes first.', '| Rules theme | Read when |', '|---|---|', row('lens'), BLOCK_END];
const AGENTS = [
  '# Project', ...KIT_BLOCK, '', '## Memory Map', '| File | Read When |', '|---|---|',
  row('project-layout'), row('communication'), row('never-shipped'), '',
  ...pair('methodology', 'Methodology pointer.'), ...pair('orchestration'),
  '  <!-- workflow:autonomy:start -->  ', 'Project text inside.', '<!-- workflow:autonomy:end -->',
  '', '---', '', FOOTER,
];
const AGENTS_DROPS = [[12, 14], [16, 23], [25, 27]];
const RULES = [
  '---', 'type: rules', '---', '', '# Rules', '', '## 2. Self-Review Checklist', '', '### 2.4. Quality Gates', 'Gates text.', '',
  '### 2.5. Communication (user-facing messages)', 'Comms text.', '',
  '### 2.6. Planning, review & process-fidelity invariants', 'Lens text.', '',
  '### 2.7. Story sessions', 'Story text.', '', '### 2.8. Project lenses', 'Own text.', '', '---', '', '## 3. Token', 'Token text.',
];
const RULES_DROPS = [[12, 20]];
const BASE_OUT = [
  ...['project-layout', 'communication', 'never-shipped'].map((theme, at) =>
    `removed: AGENTS.md: the Memory Map row of docs/ai/rules/effective/${theme}.md (line ${12 + at})`),
  'removed: AGENTS.md: the methodology pointer and its text (lines 16-18)',
  'removed: AGENTS.md: the orchestration pointer and its text (lines 19-20)',
  'removed: AGENTS.md: the autonomy pointer and its text (lines 21-23)',
  'removed: AGENTS.md: the line-cap footer (lines 25-27)',
  `removed: ${RULES_REL}: the section Communication (user-facing messages) (lines 12-14)`,
  `removed: ${RULES_REL}: the section Planning, review & process-fidelity invariants (lines 15-17)`,
  `removed: ${RULES_REL}: the section Story sessions (lines 18-20)`,
];
const UNCHANGED_AGENTS = 'unchanged: AGENTS.md: nothing of the old layout found';
const UNCHANGED_RULES = `unchanged: ${RULES_REL}: nothing of the old layout found`;

// Each line with its own ending, so a kept line keeps its bytes whatever the other lines end with.
const split = (lines, eol = LF) => lines.map((line, at) => line + (typeof eol === 'function' ? eol(at) : eol));
const join1 = (lines, eol) => split(lines, eol).join('');
const drop = (pieces, ranges) =>
  pieces.filter((_, at) => !ranges.some(([from, to = from]) => at + 1 >= from && at + 1 <= to)).join('');
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const NODES = {
  file: (path, text) => writeFileSync(path, text),
  dir: (path) => mkdirSync(path),
  symlink: (path, text) => {
    writeFileSync(`${path}.target`, text);
    symlinkSync(`${path}.target`, path);
  },
  absent: () => {},
};
const project = ({ agents = join1(AGENTS), rules = join1(RULES), kinds = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'transition-'));
  roots.push(root);
  mkdirSync(join(root, 'docs', 'ai', 'rules'), { recursive: true });
  for (const [rel, text] of [['AGENTS.md', agents], [RULES_REL, rules], [LENS_REL, '# Lens\n']]) {
    NODES[kinds[rel] ?? 'file'](join(root, rel), text);
  }
  return root;
};
const snapshot = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isFile()) return readFileSync(path).toString('hex');
  return Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]));
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const outLines = (text) => text.split(LF).filter((line) => line !== '');
const run = async (root, deps = {}) => {
  const result = await main(['--cwd', root], deps);
  assert.equal(typeof result.code, 'number');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  return result;
};
const assertRefusal = (result, name, ...mentions) => {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(outLines(result.stderr).length, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`^${name}\\b`));
  for (const text of mentions) assert.ok(result.stderr.includes(text), `${text} :: ${result.stderr}`);
};
// A refusal before the first write: one named line, and every path, kind and byte of the tree kept.
const assertRefusedUntouched = async (root, deps, name, ...mentions) => {
  const before = snapshot(root);
  const result = await run(root, deps);
  assertRefusal(result, name, ...mentions);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshot(root), before);
};
const assertRun = async (root, expectedOut, deps = {}) => {
  const result = await run(root, deps);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(outLines(result.stdout), expectedOut);
  return result;
};
const blockOnly = join1(['# Project', ...KIT_BLOCK]);

describe('spec:transition/S1 usage', () => {
  const throwing = Object.fromEntries(['open', 'lstat', 'fstat', 'readFile', 'writeFile', 'rename'].map((name) => [name, () => {
    throw new Error(`${name} before the usage judgement`);
  }]));
  for (const argv of [[], ['--bogus'], ['--cwd'], ['--cwd', ''], ['--cwd', '--x'], ['--cwd', 'a', '--cwd', 'a'], ['--cwd', 'a', 'b']]) {
    it(`exits 2 with the usage line before any read for ${JSON.stringify(argv)}`, async () => {
      const result = await main(argv, throwing);
      assert.deepEqual([result.code, result.stdout, outLines(result.stderr)], [2, '', [USAGE]]);
    });
  }
  it('accepts exactly one --cwd; main returns and the direct run exits by its code', async () => {
    assert.equal((await run(project())).code, 0);
    const cli = join(HERE, 'index.mjs');
    assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
    const direct = spawnSync(process.execPath, [cli, '--cwd', project()], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
  });
});

describe('spec:transition/S2 the first step refuses with nothing written', () => {
  const skip = `${SKIP_PREFIX} the orchestration recipes — refresh it with npx @sabaiway/agent-workflow-engine@latest init`;
  const swap = (from, to) => join1(AGENTS.map((line) => (line === from ? to : line)));
  const noBlock = join1(AGENTS.filter((_, at) => at < 1 || at > KIT_BLOCK.length));
  for (const [title, options, ...mentions] of [
    ['an absent AGENTS.md', { kinds: { 'AGENTS.md': 'absent' } }, 'no AGENTS.md',
      'create AGENTS.md, then run the upgrade again: its step 3 writes the kit block'],
    ['no block', { agents: noBlock }, 'no kit block in AGENTS.md', UPGRADE_ROUTE],
    ['a malformed block', { agents: swap(BLOCK_END, BLOCK_START) }, 'a malformed kit block in AGENTS.md', UPGRADE_ROUTE],
    ['a skip line inside the block', { agents: swap('Kit text comes first.', skip) }, 'a skipped engine text in the kit block', ENGINE_ROUTE],
    ['an absent lens file', { kinds: { [LENS_REL]: 'absent' } }, `no ${LENS_REL}`, ENGINE_ROUTE],
    ['a lens directory', { kinds: { [LENS_REL]: 'dir' } }, `no ${LENS_REL}`, ENGINE_ROUTE],
    ['no block and no lens file, the block named first', { agents: noBlock, kinds: { [LENS_REL]: 'absent' } },
      'no kit block in AGENTS.md', UPGRADE_ROUTE],
  ]) {
    it(`replacement-missing for ${title}, the old copies all present`, async () => {
      await assertRefusedUntouched(project(options), {}, 'replacement-missing', ...mentions);
    });
  }
});

describe('spec:transition/S3 pointer pairs', () => {
  const agents = [
    '<!-- workflow:autonomy:start -->', ...KIT_BLOCK, '<!-- workflow:autonomy:end -->',
    '  <!-- workflow:methodology:start -->  ', 'Filled text.', '<!-- workflow:methodology:end -->\r',
    '```', ...pair('orchestration'), '```',
    '<!-- workflow:orchestration:start -->', ...pair('orchestration'),
  ];
  it('removes each pair outside the block and a fence; a lone or cross-block marker line stays', async () => {
    const root = project({ agents: join1(agents), rules: '# Rules\n' });
    await assertRun(root, [
      'removed: AGENTS.md: the methodology pointer and its text (lines 9-11)',
      'removed: AGENTS.md: the orchestration pointer and its text (lines 17-18)',
      UNCHANGED_RULES,
    ]);
    assert.equal(read(root, 'AGENTS.md'), drop(split(agents), [[9, 11], [17, 18]]));
  });
});

describe('spec:transition/S4 theme rows', () => {
  const agents = [
    ...KIT_BLOCK, '', row('project-layout'), row('communication', ' Other cells | here |'), row('made-up'),
    '| [`docs/ai/rules/local/x.md`](./docs/ai/rules/local/x.md) | x |',
    '|  [`docs/ai/rules/effective/y.md`](./docs/ai/rules/effective/y.md) | y |',
    '```', row('fenced'), '```',
  ];
  it('removes each row the kit wrote outside the block; other first cells, the block rows and a fenced row stay', async () => {
    const root = project({ agents: join1(agents), rules: '# Rules\n' });
    await assertRun(root, [
      ...['project-layout', 'communication', 'made-up'].map((theme, at) =>
        `removed: AGENTS.md: the Memory Map row of docs/ai/rules/effective/${theme}.md (line ${8 + at})`),
      UNCHANGED_RULES,
    ]);
    assert.equal(read(root, 'AGENTS.md'), drop(split(agents), [[8, 10]]));
  });
});

describe('spec:transition/S5 the footer', () => {
  const agents = [
    ...KIT_BLOCK, 'Text.', '---', '', `${FOOTER}  `, 'Other.', FOOTER, `See ${FOOTER}`, '```', FOOTER, '```',
  ];
  it('removes the footer with its --- and blank line as placed, a footer under other lines alone', async () => {
    const root = project({ agents: join1(agents), rules: '# Rules\n' });
    await assertRun(root, [
      'removed: AGENTS.md: the line-cap footer (lines 8-10)',
      'removed: AGENTS.md: the line-cap footer (line 12)',
      UNCHANGED_RULES,
    ]);
    assert.equal(read(root, 'AGENTS.md'), drop(split(agents), [[8, 10], [12]]));
  });
});

describe('spec:transition/S6 the sections', () => {
  const rules = [
    '# R', '## Communication (user-facing messages) of ours', 'Body.', '```', '## not a heading', '```', '#### Deeper',
    '### 3. Story sessions', 'x', '## Our Story sessions', 'Kept.', '### Planning, review & process-fidelity', 'y',
  ];
  it('removes each kit section at any level and prefix up to its end; other words stay and end a section', async () => {
    const root = project({ agents: blockOnly, rules: join1(rules) });
    await assertRun(root, [
      UNCHANGED_AGENTS,
      `removed: ${RULES_REL}: the section Communication (user-facing messages) of ours (lines 2-9)`,
      `removed: ${RULES_REL}: the section Planning, review & process-fidelity (lines 12-13)`,
    ]);
    assert.equal(read(root, RULES_REL), drop(split(rules), [[2, 9], [12, 13]]));
  });
});

describe('spec:transition/S7 the field case', () => {
  const field = [
    '# Rules', '', '## 2. Planning, review & process-fidelity invariants', 'Lens.', '### Lens sub', '',
    '## 3. Communication (user-facing messages)', 'Comms.', '### 3.1. Sub', 'Sub text.', '', '## 4. User Interaction', 'Own text.',
  ];
  it('removes both level-2 sections with their subsections and keeps ## 4. whole', async () => {
    const root = project({ agents: blockOnly, rules: join1(field) });
    await assertRun(root, [
      UNCHANGED_AGENTS,
      `removed: ${RULES_REL}: the section Planning, review & process-fidelity invariants (lines 3-6)`,
      `removed: ${RULES_REL}: the section Communication (user-facing messages) (lines 7-11)`,
    ]);
    assert.equal(read(root, RULES_REL), drop(split(field), [[3, 11]]));
  });
  it('removes ### 2.5. to ### 2.7. of the template shape; ### 2.4., a project ### 2.8. and the --- stay', async () => {
    const root = project({ agents: blockOnly });
    await assertRun(root, [UNCHANGED_AGENTS, ...BASE_OUT.slice(-3)]);
    assert.equal(read(root, RULES_REL), drop(split(RULES), RULES_DROPS));
  });
});

describe('spec:transition/S8 bytes', () => {
  for (const [title, eol] of [['LF', LF], ['CRLF', '\r\n'], ['mixed', (at) => (at % 2 ? '\r\n' : LF)]]) {
    it(`keeps every line not removed with its own ending in a ${title} document`, async () => {
      const root = project({ agents: join1(AGENTS, eol), rules: join1(RULES, eol) });
      await assertRun(root, BASE_OUT);
      assert.equal(read(root, 'AGENTS.md'), drop(split(AGENTS, eol), AGENTS_DROPS));
      assert.equal(read(root, RULES_REL), drop(split(RULES, eol), RULES_DROPS));
    });
  }
  it('keeps a leading byte order mark first when the line it opened is removed', async () => {
    const agents = [...pair('methodology', 'x'), ...KIT_BLOCK];
    const root = project({ agents: `﻿${join1(agents)}`, rules: '# Rules\n' });
    await assertRun(root, ['removed: AGENTS.md: the methodology pointer and its text (lines 1-3)', UNCHANGED_RULES]);
    assert.equal(read(root, 'AGENTS.md'), `﻿${join1(KIT_BLOCK)}`);
  });
  it('keeps every byte of a tree with nothing found', async () => {
    const root = project({ agents: blockOnly, rules: '# Rules\r\n\r\nOwn.\n' });
    const before = snapshot(root);
    await assertRun(root, [UNCHANGED_AGENTS, UNCHANGED_RULES]);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('spec:transition/S9 the output', () => {
  it('prints one removed line per removal in file order, AGENTS.md first, exit 0', async () => {
    await assertRun(project(), BASE_OUT);
  });
  it('names an absent rules file absent', async () => {
    await assertRun(project({ agents: blockOnly, kinds: { [RULES_REL]: 'absent' } }), [
      UNCHANGED_AGENTS, `unchanged: ${RULES_REL}: absent`,
    ]);
  });
  it('prints a control byte in a title as found as a space', async () => {
    const root = project({ agents: blockOnly, rules: '## Story sessions\u0001and more\n' });
    await assertRun(root, [UNCHANGED_AGENTS, `removed: ${RULES_REL}: the section Story sessions and more (line 1)`]);
  });
});

describe('spec:transition/S10 idempotent', () => {
  const counting = () => {
    const writes = [];
    const writeFile = (path, ...rest) => {
      writes.push(path);
      return writeFileSync(path, ...rest);
    };
    return { writes, deps: { writeFile } };
  };
  it('a second run makes no write call, changes no byte and prints only unchanged lines', async () => {
    const root = project();
    const first = counting();
    await assertRun(root, BASE_OUT, first.deps);
    assert.equal(first.writes.length, 2, 'the write seam is the injected one');
    const before = snapshot(root);
    const second = counting();
    await assertRun(root, [UNCHANGED_AGENTS, UNCHANGED_RULES], second.deps);
    assert.deepEqual(second.writes, []);
    assert.deepEqual(snapshot(root), before);
  });
  it('a rules file left opening with --- loses those lines, and the second run is accepted and writes nothing', async () => {
    const rules = ['## Communication (user-facing messages)', 'Body.', '---', '## Story sessions', 'Body.', '---', '## Project rules', 'Own.'];
    const root = project({ agents: blockOnly, rules: join1(rules) });
    const result = await run(root);
    assert.equal(result.code, 0, result.stderr);
    const removed = outLines(result.stdout).filter((line) => line.startsWith(`removed: ${RULES_REL}: `));
    assert.deepEqual(removed.map((line) => TITLES.find((title) => line.includes(`the section ${title} (`))), TITLES.slice(0, 2));
    assert.equal(read(root, RULES_REL), '## Project rules\nOwn.\n');
    const again = counting();
    await assertRun(root, [UNCHANGED_AGENTS, UNCHANGED_RULES], again.deps);
    assert.deepEqual(again.writes, []);
  });
});

describe('spec:transition/S11 the other refusals', () => {
  const FENCE_ROUTE = 'close the fence or separate the leading --- block, then run the upgrade again';
  const eio = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  const failedRead = { readFile: () => { throw eio(); } };
  for (const [title, options, deps, name, ...mentions] of [
    ['AGENTS.md a symlink', { kinds: { 'AGENTS.md': 'symlink' } }, {}, 'file-symlink', 'AGENTS.md',
      'replace the link with a regular file holding its text, then run the upgrade again'],
    ['the rules file a symlink', { kinds: { [RULES_REL]: 'symlink' } }, {}, 'file-symlink', RULES_REL],
    ['AGENTS.md a directory', { kinds: { 'AGENTS.md': 'dir' } }, {}, 'file-unreadable', 'AGENTS.md',
      'make it a readable regular file, then run the upgrade again'],
    ['the rules file a directory', { kinds: { [RULES_REL]: 'dir' } }, {}, 'file-unreadable', RULES_REL],
    ['a failed read', {}, failedRead, 'file-unreadable', 'AGENTS.md'],
    ['a fence never closed in AGENTS.md, before the first step', { agents: '# P\n```\nx\n' }, {}, 'file-unparseable', FENCE_ROUTE],
    ['a fence never closed in the rules file', { rules: '# R\n## Story sessions\n~~~\nx\n' }, {}, 'file-unparseable', FENCE_ROUTE],
    ['an ambiguous leading --- block in the rules file', { rules: '---\n# Heading\n---\nbody\n' }, {}, 'file-unparseable', FENCE_ROUTE],
  ]) {
    it(`${name} for ${title}, nothing written`, async () => {
      await assertRefusedUntouched(project(options), deps, name, ...mentions);
    });
  }
  for (const [title, options, file, line] of [
    ['AGENTS.md', { agents: '# P\n```\nx\n' }, 'AGENTS.md', 2],
    ['the rules file', { rules: '# R\n## Story sessions\n~~~\nx\n' }, RULES_REL, 3],
    ['the leading --- block', { rules: '---\n# Heading\n---\nbody\n' }, RULES_REL, 2],
  ]) {
    it(`file-unparseable names the file and its line for ${title}`, async () => {
      const result = await run(project(options));
      assertRefusal(result, 'file-unparseable', file);
      assert.match(result.stderr, new RegExp(`${file.replaceAll('.', '\\.')}\\D{1,8}${line}\\b`));
    });
  }
  it('write-failed names the file already written, with no rollback', async () => {
    const root = project();
    const rename = (from, to) => {
      if (to.endsWith('agent_rules.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return renameSync(from, to);
    };
    assertRefusal(await run(root, { rename }), 'write-failed', 'AGENTS.md');
    assert.equal(read(root, 'AGENTS.md'), drop(split(AGENTS), AGENTS_DROPS));
    assert.equal(read(root, RULES_REL), join1(RULES));
  });
});

describe('spec:transition/S12 the landmarks live here only', () => {
  const OLD_MARKERS = ['workflow:methodology', 'workflow:orchestration', 'workflow:autonomy'];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
  const carriers = (files, needles) => files
    .filter((path) => needles.some((needle) => readFileSync(path, 'utf8').includes(needle)))
    .map((path) => relative(KIT, path));
  it('no non-test tool outside the module carries an old marker name, the footer sentence or a title', () => {
    const tools = walk(TOOLS).filter((path) => path.endsWith('.mjs') && !path.startsWith(`${HERE}/`)
      && !relative(TOOLS, path).split('/').some((part) => part.endsWith('.test.mjs') || part.endsWith('.test')));
    assert.deepEqual(carriers(tools, [...OLD_MARKERS, FOOTER, ...TITLES]), []);
  });
  it('no kit reference carries an old marker name or the footer sentence', () => {
    assert.deepEqual(carriers(walk(join(KIT, 'references')), [...OLD_MARKERS, FOOTER]), []);
  });
  it('the module imports the finder and the skip prefix from the block module and declares no block marker', () => {
    const source = readFileSync(join(HERE, 'index.mjs'), 'utf8');
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/inject-methodology\.mjs['"]/g)]
      .flatMap(([, names]) => names.split(',').map((name) => name.trim()));
    for (const name of ['findKitBlock', 'SKIP_PREFIX']) assert.ok(imported.includes(name), name);
    assert.ok(!source.includes('workflow:kit'));
  });
});
