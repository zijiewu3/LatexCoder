import assert from "node:assert/strict";
import test from "node:test";

import { createExternalGitSyncScheduler } from "../src/server/external-git.ts";
import type { ExternalGitRemote } from "../src/server/external-git.ts";
import type { Logger } from "../src/server/logger.ts";
import type { ProjectRuntime } from "../src/server/types.ts";

test("external Git scheduler runs only after the configured interval", async () => {
  let now = 1_000;
  let synchronizations = 0;
  const remote: ExternalGitRemote = {
    url: "https://example.com/owner/repository.git", branch: "main", direction: "both" as const, syncMinutes: 5,
    lastCheckedAt: 0, lastSyncedAt: null, lastStatus: null, lastError: null,
  };
  const runtime = { id: "project", deleting: false } as ProjectRuntime;
  const logger: Logger = { info() {}, error() {} };
  const scheduler = createExternalGitSyncScheduler({
    database: { listProjects: () => [{ id: "project" }], getExternalGitRemote: () => ({ ...remote }) },
    loadProject: async () => runtime,
    logger,
    now: () => now,
    start: false,
    syncProject: async () => {
      synchronizations += 1;
      remote.lastCheckedAt = now;
      remote.lastSyncedAt = now;
      remote.lastStatus = "synchronized";
      return { status: "synchronized" };
    },
  });

  await scheduler.tick();
  assert.equal(synchronizations, 1);
  now += 5 * 60_000 - 1;
  await scheduler.tick();
  assert.equal(synchronizations, 1);
  now += 1;
  await scheduler.tick();
  assert.equal(synchronizations, 2);
  scheduler.close();
});
