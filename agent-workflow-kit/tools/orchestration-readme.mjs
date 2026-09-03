export const normalizeCanonical = (value) => String(value).replace(/\r\n/gu, '\n').trim();

export const refreshIfCanonical = (current, knownPriorCanonicals, next) => {
  const normalized = normalizeCanonical(current);
  return knownPriorCanonicals.some((prior) => normalizeCanonical(prior) === normalized) ? next : current;
};

const V1_README =
  "Per-project orchestration config: the recipe used at each step (slot) of each named activity. Hand-edit this file — it is never written for you. Each activity is configured independently (e.g. plan-authoring, plan-execution), and so is each slot within it. A slot's value is a recipe: a 'review' slot accepts solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize); an 'execute' slot accepts solo | delegated (you implement / a backend runs a bounded sub-task). " +
  "The default below is 'solo' everywhere — no execution backend required. Raise a slot to reviewed or council for a second opinion, or to delegated to hand off execution; those need an execution backend set up first. Remove a slot's line to fall back to the computed default (reviewed when a review backend is ready, otherwise solo). Run the read-only procedures advisor to see an activity's steps plus the recipe resolved for your environment, and pass a per-run override to change one slot just once. Strict JSON — no comments.";

const V2_README =
  "Per-project orchestration config: the recipe used at each step (slot) of each named activity. Easiest: tell " +
  "the agent in plain language and run the `set-recipe` writer — it interprets your intent, previews the change, " +
  "and writes valid JSON for you. You can still hand-edit this file directly whenever you prefer; that option " +
  "never goes away. Each activity is configured independently (e.g. plan-authoring, plan-execution), and so is " +
  "each slot within it. A slot's value is a recipe: a 'review' slot accepts solo | reviewed | council (you " +
  "self-review / one backend reviews / both review and you synthesize); an 'execute' slot accepts solo | " +
  "delegated (you implement / a backend runs a bounded sub-task). The default below is 'solo' everywhere — no " +
  "execution backend required. Raise a slot to reviewed or council for a second opinion, or to delegated to hand " +
  "off execution; those need an execution backend set up first. Remove a slot's line (or run `set-recipe --unset " +
  "<activity>.<slot>`) to fall back to the computed default (reviewed when a review backend is ready, otherwise " +
  "solo). Run the read-only procedures advisor to see an activity's steps plus the recipe resolved for your " +
  "environment. Strict JSON — no comments.";

const V3_README =
  "Per-project orchestration config: the recipe used at each step (slot) of each named activity. " +
  "Easiest: tell the agent in plain language and run the `set-recipe` writer — it interprets your intent, " +
  "previews the change, and writes valid JSON for you. You can still hand-edit this file directly whenever you " +
  "prefer; that option never goes away. Three activities are configured independently, and so is each slot " +
  "within them: 'plan-authoring' (slots author, review), 'plan-execution' (slots execute, review) and " +
  "'routine' (slots carrier, parallel). A slot's value is a recipe: a 'review' slot accepts " +
  "solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize); an " +
  "'execute' slot accepts solo | delegated | subagent (you implement / a backend runs a bounded sub-task / a " +
  "full-tool frontier subagent carries a bounded slice you verify); the carrier slots 'plan-authoring.author' " +
  "and 'routine.carrier' accept solo | subagent. 'routine.parallel' is a flag rather than a recipe: it accepts " +
  "on | off and decides whether file-disjoint subagent slices dispatch concurrently. The default below is " +
  "'solo' for every recipe and carrier slot, and 'on' for the parallel switch — no execution backend required. " +
  "Raise a slot to reviewed or council for a second " +
  "opinion, or to delegated to hand off execution; those need an execution backend set up first. 'subagent' " +
  "needs the executor vehicle placed in this project — the composition root's `agents` writer places it; without " +
  "it the slot resolves to solo with the reason stated. Remove a slot's line, or a whole activity block (or " +
  "run `set-recipe --unset <activity>.<slot>`), to fall back to the computed default: reviewed when a review " +
  "backend is ready and otherwise solo for a review slot, solo for author, execute and carrier, on for " +
  "parallel. Run the read-only procedures advisor to see an activity's steps plus the recipe resolved for " +
  "your environment. Strict JSON — no comments.";

const ROSTER_README = V3_README.replace(
  "a 'review' slot accepts solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize)",
  "a 'review' slot accepts solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize), or an explicit roster array such as [\"codex-review\", \"agy-review\", \"review-lens\"] in hand-edit form",
);

const FOLD_README = ROSTER_README
  .replace("'plan-authoring' (slots author, review)", "'plan-authoring' (slots author, fold, review)")
  .replace("the carrier slots 'plan-authoring.author' and 'routine.carrier'", "the carrier slots 'plan-authoring.author', 'plan-authoring.fold' and 'routine.carrier'")
  .replace('solo for author, execute and carrier', 'solo for author, fold, execute and carrier');

const FOUR_README = FOLD_README.replace(
  "Three activities are configured independently, and so is each slot within them: 'plan-authoring' (slots author, fold, review), 'plan-execution' (slots execute, review) and 'routine' (slots carrier, parallel).",
  "Four activities are configured independently, and so is each slot within them: 'plan-authoring' (slots author, fold, review), 'plan-execution' (slots execute, review), 'routine' (slots carrier, parallel) and 'feedback-triage' (slot review).",
);

export const CANON_README = FOUR_README.replace(
  "The default below is 'solo' for every recipe and carrier slot, and 'on' for the parallel switch — no execution backend required.",
  "Every slot seeded below is 'solo' — no execution backend required. A slot the seed leaves silent takes the computed default stated further down: 'feedback-triage.review' is reviewed as soon as a review backend is ready (solo until then); 'plan-authoring.author', 'plan-authoring.fold' and 'routine.carrier' stay 'solo', and 'routine.parallel' stays 'on'.",
);

export const KNOWN_PRIOR_README = Object.freeze([V1_README, V2_README, V3_README, ROSTER_README, FOLD_README, FOUR_README]);

export const refreshReadme = (config) => {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) return { config, changed: false };
  const current = config._README;
  const readme = current === undefined
    ? CANON_README
    : refreshIfCanonical(current, KNOWN_PRIOR_README, CANON_README);
  if (readme === current) return { config, changed: false };
  const next = { _README: readme };
  for (const [key, value] of Object.entries(config)) if (key !== '_README') next[key] = value;
  return { config: next, changed: true };
};
