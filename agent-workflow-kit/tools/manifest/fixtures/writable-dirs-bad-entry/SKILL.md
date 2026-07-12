---
name: fixture-writable-dirs-bad-entry
description: A relative default and a lowercase env name must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-writable-dirs-bad-entry

Test fixture — a `writableDirs` entry whose `default` is not `~/`-anchored/absolute and whose `env` is not UPPER_SNAKE_CASE is malformed.
