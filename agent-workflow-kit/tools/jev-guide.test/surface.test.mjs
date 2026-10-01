import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatHelp } from '../commands.mjs';
import { BENEFITS, SEVERITIES, WHATS } from '../recommendations.mjs';

const loaded = await import('../jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = dirname(KIT);
const GUIDE = join(KIT, 'tools', 'jev-guide.mjs');
const LF = '\n';
const COMMAND = /\/agent-workflow-kit jev\b/;
const WORDS = /\bjev\b|typesafe/i;
// The contract's closed import surface: specifier → the names it may give (null: any name).
const NAMED = new Map([['node:fs', ['statSync']], ['node:os', ['homedir']], ['node:path', null], ['node:url', null],
  ['tools/direct-run.mjs', ['isDirectRun']], ['references/scripts/markdown-blocks.mjs', ['fail']],
  ['tools/jev-facts.mjs', ['KEY_VARIABLE', 'connectLine', 'keySet']]]);
const TOKENS = ['import(', 'require(', 'process.getBuiltinModule', 'process.binding', 'fetch', 'WebSocket', 'plugins',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR'];
const BARE_NAMES = /\b(getBuiltinModule|binding|dlopen|eval|Function)\b/;
const PACKAGES = [['kit', KIT], ['engine', join(REPO, 'agent-workflow-engine')], ['memory', join(REPO, 'agent-workflow-memory')]];

const sourceOf = () => readFileSync(GUIDE, 'utf8');
const identityOf = (specifier, from) => {
  if (!specifier.startsWith('.')) return specifier.startsWith('node:') ? specifier : `node:${specifier}`;
  return relative(KIT, resolve(dirname(from), specifier)).split('\\').join('/');
};
const statementsOf = (source) => source.match(/^\s*(import|export)\b[^;]*?\bfrom\s*['"][^'"]+['"]|^\s*import\s*['"][^'"]+['"]/gm) ?? [];
const specifierOf = (statement) => statement.match(/['"]([^'"]+)['"]\s*$/)[1];
const graphOf = (file, seen = new Set()) => {
  for (const statement of statementsOf(readFileSync(file, 'utf8'))) {
    const identity = identityOf(specifierOf(statement), file);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!identity.startsWith('node:')) graphOf(join(KIT, identity), seen);
  }
  return seen;
};

const made = [];
const cells = {};
const tmp = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-surface-'));
  made.push(root);
  return root;
};
const run = (argv, io) => {
  const out = [];
  const err = [];
  const code = main(argv, { log: (text) => out.push(text), error: (text) => err.push(text), ...io });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const CASES = [
  ['bare plain', () => run(['--dir', cells.bare.dir], cells.bare)],
  ['bare JSON', () => run(['--dir', cells.bare.dir, '--json'], cells.bare)],
  ['found and set', () => run(['--dir', cells.found.dir, '--json'], cells.found)],
  ['help', () => run(['--help'], cells.bare)],
  ['usage', () => run(['--bogus'], cells.bare)],
  ['not a directory', () => run(['--dir', join(cells.bare.dir, 'absent')], cells.bare)],
];
const packedFiles = (dir) => {
  const cache = mkdtempSync(join(tmpdir(), 'jev-pack-cache-'));
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env,
      npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
      NO_UPDATE_NOTIFIER: '1' } });
    assert.equal(result.status, 0, `npm pack failed in ${dir}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).files.map(({ path }) => path);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
};
// Every line of the packed files of the three packages and of the root README, CHANGELOG.md excluded.
let lines = [];
const hitsOf = (pattern) => lines.filter(({ text }) => pattern.test(text));
const where = ({ file, text }) => `${file}: ${text}`;

before(() => {
  cells.bare = { cwd: tmp(), env: {}, home: tmp() };
  cells.bare.dir = cells.bare.cwd;
  const found = tmp();
  mkdirSync(join(found, '.claude', 'skills', 'typesafe-ai'), { recursive: true });
  writeFileSync(join(found, '.claude', 'skills', 'typesafe-ai', 'SKILL.md'), '# the vendor skill\n');
  cells.found = { dir: found, cwd: found, env: { TYPESAFE_API_KEY: 'jev-canary-value' }, home: tmp() };
  const files = PACKAGES.flatMap(([name, dir]) => packedFiles(dir).map((path) => [`${name}:${path}`, join(dir, path)]))
    .concat([['root:README.md', join(REPO, 'README.md')]])
    .filter(([, path]) => basename(path) !== 'CHANGELOG.md');
  lines = files.flatMap(([file, path]) => readFileSync(path, 'utf8').split(LF).map((text, index) => ({ file, text, index })));
});
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

describe('spec:jev-guide/S7 a closed import surface, no network token and no network call', () => {
  it('imports only the named imports the contract lists, no namespace or default import', () => {
    const source = sourceOf();
    const statements = statementsOf(source);
    assert.equal(statements.length, (source.match(/^\s*import\b/gm) ?? []).length, 'every import statement parses');
    for (const statement of statements) {
      const named = statement.match(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]$/);
      assert.ok(named, `a named import: ${statement.trim()}`);
      const identity = identityOf(named[2], GUIDE);
      assert.ok(NAMED.has(identity), `an allowed module: ${identity}`);
      const names = named[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of names) assert.ok(NAMED.get(identity) === null || NAMED.get(identity).includes(name), `${identity}: ${name}`);
    }
  });

  it('keeps the transitive static import graph within the seven listed modules and never reaches the connect command', () => {
    const graph = [...graphOf(GUIDE)];
    assert.ok(graph.includes('tools/direct-run.mjs'), 'the walk reaches the direct-run leaf');
    assert.ok(graph.includes('tools/jev-facts.mjs'), 'the walk reaches the facts leaf');
    assert.deepEqual(graph.filter((identity) => !NAMED.has(identity)), []);
    assert.ok(!graph.includes('tools/jev-connect.mjs'));
  });

  it('carries none of the listed tokens nor their bare names, and names process.env once, as the default of io.env', () => {
    const source = sourceOf();
    for (const token of TOKENS) assert.ok(!source.includes(token), token);
    assert.doesNotMatch(source, BARE_NAMES);
    const envLines = source.split(LF).filter((line) => line.includes('process.env'));
    assert.equal(envLines.length, 1, envLines.join(LF));
    assert.equal((envLines[0].match(/process\.env/g) ?? []).length, 1);
    assert.match(envLines[0], /io\.env\s*\?\?\s*process\.env\b|\benv\s*=\s*process\.env\b/);
  });

  it('runs every case unchanged with globalThis.fetch replaced by a thrower', () => {
    const expected = CASES.map(([, render]) => render());
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls += 1; throw new Error('no network in the jev guide'); };
    try {
      CASES.forEach(([name, render], index) => assert.deepEqual(render(), expected[index], name));
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0);
    assert.deepEqual(expected.map(({ code }) => code), [0, 0, 0, 0, 2, 1]);
  });
});

describe('spec:jev-guide/S12 two discovery lines and nothing else', () => {
  const skillLines = () => lines.filter(({ file }) => file === 'kit:SKILL.md');
  const descriptionOf = () => skillLines().find(({ text }) => text.startsWith('description: '));
  const readmeRow = () => lines.find(({ file, text }) => file === 'kit:README.md' && text.startsWith('| `/agent-workflow-kit jev` |'));
  const entryLines = () => {
    const catalog = lines.filter(({ file }) => file === 'kit:tools/commands.mjs');
    const key = catalog.findIndex(({ text }) => text.trim() === "key: 'jev',");
    assert.ok(key > 0, 'the jev catalog entry');
    const end = catalog.findIndex(({ text }, index) => index > key && text.trim() === '},');
    return catalog.slice(key - 1, end + 1);
  };
  const guideFile = ({ file }) => ['kit:tools/jev-guide.mjs', 'kit:references/modes/jev.md', 'kit:tools/jev-facts.mjs',
    'kit:tools/jev-connect.mjs'].includes(file) || file.startsWith('kit:tools/jev-connect.test');
  const fileLines = (name) => lines.filter(({ file }) => file === name);
  const onlyOne = (found, label) => {
    assert.equal(found.length, 1, label);
    return found[0];
  };
  const rowIn = (name, opener) => {
    const all = fileLines(name);
    const start = all.findIndex(({ text }) => text.startsWith(opener));
    const end = all.findIndex(({ text }, index) => index > start && text === '});');
    assert.ok(start >= 0 && end > start, opener);
    return onlyOne(all.slice(start, end).filter(({ text }) => text.startsWith("  'jev-connect': ")), `${opener}: the jev-connect row`);
  };
  // The advisor's closed set: the three registry rows, the opt-in row, RISK_NOTED_KEYS, the decline fact, the import line and
  // the probe span, from the comment block directly above export const probeJevConnect to its closing `};`.
  const advisorLines = () => {
    const advisor = 'kit:tools/recommendations.mjs';
    const all = fileLines(advisor);
    const one = (test, label) => onlyOne(all.filter(({ text }) => test(text)), label);
    const probe = all.findIndex(({ text }) => text.startsWith('export const probeJevConnect = '));
    assert.ok(probe > 0, 'the probe');
    const first = probe - [...all.slice(0, probe)].reverse().findIndex(({ text }) => !text.startsWith('//'));
    const close = all.findIndex(({ text }, index) => index > probe && text === '};');
    return [...['export const SEVERITIES', 'export const WHATS', 'export const BENEFITS'].map((opener) => rowIn(advisor, opener)),
      one((text) => text.trim() === "{ id: 'jev-connect', mode: 'jev', advisorKey: 'jev-connect' },", 'the opt-in row'),
      one((text) => text.startsWith('export const RISK_NOTED_KEYS = '), 'RISK_NOTED_KEYS'),
      one((text) => /^const [A-Z_]+ = 'jev-connect:declined';$/.test(text), 'the decline fact'),
      one((text) => /^import \{[^}]*\} from '\.\/jev-facts\.mjs';$/.test(text), 'the import line'), ...all.slice(first, close + 1)];
  };

  it('names /agent-workflow-kit jev only on the description line, the README row, the mode doc and the guide', () => {
    const allowed = [descriptionOf(), readmeRow()];
    assert.ok(allowed.every(Boolean) && allowed.every(({ text }) => COMMAND.test(text)), 'both discovery lines');
    assert.deepEqual(hitsOf(COMMAND).filter((line) => !allowed.includes(line) && !guideFile(line)).map(where), []);
  });

  it('keeps the description one YAML plain scalar and the README row directly after the tier row, read-only', () => {
    assert.doesNotMatch(descriptionOf().text.slice('description: '.length), /: | #|:$/);
    const readme = lines.filter(({ file }) => file === 'kit:README.md');
    const tier = readme.findIndex(({ text }) => text.startsWith('| `/agent-workflow-kit tier` |'));
    const row = readme[tier + 1].text;
    assert.equal(row.split('|')[1].trim(), '`/agent-workflow-kit jev`');
    assert.ok(row.includes('read-only'), row);
  });

  it('carries the command on exactly one line of the help render', () => {
    assert.equal(formatHelp().split(LF).filter((line) => COMMAND.test(line)).length, 1);
  });

  it('says jev or typesafe only on the discovery lines, the jev header and router line, the catalog entry, the advisor lines, the ack lane row, the note and the intro words, the mode doc and the guide', () => {
    const header = skillLines().findIndex(({ text }) => text === '### Mode: jev');
    assert.ok(header >= 0, 'the jev header');
    const doc = fileLines('kit:references/modes/recommendations.md');
    const note = onlyOne(doc.filter(({ text }) => text.startsWith('- `jev-connect` — ')), 'the jev-connect note');
    const intro = onlyOne(doc.filter(({ text }) => text.includes('Jev not connected on this host')), 'the intro-list words');
    assert.doesNotMatch(intro.text.replace('Jev not connected on this host', ''), WORDS, 'the intro line says nothing else');
    const allowed = [descriptionOf(), readmeRow(), skillLines()[header], skillLines()[header + 2], ...entryLines(), ...advisorLines(),
      rowIn('kit:tools/ack-store.mjs', 'export const ACK_LANES'), note, intro];
    assert.ok(allowed.slice(0, 4).every((line) => line && WORDS.test(line.text)), 'every named line carries the word');
    assert.deepEqual(hitsOf(WORDS).filter((line) => !allowed.includes(line) && !guideFile(line)).map(where), []);
  });

  it('gives the Recommendations registries exactly one jev key, jev-connect, and the reference profile none', () => {
    const profile = JSON.parse(readFileSync(join(KIT, 'references', 'reference-profile.json'), 'utf8'));
    for (const registry of [SEVERITIES, WHATS, BENEFITS]) assert.deepEqual(Object.keys(registry).filter((key) => WORDS.test(key)), ['jev-connect']);
    assert.ok(profile.items.length > 0);
    assert.deepEqual(profile.items.map(({ id }) => id).filter((id) => WORDS.test(id)), []);
  });
});
