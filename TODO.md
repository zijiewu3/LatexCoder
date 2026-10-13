# TODO

1. **Scheduled auto-compilation** — Implemented: configurable per-project interval, changed-source detection, and duplicate-queue avoidance.

2. **External Git remote synchronization** — Implemented: owner-managed HTTPS/SSH remote, pull/push direction, optional interval, non-interactive service credentials, and conflict quarantine on live `main`.

3. **Selected-block Git history and restore** — Let a user select a contiguous text block, inspect the Git commits that changed it, preview a historical version of that block, and restore only that block rather than an entire file or project. Require exact file/block freshness checks, make a pre-restore checkpoint, apply the replacement through the collaboration layer, and refuse ambiguous history mappings (for example, after major rewrites or moves) instead of guessing.
