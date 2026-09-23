// The one shared asserted-anchor region cut for the doc checks in test/. It declares NO test of its own; it
// sits in test/, outside files[], so it never ships; the `.test.mjs` name keeps it out of the changed-line
// coverage domain.

import assert from 'node:assert/strict';

// Region slice with asserted anchors (a renamed heading fails loudly, never matches nothing): from the
// first `from` to the first `to` after the end of `from`, or to the end of the text when `to` is omitted.
export const cutRegion = (text, from, to, where) => {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `${where}: missing region anchor "${from}"`);
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `${where}: missing region anchor "${to}"`);
  return text.slice(start, end);
};
