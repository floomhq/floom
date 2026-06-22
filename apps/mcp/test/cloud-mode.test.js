import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readCredentials,
  updateCredentials,
  writeCredentials,
} from "../dist/lib/credentials.js";
import {
  FloomApiClient,
  FloomApiError,
  createAuthenticatedClient,
  resolveLoginApiBase,
} from "../dist/lib/api.js";
import { doctorCommand } from "../dist/commands/doctor.js";
import { acquireLoginLock, cloudRateLimitRetryMs, resolveInitialCloudWorkspace } from "../dist/commands/login.js";

test("cloud login honors Retry-After headers on cli-exchange 429", () => {
  const error = new FloomApiError(
    "rate limited",
    429,
    { detail: { retry_after: 60 } },
    new Headers({ "Retry-After": "17" }),
  );

  assert.equal(cloudRateLimitRetryMs(error, 2), 17_000);
});

test("cloud login falls back to structured retry_after body on cli-exchange 429", () => {
  const error = new FloomApiError("rate limited", 429, {
    detail: { retry_after: 42 },
  });

  assert.equal(cloudRateLimitRetryMs(error, 2), 42_000);
});

test("cloud login treats cli-exchange 429 without retry metadata as slow_down", () => {
  const error = new FloomApiError("rate limited", 429, {});

  assert.equal(cloudRateLimitRetryMs(error, 2), 5_000);
});

test("login lock blocks concurrent local login flows", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-login-lock-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const release = await acquireLoginLock();
  try {
    await assert.rejects(
      () => acquireLoginLock(),
      /Another .* login is already running/,
    );
  } finally {
    await release();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  }
});

test("cloud login defaults to hosted Floom API", () => {
  const originalBase = process.env.WORKEROS_API_BASE;
  const originalFloomBase = process.env.FLOOM_API_BASE;
  const originalCloud = process.env.WORKEROS_CLOUD;
  try {
    delete process.env.WORKEROS_API_BASE;
    delete process.env.FLOOM_API_BASE;
    delete process.env.WORKEROS_CLOUD;
    assert.equal(resolveLoginApiBase({ cloud: true }), "https://workeros-api.floom.dev");
    process.env.WORKEROS_CLOUD = "1";
    assert.equal(resolveLoginApiBase(), "https://workeros-api.floom.dev");
  } finally {
    if (originalBase === undefined) delete process.env.WORKEROS_API_BASE;
    else process.env.WORKEROS_API_BASE = originalBase;
    if (originalFloomBase === undefined) delete process.env.FLOOM_API_BASE;
    else process.env.FLOOM_API_BASE = originalFloomBase;
    if (originalCloud === undefined) delete process.env.WORKEROS_CLOUD;
    else process.env.WORKEROS_CLOUD = originalCloud;
  }
});

test("cloud login can persist api_token credentials from cli-exchange", () => {
  const src = readFileSync(new URL("../src/commands/login.ts", import.meta.url), "utf8");
  assert.match(src, /api_token: exchanged\.api_token/);
  assert.match(src, /if \(exchanged\.api_token\)/);
});

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-cloud-"));
  const originalHome = process.env.HOME;
  const originalToken = process.env.WORKEROS_API_TOKEN;
  const originalBase = process.env.WORKEROS_API_BASE;
  const originalWorkspace = process.env.WORKEROS_WORKSPACE_ID;
  const originalCloud = process.env.WORKEROS_CLOUD;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    if (originalToken === undefined) delete process.env.WORKEROS_API_TOKEN;
    else process.env.WORKEROS_API_TOKEN = originalToken;
    if (originalBase === undefined) delete process.env.WORKEROS_API_BASE;
    else process.env.WORKEROS_API_BASE = originalBase;
    if (originalWorkspace === undefined) delete process.env.WORKEROS_WORKSPACE_ID;
    else process.env.WORKEROS_WORKSPACE_ID = originalWorkspace;
    if (originalCloud === undefined) delete process.env.WORKEROS_CLOUD;
    else process.env.WORKEROS_CLOUD = originalCloud;
  }
}

test("readCredentials back-compat treats legacy schema as OSS mode", async () => {
  await withTempHome(async () => {
    // Legacy schema: api_base + api_secret + authed_at, no `mode` field.
    await writeCredentials({
      api_base: "https://localhost:8000",
      mode: "oss",
      api_secret: "legacy-secret",
      authed_at: new Date().toISOString(),
    });
    const creds = await readCredentials();
    assert.ok(creds);
    assert.equal(creds.mode, "oss");
    assert.equal(creds.api_secret, "legacy-secret");
    assert.equal(creds.workspace_id, undefined);
  });
});

test("readCredentials rejects cloud creds missing refresh_token", async () => {
  await withTempHome(async () => {
    await writeCredentials({
      api_base: "https://workeros-api.floom.dev",
      mode: "cloud",
      // refresh_token + supabase_url intentionally omitted
      authed_at: new Date().toISOString(),
    });
    const creds = await readCredentials();
    assert.equal(creds, null);
  });
});

test("updateCredentials persists workspace_id without dropping refresh_token", async () => {
  await withTempHome(async () => {
    await writeCredentials({
      api_base: "https://workeros-api.floom.dev",
      mode: "cloud",
      refresh_token: "rt-1",
      supabase_url: "https://abc.supabase.co",
      supabase_anon_key: "anon-key",
      authed_at: new Date().toISOString(),
    });
    await updateCredentials({ workspace_id: "ws_test123", workspace_name: "Test WS" });
    const creds = await readCredentials();
    assert.ok(creds);
    assert.equal(creds.workspace_id, "ws_test123");
    assert.equal(creds.workspace_name, "Test WS");
    assert.equal(creds.refresh_token, "rt-1");
  });
});

test("readCredentials accepts cloud PAT from environment", async () => {
  await withTempHome(async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    process.env.WORKEROS_API_TOKEN = "floom_pat_123";
    process.env.WORKEROS_WORKSPACE_ID = "ws_env";
    const creds = await readCredentials();
    assert.ok(creds);
    assert.equal(creds.mode, "cloud");
    assert.equal(creds.api_base, "https://workeros-api.floom.dev");
    assert.equal(creds.api_token, "floom_pat_123");
    assert.equal(creds.workspace_id, "ws_env");
  });
});

test("WORKEROS_CLOUD=1 does not silently reuse saved OSS credentials", async () => {
  await withTempHome(async () => {
    await writeCredentials({
      api_base: "https://localhost:8000",
      mode: "oss",
      api_secret: "legacy-secret",
      authed_at: new Date().toISOString(),
    });
    process.env.WORKEROS_CLOUD = "1";
    const creds = await readCredentials();
    assert.equal(creds, null);
  });
});

async function startMockSupabase() {
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url && req.url.startsWith("/auth/v1/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "jwt-abc",
            refresh_token: "rt-2", // rotated
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.listen(0);
  await once(server, "listening");
  return { server, port: server.address().port, seen };
}

async function startMockApi() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === "/api/workers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "w_1", name: "Test", status: "healthy" }]));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0);
  await once(server, "listening");
  return { server, port: server.address().port, seen };
}

async function startMockWorkspaceApi(responseBody, status = 200) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === "/api/workspaces") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0);
  await once(server, "listening");
  return { server, port: server.address().port, seen };
}

async function startMockDoctorApi() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "test" }));
      return;
    }
    if (req.url === "/api/system/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/runs?limit=1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0);
  await once(server, "listening");
  return { server, port: server.address().port, seen };
}

test("cloud login resolver selects API active_id workspace", async () => {
  const api = await startMockWorkspaceApi({
    active_id: "ws_active",
    workspaces: [
      { id: "ws_other", name: "Other" },
      { id: "ws_active", name: "Default Team" },
    ],
  });
  try {
    const workspace = await resolveInitialCloudWorkspace({
      api_base: `http://127.0.0.1:${api.port}`,
      mode: "cloud",
      api_token: "pat-test",
      authed_at: new Date().toISOString(),
    });
    assert.deepEqual(workspace, { id: "ws_active", name: "Default Team" });
    const call = api.seen.find((r) => r.url === "/api/workspaces");
    assert.ok(call, "expected hosted /api/workspaces call");
    assert.equal(call.headers["x-floom-token"], "pat-test");
  } finally {
    api.server.close();
  }
});

test("cloud login resolver selects sole workspace when active_id is absent", async () => {
  const api = await startMockWorkspaceApi({
    active_id: null,
    workspaces: [{ id: "ws_only", name: "Only Team" }],
  });
  try {
    const workspace = await resolveInitialCloudWorkspace({
      api_base: `http://127.0.0.1:${api.port}`,
      mode: "cloud",
      api_token: "pat-test",
      authed_at: new Date().toISOString(),
    });
    assert.deepEqual(workspace, { id: "ws_only", name: "Only Team" });
  } finally {
    api.server.close();
  }
});

test("cloud login resolver keeps login non-fatal when workspace lookup fails", async () => {
  const api = await startMockWorkspaceApi({ detail: "boom" }, 500);
  try {
    const workspace = await resolveInitialCloudWorkspace({
      api_base: `http://127.0.0.1:${api.port}`,
      mode: "cloud",
      api_token: "pat-test",
      authed_at: new Date().toISOString(),
    });
    assert.equal(workspace, null);
  } finally {
    api.server.close();
  }
});

test("cloud client sends JWT + X-Workeros-Workspace and rewrites /workers to /api/workers", async () => {
  await withTempHome(async () => {
    const supa = await startMockSupabase();
    const api = await startMockApi();
    try {
      await writeCredentials({
        api_base: `http://127.0.0.1:${api.port}`,
        mode: "cloud",
        refresh_token: "rt-1",
        supabase_url: `http://127.0.0.1:${supa.port}`,
        supabase_anon_key: "anon-key",
        workspace_id: "ws_42",
        workspace_name: "Workspace 42",
        authed_at: new Date().toISOString(),
      });
      const { client } = await createAuthenticatedClient();
      const workers = await client.requestJson("GET", "/workers");
      assert.deepEqual(workers, [{ id: "w_1", name: "Test", status: "healthy" }]);

      // Supabase was hit exactly once for refresh.
      const tokenCalls = supa.seen.filter((r) => r.url.startsWith("/auth/v1/token"));
      assert.equal(tokenCalls.length, 1);

      // API call carried Bearer JWT and workspace header.
      const workersCall = api.seen.find((r) => r.url === "/api/workers");
      assert.ok(workersCall, "expected /api/workers call (engine mounted under /api)");
      assert.equal(workersCall.headers["authorization"], "Bearer jwt-abc");
      assert.equal(workersCall.headers["x-workeros-workspace"], "ws_42");
      assert.equal(workersCall.headers["x-floom-secret"], undefined);

      // Rotated refresh token was persisted.
      const refreshed = await readCredentials();
      assert.equal(refreshed.refresh_token, "rt-2");
    } finally {
      supa.server.close();
      api.server.close();
    }
  });
});

test("cloud client sends PAT + X-Workeros-Workspace and rewrites /workers to /api/workers", async () => {
  await withTempHome(async () => {
    const api = await startMockApi();
    try {
      process.env.WORKEROS_API_BASE = `http://127.0.0.1:${api.port}`;
      process.env.WORKEROS_API_TOKEN = "floom_pat_456";
      process.env.WORKEROS_WORKSPACE_ID = "ws_pat";
      const { client } = await createAuthenticatedClient();
      const workers = await client.requestJson("GET", "/workers");
      assert.deepEqual(workers, [{ id: "w_1", name: "Test", status: "healthy" }]);

      const workersCall = api.seen.find((r) => r.url === "/api/workers");
      assert.ok(workersCall, "expected /api/workers call (engine mounted under /api)");
      assert.equal(workersCall.headers["x-floom-token"], "floom_pat_456");
      assert.equal(workersCall.headers["x-workeros-workspace"], "ws_pat");
      assert.equal(workersCall.headers["authorization"], undefined);
      assert.equal(workersCall.headers["x-floom-secret"], undefined);
    } finally {
      api.server.close();
    }
  });
});

test("doctor accepts cloud PAT credentials and uses shared client headers", async () => {
  await withTempHome(async () => {
    const api = await startMockDoctorApi();
    const originalStdout = process.stdout.write.bind(process.stdout);
    let stdout = "";
    try {
      process.env.WORKEROS_API_BASE = `http://127.0.0.1:${api.port}`;
      process.env.WORKEROS_API_TOKEN = "floom_pat_doctor";
      process.env.WORKEROS_WORKSPACE_ID = "ws_doctor";
      process.stdout.write = (chunk) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      };

      const code = await doctorCommand({ json: true });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).ok, true);

      const systemInfoCall = api.seen.find((r) => r.url === "/api/system/info");
      assert.ok(systemInfoCall, "expected cloud-rewritten /api/system/info call");
      assert.equal(systemInfoCall.headers["x-floom-token"], "floom_pat_doctor");
      assert.equal(systemInfoCall.headers["x-workeros-workspace"], "ws_doctor");
      assert.equal(systemInfoCall.headers["x-floom-secret"], undefined);

      const runsCall = api.seen.find((r) => r.url === "/api/runs?limit=1");
      assert.ok(runsCall, "expected cloud-rewritten /api/runs call");
      assert.equal(runsCall.headers["x-floom-token"], "floom_pat_doctor");
      assert.equal(runsCall.headers["x-workeros-workspace"], "ws_doctor");
      assert.equal(runsCall.headers["x-floom-secret"], undefined);
    } finally {
      process.stdout.write = originalStdout;
      api.server.close();
    }
  });
});

test("oss client sends x-floom-secret and does NOT rewrite paths", async () => {
  await withTempHome(async () => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url === "/workers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0);
    await once(server, "listening");
    try {
      await writeCredentials({
        api_base: `http://127.0.0.1:${server.address().port}`,
        mode: "oss",
        api_secret: "shared-secret",
        authed_at: new Date().toISOString(),
      });
      const { client } = await createAuthenticatedClient();
      await client.requestJson("GET", "/workers");
      const call = seen.find((r) => r.url === "/workers");
      assert.ok(call, "expected /workers call (no /api prefix in OSS mode)");
      assert.equal(call.headers["x-floom-secret"], "shared-secret");
      assert.equal(call.headers["authorization"], undefined);
      assert.equal(call.headers["x-workeros-workspace"], undefined);
    } finally {
      server.close();
    }
  });
});

test("FloomApiClient.authHeaders is callable from outside (used by SSE follow)", async () => {
  await withTempHome(async () => {
    const supa = await startMockSupabase();
    try {
      const client = new FloomApiClient(`http://127.0.0.1:9999`, {
        api_base: `http://127.0.0.1:9999`,
        mode: "cloud",
        refresh_token: "rt-1",
        supabase_url: `http://127.0.0.1:${supa.port}`,
        supabase_anon_key: "anon-key",
        workspace_id: "ws_99",
        authed_at: new Date().toISOString(),
      });
      const headers = await client.authHeaders();
      assert.equal(headers.authorization, "Bearer jwt-abc");
      assert.equal(headers["x-workeros-workspace"], "ws_99");
    } finally {
      supa.server.close();
    }
  });
});
