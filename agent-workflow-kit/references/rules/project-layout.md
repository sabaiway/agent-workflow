---
type: rules
lastUpdated: 2026-10-18
scope: permanent
staleAfter: never
owner: kit
maxLines: 80
---

# Project layout

Where a file goes is decided by what it means, never by where there is room.

## A module is a directory

A module is a directory holding everything that belongs to it: its code, its tests, its mocks, its
fixtures and its command-line entry. Tests live inside the module, next to the code they check, never
in a separate tree.

## The index is the one door

The module's own index file, the one its language uses for that purpose, exports only what is used
outside the module. Nothing outside reaches past the index into a file of the module.

## The spec is the description

No README repeats the module's spec. The spec describes the module; a README that restates it drifts
from it.

## Modules nest by meaning

Modules nest by meaning: a slice holds its modules, and a shared layer holds what several slices use.
Modules never nest by technical layer, so there is no directory of all controllers or all helpers.

## The spec mirrors the module

Specs live in docs/ai/specs. A spec's path mirrors its module's path, so the name of one gives the place of the other.

## Old code

Old code keeps its place as a recorded exception. New and touched code follows these rules.
