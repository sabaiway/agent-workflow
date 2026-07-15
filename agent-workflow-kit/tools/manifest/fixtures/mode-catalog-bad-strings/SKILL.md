---
name: fixture-mode-catalog-bad-strings
description: modeCatalog strings over the one-line cap or carrying control characters — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-strings

Negative fixture — every catalog string the renderer prints is a capped, control-character-free ONE
line, and `whenToUse[]` is a non-empty list (a mode that never says when to reach for it is not
discoverable).
