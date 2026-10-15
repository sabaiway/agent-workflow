### Mode: state-block-guard

<!-- opt-in-capability: state-block -->

The opt-in **closing-state-block detector**, wired as a Claude Code `Stop` hook. It ships as a
**self-contained** runtime at `references/hooks/state-block-guard.mjs` (no kit imports — a placed
copy keeps working if the kit is uninstalled) and the runtime itself **writes nothing**. Its writer is
`tools/state-block-hook.mjs`: it places the runtime and wires the `Stop` entry running
`node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs"` (see *The writer*, below).

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

**Language — one vocabulary, English, and no list of others.** The slot labels and every phrase set
are English. The kit enumerates no second language: a shipped language list is a guess about somebody
else's dialogue, and it never stops growing. A deployment whose dialogue language is not English
extends the arrays **in its own placed copy** — the runtime is copied into the project and
self-contained, so that edit is local and survives an uninstalled kit. Until it is made, such a
deployment gets **no detection**, silently. That is a real limit, stated rather than hidden, and it is
not a configuration you can set today.

**The writer — `tools/state-block-hook.mjs`.** The `state-block` advisor item is a harness item:
the agent applies it on the chat yes after the danger check, and `init`, run in a console from the
project's folder, applies it on the terminal y as the route the user may take instead. Without
`--apply` the writer is a preview that writes nothing; `--apply` writes. It imports the gate-approval
writer's symlink, target and settings-shape checks from `tools/gate-hook.mjs`; its unsafe-mode and
stamp refusals use that writer's error codes:

- the runtime goes to `.claude/hooks/state-block-guard.mjs` — created when absent, kept when
  byte-equal, replaced in place when it differs (the preview says so, and the check's result names
  the replaced bytes' digest beside the new one);
- the `Stop` entry is merged into `.claude/settings.json` by the three cases — no `hooks` key: the
  whole object below is added; a `hooks` key without `Stop`: the `Stop` key is added beside it; a
  `hooks.Stop` array: one element is appended, every foreign entry kept. A `hooks.Stop` that is
  present and not an array is a refusal with nothing written;
- the entry is merged only while no `Stop` entry of either settings file runs the runtime, so a
  wiring you made yourself (another path, `--require-block`) counts and is never duplicated;
- a symlinked `.claude`, `.claude/hooks`, target or settings file, malformed settings and an unsafe
  permission mode each refuse with nothing written; a deployment stamp behind the kit refuses
  `--apply` (the preview still answers and notes it); the runtime is written through gate-hook's
  `writeHookFile` (an exclusive create, a no-follow replace), so a runtime file swapped for a symlink
  before the write refuses with nothing written through it, and where Node exposes no no-follow open flag
  (native Windows) a replace refuses; the placed file is re-read, no-follow, before the settings write.

The entry it writes:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**The writer offers that command without `--require-block`; add it to the command in your
`.claude/settings.json` IF your project requires the three-part block on every message** — then a
turn that drops the block entirely is reported too. It is left OFF on purpose: this kit does not mandate the block, so switching it on for a project that never adopted it
would warn after nearly every turn. `--require-block` is the **only** argument accepted: an
unrecognised one makes the guard refuse to judge the turn and say so, rather than quietly running in
the weaker mode you did not choose.

Claude Code reloads its settings files when they change, so a wired `Stop` hook runs from the next
turn end — no session restart needed.

**Trust posture (state it plainly when asking consent):** the guard reads the closing assistant
message of each turn and writes one warning line. It runs a Node process on every turn end, it does
not read your repository, it makes no network call, and it can approve nothing — its blast radius is
the warning text. It is not a sandbox and not a permission control.

**Honest residuals:**

- **Detection, not prevention** — restated because it is the one thing that must not blur.
- **The judgement is LEXICAL, and that is a layer with limits, not a temporary weakness.** It matches
  slot labels and phrase sets on **Unicode-aware** word boundaries — the markers are English but the
  message is the project's dialogue language, which need not be ASCII, and JavaScript's `\b` would
  read every non-ASCII letter as a word break and match a marker sitting inside a longer word. On the
  English side the same class is what stops «none» matching inside «nonexistent». It cannot parse a
  sentence, and it cannot recognise a wording it has never been told about. Two rules that tried to
  close an edge here were **deleted rather than tightened a third time**, because each next version
  needed a second classifier — the residuals below are what replaced them. A named specimen of the
  cost: «confirm that nothing was missed» is a real ask and is FLAGGED, because the banned word sits
  inside it. Phrase the ask without the word.
- **A comma-joined qualifier is flagged.** «one yes, nothing else is needed» warns; the same sentence
  with a `;` or a full stop passes. The rule that tried to exempt the comma form kept letting a real
  "nothing" through behind a harmless prefix, so it was removed and the false flag is accepted
  instead. It costs one line and names its own fix.
- **A condition is bound to a promise by TOKEN ORDER inside one segment, which is an approximation.**
  «after your yes — I take the class» passes; «I take the class, and if the test fails I'll report»
  is flagged. Two known misreadings follow from the approximation, both accepted: an honest TRAILING
  gate («I take it when you say so») is flagged, and a gate belonging to an earlier comma-clause («if
  the test fails I'll report, and now I start the next class») wrongly excuses the promise after it.
  Leading with the gate avoids the first; the second is a miss this layer cannot close without
  parsing.
- **The promise markers are a MIXED set, and each half misses differently.** Some are pronoun+modal
  («I'll», «I will», «I'm going to»), which name no verb of their own and so cannot tell starting
  from waiting; waiting is therefore excluded by an explicit list — «I'll wait for your approval»
  passes, because waiting is what a turn that ends actually does — and an unusual way of saying "I am
  waiting" is flagged. The others are pronoun+verb («I take», «I start», «I begin», «I move on»),
  which name the action but only in the exact wording listed: a synonym nobody wrote down is missed
  entirely, and a stative use of a listed verb («I take that as settled») is a false flag.
- **A host that does not deliver `last_assistant_message` gets no detection**, silently. There is no
  transcript fallback, on purpose — see above.
- **Without `--require-block`, a turn that drops the block entirely is not detected.** That is the
  cost of not warning every turn in projects that never adopted the block.
- **Removing the wiring silently removes the detector.** There is no rung that notices a hook that
  stopped being wired.
