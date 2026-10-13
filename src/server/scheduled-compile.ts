import { compilationSourceRevision } from "./project-files.ts";
import type { Logger } from "./logger.ts";
import type { ProjectRuntime } from "./types.ts";

export type ScheduledCompileSettings = {
  main: string;
  compiler: string;
  scheduledCompileMinutes: number;
};

export type ScheduledCompileState = {
  minutes: number;
  lastCheckedAt: number;
  lastAttemptRevision: string | null;
};

export type ScheduledCompileDatabase = {
  listProjects(): Array<{ id: string }>;
  getSettings(projectId: string): ScheduledCompileSettings;
  getScheduledCompileState(projectId: string): ScheduledCompileState;
  recordScheduledCompileCheck(projectId: string, checkedAt: number): void;
  recordScheduledCompileAttempt(projectId: string, checkedAt: number, revision: string): void;
};

export type ScheduledCompileScheduler = {
  close(): void;
  tick(): Promise<void>;
};

export type ScheduledCompileSchedulerOptions = {
  compileProject(runtime: ProjectRuntime, main: string): Promise<{ success: boolean }>;
  database: ScheduledCompileDatabase;
  loadProject(projectId: string): Promise<ProjectRuntime>;
  logger: Logger;
  notify(projectId: string): void;
  now?: () => number;
  pollMs?: number;
  start?: boolean;
};

const DEFAULT_POLL_MS = 60_000;

export function createScheduledCompileScheduler(options: ScheduledCompileSchedulerOptions): ScheduledCompileScheduler {
  const now = options.now || Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("Scheduled compilation poll interval must be a positive integer");

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function compileIfDue(projectId: string): Promise<void> {
    const state = options.database.getScheduledCompileState(projectId);
    if (!state.minutes) return;
    const checkedAt = now();
    const intervalMs = state.minutes * 60_000;
    if (state.lastCheckedAt && checkedAt - state.lastCheckedAt < intervalMs) return;

    // Record the inspection before loading the project. A missing or temporarily
    // unavailable project should not cause a tight retry loop every poll cycle.
    options.database.recordScheduledCompileCheck(projectId, checkedAt);
    const runtime = await options.loadProject(projectId);
    if (runtime.deleting || runtime.compilePromise) return;

    const settings = options.database.getSettings(projectId);
    runtime.collaboration.flush();
    const revision = await compilationSourceRevision(runtime.projectDir, runtime.build.main || settings.main, settings.compiler);
    if ((runtime.build.status === "success" && runtime.build.sourceRevision === revision) || state.lastAttemptRevision === revision) return;

    options.database.recordScheduledCompileAttempt(projectId, checkedAt, revision);
    options.notify(projectId);
    options.logger.info("scheduled_compile.started", { projectId, intervalMinutes: state.minutes });
    try {
      const result = await options.compileProject(runtime, runtime.build.main || settings.main);
      options.logger.info("scheduled_compile.finished", { projectId, success: result.success });
    } catch (error) {
      options.logger.error("scheduled_compile.failed", error, { projectId });
    } finally {
      options.notify(projectId);
    }
  }

  async function tick(): Promise<void> {
    if (closed || running) return;
    running = true;
    try {
      await Promise.all(options.database.listProjects().map(project => compileIfDue(project.id).catch(error => {
        options.logger.error("scheduled_compile.project_failed", error, { projectId: project.id });
      })));
    } finally {
      running = false;
    }
  }

  if (options.start !== false) {
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref();
    void tick();
  }

  return {
    close(): void {
      closed = true;
      if (timer) clearInterval(timer);
    },
    tick,
  };
}
