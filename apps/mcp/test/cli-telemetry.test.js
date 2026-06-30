import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function startMockApi() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/workers/")) {
      json(response, 200, {
        id: decodeURIComponent(url.pathname.split("/").pop() || ""),
        name: "CLI Telemetry Worker",
        status: "healthy",
        trigger_type: "manual",
        enabled: true,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workers") {
      json(response, 200, []);
      return;
    }

    json(response, 404, { detail: "Not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function startMockPosthog() {
  const events = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/capture/") {
      events.push(await readBody(request));
      json(response, 200, { status: "ok" });
      return;
    }
    json(response, 404, { detail: "Not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    events,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for condition");
}

async function runCli(args, env = {}) {
  const childEnv = {
    ...process.env,
    POSTHOG_KEY: "",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    POSTHOG_HOST: "",
    ...env,
  };
  if (childEnv.HOME && !Object.hasOwn(childEnv, "XDG_CONFIG_HOME")) {
    childEnv.XDG_CONFIG_HOME = join(childEnv.HOME, ".config");
  }
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "exit");
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function packageVersion() {
  const parsed = JSON.parse(await readFile("package.json", "utf8"));
  return parsed.version;
}

test("CLI emits source-tagged command telemetry without argument values", async (t) => {
  const api = await startMockApi();
  const posthog = await startMockPosthog();
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-telemetry-home-"));
  const workerId = "worker-secretish-arg-123";
  t.after(() => api.server.close());
  t.after(() => posthog.server.close());

  const result = await runCli(["workers", "show", workerId, "--json"], {
    HOME: home,
    POSTHOG_KEY: "ph_cli_test_key",
    POSTHOG_HOST: posthog.baseUrl,
    WORKEROS_API_BASE: api.baseUrl,
    WORKEROS_API_SECRET: "test-secret",
    WORKEROS_WORKSPACE_ID: "ws_cli",
  });
  assert.equal(result.code, 0, result.stderr);

  const event = await waitFor(() => posthog.events.find((item) => item.event === "cli_command"));
  assert.equal(event.api_key, "ph_cli_test_key");
  assert.equal(event.distinct_id, "ws_cli");
  assert.equal(event.properties.command, "workers.show");
  assert.equal(event.properties.ok, true);
  assert.equal(event.properties.source, "cli");
  assert.equal(event.properties.cli_version, await packageVersion());
  assert.equal(event.properties.workspace_id, "ws_cli");
  assert.deepEqual(event.properties.$groups, { workspace: "ws_cli" });
  assert.equal(typeof event.properties.duration_ms, "number");
  assert.ok(event.properties.duration_ms >= 0);
  assert.equal(Object.hasOwn(event.properties, "arguments"), false);
  assert.equal(Object.hasOwn(event.properties, "args"), false);
  assert.equal(Object.hasOwn(event.properties, "argv"), false);
  assert.equal(JSON.stringify(event).includes(workerId), false);
});

test("CLI telemetry marks non-zero command results as not ok", async (t) => {
  const posthog = await startMockPosthog();
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-telemetry-empty-home-"));
  t.after(() => posthog.server.close());

  const result = await runCli(["whoami"], {
    HOME: home,
    POSTHOG_KEY: "ph_cli_test_key",
    POSTHOG_HOST: posthog.baseUrl,
  });
  assert.equal(result.code, 1);

  const event = await waitFor(() => posthog.events.find((item) => item.event === "cli_command"));
  assert.equal(event.properties.command, "whoami");
  assert.equal(event.properties.ok, false);
  assert.equal(event.properties.source, "cli");
  assert.match(event.distinct_id, /^mcp_anon_[a-f0-9]{24}$/);
  assert.equal(Object.hasOwn(event.properties, "workspace_id"), false);
  assert.equal(Object.hasOwn(event.properties, "$groups"), false);
});

test("CLI --no-telemetry suppresses command telemetry", async (t) => {
  const posthog = await startMockPosthog();
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-telemetry-optout-home-"));
  t.after(() => posthog.server.close());

  const result = await runCli(["--no-telemetry", "whoami"], {
    HOME: home,
    POSTHOG_KEY: "ph_cli_test_key",
    POSTHOG_HOST: posthog.baseUrl,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(posthog.events, []);
});

test("CLI telemetry honors DO_NOT_TRACK through the shared helper", async (t) => {
  const api = await startMockApi();
  const posthog = await startMockPosthog();
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-telemetry-dnt-home-"));
  t.after(() => api.server.close());
  t.after(() => posthog.server.close());

  const result = await runCli(["workers", "list", "--json"], {
    HOME: home,
    DO_NOT_TRACK: "1",
    POSTHOG_KEY: "ph_cli_test_key",
    POSTHOG_HOST: posthog.baseUrl,
    WORKEROS_API_BASE: api.baseUrl,
    WORKEROS_API_SECRET: "test-secret",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(posthog.events, []);
});
