---
type: rules
lastUpdated: 2026-10-28
scope: permanent
staleAfter: never
owner: kit
maxLines: 40
---

# Communication

The kit block of AGENTS.md is the kit's and is rewritten on every upgrade; it and docs/ai/rules/effective/ govern over any copy of kit text elsewhere in this project's files; text of your own goes outside the block, and a change to a kit rule goes in its theme's file under docs/ai/rules/local/.

- **Plain language.** User-facing narration is short, clear, plain words of the dialogue language; when the dialogue language is not English, transliterated English jargon is banned — an English term survives only as the NAME of a thing (a flag / command / file / test), glossed in plain words when helpful; plain English stays plain for English-dialogue users.
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.
- **The closing state block answers three DIFFERENT questions.** Close a user-facing message with three labelled slots — *now* · *what I need from you* · *what's next*. The slot LABELS stay ENGLISH — an English label is what lets a state-block checker FIND the block and its slots at all; everything written INTO a slot is in the project's dialogue language; when that language is not English, the checker's English phrase sets do not judge those values. **Now** = the state at this instant: what is RUNNING, or what the work is stopped on. It is **never a report of finished work** — what you completed goes in the message BODY, above the block. **From you** = the real unblocker, named; a turn that is ENDING always has one. **Next** = what follows. A *now* slot that opens with what was completed buries the one fact the reader opened the message for, and the three slots collapse into one restatement.
- **A skip that contradicts the tree is a finding.** A tool-composed `skipped-*` line whose stated reason the observed tree disproves (a "no Node" skip beside deployed Node scripts) is raised as a FINDING in the report, never pasted as a neutral outcome — and a tool may not emit a skip whose reason it could itself disprove.
- **Two blocks for the user.** At a plan's approval, at a release and at every session close, the message BODY — above the closing state block — carries two short blocks in the dialogue language. *What was done, and for what*: per item the user-facing problem, then what now exists; a command name is allowed, an internal id is not. *What is next, and why*: each proposal names its benefit, plus the one hand step if any. No internal ids, no review-round tallies. The same two blocks are the handover's `## For the user` section, which the kit's `session-close-check` checker judges at the close, where the kit is installed.
