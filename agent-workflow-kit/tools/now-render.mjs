import { glyphsFor } from './presentation.mjs';
import { visibleLength } from './renderers.mjs';
import { foldQueue, isWithheld, judgeRow, derivePhase } from './now-status.mjs';

const BLOCK_TITLE = Object.freeze({ now: 'NOW', steps: 'STEPS', queue: 'QUEUE', campaign: 'CAMPAIGN' });
const STATUS_GLYPH = Object.freeze({
  landed: 'present',
  'in progress': 'note',
  pending: 'missing',
  unjudged: 'unknown',
});
const SGR = Object.freeze({ bold: '\x1b[1m', reset: '\x1b[0m' });

const getHeading = (title, color) => color ? `${SGR.bold}${title}${SGR.reset}` : title;
const getStepName = (step) => step?.row ? `${step.row.id} · ${step.row.path}` : step?.name ?? 'none';
const getRedProof = (tree, path) => isWithheld(tree) ? null : tree.redProofs.find((proof) => proof.path === path) ?? null;

const getPlanView = (plan, tree) => {
  if (!plan.parsed) return { path: plan.path, parseError: plan.parseError, phase: null, rows: [] };
  const rows = plan.rows.map(({ row, raw, evidence }) => judgeRow({ ...row, raw }, {
    ...evidence,
    redProof: getRedProof(tree, evidence.path),
  }));
  return { path: plan.path, parseError: plan.parseError, phase: derivePhase(plan.parsed, rows), rows };
};

const getPhaseMarker = (step) => step?.row
  ? { row: { id: step.row.id, path: step.row.path } }
  : step ? { name: step.name } : null;
const getPhaseView = (phase) => ({
  name: phase.name,
  current: getPhaseMarker(phase.current),
  next: getPhaseMarker(phase.next),
  inProgress: phase.inProgress,
});

const getPlanBlocks = (plans, tree) => {
  if (isWithheld(plans)) return { plans: plans, steps: plans };
  const entries = plans.entries.map((plan) => getPlanView(plan, tree));
  return {
    plans: { entries: entries.map(({ path, parseError, phase }) => ({ path, parseError, phase: phase ? getPhaseView(phase) : null })) },
    steps: { entries: entries.map(({ path, parseError, rows }) => ({ path, parseError, rows })) },
  };
};

export const toNowViewModel = (facts) => {
  const planBlocks = getPlanBlocks(facts.plans, facts.tree);
  const plans = isWithheld(planBlocks.plans) ? planBlocks.plans : planBlocks.plans.entries;
  const tree = isWithheld(facts.tree) ? facts.tree : { ...facts.tree };
  const now = isWithheld(plans) && isWithheld(tree)
    ? { withheld: [...new Set([plans.withheld, tree.withheld])].join(' \u00b7 ') }
    : { plans, tree };
  const queue = isWithheld(facts.queue)
    ? facts.queue
    : { path: facts.queue.path, ...foldQueue(facts.queue.rows) };
  return { now, steps: planBlocks.steps, queue, campaign: isWithheld(facts.campaign) ? facts.campaign : { ...facts.campaign } };
};

const getWithheldLines = (title, block, color) => [getHeading(title, color), `${title} — WITHHELD: ${block.withheld}`];
const getAnnotationText = (annotation) => annotation.kind === 'red-proof'
  ? `red-proof ${annotation.text}`
  : annotation.text;
const getStatusTail = (step) => {
  const detail = step.detail ? ` (${step.detail})` : '';
  const annotations = step.annotations.map((annotation) => ` (${getAnnotationText(annotation)})`).join('');
  return ` [${step.evidenceSource}]${detail}${annotations}`;
};

const renderNowBlock = (block, color, glyph) => {
  if (isWithheld(block)) return getWithheldLines(BLOCK_TITLE.now, block, color);
  const lines = [getHeading(BLOCK_TITLE.now, color)];
  if (isWithheld(block.plans)) lines.push(`  plans \u2014 WITHHELD: ${block.plans.withheld}`);
  else if (block.plans.length === 0) lines.push('  no plan in flight');
  for (const plan of isWithheld(block.plans) ? [] : block.plans) {
    lines.push(`  plan: ${plan.path}`);
    if (plan.parseError) {
      lines.push(`    ${glyph.unknown} could not parse: ${plan.parseError}`);
      continue;
    }
    lines.push(`    phase: ${plan.phase.name}`);
    lines.push(`    current: ${getStepName(plan.phase.current)}`);
    lines.push(`    next: ${getStepName(plan.phase.next)}`);
    for (const step of plan.phase.inProgress) lines.push(`    ${glyph.note} in progress: ${getStepName(step)} — ${step.status}${getStatusTail(step)}`);
  }
  const tree = block.tree;
  if (isWithheld(tree)) {
    lines.push(`  tree \u2014 WITHHELD: ${tree.withheld}`);
    return lines;
  }
  const clean = tree.clean === null ? 'unknown' : tree.clean ? 'clean' : 'changed';
  lines.push(`  tree: ${tree.fingerprint} · ${clean}`);
  for (const verdict of tree.verdicts) lines.push(`    ${glyph.note} ${verdict.line}`);
  lines.push(tree.finalRun
    ? `    final run: ${tree.finalRun.status} ${tree.finalRun.gates} gates · ${tree.finalRun.fingerprintBefore} · ${tree.finalRun.timestamp} · ${tree.finalRun.coverage}`
    : '    final run: none');
  for (const proof of tree.redProofs) lines.push(`    red-proof: ${proof.path} · ${proof.currency}`);
  return lines;
};

const renderStepsBlock = (block, color, glyph) => {
  if (isWithheld(block)) return getWithheldLines(BLOCK_TITLE.steps, block, color);
  const lines = [getHeading(BLOCK_TITLE.steps, color)];
  if (block.entries.length === 0) lines.push('  no steps — no plan in flight');
  for (const plan of block.entries) {
    lines.push(`  plan: ${plan.path}`);
    if (plan.parseError) {
      lines.push(`    WITHHELD: ${plan.parseError}`);
      continue;
    }
    for (const step of plan.rows) {
      lines.push(`    ${glyph[STATUS_GLYPH[step.status]]} ${getStepName(step)} — ${step.status}${getStatusTail(step)}`);
    }
  }
  return lines;
};

const renderQueueBlock = (block, color) => {
  if (isWithheld(block)) return getWithheldLines(BLOCK_TITLE.queue, block, color);
  const counts = Object.entries(block.counts).map(([klass, count]) => `${klass} ${count}`).join(' · ');
  const lines = [getHeading(BLOCK_TITLE.queue, color), `  ${block.path} · ${block.total} rows · ${counts}`];
  for (const bucket of block.buckets) {
    const domain = bucket.order === 'priority' ? 'priority' : 'archive';
    const bucketCounts = Object.entries(bucket.counts).map(([klass, count]) => `${klass} ${count}`).join(' · ');
    lines.push(`  ${domain} · ${bucket.label} · ${bucketCounts}`);
    for (const row of bucket.rows) lines.push(`  ${domain} · ${bucket.label} · ${bucket.order} ${row.position}: ${row.name} — ${row.klass}`);
  }
  return lines;
};

const getFigure = (value) => value === null || value === undefined ? 'not recorded' : String(value);
const renderCampaignBlock = (block, color) => {
  if (isWithheld(block)) return getWithheldLines(BLOCK_TITLE.campaign, block, color);
  const lines = [getHeading(BLOCK_TITLE.campaign, color), `  state: ${block.state}`];
  if (block.state !== 'absent') {
    lines.push(`  caps: ${block.maxLines} lines · ${block.maxLineBytes} bytes per line`);
    lines.push(`  roots: ${block.roots} · recorded files: ${getFigure(block.recordedFiles)} · aggregate lines: ${getFigure(block.aggregateLines)}`);
  }
  return lines;
};

const padLine = (line, width) => {
  const visible = visibleLength(line);
  return line === '' || visible >= width ? line : line + ' '.repeat(width - visible);
};

export const renderNow = (vm, surface = {}) => {
  if (surface.mode === 'json') return '';
  const color = surface.mode === 'ansi' && Boolean(surface.color);
  const glyph = glyphsFor(Boolean(surface.ascii));
  const lines = [
    ...renderNowBlock(vm.now, color, glyph),
    '',
    ...renderStepsBlock(vm.steps, color, glyph),
    '',
    ...renderQueueBlock(vm.queue, color),
    '',
    ...renderCampaignBlock(vm.campaign, color),
  ];
  return surface.mode === 'ansi'
    ? lines.map((line) => padLine(line, surface.width ?? 80)).join('\n')
    : lines.join('\n');
};
