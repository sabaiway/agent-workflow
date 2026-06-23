# Setting up Antigravity CLI (`agy`) on a clean machine

This setup is **secret-free**. `agy` itself is **not** bundled — it requires a binary install and a
one-time interactive sign-in with your own subscription. Do this once per machine, then the skill
works in any project.

## 1. Install the binary

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc / ~/.zshrc to persist
agy --version                          # expect 1.0.10 or newer
```

- The binary is **`agy`** (not `antigravity`); it installs to `~/.local/bin/agy`.
- Keep `$HOME/.local/bin` on `PATH` (the wrapper also prepends it defensively).

## 2. Sign in once (subscription only)

Run `agy` once interactively and complete the **OAuth** sign-in with a **Google AI Pro/Ultra**
account:

```bash
agy
```

This caches an OAuth token under `~/.gemini/antigravity-cli/` (`antigravity-oauth-token`). That token
is **personal** — never copy, commit, package, print, or share that directory or token. This skill
needs no API keys and must not be configured with API-key billing; the wrapper unsets every
`*_API_KEY` so billing can never silently fall back to pay-as-you-go.

## 3. Put the wrapper on `PATH` as `agy-run`

The skill ships the wrapper at `bin/agy.sh`. Expose it on `PATH` under the stable name `agy-run`
(idempotent; refuses to clobber a non-symlink):

```bash
mkdir -p "$HOME/.local/bin"
skill_dir="$HOME/.claude/skills/antigravity-cli-bridge"   # adjust if installed elsewhere
dst="$HOME/.local/bin/agy-run"
if [ -e "$dst" ] && [ ! -L "$dst" ]; then
  echo "STOP: $dst exists and is not a symlink"; exit 1
fi
chmod +x "$skill_dir/bin/agy.sh"
ln -sfn "$skill_dir/bin/agy.sh" "$dst"
export PATH="$HOME/.local/bin:$PATH"
command -v agy-run
```

## 4. Smoke test

```bash
agy --version
echo "say OK" | agy-run -
```

Expected: the version prints (`1.0.10` or newer), then a short reply containing `OK`. If `agy-run`
reports `'agy' not found`, fix your `PATH` (step 1). If it asks you to sign in, complete step 2.

## Notes

- `agy-run` is headless and plain-text only; there is no JSON output mode.
- `AGY_MODEL` selects the exact model display string; `AGY_TIMEOUT` controls `--print-timeout`.
- Extra `agy` flags go after `--`, e.g. `agy-run @prompt.md -- --add-dir .`.
- Re-run interactive `agy` only when the OAuth token expires or the account changes.
