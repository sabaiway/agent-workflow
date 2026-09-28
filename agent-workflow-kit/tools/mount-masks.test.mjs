// mount-masks.test.mjs — the mount-table judge of the sandbox-masks lane (spec kit/review-domain/sandbox-masks,
// S5-S10, S15, S20, S21). Every table is synthetic text over a real temporary work tree: the judge reads
// only the text it is given, and the root it is given is resolved to its realpath first.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LIBRARY_ONLY_MODULES } from './direct-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAF = join(HERE, 'mount-masks.mjs');
// Imported dynamically: the red-first proof loads this suite on a tree where the leaf does not exist yet.
const leaf = await import('./mount-masks.mjs').catch(() => ({}));
const foreignMountTargets = leaf.foreignMountTargets ?? (() => { throw new Error('mount-masks.mjs is absent'); });

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'mount-masks-')));
after(() => rmSync(TMP, { recursive: true, force: true }));
const R = join(TMP, 'repo');
mkdirSync(R);

const BS = String.fromCharCode(92); // one backslash, spelled out so no editor decodes an escape
const MALFORMED = /malformed mountinfo/;
// One mountinfo line: mount id, parent id, major:minor, root, mount point, options, -, fstype, source, super options.
const line = (id, parent, dev, root, point) => `${id} ${parent} ${dev} ${root} ${point} rw,relatime - ext4 /dev/sda rw`;
const table = (...lines) => `${lines.join('\n')}\n`;
// The base every case sits on: the root mount (its parent unlisted) and the work tree bound from /wt of 8:2.
const BASE = [line(1, 0, '8:1', '/', '/'), line(2, 1, '8:2', '/wt', R)];
const answer = (text, root = R) => [...foreignMountTargets(root, text)].sort();
const judge = (...lines) => answer(table(...BASE, ...lines));
const FOREIGN = (id, parent, rel) => line(id, parent, '0:40', '/tmp/empty', `${R}/${rel}`);
const SELF = (id, parent, rel) => line(id, parent, '8:2', `/wt/${rel}`, `${R}/${rel}`);

describe('mount-masks — the parser (spec:sandbox-masks/S5)', () => {
  it('splits on single spaces: an empty source field and optional fields are fields', () => {
    const got = judge(
      `3 2 0:40 /tmp/empty ${R}/.bashrc rw - tmpfs  rw`,
      `4 2 0:41 /tmp/empty ${R}/.zshrc rw shared:5 master:1 - tmpfs tmpfs rw`,
      `5 2 0:42 /tmp/empty ${R}/.profile rw - tmpfs `,
      `6 2 0:43 /tmp/empty ${R}/.gitconfig  - tmpfs none rw`,
    );
    assert.deepEqual(got, ['.bashrc', '.gitconfig', '.profile', '.zshrc'], 'an empty options field still makes six before -');
  });

  it('ignores the empty tail after the last newline and everything after the source', () => {
    const lines = [...BASE, `3 2 0:40 /tmp/empty ${R}/.bashrc rw - tmpfs none rw,x${BS}q extra ${BS}fields`];
    assert.deepEqual(answer(table(...lines)), ['.bashrc'], 'the trailing newline leaves no line behind');
    assert.deepEqual(answer(lines.join('\n')), ['.bashrc'], 'a table without the trailing newline reads the same');
  });

  it('decodes the four octal escapes in the mount point and in the root', () => {
    const got = judge(
      FOREIGN(3, 2, `a${BS}040b`),
      FOREIGN(4, 2, `t${BS}011x`),
      FOREIGN(5, 2, `n${BS}012x`),
      FOREIGN(6, 2, `s${BS}134x`),
      SELF(7, 2, `c${BS}040d`),
    );
    assert.deepEqual(got, ['a b', 'n\nx', `s${BS}x`, 't\tx'], 'a self bind whose root carries an escape stays self once both sides decode');
  });

  it('finds the visible entry of a stack by parent ids, whatever the list order', () => {
    const lines = [...BASE, FOREIGN(3, 2, '.zshrc'), SELF(4, 3, '.zshrc'), SELF(5, 2, '.bashrc'), FOREIGN(6, 5, '.bashrc')];
    assert.deepEqual(answer(table(...lines)), ['.bashrc'], 'listed order: the top of each stack is judged');
    assert.deepEqual(answer(table(...lines.reverse())), ['.bashrc'], 'reversed order: the same tops');
  });
});

describe('mount-masks — an unknown backslash sequence (spec:sandbox-masks/S6)', () => {
  it('a mount point or a root carrying any backslash sequence but the four escapes is malformed', () => {
    assert.throws(() => judge(FOREIGN(3, 2, `x${BS}041y`)), MALFORMED, 'an unknown octal escape in the mount point');
    assert.throws(() => judge(line(3, 2, '0:40', `/tmp/e${BS}xmpty`, `${R}/.bashrc`)), MALFORMED, 'a non-octal sequence in the root');
    assert.throws(() => judge(FOREIGN(3, 2, `trail${BS}`)), MALFORMED, 'a lone backslash ending the mount point');
    assert.throws(() => judge(FOREIGN(3, 2, `x${BS}04`)), MALFORMED, 'a short octal escape');
  });
});

describe('mount-masks — a line with no - field (spec:sandbox-masks/S7)', () => {
  it('a line whose fields hold no bare - is malformed, a blank line inside the table included', () => {
    assert.throws(() => judge(`3 2 0:40 /tmp/empty ${R}/.bashrc rw tmpfs none rw`), MALFORMED, 'no - field at all');
    assert.throws(() => judge(`3 2 0:40 /tmp/empty ${R}/.bashrc rw,- tmpfs none rw`), MALFORMED, 'a - inside another field is not the field');
    assert.throws(() => answer(`${BASE[0]}\n\n${BASE[1]}\n`), MALFORMED, 'a blank line is a line');
  });
});

describe('mount-masks — too few fields around the - field (spec:sandbox-masks/S8)', () => {
  it('fewer than six fields before the - field, or fewer than two after it, is malformed; six and two are enough', () => {
    assert.throws(() => judge(`3 2 0:40 ${R}/.bashrc rw - tmpfs none rw`), MALFORMED, 'five fields before -');
    assert.throws(() => judge(`3 2 0:40 /tmp/empty ${R}/.bashrc rw - tmpfs`), MALFORMED, 'one field after -');
    assert.throws(() => judge(`3 2 0:40 /tmp/empty ${R}/.bashrc rw -`), MALFORMED, 'no field after -');
    assert.deepEqual(judge(`3 2 0:40 /tmp/empty ${R}/.bashrc rw - tmpfs none`), ['.bashrc'], 'exactly six before and two after');
  });
});

describe('mount-masks — only an exact mount target counts (spec:sandbox-masks/S9)', () => {
  it('a path under a foreign directory bind is not itself a target and is never answered', () => {
    const got = judge(line(3, 2, '0:40', '/elsewhere/d', `${R}/d`));
    assert.deepEqual(got, ['d']);
    assert.ok(!got.includes('d/f'), 'd/f is left to lstat alone');
  });
});

describe('mount-masks — the root and the answered paths (spec:sandbox-masks/S10)', () => {
  it('a symlinked root is judged at its realpath', () => {
    const link = join(TMP, 'link');
    symlinkSync(R, link);
    assert.deepEqual(answer(table(...BASE, FOREIGN(3, 2, '.bashrc')), link), ['.bashrc']);
  });

  it('a target at the root, outside it or beside it under a shared prefix is never answered', () => {
    const got = judge(
      line(3, 1, '0:40', '/tmp/empty', join(TMP, 'other', '.bashrc')),
      line(4, 1, '0:40', '/tmp/empty', `${R}-sib/.bashrc`),
      FOREIGN(5, 2, 'kept'),
    );
    assert.deepEqual(got, ['kept'], 'only a target strictly below the root');
    assert.deepEqual(answer(table(line(1, 0, '8:1', '/', '/'), line(2, 1, '0:50', '/x', R))), [], 'a foreign mount AT the root is not a path of the tree');
  });

  it('answered paths are relative to the root and joined with /', () => {
    assert.deepEqual(judge(line(3, 2, '8:2', '/wt/a', `${R}/a`), FOREIGN(4, 3, 'a/b')), ['a/b']);
  });
});

describe('mount-masks — the leaf is library-only (spec:sandbox-masks/S15)', () => {
  it('a direct run prints nothing and exits 0: no import effect and no direct-run dispatch', () => {
    const run = spawnSync(process.execPath, [LEAF], { encoding: 'utf8' });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', '']);
    assert.ok(!('mount-masks.mjs' in LIBRARY_ONLY_MODULES), 'no mode doc names the leaf, so the registry leaves it out');
  });

  it('it exports the one judge and imports only node: builtins, so no writer is in its closure', () => {
    assert.deepEqual(Object.keys(leaf), ['foreignMountTargets']);
    const specifiers = [...readFileSync(LEAF, 'utf8').matchAll(/(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(specifiers.length > 0 && specifiers.every((s) => s.startsWith('node:')), `imports: ${specifiers.join(', ')}`);
  });

  it('the package ships it: tools/ is in files and no negation strips a non-test module', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.ok(existsSync(LEAF) && pkg.files.includes('tools/'));
    assert.deepEqual(pkg.files.filter((f) => f.startsWith('!tools/')), ['!tools/**/*.test.mjs', '!tools/manifest/fixtures/**']);
  });
});

describe('mount-masks — a self bind only the translation proves (spec:sandbox-masks/S20)', () => {
  it('the tree filesystem mounted at an ancestor with root /: a bind of its own path is self', () => {
    const got = answer(table(
      line(1, 0, '8:1', '/', '/'),
      line(2, 1, '8:2', '/', TMP),
      line(3, 2, '8:2', '/repo/.mcp.json', `${R}/.mcp.json`),
      line(4, 2, '8:2', '/repo/elsewhere', `${R}/.bashrc`),
      line(5, 2, '0:40', '/repo/.idea', `${R}/.idea`),
    ));
    assert.deepEqual(got, ['.bashrc', '.idea'], 'same device and another path, or the translated path on another device: foreign');
  });

  it('a source directory mounted elsewhere, the tree bound from it: a bind of the translated path is self', () => {
    const got = answer(table(
      line(1, 0, '8:1', '/', '/'),
      line(5, 1, '8:2', '/src', join(TMP, 'src-view')),
      line(2, 1, '8:2', '/src/tree', R),
      line(3, 2, '8:2', '/src/tree/.mcp.json', `${R}/.mcp.json`),
      line(4, 2, '8:2', '/src/other', `${R}/.bashrc`),
    ));
    assert.deepEqual(got, ['.bashrc']);
  });
});

describe('mount-masks — the stack cases (spec:sandbox-masks/S21)', () => {
  it('a mask bound twice at one path stays foreign, and a mask over a self bind is foreign', () => {
    assert.deepEqual(judge(FOREIGN(3, 2, '.bashrc'), FOREIGN(4, 3, '.bashrc')), ['.bashrc']);
    assert.deepEqual(judge(SELF(3, 2, '.zshrc'), FOREIGN(4, 3, '.zshrc')), ['.zshrc']);
  });

  it('a recursive bind second copy is a hidden layer: the path is judged by its visible copy', () => {
    const copy = line(8, 1, '8:3', '/', '/mnt/copy');
    assert.deepEqual(judge(copy, SELF(5, 2, '.idea'), FOREIGN(9, 8, '.idea')), [], 'visible self, hidden foreign copy');
    assert.deepEqual(judge(copy, FOREIGN(5, 2, '.idea'), SELF(9, 8, '.idea')), ['.idea'], 'visible foreign, hidden self copy');
  });

  it('a foreign file mount covered by a later bind of its directory leaves only hidden entries', () => {
    assert.deepEqual(judge(FOREIGN(3, 2, 'd/f'), SELF(4, 2, 'd')), []);
  });

  it('a mount stacked at / is the visible /, and the mounts on the covered root are hidden layers', () => {
    const got = answer(table(
      line(1, 0, '8:1', '/', '/'),
      line(11, 1, '8:9', '/', '/'),
      line(2, 1, '8:2', '/wt', R),
      FOREIGN(3, 2, '.bashrc'),
      FOREIGN(12, 11, '.zshrc'),
    ));
    assert.deepEqual(got, ['.zshrc']);
  });

  it('a root mount whose parent is unlisted or itself refuses nothing', () => {
    assert.deepEqual(judge(FOREIGN(3, 2, '.bashrc')), ['.bashrc'], 'unlisted parent');
    assert.deepEqual(answer(table(line(1, 1, '8:1', '/', '/'), BASE[1], FOREIGN(3, 2, '.bashrc'))), ['.bashrc'], 'self-parented');
  });

  it('a parent id a walk needs and the table lacks is malformed', () => {
    assert.throws(() => judge(FOREIGN(3, 99, '.bashrc')), MALFORMED);
  });

  it('two tops over the same H are malformed, at / over the root mount too', () => {
    assert.throws(() => judge(FOREIGN(3, 2, '.bashrc'), line(4, 2, '0:41', '/tmp/empty', `${R}/.bashrc`)), MALFORMED);
    assert.throws(() => answer(table(...BASE, line(11, 1, '8:9', '/', '/'), line(12, 1, '8:10', '/', '/'))), MALFORMED);
  });

  it('no root mount, or several, is malformed', () => {
    assert.throws(() => answer(table(line(1, 2, '8:1', '/', '/'), BASE[1])), MALFORMED, 'the only entry at / has a listed parent');
    assert.throws(() => answer(table(...BASE, line(5, 6, '8:5', '/', '/'))), MALFORMED, 'two entries at / with unlisted parents');
    assert.throws(() => answer(''), MALFORMED, 'an empty table');
  });
});
