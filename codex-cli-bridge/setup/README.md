# Setting up OpenAI Codex CLI (`codex`) on a clean machine

This setup is **secret-free**. `codex` itself is **not** bundled — it requires a binary install and a
one-time interactive sign-in with your own ChatGPT subscription. Do this once per machine, then the
skill works in any git repository that has a root `AGENTS.md`.

## 1. Install the binary

Install the official OpenAI Codex CLI using the current official channel for your platform, then
confirm it is on `PATH`:

```bash
npm install -g @openai/codex     # or: brew install codex  (use the current official channel)
codex --version                  # this skill was verified with codex-cli 0.142.3 or newer
```

The binary is **`codex`**. If `codex --version` works but the wrappers can't find it, fix your
`PATH`. If the installed binary's help disagrees with this skill's references, the live binary wins.

## 2. Sign in once (subscription only)

Run `codex login` once and complete the **ChatGPT** sign-in:

```bash
codex login
codex login status               # expect: Logged in using ChatGPT
```

This caches credentials under `CODEX_HOME` (`~/.codex`, e.g. `~/.codex/auth.json`). That directory is
**personal** — never copy, commit, package, print, or share it. This skill needs **no API keys** and
must not be configured with api-key billing; both wrappers unset every `*_API_KEY` (and
`OPENAI_BASE_URL`) and pass `--ignore-user-config`, so billing can never silently fall back to
pay-as-you-go and a personal `~/.codex/config.toml` can never change behaviour.

## 3. Put the wrappers on `PATH`

The skill ships two wrappers: `bin/codex-exec.sh` and `bin/codex-review.sh`. Expose them on `PATH`
under the stable names `codex-exec` / `codex-review` via idempotent managed symlinks (refuse to
clobber a non-symlink):

```bash
mkdir -p "$HOME/.local/bin"
skill_dir="$HOME/.claude/skills/codex-cli-bridge"   # adjust if installed elsewhere
for w in codex-exec codex-review; do
  src="$skill_dir/bin/$w.sh"
  dst="$HOME/.local/bin/$w"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "STOP: $dst exists and is not a symlink"; exit 1
  fi
  chmod +x "$src"
  ln -sfn "$src" "$dst"
done
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc / ~/.zshrc to persist
command -v codex-exec && command -v codex-review
```

## 4. Smoke test

```bash
codex --version                                          # version prints
env -u OPENAI_API_KEY -u CODEX_API_KEY -u OPENAI_BASE_URL codex login status
```

Expected: the version prints, and login status includes exactly `Logged in using ChatGPT` (the
`env -u …` mirrors the wrappers, so stray keys can't mask the real auth mode). If the status does not
include that text, redo step 2. If a wrapper reports `'codex' not found`, fix your `PATH` (step 1);
if it reports a missing git work tree or root `AGENTS.md`, run it from a project root that has them.

## Notes

- The wrappers are **subscription-only** by design and will not use api-key billing.
- `codex-exec` runs a **workspace-write** sandbox with **network OFF**; `codex-review` runs
  **read-only**. They also pin the frontier model/effort (refusing a downgrade), enforce a hard
  timeout, capture only codex's final message, and block codex from writing git via a shim — see
  [`../references/sandbox-and-flags.md`](../references/sandbox-and-flags.md) and the knob table in
  [`../SKILL.md`](../SKILL.md#environment-knobs). No setup is needed to enable these — they are on by
  default.
- `codex exec` requires a git repository, and the wrappers also require a root `AGENTS.md`. The
  orchestrator commits, not codex. Re-run `codex login` only when the cached login expires or the
  account changes.
- On Linux, install `bubblewrap` (`sudo apt install bubblewrap` or equivalent) to silence the
  "could not find bubblewrap" warning; codex otherwise uses a bundled copy.
