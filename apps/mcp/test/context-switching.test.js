import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCredentials, writeCredentials } from "../dist/lib/credentials.js";
import { WorkerosApiClient } from "../dist/lib/api.js";
import { workspacesSwitchCommand, workspacesListCommand } from "../dist/commands/workspaces.js";
import { mcpInstallCommand, mcpListCommand, mcpSwitchCommand } from "../dist/commands/mcp.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-ctx-"));
  const originalHome = process.env.HOME;
  const saved = {};
  for (const key of [
    "WORKEROS_API_TOKEN",
    "WORKEROS_API_SECRET",
    "FLOOM_API_SECRET",
    "WORKEROS_API_BASE",
    "FLOOM_API_BASE",
    "WORKEROS_WORKSPACE_ID",
    "WORKEROS_WORKSPACE_NAME",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const WORKSPACES = [
  { id: "local-default", name: "Local", created_at: "2026-01-01" },
  { id: "ws_0123456789abcd", name: "Team A", created_at: "2026-01-02" },
];

const CONNECTIONS = [
  { kind: "mcp", mcp_label: "github", mcp_transport: "streamable_http", status: "active" },
  { kind: "mcp", mcp_label: "linear", mcp_transport: "sse", status: "active" },
  { kind: "composio", app_name: "gmail", status: "active" },
];

// Minimal OSS API stub: /workspaces, /workspaces/:id/select, /connections.
async function withStubServer(fn, { cloud = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const prefix = cloud ? "/api" : "";
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === `${prefix}/workspaces`) {
      res.end(JSON.stringify({ workspaces: WORKSPACES, active_id: "local-default" }));
      return;
    }
    const select = req.url.match(/^\/workspaces\/([^/]+)\/select$/);
    if (!cloud && req.method === "POST" && select) {
      const found = WORKSPACES.find((row) => row.id === select[1]);
      res.statusCode = found ? 200 : 404;
      res.end(JSON.stringify(found || { detail: "workspace not found" }));
      return;
    }
    if (req.method === "GET" && req.url === `${prefix}/connections`) {
      res.end(JSON.stringify(CONNECTIONS));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, calls);
  } finally {
    server.close();
  }
}

async function writeOssCreds(apiBase, extra = {}) {
  await writeCredentials({
    api_base: apiBase,
    mode: "oss",
    api_secret: "test-secret",
    authed_at: new Date().toISOString(),
    ...extra,
  });
}

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    restore: () => { process.stdout.write = original; },
    text: () => chunks.join(""),
  };
}

test("workspace switch persists and validates via /select in OSS mode", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeOssCreds(base);
      const code = await workspacesSwitchCommand("Team A");
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "ws_0123456789abcd");
      assert.equal(creds.workspace_name, "Team A");
      assert.ok(calls.includes("POST /workspaces/ws_0123456789abcd/select"));
    });
  });
});

test("workspace switch fails with exit 1 on unknown workspace and keeps credentials", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base, { workspace_id: "local-default", workspace_name: "Local" });
      const code = await workspacesSwitchCommand("does-not-exist");
      assert.equal(code, 1);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "local-default");
    });
  });
});

test("workspace switch fails with exit 1 when not logged in", async () => {
  await withTempHome(async () => {
    const code = await workspacesSwitchCommand("Team A");
    assert.equal(code, 1);
  });
});

test("workspace list marks the active workspace and shows auth status", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base, { workspace_id: "ws_0123456789abcd", workspace_name: "Team A" });
      const captured = captureStdout();
      let code;
      try {
        code = await workspacesListCommand({});
      } finally {
        captured.restore();
      }
      assert.equal(code, 0);
      const out = captured.text();
      const activeLine = out.split("\n").find((line) => line.startsWith("*"));
      assert.ok(activeLine, "active row is marked with *");
      assert.match(activeLine, /Team A/);
      assert.match(activeLine, /authenticated/);
    });
  });
});

test("OSS auth headers carry the persisted active workspace", async () => {
  await withTempHome(async () => {
    await writeOssCreds("https://workers-api.floom.dev", { workspace_id: "ws_0123456789abcd" });
    const creds = await readCredentials();
    const client = new WorkerosApiClient(creds.api_base, creds);
    const headers = await client.authHeaders();
    assert.equal(headers["x-floom-secret"], "test-secret");
    assert.equal(headers["x-workeros-workspace"], "ws_0123456789abcd");
  });
});

test("workspace switch works against cloud /api/workspaces", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeCredentials({
        api_base: base,
        mode: "cloud",
        api_token: "pat-token",
        authed_at: new Date().toISOString(),
      });
      const code = await workspacesSwitchCommand("ws_0123456789abcd");
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "ws_0123456789abcd");
      assert.ok(!calls.some((call) => call.includes("/select")), "cloud mode does not call /select");
    }, { cloud: true });
  });
});

test("mcp install (OSS) bakes the active workspace header into the client config", async () => {
  await withTempHome(async (home) => {
    await writeOssCreds("https://workers-api.floom.dev", { workspace_id: "ws_0123456789abcd" });
    const code = await mcpInstallCommand({ target: "claude" });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    const entry = config.mcpServers.workeros;
    assert.equal(entry.headers["x-floom-secret"], "test-secret");
    assert.equal(entry.headers["x-workeros-workspace"], "ws_0123456789abcd");
  });
});

test("mcp install (OSS) omits the workspace header when no workspace is selected", async () => {
  await withTempHome(async (home) => {
    await writeOssCreds("https://workers-api.floom.dev");
    const code = await mcpInstallCommand({ target: "claude" });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(config.mcpServers.workeros.headers["x-workeros-workspace"], undefined);
  });
});

test("mcp switch persists the active MCP server and survives reads", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base);
      const code = await mcpSwitchCommand("github");
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.active_mcp_label, "github");
    });
  });
});

test("mcp switch fails with exit 1 on unknown server", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base);
      const code = await mcpSwitchCommand("does-not-exist");
      assert.equal(code, 1);
      const creds = await readCredentials();
      assert.equal(creds.active_mcp_label, undefined);
    });
  });
});

test("mcp switch fails with exit 1 when not logged in", async () => {
  await withTempHome(async () => {
    const code = await mcpSwitchCommand("github");
    assert.equal(code, 1);
  });
});

test("mcp list filters to MCP connections and marks the active one", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base, { active_mcp_label: "linear" });
      const captured = captureStdout();
      let code;
      try {
        code = await mcpListCommand({ json: true });
      } finally {
        captured.restore();
      }
      assert.equal(code, 0);
      const rows = JSON.parse(captured.text());
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.kind === "mcp"));
      assert.deepEqual(
        rows.map((row) => [row.mcp_label, row.active]),
        [["github", false], ["linear", true]],
      );
    });
  });
});
