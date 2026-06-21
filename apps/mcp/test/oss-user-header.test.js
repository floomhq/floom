// #1742: OSS/self-hosted engines with user-header scope require x-floom-user
// alongside the shared secret. The CLI had no way to send it, so any such
// instance 401'd ("x-floom-user header required when user-header scope is
// enabled"). These tests cover the three header paths (CLI client, MCP server,
// baked MCP client config) plus the --user flag and WORKEROS_USER env wiring.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readCredentials, writeCredentials } from "../dist/lib/credentials.js";
import { FloomApiClient } from "../dist/lib/api.js";
import { mcpInstallCommand } from "../dist/commands/mcp.js";
import { buildCliProgram } from "../dist/cli.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-user-"));
  const saved = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "WORKEROS_API_TOKEN",
    "WORKEROS_API_SECRET",
    "FLOOM_API_SECRET",
    "WORKEROS_API_BASE",
    "FLOOM_API_BASE",
    "WORKEROS_USER",
    "FLOOM_USER",
    "WORKEROS_WORKSPACE_ID",
    "WORKEROS_WORKSPACE_NAME",
    "WORKEROS_CLOUD",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("WORKEROS_USER env populates OSS credentials and sends x-floom-user", async () => {
  await withTempHome(async () => {
    process.env.WORKEROS_API_BASE = "http://127.0.0.1:8011";
    process.env.WORKEROS_API_SECRET = "env-secret";
    process.env.WORKEROS_USER = "alice@example.com";
    const creds = await readCredentials();
    assert.equal(creds.mode, "oss");
    assert.equal(creds.user, "alice@example.com");
    const headers = await new FloomApiClient(creds.api_base, creds).authHeaders();
    assert.equal(headers["x-floom-secret"], "env-secret");
    assert.equal(headers["x-floom-user"], "alice@example.com");
  });
});

test("FLOOM_USER alias also sets x-floom-user", async () => {
  await withTempHome(async () => {
    process.env.WORKEROS_API_BASE = "http://127.0.0.1:8011";
    process.env.WORKEROS_API_SECRET = "env-secret";
    process.env.FLOOM_USER = "bob@example.com";
    const creds = await readCredentials();
    assert.equal(creds.user, "bob@example.com");
  });
});

test("no x-floom-user header when user is unset", async () => {
  await withTempHome(async () => {
    await writeOssCreds("https://localhost:8000");
    const creds = await readCredentials();
    const headers = await new FloomApiClient(creds.api_base, creds).authHeaders();
    assert.equal(headers["x-floom-secret"], "test-secret");
    assert.equal(headers["x-floom-user"], undefined);
  });
});

test("WORKEROS_USER env overrides a saved OSS creds file", async () => {
  await withTempHome(async () => {
    await writeOssCreds("https://localhost:8000", { user: "file-user" });
    process.env.WORKEROS_USER = "override-user";
    const creds = await readCredentials();
    assert.equal(creds.user, "override-user");
  });
});

test("saved OSS creds file user is used when no env override", async () => {
  await withTempHome(async () => {
    await writeOssCreds("https://localhost:8000", { user: "file-user" });
    const creds = await readCredentials();
    assert.equal(creds.user, "file-user");
  });
});

test("WORKEROS_API_SECRET selects OSS mode even with a saved cloud creds file", async () => {
  // #1742 ask #2: the env-provided OSS secret must win over a stale cloud
  // credentials.json instead of leaving the CLI stuck in cloud mode.
  await withTempHome(async () => {
    await writeCredentials({
      api_base: "https://workeros-api.floom.dev",
      mode: "cloud",
      api_token: "stale-pat",
      authed_at: new Date().toISOString(),
    });
    process.env.WORKEROS_API_BASE = "http://127.0.0.1:8011";
    process.env.WORKEROS_API_SECRET = "env-secret";
    process.env.WORKEROS_USER = "alice@example.com";
    const creds = await readCredentials();
    assert.equal(creds.mode, "oss");
    assert.equal(creds.api_base, "http://127.0.0.1:8011");
    const headers = await new FloomApiClient(creds.api_base, creds).authHeaders();
    assert.equal(headers["x-floom-secret"], "env-secret");
    assert.equal(headers["x-floom-user"], "alice@example.com");
    assert.equal(headers["x-floom-token"], undefined);
  });
});

test("mcp install (OSS) bakes the x-floom-user header into the client config", async () => {
  await withTempHome(async (home) => {
    await writeOssCreds("https://localhost:8000", { user: "alice@example.com" });
    const code = await mcpInstallCommand({ target: "claude" });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    const entry = config.mcpServers.floom;
    assert.equal(entry.headers["x-floom-secret"], "test-secret");
    assert.equal(entry.headers["x-floom-user"], "alice@example.com");
  });
});

test("--user flag flows into x-floom-user via whoami against the API", async () => {
  await withTempHome(async () => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ path: new URL(req.url, "http://127.0.0.1").pathname, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      process.env.WORKEROS_API_BASE = base;
      process.env.WORKEROS_API_SECRET = "env-secret";
      const program = buildCliProgram("floom");
      program.exitOverride();
      await program.parseAsync(["node", "floom", "--user", "carol@example.com", "whoami", "--json"]);
    } finally {
      server.close();
    }
    const infoReq = seen.find((r) => r.path === "/system/info");
    assert.ok(infoReq, "expected a /system/info request");
    assert.equal(infoReq.headers["x-floom-secret"], "env-secret");
    assert.equal(infoReq.headers["x-floom-user"], "carol@example.com");
  });
});

test("MCP server sends x-floom-user on API calls in OSS mode", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await mkdtemp(join(tmpdir(), "wos-user-srv-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WORKEROS_API_TOKEN;
  env.WORKEROS_API_BASE = base;
  env.WORKEROS_API_SECRET = "env-secret";
  env.WORKEROS_USER = "dave@example.com";

  const client = new Client({ name: "user-header-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env });
  await client.connect(transport);
  try {
    await client.callTool({ name: "workers.list", arguments: {} });
  } finally {
    await client.close();
    server.close();
  }
  const apiReqs = seen.filter((r) => r.headers["x-floom-secret"]);
  assert.ok(apiReqs.length >= 1, "expected at least one authenticated API request");
  for (const r of apiReqs) {
    assert.equal(r.headers["x-floom-user"], "dave@example.com", `missing x-floom-user on ${r.method} ${r.path}`);
  }
});
