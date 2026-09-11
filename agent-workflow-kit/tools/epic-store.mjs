import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describeNonRegular, readRegularFileNoFollow } from './fs-read-nofollow.mjs';

export const EPICS_REL = 'docs/ai/epics';
const MARKDOWN_SUFFIX = '.md';
const ABSENT_CODE = 'ENOENT';
const REGULAR_FILE = 'regular file';
const describeRead = (result) => result.code ?? result.className ?? result.outcome;
const refuseStore = (error) => ({ outcome: 'refused', reason: error?.code ?? error?.message ?? String(error) });

export const readEpicEntries = (root, read) => readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
  const name = entry.name;
  if (entry.isDirectory()) return { name, outcome: 'directory' };
  if (!name.endsWith(MARKDOWN_SUFFIX)) return { name, text: '' };
  const result = read(join(root, name));
  if (result.outcome === 'ok') return { name, text: result.content };
  if (result.outcome === 'foreign') return { name, outcome: 'non-regular', kind: result.className };
  return { name, outcome: 'unreadable', reason: describeRead(result) };
});

export const readEpicStore = (projectRoot, read = readRegularFileNoFollow) => {
  const root = join(projectRoot, EPICS_REL);
  const probe = (() => {
    try { return { stats: lstatSync(root) }; }
    catch (error) { return { result: error?.code === ABSENT_CODE ? { outcome: 'absent', entries: [] } : refuseStore(error) }; }
  })();
  if (probe.stats?.isDirectory()) {
    try { return { outcome: 'ok', entries: readEpicEntries(root, read) }; }
    catch (error) { return refuseStore(error); }
  }
  return probe.result ?? { outcome: 'refused', reason: probe.stats.isFile() ? REGULAR_FILE : describeNonRegular(probe.stats) };
};
