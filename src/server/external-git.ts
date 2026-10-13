import { apiError } from "./core.ts";
import type { Logger } from "./logger.ts";
import type { ProjectRuntime } from "./types.ts";

export type ExternalGitDirection = "pull" | "push" | "both";

export type ExternalGitRemote = {
  url: string;
  branch: string;
  direction: ExternalGitDirection;
  syncMinutes: number;
  lastCheckedAt: number;
  lastSyncedAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
};

export type ExternalGitRemoteDatabase = {
  listProjects(): Array<{ id: string }>;
  getExternalGitRemote(projectId: string): ExternalGitRemote | null;
};

export type ExternalGitSyncScheduler = {
  close(): void;
  tick(): Promise<void>;
};

export type ExternalGitSyncSchedulerOptions = {
  database: ExternalGitRemoteDatabase;
  loadProject(projectId: string): Promise<ProjectRuntime>;
  logger: Logger;
  syncProject(runtime: ProjectRuntime): Promise<{ status: string }>;
  now?: () => number;
  pollMs?: number;
  start?: boolean;
};

const DEFAULT_POLL_MS = 60_000;

export function cleanExternalGitRemoteUrl(value: unknown, allowFileRemote = false): string {
  if (typeof value !== "string") throw apiError("invalid_external_git_remote", "remote URL is required");
  const url = value.trim();
  if (!url || url.length > 2048 || /[\0\s]/.test(url) || url.startsWith("-")) {
    throw apiError("invalid_external_git_remote", "remote URL is invalid");
  }
  if (url.startsWith("file://")) {
    if (!allowFileRemote) throw apiError("invalid_external_git_remote", "file:// remotes are not enabled on this server");
    try { new URL(url); return url; } catch { throw apiError("invalid_external_git_remote", "remote URL is invalid"); }
  }
  if (url.toLowerCase().startsWith("https://")) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.username || parsed.password) throw new Error("credentials are not allowed");
      return url;
    } catch {
      throw apiError("invalid_external_git_remote", "use a valid HTTPS remote URL without embedded credentials");
    }
  }
  if (/^ssh:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.password) throw new Error("invalid SSH URL");
      return url;
    } catch {
      throw apiError("invalid_external_git_remote", "use a valid SSH remote URL");
    }
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/:+-]+$/.test(url)) return url;
  throw apiError("invalid_external_git_remote", "use an HTTPS or SSH Git remote URL");
}

export function cleanExternalGitBranch(value: unknown): string {
  if (typeof value !== "string") throw apiError("invalid_external_git_branch", "remote branch is required");
  const branch = value.trim();
  if (!branch || branch.length > 200 || branch.startsWith("-") || branch.startsWith("/") || branch.startsWith("refs/") || branch.endsWith("/")
    || branch.endsWith(".") || branch.includes("..") || branch.includes("//") || branch.includes("@{")
    || /(?:^|\/)\.|\.lock(?:\/|$)|[^A-Za-z0-9._/-]/.test(branch)) {
    throw apiError("invalid_external_git_branch", "remote branch is invalid");
  }
  return branch;
}

export function externalGitTrackingRef(projectId: string, branch: string): string {
  const safeProject = projectId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `refs/latexcoder/external/${safeProject}/${branch}`;
}

export function createExternalGitSyncScheduler(options: ExternalGitSyncSchedulerOptions): ExternalGitSyncScheduler {
  const now = options.now || Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("External Git sync poll interval must be a positive integer");

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function syncIfDue(projectId: string): Promise<void> {
    const remote = options.database.getExternalGitRemote(projectId);
    if (!remote || !remote.syncMinutes) return;
    const checkedAt = now();
    if (remote.lastCheckedAt && checkedAt - remote.lastCheckedAt < remote.syncMinutes * 60_000) return;
    const runtime = await options.loadProject(projectId);
    if (runtime.deleting) return;
    options.logger.info("external_git_sync.started", { projectId, intervalMinutes: remote.syncMinutes });
    const result = await options.syncProject(runtime);
    options.logger.info("external_git_sync.finished", { projectId, status: result.status });
  }

  async function tick(): Promise<void> {
    if (closed || running) return;
    running = true;
    try {
      await Promise.all(options.database.listProjects().map(project => syncIfDue(project.id).catch(error => {
        options.logger.error("external_git_sync.failed", error, { projectId: project.id });
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
