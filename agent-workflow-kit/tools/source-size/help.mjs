export const helpText = ({ SOURCE_SIZE_CONFIG_REL, SOURCE_SIZE_SCHEMA, KIT_FOLDER_ROOT }) => `source-size-check — the declared source-size practice (agent-workflow family).

Usage:
  node source-size-check.mjs --check [--cwd <project-root>]
  node source-size-check.mjs --write-baseline [--layout] [--reason "<text>"] [--cwd <project-root>]
  node source-size-check.mjs --adopt [--reason "<text>"] [--cwd <project-root>]
  node source-size-check.mjs --override <id> [--value <n>] [--tolerance <p>] --reason "<text>" [--cwd <project-root>]
  node source-size-check.mjs --override <id> --kit-default --reason "<text>" [--cwd <project-root>]

Judges every in-scope file against ${SOURCE_SIZE_CONFIG_REL} (schema ${SOURCE_SIZE_SCHEMA}): git-tracked files
under a declared root carrying a declared extension, minus the excluded path-segment prefixes and
the kit's own folder ${KIT_FOLDER_ROOT}, which nothing here judges and no root may declare. An
absent "roots" is the one root ".", every tracked path; a config declaring no extension judges no
file, and every check says so. With the config absent the check judges layout alone under the
kit's values. Symlinks and submodule gitlinks are skipped by kind; an unmerged index, a non-UTF-8
in-scope path, an unverifiable in-scope file and an empty declared scope are refusals.

Limits: the kit's own five, kept in its code, each with a tolerance; the config holds only a
project's reasoned overrides under "limits". A value at or under its limit is clean, above it within
the band ceil(value x tolerance / 100) a WARNING printed on every run (exit 0), and beyond the band a
stop unless a record holds it. Every --check, --write-baseline and --override run that resolves the
config and ends in no usage, config, enumeration or scope error states all five limits with value,
tolerance and source, then what it does not judge, then its warnings, then its stops; a --check that
stops opens instead with its verdict line, its findings and its remedy, its limits, notes and warnings
after them.

Counting: lines, and the longest line in BYTES. A terminator never counts (the CR of a CRLF
included); a last line with no final newline still counts; an empty file is 0 lines. Layout: the
entries of each directory and its depth below its root, over every tracked entry under a declared
root outside the kit's own folder ${KIT_FOLDER_ROOT} plus the spec store docs/ai/specs walked from
disk, and the files of each declared root.

A recorded entry is an exception with its reason: a finding stops exactly when the regeneration
would raise it, and a record above the tree or gone warns until the regeneration lowers or removes
it. No line sum over a root is judged or recorded: an "aggregate" an earlier schema recorded warns
on every check of a minted config and is dropped, with no reason, by the next regeneration.

--write-baseline regenerates the machine keys (baseline, and layout where it is judged) from the
tree and writes schema ${SOURCE_SIZE_SCHEMA}, on an absent config too. --layout starts the layout record on a
present config that has none. The authored keys keep their values and their order; the file is
canonically serialized. A regeneration that RAISES any recorded value needs --reason; the string is
recorded in the entry it raised. A pure tighten needs none. A config of an earlier schema is moved in
the same write; a minted schema-1 one whose regeneration is refused is moved off schema 1 in a write
of its own, its records carried as they are; --check stops on schema 1 until it is moved.

--adopt is the ONE-line adoption: it mints the record and declares the source-size gate (and NOTHING
else) in docs/ai/gates.json. It is idempotent on an already-adopted project. With the config absent
it refuses with the exact file to author. A refused declaration exits nonzero and reports both
halves: what was minted and what was not declared.

--override writes one override of a kit limit (lines-per-file, bytes-per-line, entries-per-directory,
depth: --value and/or --tolerance; files-per-root: --tolerance only), or with --kit-default removes
it; an option left out keeps the limit's current value or tolerance, and --reason is mandatory. It
runs only once regenerating the record under the current limits would raise nothing, and
regenerates the record in the same write.

Exit codes: 0 green, warnings included; 1 a stop or a refusal; 2 usage, config or enumeration error, or an unexpected error.`;
