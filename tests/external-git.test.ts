import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { execFileAsync, testGit, withServer } from "./helpers/server.ts";

test("an owner can pull from and push to an external Git remote", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-external-git-"));
  const remoteDirectory = path.join(temporary, "remote.git");
  const externalClone = path.join(temporary, "external");
  try {
    await execFileAsync("git", ["init", "--bare", remoteDirectory]);
    const remoteUrl = pathToFileURL(remoteDirectory).toString();
    await withServer(async ({ base, projectDir }) => {
      const checkpoint = await fetch(`${base}/v1/git/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Prepare external remote" }) });
      assert.equal(checkpoint.status, 200);
      const configured = await fetch(`${base}/v1/git/remote`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remoteUrl, branch: "main", direction: "both", syncMinutes: 0 }),
      });
      assert.equal(configured.status, 200, await configured.clone().text());
      assert.deepEqual((await configured.json()).remote, {
        url: remoteUrl, branch: "main", direction: "both", syncMinutes: 0,
        lastCheckedAt: 0, lastSyncedAt: null, lastStatus: null, lastError: null,
      });
      const seeded = await fetch(`${base}/v1/git/remote/sync`, { method: "POST" });
      assert.equal(seeded.status, 200, await seeded.clone().text());
      assert.equal((await seeded.json()).sync.status, "synchronized");

      await execFileAsync("git", ["clone", "--branch", "main", remoteUrl, externalClone]);
      await writeFile(path.join(externalClone, "from-remote.tex"), "from external remote\n", "utf8");
      await testGit(externalClone, ["add", "from-remote.tex"]);
      await testGit(externalClone, ["commit", "-m", "Add external file"]);
      await testGit(externalClone, ["push", "origin", "main"]);

      const pulled = await fetch(`${base}/v1/git/remote/sync`, { method: "POST" });
      assert.equal(pulled.status, 200, await pulled.clone().text());
      assert.equal((await pulled.json()).sync.status, "synchronized");
      assert.equal(await (await fetch(`${base}/v1/files?path=from-remote.tex`)).text(), "from external remote\n");

      const localWrite = await fetch(`${base}/v1/files?path=from-live.tex`, { method: "PUT", body: "from live collaboration\n" });
      assert.equal(localWrite.status, 201);
      const pushed = await fetch(`${base}/v1/git/remote/sync`, { method: "POST" });
      assert.equal(pushed.status, 200, await pushed.clone().text());
      assert.equal((await pushed.json()).sync.status, "synchronized");
      assert.equal(await testGit(remoteDirectory, ["show", "main:from-live.tex"]), "from live collaboration");

      const status = await fetch(`${base}/v1/git/remote`);
      assert.equal(status.status, 200);
      assert.equal((await status.json()).remote.lastStatus, "synchronized");
      const credentialUrl = await fetch(`${base}/v1/git/remote`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://token@example.com/owner/repo.git", branch: "main", direction: "pull", syncMinutes: 0 }),
      });
      assert.equal(credentialUrl.status, 400);
    }, { allowFileGitRemote: true, gitCheckpointIdleMs: 3_600_000, gitCheckpointMaxWaitMs: 3_600_000 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an external Git conflict leaves the live main branch unchanged", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-external-conflict-"));
  const remoteDirectory = path.join(temporary, "remote.git");
  const externalClone = path.join(temporary, "external");
  try {
    await execFileAsync("git", ["init", "--bare", remoteDirectory]);
    const remoteUrl = pathToFileURL(remoteDirectory).toString();
    await withServer(async ({ base, projectDir }) => {
      const original = await (await fetch(`${base}/v1/files?path=main.tex`)).text();
      const checkpoint = await fetch(`${base}/v1/git/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Prepare external remote" }) });
      assert.equal(checkpoint.status, 200);
      await testGit(projectDir, ["push", remoteUrl, "main:main"]);
      await fetch(`${base}/v1/git/remote`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remoteUrl, branch: "main", direction: "both", syncMinutes: 0 }),
      });
      await execFileAsync("git", ["clone", "--branch", "main", remoteUrl, externalClone]);
      await writeFile(path.join(externalClone, "main.tex"), original.replace("shared live", "external remote version"), "utf8");
      await testGit(externalClone, ["add", "main.tex"]);
      await testGit(externalClone, ["commit", "-m", "External conflicting edit"]);
      await testGit(externalClone, ["push", "origin", "main"]);

      const local = original.replace("shared live", "live collaborative version");
      await fetch(`${base}/v1/files?path=main.tex`, { method: "PUT", body: local });
      const result = await fetch(`${base}/v1/git/remote/sync`, { method: "POST" });
      assert.equal(result.status, 200, await result.clone().text());
      const payload = await result.json();
      assert.equal(payload.sync.status, "conflict");
      assert.equal(await (await fetch(`${base}/v1/files?path=main.tex`)).text(), local);
      assert.match(await testGit(projectDir, ["branch", "--list", "conflict/*"]), /conflict\//);
    }, { allowFileGitRemote: true, gitCheckpointIdleMs: 3_600_000, gitCheckpointMaxWaitMs: 3_600_000 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
