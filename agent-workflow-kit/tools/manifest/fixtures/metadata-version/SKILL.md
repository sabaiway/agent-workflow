---
name: metadata-version
version: '9.9.9'
description: A decoy top-level `version:` that must NOT be read as the authoritative version.
metadata:
  version: '1.0.0'
---

# metadata-version fixture — authoritative version is `metadata.version` (1.0.0), not the
# stray top-level `version: 9.9.9`. capability.json declares 1.0.0, so this is VALID.
