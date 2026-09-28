# TODO

1. **Scheduled auto-compilation** — Add a configurable per-project interval that recompiles only when source files have changed since the last successful build. Expose the interval in project settings and avoid queueing duplicate builds.

2. **External Git remote synchronization** — Add configurable synchronization with a GitHub or other Git remote, rather than relying only on LaTeX Coder's local clone/push endpoint. Define authentication, pull/push direction, scheduling or webhook behavior, and conflict handling with the live `main` branch.

3. **Selected-block Git history and restore** — Let a user select a contiguous text block, inspect the Git commits that changed it, preview a historical version of that block, and restore only that block rather than an entire file or project. Require exact file/block freshness checks, make a pre-restore checkpoint, apply the replacement through the collaboration layer, and refuse ambiguous history mappings (for example, after major rewrites or moves) instead of guessing.
