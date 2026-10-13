import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compilationSourceRevision } from "../src/server/project-files.ts";
import { createScheduledCompileScheduler } from "../src/server/scheduled-compile.ts";
import type { Logger } from "../src/server/logger.ts";
import type { ProjectRuntime } from "../src/server/types.ts";
import { createFakeLatexmk, waitFor, withServer } from "./helpers/server.ts";

test("scheduled compilation skips unchanged source and retries only after a later change", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-scheduled-compile-"));
  try {
    const main = path.join(directory, "main.tex");
    await writeFile(main, "Initial source\n", "utf8");
    const initialRevision = await compilationSourceRevision(directory);
    const runtime = {
      id: "project",
      projectDir: directory,
      build: { status: "success", main: "main.tex", sourceRevision: initialRevision },
      collaboration: { flush() {} },
      compilePromise: null,
      deleting: false,
    } as unknown as ProjectRuntime;
    const state = { minutes: 1, lastCheckedAt: 0, lastAttemptRevision: null as string | null };
    let now = 60_000;
    let compilations = 0;
    const logger: Logger = { info() {}, error() {} };
    const scheduler = createScheduledCompileScheduler({
      database: {
        listProjects: () => [{ id: runtime.id }],
        getSettings: () => ({ main: "main.tex", compiler: "auto", scheduledCompileMinutes: state.minutes }),
        getScheduledCompileState: () => ({ ...state }),
        recordScheduledCompileCheck: (_projectId, checkedAt) => { state.lastCheckedAt = checkedAt; },
        recordScheduledCompileAttempt: (_projectId, checkedAt, revision) => {
          state.lastCheckedAt = checkedAt;
          state.lastAttemptRevision = revision;
        },
      },
      loadProject: async () => runtime,
      compileProject: async () => { compilations++; return { success: false }; },
      logger,
      notify() {},
      now: () => now,
      start: false,
    });

    await scheduler.tick();
    assert.equal(compilations, 0, "a current successful PDF is not rebuilt");

    await writeFile(main, "First update\n", "utf8");
    now += 60_000;
    await scheduler.tick();
    assert.equal(compilations, 1, "a changed source is compiled");

    now += 60_000;
    await scheduler.tick();
    assert.equal(compilations, 1, "an unchanged failed source is not retried");

    await writeFile(main, "Second update\n", "utf8");
    now += 60_000;
    await scheduler.tick();
    assert.equal(compilations, 2, "a later source change schedules another attempt");
    scheduler.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the server compiles a changed project on its configured schedule", async () => {
  const compilerDirectory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-scheduled-compiler-"));
  try {
    const compiler = await createFakeLatexmk(compilerDirectory);
    await withServer(async ({ base, database }) => {
      const project = (await (await fetch(`${base}/v1/project`)).json()).project;
      const settings = await fetch(`${base}/v1/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ main: "main.tex", compiler: "auto", autoCompile: false, scheduledCompileMinutes: 1 }),
      });
      assert.equal(settings.status, 200);

      const countPath = path.join(compilerDirectory, "count");
      await waitFor(() => existsSync(countPath));
      assert.equal(readFileSync(countPath, "utf8").trim(), "1");

      const update = await fetch(`${base}/v1/files?path=main.tex`, {
        method: "PUT",
        body: "\\documentclass{article}\\begin{document}Updated\\end{document}\\n",
      });
      assert.equal(update.status, 201);
      database.recordScheduledCompileCheck(project.id, 0);
      await waitFor(() => existsSync(countPath) && Number(readFileSync(countPath, "utf8")) >= 2);
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(readFileSync(countPath, "utf8").trim(), "2", "unchanged source is not compiled again");
    }, { compiler, scheduledCompilePollMs: 10 });
  } finally {
    await rm(compilerDirectory, { recursive: true, force: true });
  }
});
