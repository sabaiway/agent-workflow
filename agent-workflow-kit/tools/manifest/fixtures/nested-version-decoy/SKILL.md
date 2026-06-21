---
name: nested-version-decoy
metadata:
  version: '1.0.0'
  nested:
    version: '9.9.9'
---

# nested-version-decoy fixture — the DIRECT metadata.version (1.0.0) wins; the deeper
# metadata.nested.version (9.9.9) must be ignored. capability.json declares 1.0.0 → VALID.
