import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCredentials, writeCredentials } from "../dist/lib/credentials.js";
import { FloomApiClient } from "../dist/lib/api.js";
import { workspacesCreateCommand, workspacesSwitchCommand, workspacesListCommand } from "../dist/commands/workspaces.js";
import { connectionsAddCommand, connectionsListCommand } from "../dist/commands/connections.js";
import { mcpInstallCommand, mcpListCommand, mcpSwitchCommand, mcpTestCommand } from "../dist/commands/mcp.js";

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
  { id: "conn-github", kind: "mcp", mcp_label: "github", mcp_transport: "streamable_http", status: "active" },
  { id: "conn-linear", kind: "mcp", mcp_label: "linear", mcp_transport: "sse", status: "active" },
  {
    id: "conn-gmail",
    kind: "composio",
    app_name: "gmail",
    account_label: "local-user",
    display_name: "local-user",
    status: "active",
    last_used_by: "Gmail Intake Brief",
  },
];

const TEST_RESULTS = {
  "conn-github": { status: "valid", reason: "ok", tested_at: "2026-06-11T00:00:00Z", tools: ["search_issues"] },
  "conn-linear": { status: "failed", reason: "HTTP 401 from MCP server", tested_at: "2026-06-11T00:00:00Z" },
};

// Minimal OSS API stub: /workspaces, /workspaces/:id/select, /connections.
async function withStubServer(fn, { cloud = false, workersStatus = 200 } = {}) {
  const calls = [];
  const bodies = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const prefix = cloud ? "/api" : "";
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsedBody = raw ? JSON.parse(raw) : null;
      bodies.push({ method: req.method, url: req.url, body: parsedBody });
      res.setHeader("content-type", "application/json");
      // Workspace-access probe target (#1829): a workspace-scoped token returns
      // 403 here when the active workspace header is one it isn't minted for.
      if (req.method === "GET" && req.url === `${prefix}/workers`) {
        res.statusCode = workersStatus;
        res.end(JSON.stringify(workersStatus === 200 ? [] : { detail: "forbidden" }));
        return;
      }
      if (req.method === "GET" && req.url === `${prefix}/workspaces`) {
        res.end(JSON.stringify({ workspaces: WORKSPACES, active_id: "local-default" }));
        return;
      }
      if (req.method === "POST" && req.url === `${prefix}/workspaces`) {
        res.end(JSON.stringify({
          id: "ws_created",
          name: parsedBody?.name || "Created",
          created_at: "2026-01-03",
        }));
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
      if (req.method === "POST" && req.url === `${prefix}/connections`) {
        res.end(JSON.stringify({
          id: "conn-created",
          app_name: parsedBody?.app_name || "gmail",
          redirect_url: "https://auth.example/authorize",
          composio_connection_id: "ca_created",
        }));
        return;
      }
      const connTest = req.url.match(/^\/connections\/([^/]+)\/test$/);
      if (!cloud && req.method === "POST" && connTest && TEST_RESULTS[connTest[1]]) {
        res.end(JSON.stringify(TEST_RESULTS[connTest[1]]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, calls, bodies);
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

test("workspace create posts to API and persists new active workspace", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls, bodies) => {
      await writeOssCreds(base);
      const code = await workspacesCreateCommand("Customer A", { json: true });
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "ws_created");
      assert.equal(creds.workspace_name, "Customer A");
      assert.ok(calls.includes("POST /workspaces"));
      assert.deepEqual(
        bodies.find((call) => call.method === "POST" && call.url === "/workspaces")?.body,
        { name: "Customer A" },
      );
    });
  });
});

test("OSS auth headers carry the persisted active workspace", async () => {
  await withTempHome(async () => {
    await writeOssCreds("https://localhost:8000", { workspace_id: "ws_0123456789abcd" });
    const creds = await readCredentials();
    const client = new FloomApiClient(creds.api_base, creds);
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
      assert.ok(!calls.some((call) => call.includes("/select")), "hosted mode does not call /select");
    }, { cloud: true });
  });
});

test("workspace create works against cloud /api/workspaces", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeCredentials({
        api_base: base,
        mode: "cloud",
        api_token: "pat-token",
        authed_at: new Date().toISOString(),
      });
      const code = await workspacesCreateCommand("Cloud Customer", { json: true });
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "ws_created");
      assert.equal(creds.workspace_name, "Cloud Customer");
      assert.ok(calls.includes("POST /api/workspaces"));
    }, { cloud: true });
  });
});

// #1829: a workspace-scoped hosted api_token 403s on the now-active workspace
// once create/switch repoints it. The CLI must probe access first and leave the
// active workspace intact instead of wedging into a 403 loop that only a
// hand-edit of credentials.json recovers from.
test("cloud workspace switch refuses to de-scope a workspace-scoped token (#1829)", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeCredentials({
        api_base: base,
        mode: "cloud",
        api_token: "pat-token",
        workspace_id: "local-default",
        workspace_name: "Local",
        authed_at: new Date().toISOString(),
      });
      const code = await workspacesSwitchCommand("ws_0123456789abcd");
      assert.equal(code, 1);
      const creds = await readCredentials();
      // Active workspace unchanged — no hand-edit of credentials.json needed.
      assert.equal(creds.workspace_id, "local-default");
      assert.equal(creds.workspace_name, "Local");
      assert.ok(calls.includes("GET /api/workers"), "switch probes workspace access");
    }, { cloud: true, workersStatus: 403 });
  });
});

test("cloud workspace create does not repoint to an inaccessible workspace (#1829)", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeCredentials({
        api_base: base,
        mode: "cloud",
        api_token: "pat-token",
        workspace_id: "local-default",
        workspace_name: "Local",
        authed_at: new Date().toISOString(),
      });
      const code = await workspacesCreateCommand("New Team", { json: true });
      // Creation succeeded server-side, but the active workspace stays usable.
      assert.equal(code, 0);
      const creds = await readCredentials();
      assert.equal(creds.workspace_id, "local-default");
      assert.equal(creds.workspace_name, "Local");
      assert.ok(calls.includes("POST /api/workspaces"));
      assert.ok(calls.includes("GET /api/workers"), "create probes workspace access");
    }, { cloud: true, workersStatus: 403 });
  });
});

test("connections add starts OAuth and prints the authorization URL", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls, bodies) => {
      await writeOssCreds(base);
      const captured = captureStdout();
      let code;
      try {
        code = await connectionsAddCommand("Gmail", {});
      } finally {
        captured.restore();
      }
      assert.equal(code, 0);
      assert.ok(calls.includes("POST /connections"));
      assert.deepEqual(
        bodies.find((call) => call.method === "POST" && call.url === "/connections")?.body,
        { app_name: "gmail" },
      );
      assert.match(captured.text(), /https:\/\/auth\.example\/authorize/);
    });
  });
});

test("connections list separates app from account label", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base);
      const captured = captureStdout();
      let code;
      try {
        code = await connectionsListCommand({});
      } finally {
        captured.restore();
      }
      assert.equal(code, 0);
      const out = captured.text();
      assert.match(out, /App/);
      assert.match(out, /Account/);
      assert.match(out, /gmail/);
      assert.match(out, /local-user/);
      assert.match(out, /Gmail Intake Brief/);
    });
  });
});

test("connections add works against cloud /api/connections", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base, calls) => {
      await writeCredentials({
        api_base: base,
        mode: "cloud",
        api_token: "pat-token",
        workspace_id: "ws_cloud",
        authed_at: new Date().toISOString(),
      });
      const code = await connectionsAddCommand("github", { json: true });
      assert.equal(code, 0);
      assert.ok(calls.includes("POST /api/connections"));
    }, { cloud: true });
  });
});

test("mcp install (OSS) bakes the active workspace header into the client config", async () => {
  await withTempHome(async (home) => {
    await writeOssCreds("https://localhost:8000", { workspace_id: "ws_0123456789abcd" });
    const code = await mcpInstallCommand({ target: "claude" });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    const entry = config.mcpServers.floom;
    assert.equal(entry.headers["x-floom-secret"], "test-secret");
    assert.equal(entry.headers["x-workeros-workspace"], "ws_0123456789abcd");
  });
});

test("mcp install (OSS) omits the workspace header when no workspace is selected", async () => {
  await withTempHome(async (home) => {
    await writeOssCreds("https://localhost:8000");
    const code = await mcpInstallCommand({ target: "claude" });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(config.mcpServers.floom.headers["x-workeros-workspace"], undefined);
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

test("mcp test defaults to the active server and exits 0 when valid", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base, { active_mcp_label: "github" });
      const captured = captureStdout();
      let code;
      try {
        code = await mcpTestCommand(undefined, { json: true });
      } finally {
        captured.restore();
      }
      assert.equal(code, 0);
      const result = JSON.parse(captured.text());
      assert.equal(result.label, "github");
      assert.equal(result.status, "valid");
      assert.deepEqual(result.tools, ["search_issues"]);
    });
  });
});

test("mcp test exits 1 when the probed server fails", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base);
      const code = await mcpTestCommand("linear", {});
      assert.equal(code, 1);
    });
  });
});

test("mcp test exits 1 when no name given and no active server set", async () => {
  await withTempHome(async () => {
    await withStubServer(async (base) => {
      await writeOssCreds(base);
      const code = await mcpTestCommand(undefined, {});
      assert.equal(code, 1);
    });
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
