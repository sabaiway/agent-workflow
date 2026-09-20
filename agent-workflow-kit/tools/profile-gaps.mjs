import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES_REGIONS,
  extractRegionBy,
  readTemplateSpan,
  planInsert,
  frontmatterMaxLines,
  decodeUtf8Strict,
} from './rules-regions.mjs';

const GAP_ID = 'story-sessions-section';
const STORY_ID = 'story-sessions';
const TEMPLATE_CANON = 'template';
const ENCODING = 'utf8';
const MISSING_FILE_CODE = 'ENOENT';
const SINGLE_HEADING = 1;
const TARGET_PATH = 'docs/ai/agent_rules.md';
const TEMPLATE_PATH = fileURLToPath(new URL('../references/templates/agent_rules.md', import.meta.url));
const INSERT_PATH = fileURLToPath(new URL('./rules-insert.mjs', import.meta.url));
const COMMAND_PREFIX = 'node ';
const CWD_FLAG = ' --cwd ';
const VERDICTS = Object.freeze({
  present: 'present',
  absent: 'absent',
  undecidable: 'undecidable',
});
const REASONS = Object.freeze({
  template: 'template',
  fileAbsent: 'file-absent',
  fileSymlink: 'file-symlink',
  fileUnreadable: 'file-unreadable',
});
const TEMPLATE_REGIONS = RULES_REGIONS.filter(({ canon }) => canon === TEMPLATE_CANON);
const STORY_REGION = RULES_REGIONS.find(({ id }) => id === STORY_ID);

const reportUndecidable = (reason) => ({ verdict: VERDICTS.undecidable, reason });

const readSpans = (deps) => {
  try {
    const template = deps.readFileSync(TEMPLATE_PATH, ENCODING);
    const entries = TEMPLATE_REGIONS.map(({ id, headingRe }) => [
      id, readTemplateSpan(template, headingRe),
    ]);
    const spans = Object.fromEntries(entries);
    if (Object.values(spans).some(({ defect }) => defect)) {
      return reportUndecidable(REASONS.template);
    }
    return { spans };
  } catch {
    return reportUndecidable(REASONS.template);
  }
};

const readTarget = (root, deps) => {
  const target = resolve(root, TARGET_PATH);
  try {
    const stat = deps.lstatSync(target);
    if (stat.isSymbolicLink()) return reportUndecidable(REASONS.fileSymlink);
    if (!stat.isFile()) return reportUndecidable(REASONS.fileUnreadable);
  } catch (error) {
    const reason = error?.code === MISSING_FILE_CODE ? REASONS.fileAbsent : REASONS.fileUnreadable;
    return reportUndecidable(reason);
  }
  try {
    return { text: decodeUtf8Strict(deps.readFileSync(target)) };
  } catch {
    return reportUndecidable(REASONS.fileUnreadable);
  }
};

const detectStorySessions = ({ root, deps }) => {
  const template = readSpans(deps);
  if (template.verdict) return template;
  const target = readTarget(root, deps);
  if (target.verdict) return target;
  const { text } = target;
  if (extractRegionBy(text, STORY_REGION.headingRe).count === SINGLE_HEADING) {
    return { verdict: VERDICTS.present };
  }
  const result = planInsert({ text, spans: template.spans, cap: frontmatterMaxLines(text) });
  if (result.refusal) return reportUndecidable(result.refusal);
  return { verdict: VERDICTS.absent };
};

const buildInsertPreview = (root) => COMMAND_PREFIX + INSERT_PATH + CWD_FLAG + root;

export const PROFILE_GAPS = Object.freeze([
  Object.freeze({ id: GAP_ID, detect: detectStorySessions, apply: buildInsertPreview }),
]);
