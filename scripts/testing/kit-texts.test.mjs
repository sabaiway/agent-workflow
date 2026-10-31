import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIOR_FILES } from '../../agent-workflow-kit/tools/script-priors.mjs';
import { KIT_COMMANDS } from '../../agent-workflow-kit/references/scripts/run.mjs';
import { readFamily } from '../../agent-workflow-kit/references/scripts/family.mjs';

// The kit-texts guard (spec script-family, scenario S12): every kit text — a packed .md or .json of the kit, memory or engine
// package, or the root README — names a kit check through `node scripts/agent-workflow/run.mjs <name>` and a deployed
// file by its deployed path; a flat-layout name stands only where a frozen exclusion below excuses it.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES = ['agent-workflow-kit', 'agent-workflow-memory', 'agent-workflow-engine'];
const DEPLOYED = readFamily(join(REPO, 'agent-workflow-kit', 'references', 'scripts')).filter((e) => e.role === 'deployed').map((e) => e.path);
const TARGETS = Object.values(KIT_COMMANDS);

const alt = (names) => names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const LEFT = String.raw`(?<![\w.-])(?<!references[\\/])`;
const RIGHT = String.raw`(?![\w-]|\.\w)`;
const FLAT_RE = new RegExp(String.raw`${LEFT}scripts[\\/](?:${alt(PRIOR_FILES)}|<[^<>\s]*>\.mjs)${RIGHT}`, 'g');
const KIT_FOLDER_RE = new RegExp(String.raw`${LEFT}scripts[\\/]agent-workflow(?![\w-])[^\s"'\x60()[\],;:]*`, 'g');
const RUN_RE = new RegExp(String.raw`(?<![\w.-])((?:[^\s"'\x60()[\]]*[\\/])?)run\.mjs${RIGHT}(?: ([^\s"'\x60),;]+))?`, 'g');
const BARE_RE = new RegExp(String.raw`(?<![\w.-])node (?:${alt(TARGETS.map((t) => t.split('/').pop()))})${RIGHT}`, 'g');

const kitFolderFlag = (path) => {
  const rel = path.slice('scripts/agent-workflow'.length).replace(/\\/g, '/').replace(/\.+$/, '').replace(/^\/+|\/+$/g, '');
  if (TARGETS.includes(rel)) return true;
  return !(rel === '' || rel.includes('<') || DEPLOYED.includes(rel) || DEPLOYED.some((d) => d.startsWith(`${rel}/`)));
};

const runFlag = (prefix, name) => {
  const at = prefix.replace(/\\/g, '/');
  if (/(^|\/)references\/scripts\/$/.test(at)) return false;
  if (at !== '' && !/(^|\/)scripts\/agent-workflow\/$/.test(at)) return true;
  const word = (name ?? '').replace(/[.:]+$/, '');
  if (!/^[\w-]/.test(word) || word === '--help' || word === '-h') return false;
  return !Object.hasOwn(KIT_COMMANDS, word);
};

// Every whitespace run reads as one space; each kept character remembers the line it came from.
const normalize = (raw) => {
  let text = '';
  const lineOf = [];
  for (let i = 0, line = 1; i < raw.length; i += 1) {
    const space = /\s/.test(raw[i]);
    if (!space || !/\s/.test(raw[i - 1] ?? '')) { text += space ? ' ' : raw[i]; lineOf.push(line); }
    if (raw[i] === '\n') line += 1;
  }
  return { text, lineOf };
};

const hitsIn = (text) => [
  ...[...text.matchAll(FLAT_RE)].map((m) => ({ index: m.index, path: m[0] })),
  ...[...text.matchAll(KIT_FOLDER_RE)].filter((m) => kitFolderFlag(m[0])).map((m) => ({ index: m.index, path: m[0] })),
  ...[...text.matchAll(RUN_RE)].filter((m) => runFlag(m[1], m[2])).map((m) => ({ index: m.index, path: m[0] })),
  ...[...text.matchAll(BARE_RE)].map((m) => ({ index: m.index, path: m[0] })),
];

// judge(raw, isJson) → the flagged forms with their lines; a JSON text is read through its decoded strings too.
const judge = (raw, isJson = false) => {
  const { text, lineOf } = normalize(raw);
  const hits = hitsIn(text).map((h) => ({ line: lineOf[h.index], path: h.path }));
  if (isJson) {
    let line = 1;
    let from = 0;
    for (const m of raw.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
      for (; from < m.index; from += 1) if (raw[from] === '\n') line += 1;
      hits.push(...hitsIn(JSON.parse(m[0]).replace(/\s+/g, ' ')).map((h) => ({ line, path: h.path })));
    }
  }
  const seen = new Set();
  return hits.filter((h) => !seen.has(`${h.line}\t${h.path}`) && seen.add(`${h.line}\t${h.path}`)).sort((a, b) => a.line - b.line);
};

const pack = (dir) => {
  // The npm cache rides under the temp dir and every network side-channel is off, so a sandboxed run stays green.
  const cache = mkdtempSync(join(tmpdir(), 'kit-texts-cache-'));
  const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', NO_UPDATE_NOTIFIER: '1' };
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', env });
  rmSync(cache, { recursive: true, force: true });
  assert.equal(res.status, 0, `npm pack failed in ${dir}: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  return (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).files.map((f) => f.path);
};
const textsOf = (paths) => paths.filter((p) => /\.(md|json)$/.test(p));

// The frozen exclusions: history alone.
const HISTORY = 'history: a release record states what shipped then';
const EXCLUSIONS = Object.freeze([
  { at: 'agent-workflow-kit/CHANGELOG.md', whole: true, reason: HISTORY, owner: 'the kit release history' },
  { at: 'agent-workflow-kit/migrations/', whole: true, reason: HISTORY, owner: 'the kit release history' },
  { at: 'agent-workflow-memory/CHANGELOG.md', whole: true, reason: HISTORY, owner: 'the memory release history' },
  { at: 'agent-workflow-memory/migrations/', whole: true, reason: HISTORY, owner: 'the memory release history' },
].map(Object.freeze));

const under = (x, file) => file === x.at || (x.at.endsWith('/') && file.startsWith(x.at));
const excused = (file, hit, exclusions = EXCLUSIONS) => exclusions.some((x) => under(x, file) && (x.whole === true || x.paths.includes(hit.path)));

// exclusionFaults(exclusions, packed, hitsByFile) → every way an exclusion is not earned by the current texts.
const exclusionFaults = (exclusions, packed, hitsByFile) => exclusions.flatMap((x) => {
  const faults = [];
  if (!packed.some((p) => under(x, p))) faults.push(`${x.at}: names no packed file or folder`);
  if (typeof x.reason !== 'string' || x.reason === '' || typeof x.owner !== 'string' || x.owner === '') faults.push(`${x.at}: carries no reason or no owner`);
  if ((x.whole === true) === Array.isArray(x.paths) || (Array.isArray(x.paths) && x.paths.length === 0)) faults.push(`${x.at}: names neither its paths nor its whole`);
  const hits = Object.entries(hitsByFile).filter(([file]) => under(x, file)).flatMap(([, h]) => h);
  if (x.whole === true && hits.length === 0) faults.push(`${x.at}: its whole excuses no current hit`);
  for (const path of x.paths ?? []) if (!hits.some((h) => h.path === path)) faults.push(`${x.at}: ${path} excuses no current hit`);
  return faults;
});

describe('spec:script-family/S12 every kit text names the kit folder and the stable command', () => {
  const FLAGGED = [
    ...PRIOR_FILES.map((name) => ['md', `scripts/${name}`]),
    ['md', 'see /scripts/check-docs-size.mjs'], ['md', './scripts/check-docs-size.mjs'], ['md', '../scripts/check-docs-size.mjs'],
    ['md', '<root>/scripts/check-docs-size.mjs'], ['md', '$ROOT/scripts/check-docs-size.mjs'], ['md', '[the checker](scripts/check-docs-size.mjs)'],
    ['md', '"scripts/check-docs-size.mjs"'], ['md', '\'scripts/check-docs-size.mjs\''], ['md', '`scripts/check-docs-size.mjs`'],
    ['md', 'scripts\\check-docs-size.mjs'], ['md', 'Run scripts/check-docs-size.mjs.'],
    ['md', '```sh\nnode scripts/check-docs-size.mjs --check-index\n```'], ['md', 'run it with node\n  scripts/check-docs-size.mjs --check-index'],
    ['json', '{ "cmd": "node scripts\\u002fcheck-docs-size.mjs" }'],
    ['md', 'node scripts/<x>.mjs'],
    ['md', 'scripts/agent-workflow/docs-size/check-docs-size.mjs'], ['md', 'scripts/agent-workflow/git-hooks/install-git-hooks.mjs'],
    ['md', 'scripts/agent-workflow/spec-schema.mjs'],
    ['md', 'node scripts/agent-workflow/run.mjs check-docs-size'], ['md', 'node scripts/agent-workflow/run.mjs\n  check-docs-size --check-index'],
    ['md', 'node scripts/run.mjs docs-size'], ['md', 'node check-docs-size.mjs --check-index'],
  ];
  for (const [kind, line] of FLAGGED) {
    it(`flags ${JSON.stringify(line)}`, () => {
      assert.notDeepEqual(judge(line, kind === 'json'), [], `${JSON.stringify(line)} must be flagged`);
    });
  }

  const SPARED = [
    ['md', 'agent-workflow-kit/references/scripts/docs-size/check-docs-size.mjs'], ['md', '<kit>/references/scripts/check-docs-size.mjs'],
    ['md', 'references/scripts/check-docs-size.mjs'], ['md', 'node ${CLAUDE_SKILL_DIR}/references/scripts/run.mjs check-docs-size'],
    ['md', 'scripts/my-check-docs-size.mjs'], ['md', 'scripts/check-docs-size.mjs.bak'], ['md', 'the `check-docs-size.mjs` checker'],
    ['md', 'node scripts/agent-workflow/run.mjs docs-size --check-index'], ['md', 'node scripts/agent-workflow/run.mjs <name> [arguments...]'],
    ['md', 'node scripts/agent-workflow/run.mjs --help'], ['md', 'node scripts/release/release-run.mjs publish'],
    ['md', 'the kit folder scripts/agent-workflow/'], ['md', 'scripts/agent-workflow/docs-size/'],
    ['md', 'scripts/agent-workflow/spec-schema/spec-schema.mjs'], ['md', 'scripts/agent-workflow/<path>'],
    ['json', '{ "path": "run.mjs", "role": "deployed", "seed": false }'],
  ];
  for (const [kind, line] of SPARED) {
    it(`spares ${JSON.stringify(line)}`, () => {
      assert.deepEqual(judge(line, kind === 'json'), [], `${JSON.stringify(line)} must be spared`);
    });
  }

  let packed;
  let hitsByFile;
  before(() => {
    packed = PACKAGES.flatMap((pkg) => pack(join(REPO, pkg)).map((p) => `${pkg}/${p}`));
    hitsByFile = Object.fromEntries([...textsOf(packed), 'README.md'].map((file) => [file, judge(readFileSync(join(REPO, file), 'utf8'), file.endsWith('.json'))]));
  });

  it('every kit text holds no flagged form outside the frozen exclusions', () => {
    assert.ok(Object.keys(hitsByFile).length > 100, `the kit texts were not read: ${Object.keys(hitsByFile).length}`);
    const unexcused = Object.entries(hitsByFile).flatMap(([file, hits]) => hits.filter((h) => !excused(file, h)).map((h) => `${file}:${h.line} ${h.path}`));
    assert.deepEqual(unexcused, [], `kit texts name the flat layout or a wrong command:\n${unexcused.join('\n')}`);
  });

  it('a Markdown file newly added to a packed folder is a kit text the guard judges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-texts-pkg-'));
    try {
      cpSync(join(REPO, 'agent-workflow-engine'), dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
      writeFileSync(join(dir, 'references', 'kit-texts-new.md'), 'Run node scripts/check-docs-size.mjs --check-index.\n');
      const texts = textsOf(pack(dir));
      assert.ok(texts.includes('references/kit-texts-new.md'), `the new file is not packed: ${texts.join(' ')}`);
      assert.deepEqual(judge(readFileSync(join(dir, 'references', 'kit-texts-new.md'), 'utf8')), [{ line: 1, path: 'scripts/check-docs-size.mjs' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('each exclusion names a packed file or folder, its reason and owner, and excuses a current hit with each path or its whole', () => {
    assert.deepEqual(exclusionFaults(EXCLUSIONS, packed, hitsByFile), []);
  });

  it('an exclusion that names no packed file, excuses no current hit, or lacks its reason or owner is a fault', () => {
    const fakePacked = ['agent-workflow-kit/a.md', 'agent-workflow-kit/m/b.md'];
    const fakeHits = { 'agent-workflow-kit/a.md': [{ line: 1, path: 'scripts/check-docs-size.mjs' }], 'agent-workflow-kit/m/b.md': [] };
    const faults = exclusionFaults([
      { at: 'agent-workflow-kit/gone.md', whole: true, reason: 'r', owner: 'o' },
      { at: 'agent-workflow-kit/m/', whole: true, reason: 'r', owner: 'o' },
      { at: 'agent-workflow-kit/a.md', paths: ['scripts/spec-schema.mjs'], reason: 'r', owner: 'o' },
      { at: 'agent-workflow-kit/a.md', whole: true, reason: '', owner: 'o' },
      { at: 'agent-workflow-kit/a.md', paths: ['scripts/check-docs-size.mjs'], reason: 'r', owner: 'o' },
    ], fakePacked, fakeHits);
    assert.deepEqual(faults, [
      'agent-workflow-kit/gone.md: names no packed file or folder',
      'agent-workflow-kit/gone.md: its whole excuses no current hit',
      'agent-workflow-kit/m/: its whole excuses no current hit',
      'agent-workflow-kit/a.md: scripts/spec-schema.mjs excuses no current hit',
      'agent-workflow-kit/a.md: carries no reason or no owner',
    ]);
  });
});
