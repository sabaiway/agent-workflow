// family-members.mjs — the pure DATA LEAF: the one authoritative table of agent-workflow family members.
//
// Extracted from family-registry.mjs so the two consumers that only need the static table — the npx
// installer (bin/install.mjs, which derives its init-refresh cascade from it) and family-registry
// itself — can import the DATA without dragging in the whole status/presenter graph
// (detect-backends, the manifest validator, hide-footprint, engine-source, recipes, the renderers …).
// install.mjs runs on the npx cold-start hot path, so the leaner import matters; single-source-of-truth
// + the drift-guard (family-registry.test.mjs pins FAMILY_MEMBERS to the 5 in-repo capability.json)
// are preserved — the table just lives in a dependency-free leaf now.
//
// Pure data, no imports, no side effects, Node >= 18.

// ── the unified registry ───────────────────────────────────────────────────────
// One entry per family member. `installed` is the detect.installed spec (env + home-relative default
// + marker file); `deployed` is the project-relative stamp a deploy writes (kit + memory only);
// `npm` is the install package (null for the bridges, which are placed by `setup`, not npm);
// `wrapperCmds` is the deduped roles[].cmd set the `setup` linker creates on PATH (bridges only).
// Kept in lockstep with the 5 in-repo capability.json by the drift-guard test. The two release skills
// (release-engineering / release-marketing) are deliberately NOT here — they are not family members
// (AD-013): no capability.json, not in the kit tarball, not in the role vocabulary.
export const FAMILY_MEMBERS = [
  {
    name: 'agent-workflow-kit',
    kind: 'composition-root',
    installed: { env: 'AGENT_WORKFLOW_KIT_DIR', default: '~/.claude/skills/agent-workflow-kit', file: 'SKILL.md' },
    deployed: { file: 'docs/ai/.workflow-version' },
    npm: '@sabaiway/agent-workflow-kit',
    wrapperCmds: [],
  },
  {
    name: 'agent-workflow-memory',
    kind: 'memory-substrate',
    installed: { env: 'AGENT_WORKFLOW_MEMORY_DIR', default: '~/.claude/skills/agent-workflow-memory', file: 'SKILL.md' },
    deployed: { file: 'docs/ai/.memory-version' },
    npm: '@sabaiway/agent-workflow-memory',
    wrapperCmds: [],
  },
  {
    name: 'agent-workflow-engine',
    kind: 'methodology-engine',
    installed: { env: 'AGENT_WORKFLOW_ENGINE_DIR', default: '~/.claude/skills/agent-workflow-engine', file: 'SKILL.md' },
    deployed: null,
    npm: '@sabaiway/agent-workflow-engine',
    wrapperCmds: [],
  },
  {
    name: 'codex-cli-bridge',
    kind: 'execution-backend',
    installed: { env: 'CODEX_CLI_BRIDGE_DIR', default: '~/.claude/skills/codex-cli-bridge', file: 'SKILL.md' },
    deployed: null,
    npm: null,
    wrapperCmds: ['codex-exec', 'codex-review'],
  },
  {
    name: 'antigravity-cli-bridge',
    kind: 'execution-backend',
    installed: { env: 'ANTIGRAVITY_CLI_BRIDGE_DIR', default: '~/.claude/skills/antigravity-cli-bridge', file: 'SKILL.md' },
    deployed: null,
    npm: null,
    wrapperCmds: ['agy-run'],
  },
];

// A GLOBAL skill (lives under ~/.claude/skills) may be shared by other projects on the host — the
// uninstaller warns before removing one (there is no cross-project dependency tracking). All current
// members are global skills; the field is explicit so the warning is data-driven, not hardcoded.
export const isGlobalSkill = (member) => member.kind !== undefined; // every member is a global skill today
