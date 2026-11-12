// Rotation conservation (spec rotation-conservation).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CARRY_REL = 'docs/ai/history/changelog.carry';

export const readCarry = (root) => {
  try {
    return readFileSync(resolve(root, CARRY_REL), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

export const renderCarry = (entries) => entries.map((entry) => entry.block).join('\n\n---\n\n');

export const unionEntries = (sources) => {
  const seen = new Set();
  const entries = [];
  const lastOnly = [];
  for (const [index, source] of sources.entries()) {
    for (const entry of source) {
      const identity = `${entry.dateStr}|${entry.title}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
      if (index === sources.length - 1) lastOnly.push(entry);
    }
  }
  return { entries, lastOnly };
};

export const trimmedLines = (section) => {
  const lines = [...section.lines];
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
};

export const sectionsToAppend = (archiveSections, sections, bare) => {
  const key = (section) => JSON.stringify(trimmedLines(bare(section)));
  const archived = new Set(archiveSections.map(key));
  return sections.filter((section) => !archived.has(key(section)));
};
