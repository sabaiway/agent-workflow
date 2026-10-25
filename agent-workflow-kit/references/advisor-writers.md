# Advisor writers

`tools/write-lanes.mjs` is the one source of the advisor's variant set and lanes; each row below names a variant's lane and its writer — a harness or kit form's file, a chat apply's writers or writer mode — or `user step`.

| variant | lane | writer |
| --- | --- | --- |
| velocity-core | harness | velocity-profile.mjs |
| kit-tools-tier | harness | velocity-profile.mjs |
| bridge-tier | harness | velocity-profile.mjs |
| autonomy-policy | chat | set-autonomy |
| autonomy-render | harness | velocity-profile.mjs |
| sandbox-provision | user | user step |
| sandbox-provision.installable | user | user step |
| review-recipe | user | user step |
| gates-declaration | chat | gates-init.mjs |
| gates-inert | chat | gates-init.mjs |
| gates-inert.unfillable | user | user step |
| gates-inert.no-verification | chat | gates-init.mjs |
| gates-inert.producer-unrecognized | user | user step |
| gates-inert.coverage-domain-narrow | chat | ack-write.mjs |
| source-size | chat | source-size-check.mjs |
| source-size.unminted | chat | source-size-check.mjs |
| source-size.adopted-elsewhere | chat | ack-write.mjs |
| source-size.id-squatter | user | user step |
| source-size.schema-1 | chat | source-size-check.mjs |
| source-size.layout | chat | source-size-check.mjs |
| gate-hook | harness | gate-hook.mjs |
| gate-hook.marker-stale | harness | gate-hook.mjs |
| commit-guard | harness | git-hooks.mjs |
| hook-checks | harness | git-hooks.mjs |
| enforcement | harness | git-hooks.mjs |
| read-lane | chat | gate-hook.mjs |
| read-lane.stale | harness | gate-hook.mjs |
| read-lane.missing | harness | gate-hook.mjs |
| state-block | harness | state-block-hook.mjs |
| mcp-channel | harness | mcp.mjs |
| mcp-channel.differing | harness | mcp.mjs |
| agents | harness | cheap-agents.mjs |
| agents.not-current | kit | cheap-agents.mjs |
| executor-vehicle | harness | cheap-agents.mjs |
| attribution | harness | attribution.mjs |
| footprint-global | harness | hide-footprint.mjs |
| family-freshness | user | user step |
| sandbox-masks | chat | sandbox-masks.mjs |
| sandbox-masks.unfenced-mount | chat | sandbox-masks.mjs |
| worktrees-dir | harness | velocity-profile.mjs |
| worktrees-dir.home | user | user step |
| spec-adoption | chat | ensure-configs.mjs |
| profile-gap | chat | rules-insert.mjs, tier-preview.mjs, checker-gates.mjs |
| jev-connect | user | user step |
| jev-skill | harness | jev-skill.mjs |
| jev-skill.earlier | harness | jev-skill.mjs |
| spec-adoption.adopting | chat | ack-write.mjs |
