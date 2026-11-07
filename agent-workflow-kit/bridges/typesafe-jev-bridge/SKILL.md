---
name: typesafe-jev-bridge
description: Ask TypeSafe's Jev decision model a set of choice questions about a stated situation and get back typed notes, each with a choice, the probability of every option and a confidence. Use when a step wants a second, calibrated opinion as a note — never a verdict: the bridge moves no gate, review or commit.
metadata:
  version: '1.1.0'
---

# typesafe-jev-bridge

Bridges the main agent to **Jev**, TypeSafe's decision model, through one wrapper, `jev-ask`, which is
the bridge's one role: **judge**. Every answer it prints is a **note** with a confidence; no gate,
verdict, review or commit reads it, so the wrapper writes no file and mints no receipt.

## The model

The model is the host setting `JEV_MODEL`, with this folder's `capability.json` `posture.model` as
the default and the calibrated version. `/agent-workflow-kit bridge-settings` shows the offered
versions and sets one. An environment value overrides the saved setting; an explicitly empty
`JEV_MODEL=` selects the default. Every request names the effective model, which must be offered
by the manifest. An answer naming another model is refused (exit 7) and prints no note.

Notes on another offered version are marked uncalibrated: the posture line carries `uncalibrated`
and the output document's `calibrated` is false. A run on `posture.model` carries `calibrated: true`.

## The key

The key is the value of the variable the first `PASSED_VARIABLE` line of this folder's
`service-facts.txt` names, read from the environment only — never from the request file or the
command line. The wrapper sends it, trimmed, in the `Authorization` header and never prints a byte of
it. To save the key on a host, follow [`setup/README.md`](setup/README.md).

A delegated codex or agy run reaching Jev on its own is not this bridge: that access is the
every-run rule of those bridges' wrappers (spec bridges/jev-every-run).

## Usage

```text
jev-ask <request-file>
jev-ask --help        (alias -h)
```

The request file is one UTF-8 JSON object with exactly two keys:

- `state` — a non-empty string: the situation the questions are about.
- `questions` — an object of one or more question ids, each
  `{ "type": "choice", "instructions": "<non-empty>", "criteria": { "<option id>": "<non-empty>", … } }`
  with 2 to 255 options. A choice is the one question type admitted.

Before any request the wrapper bounds the request locally: the UTF-8 bytes of the compact JSON of
`state` plus the largest `[id, question]` pair at most 30 000, the whole request body at most 60 000.

Before the request, stderr carries one posture line:
`judge posture: model=<requested id> source=model:<source> host=<endpoint host> timeout=10s`, where
the source is `default`, `setting` or `environment`. On an uncalibrated run, `uncalibrated` appears
between the source and `host=`. On exit 0 stdout carries one JSON document and one newline:

```json
{ "model": "<answering id>", "calibrated": true, "requestId": "<request id or null>", "notes": { "<question id>": { "choice": "…", "probabilities": { "…": 0.9 }, "confidence": 0.8 } } }
```

## Exit statuses

A non-zero exit prints nothing on stdout and exactly one stderr line, after the posture line when
the request was sent. Any warning from the shared posture reader precedes these lines and is
outside that count.

| Exit | Meaning |
|------|---------|
| 0 | the notes printed |
| 2 | usage, or a request stopped before it is sent: an operand, a flag, a model the manifest does not offer, an unreadable file, the request grammar or the size bound |
| 3 | no key: the variable is unset, empty or blank; no request is made |
| 4 | timeout: no complete answer within 10 seconds |
| 5 | an HTTP status outside 2xx, a redirect included; the line names the status, the request id when the vendor sent one and, for 401, 422, 429 and 529, the cause |
| 6 | a malformed answer |
| 7 | the answer names another model than the requested one |
| 8 | the request failed before any status (name lookup, connection, TLS) |
| 127 | the wrapper's own folder, its `service-facts.txt`, `node` on PATH or the manifest's model could not be read, or the manifest lacks the `JEV_MODEL` entry or its non-empty offered list of strings |
