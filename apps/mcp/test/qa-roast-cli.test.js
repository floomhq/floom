import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCredentials } from "../dist/lib/credentials.js";
import { mcpInstallCommand } from "../dist/commands/mcp.js";
import { runWorkerCommand } from "../dist/commands/run.js";

async function withCleanEnv(fn) {
  const saved = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "WORKEROS_API_TOKEN",
    "WORKEROS_API_SECRET",
    "FLOOM_API_SECRET",
    "WORKEROS_API_BASE",
    "FLOOM_API_BASE",
    "WORKEROS_WORKSPACE_ID",
    "WORKEROS_WORKSPACE_NAME",
    "WORKEROS_CLOUD",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("credentials honor XDG_CONFIG_HOME before HOME/.config", async () => {
  await withCleanEnv(async () => {
    const home = await mkdtemp(join(tmpdir(), "workeros-home-"));
    const xdg = await mkdtemp(join(tmpdir(), "workeros-xdg-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = xdg;

    await writeCredentials({
      api_base: "https://localhost:8000",
      mode: "oss",
      api_secret: "xdg-secret",
      authed_at: new Date().toISOString(),
    });

    assert.equal(existsSync(join(xdg, "floom", "credentials.json")), true);
    assert.equal(existsSync(join(home, ".config", "floom", "credentials.json")), false);
  });
});

test("run treats pending_approval as terminal and prints review guidance", async () => {
  await withCleanEnv(async () => {
    const home = await mkdtemp(join(tmpdir(), "workeros-run-pending-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/workers/worker_pending/runs") {
        res.end(JSON.stringify({ run_id: "run_pending" }));
        return;
      }
      if (req.method === "GET" && req.url === "/runs/run_pending") {
        res.end(JSON.stringify({ id: "run_pending", status: "pending_approval" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const originalStdout = process.stdout.write.bind(process.stdout);
    let stdout = "";
    try {
      await writeCredentials({
        api_base: `http://127.0.0.1:${server.address().port}`,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      process.stdout.write = (chunk) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        return true;
      };

      const code = await runWorkerCommand("worker_pending", {});

      assert.equal(code, 0);
      assert.match(stdout, /Status:\s+pending_approval/);
      assert.match(stdout, /awaiting approval/);
      assert.equal(seen.filter((call) => call.url === "/runs/run_pending").length, 1);
    } finally {
      process.stdout.write = originalStdout;
      server.close();
    }
  });
});

test("cloud MCP generic config uses workspace URL and redacts PAT unless explicitly shown", async () => {
  await withCleanEnv(async () => {
    const home = await mkdtemp(join(tmpdir(), "workeros-mcp-cloud-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    await writeCredentials({
      api_base: "https://workeros-api.floom.dev",
      mode: "cloud",
      api_token: "wos_live_pat_secret",
      workspace_id: "ws_cloud",
      workspace_name: "Cloud Workspace",
      authed_at: new Date().toISOString(),
    });

    const originalStdout = process.stdout.write.bind(process.stdout);
    let stdout = "";
    try {
      process.stdout.write = (chunk) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        return true;
      };
      assert.equal(await mcpInstallCommand({ target: "generic" }), 0);
      assert.match(stdout, /https:\/\/workeros-api\.floom\.dev\/mcp\/ws_cloud/);
      assert.doesNotMatch(stdout, /wos_live_pat_secret/);
      assert.match(stdout, /<Authorization>/);

      stdout = "";
      assert.equal(await mcpInstallCommand({ target: "generic", showToken: true }), 0);
      assert.match(stdout, /Bearer wos_live_pat_secret/);
    } finally {
      process.stdout.write = originalStdout;
    }
  });
});
