### Mode: state-block-guard

The opt-in **closing-state-block detector**, wired as a Claude Code `Stop` hook. It ships as a
**self-contained** runtime at `references/hooks/state-block-guard.mjs` (no kit imports — a placed
copy keeps working if the kit is uninstalled) and it **writes nothing**: this mode is read-only, and
the wiring is yours to paste (see *No writer yet*, below).

**Read this first — what it is and is not.** A `Stop` hook runs when a turn has already ENDED, so it
**cannot un-send the message it judges**. This is **DETECTION, not prevention**. What it buys is
exactly one thing, and the thing is worth a release: a defect that previously depended on a human
re-reading every closing message becomes an immediate, visible warning. Any surface that describes
this as preventing the defect is describing it wrongly.

**What it detects.** Two shapes, both of which are not merely *discouraged* at Stop time but
**provably false** — which is what makes them mechanically judgeable at all:

- **The «what I need from you» slot answering "nothing".** A turn that ends is by definition idle, so
  a resume from the reader IS required; a slot saying otherwise states something untrue. Judged over
  the slot's **first clause only** — a slot that names a real ask and then, after a `;` or a full
  stop, adds «nothing else is needed» is honest and passes. A COMMA does not open a new clause, so
  the comma-joined version of that sentence is flagged; see the residuals. Hedged forms count: «not
  required», «your presence is not required right now», «nothing right now», «n/a».
- **Announce-and-stop.** The «what next» slot promising first-person imminent work («I take the
  class…», «I'll start…») while the turn ends. A promise **gated on something named** («after your
  yes — I publish», «once CI finishes…») states a dependency instead of a false start, and passes.

**A message with no recognisable block at all is SILENT by default.** This kit does not mandate the
three-part closing block — it is a per-project dialogue contract — so warning whenever a block is
absent would fire on nearly every turn of a project that never adopted it, and a hook that runs on
every single turn must not become that noise. Pass `--require-block` in the wiring to turn the
absent-block report on; the honest residual of the default is stated plainly below.

**What it does NOT judge.** Quoted material (`>` lines) and fenced code blocks are stripped before
anything is matched, and each slot label must start its own line. Otherwise a message that *discusses*
this contract — pasting the very specimen the guard catches — would be judged on the paste instead of
its own closing block. Labels are then grouped into whole blocks — never picked one slot at a time,
which would splice a stray trailing label onto an earlier block and judge a block nobody wrote. The
**last started** group decides: if the message ends mid-block, the turn did not end on a block at
all, and `--require-block` says so rather than falling back to an earlier one the turn had moved past.

**How it reports (the channel is part of the contract).** At exit 0 a `Stop` hook's **stderr goes to
the debug log and is seen by nobody**; the one user-visible lane is JSON on stdout carrying
`systemMessage`. The guard emits exactly that:

```json
{"systemMessage": "state-block-guard — the closing state block is defective (CONTINUATION-STALL):\n• …"}
```

The same channel carries FAILURES, under their own headline — reporting «the closing state block is
defective» when no block was ever read would blame the writer for the guard's own blindness.
«Exit 0 on every path» and «say nothing on every path» are different promises, and only the first is
kept: if the guard cannot see the turn — the payload will not parse, is not a JSON object, or
carries a `last_assistant_message` that is present but not a string — it is blind, and it says so
instead of going quiet. An ABSENT field is different: that is a host delivering nothing, and it stays
silent.

It **never** emits `decision`, `continue`, `stopReason`, or `hookSpecificOutput`, and it **exits 0 on
every path** — including every failure path. A hook that runs on every single turn must never become
the blocker or the noise. Blocking the stop would re-enter the model on a message the reader has
already seen, which is not what a detector is for; the payload does carry `stop_hook_active`, so a
future intervening variant has the loop guard it would need, but that variant is deliberately not
this one.

**Where it reads the closing message — one source, deliberately.** The `last_assistant_message` field
of the `Stop` payload, and nothing else. A `transcript_path` fallback was built and then **removed**:
the transcript file is written asynchronously, so a lagging one can END on the previous turn's
assistant entry with nothing after it, and no check on the file can tell that apart from the current
turn. A fallback that may be confidently wrong about WHICH TURN it read is worse than no fallback,
because being confidently wrong is the single failure a detector must not have.

The consequence is stated rather than hidden: **a host that does not deliver `last_assistant_message`
gets no detection at all**, silently — not a warning on every turn, which is what a host-shaped
condition would produce. An EMPTY delivered message is different: it is text, so a turn that ended
with no prose is judged as having no block, which `--require-block` will report.

**Language.** The slot labels and both banned sets carry Russian and English twins, because the
contract this enforces was written for a Russian-dialogue deployment. A deployment in another
dialogue language gets no detection until its labels are added — that is a real limit, not a
configuration you can set today.

**No writer yet — and why, plainly.** Every other placed thing in this kit arrives through a
consent-gated writer. This one does not, deliberately:

- extending the gate-approval writer (`tools/gate-hook.mjs`) would grow a second placement path
  through the family's **highest-blast-radius** component — the one that wires command
  auto-approval — for the benefit of a detector;
- a second dedicated writer would duplicate that writer's hardened placement discipline (symlink
  refusal, malformed-settings refusal, unknown-script refusal, merge-don't-clobber), which this
  project's own DRY rule forbids.

The wiring is eight lines of JSON, and hand-editing `settings.json` from a paste-ready block is the
form this family already sanctions. When the detector has earned a writer in real use, it gets one.

**Wiring it (paste-ready, two steps).**

1. Copy the runtime into your project (it is self-contained; the copy keeps working without the kit).
   **Check before you copy** — this is a plain copy, not a guarded writer, so the safety is yours:

   ```
   ls -ld .claude .claude/hooks
   ls -l .claude/hooks/state-block-guard.mjs
   ```

   Stop if `.claude` or `.claude/hooks` is a **symlink** (a copy would write through it to somewhere
   you did not choose), and stop if the target already exists — including a dangling symlink. Only
   then:

   ```
   mkdir -p .claude/hooks
   cp "${CLAUDE_SKILL_DIR}/references/hooks/state-block-guard.mjs" .claude/hooks/state-block-guard.mjs
   ```

   To UPDATE an existing copy, `diff` it against the bundled file first and replace it deliberately.
   No `cp` flag makes this safe for you: `-n` is not portable in the same way everywhere, and none of
   them refuse a symlinked parent directory.

2. Merge this into `.claude/settings.json` — **merge, do not clobber.** Three cases, and getting the
   third wrong silently disables someone else's hook:
   - no `hooks` key → add the whole object below;
   - a `hooks` key WITHOUT `Stop` (for example only the gate-approval `PreToolUse` entry) → add the
     `Stop` key beside it;
   - a `hooks.Stop` array that ALREADY EXISTS → **append one element to that array**, never replace
     it and never write a second `Stop` key. If `hooks.Stop` is present but is not an array, stop and
     fix that by hand first — pasting into it would destroy whatever is there.

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs\" --require-block",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

Drop `--require-block` if your project has not adopted the three-part closing block and you only want
the two lying-slot checks. `--require-block` is the **only** argument accepted: an unrecognised one
makes the guard refuse to judge the turn and say so, rather than quietly running in the weaker mode
you did not choose.

A `Stop` hook is read at session start, so it becomes live in the **next** session, not the current
one.

**Trust posture (state it plainly when asking consent):** the guard reads the closing assistant
message of each turn and writes one warning line. It runs a Node process on every turn end, it does
not read your repository, it makes no network call, and it can approve nothing — its blast radius is
the warning text. It is not a sandbox and not a permission control.

**Honest residuals:**

- **Detection, not prevention** — restated because it is the one thing that must not blur.
- **The judgement is LEXICAL, and that is a layer with limits, not a temporary weakness.** It matches
  slot labels and phrase sets on Unicode-aware word boundaries, so an honest «I need your
  confirmation» is not read as «not needed» and a marker inside a longer word is not read as a
  refusal. It cannot parse a sentence, and it cannot recognise a wording it has never been told
  about. Two rules that tried to close an edge here were **deleted rather than tightened a third
  time**, because each next version needed a second classifier — the residuals below are what
  replaced them. A named specimen of the cost: «confirm that nothing was missed» is a real ask
  and is FLAGGED, because the banned word sits inside it. Phrase the ask without the word.
- **A comma-joined qualifier is flagged.** «one yes, nothing else is needed» warns; the same
  sentence with a `;` or a full stop passes. The rule that tried to exempt the comma form kept
  letting a real "nothing" through behind a harmless prefix, so it was removed and the false flag is
  accepted instead. It costs one line and names its own fix.
- **A condition is bound to a promise by TOKEN ORDER inside one segment, which is an approximation.**
  «after your yes — I take the class» passes; «I take the class, and if the test fails I'll report» is flagged. Two
  known misreadings follow from the approximation, both accepted: an honest TRAILING gate («I take it,
  when you say so») is flagged, and a gate belonging to an earlier comma-clause («if the test fails,
  I'll report, and now I start») wrongly excuses the promise after it. Leading with the gate avoids the
  first; the second is a miss this layer cannot close without parsing.
- **The English side is weaker than the Russian side, structurally.** Russian promises are action
  verbs («I take», «I start»); the others are pronoun+modal («I'll», «I will»), which cannot tell
  starting from waiting. Waiting is explicitly excluded — «I'll wait for your approval» passes,
  because waiting is what a turn that ends actually does — but the exclusion is a list, and an
  unusual way of saying "I am waiting" will be flagged.
- **A host that does not deliver `last_assistant_message` gets no detection**, silently. There is no
  transcript fallback, on purpose — see above.
- **Without `--require-block`, a turn that drops the block entirely is not detected.** That is the
  cost of not warning every turn in projects that never adopted the block.
- **Removing the wiring silently removes the detector.** There is no rung that notices a hook that
  stopped being wired.
