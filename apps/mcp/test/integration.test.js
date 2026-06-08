import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workerYaml = `schema_version: "0.3"
name: mcp-test-worker
title: MCP Test Worker
description: Tiny worker created through the MCP integration test.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs:
    - name: message
      type: string
      required: false
  outputs:
    - name: result
      type: string
`;

const workerYamlWithConnection = `${workerYaml}
connections: [gmail]
`;

const runPy = `def run(inputs, context):
    return {"result": inputs.get("message", "ok")}
`;

const runPyWithSecret = `import os

def run(inputs, context):
    return {"key": os.environ["OPENAI_API_KEY"]}
`;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function empty(response, status) {
  response.writeHead(status);
  response.end();
}

function sse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readRaw(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function makeWorkerDetail(id, overrides = {}) {
  return {
    id,
    name: "MCP Test Worker",
    description: "Tiny worker created through the MCP integration test.",
    status: "healthy",
    paused: false,
    trigger_type: "manual",
    runner: "local",
    config: {
      id,
      name: "MCP Test Worker",
      description: "Tiny worker created through the MCP integration test.",
      trigger: { type: "manual" },
      runtime: { type: "python", entrypoint: "run.py", runner: "local" },
      inputs: [],
      secrets: [],
      outputs: [],
      approvals: { required: false },
    },
    recent_runs: [],
    manifest_yaml: workerYaml,
    ...overrides,
  };
}

async function startMockApi() {
  const seen = [];
  const bodies = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);

    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workers") {
      json(response, 200, []);
      return;
    }

    if (request.method === "GET" && url.pathname === "/contexts") {
      json(response, 200, [{
        name: "kb-test",
        file_count: 2,
        total_size_bytes: 32,
        updated_at: "2026-05-28T00:00:00Z",
        writeable: false,
      }]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/contexts/kb-test") {
      json(response, 200, {
        name: "kb-test",
        file_count: 2,
        total_size_bytes: 32,
        updated_at: "2026-05-28T00:00:00Z",
        writeable: false,
        files: [
          {
            path: "faq.md",
            size: 12,
            mime_type: "text/markdown",
            updated_at: "2026-05-28T00:00:00Z",
            is_binary: false,
          },
          {
            path: "deck.pdf",
            size: 20,
            mime_type: "application/pdf",
            updated_at: "2026-05-28T00:00:00Z",
            is_binary: true,
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/contexts/kb-test/files/faq.md") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end("# FAQ\n");
      return;
    }

    if (request.method === "PUT" && url.pathname === "/contexts/kb-test/files/notes.txt") {
      const body = await readBody(request);
      assert.equal(body.content, "hello context");
      json(response, 200, {
        path: "notes.txt",
        size: 13,
        mime_type: "text/plain",
        updated_at: "2026-05-28T00:00:00Z",
        is_binary: false,
      });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/contexts/kb-test/files/deck.pdf") {
      const body = await readRaw(request);
      assert.equal(body.toString("utf8"), "pdf bytes");
      json(response, 200, {
        path: "deck.pdf",
        size: body.length,
        mime_type: "application/pdf",
        updated_at: "2026-05-28T00:00:00Z",
        is_binary: true,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workers/mcp-test-worker") {
      json(response, 200, makeWorkerDetail("mcp-test-worker"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/workers") {
      const body = await readBody(request);
      bodies.push(body);
      assert.equal(body.run_py.includes("WORKEROS_API_SECRET"), false);
      if (body.worker_yml.includes("Bad Worker")) {
        json(response, 400, {
          detail: {
            message: "Schema validation failed",
            errors: [{ loc: "request", msg: "Field required", type: "missing" }],
          },
        });
        return;
      }
      json(response, 200, makeWorkerDetail("mcp-test-worker", { manifest_yaml: body.worker_yml }));
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/workers/mcp-test-worker") {
      const body = await readBody(request);
      bodies.push(body);
      assert.equal(body.trigger_type, "schedule");
      assert.equal(body.cron_expr, "0 9 * * *");
      assert.equal(body.cron_timezone, "Europe/Berlin");
      assert.deepEqual(body.input_values, { message: "scheduled" });
      assert.deepEqual(body.capabilities, { secrets: ["OPENAI_API_KEY"] });
      assert.equal(body.webhook_secret_rotate, false);
      json(response, 200, makeWorkerDetail("mcp-test-worker", { trigger_type: "schedule" }));
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/workers/missing") {
      await readBody(request);
      json(response, 404, { detail: "Worker not found" });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/workers/mcp-test-worker") {
      empty(response, 204);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/workers/missing") {
      json(response, 404, { detail: "Worker not found" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/workers/mcp-test-worker/runs") {
      const body = await readBody(request);
      assert.deepEqual(body.inputs, { message: "hello" });
      json(response, 200, { status: "running", run_id: "run_test" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      json(response, 200, [{ id: "run_test", worker_id: "mcp-test-worker", status: "completed" }]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_test") {
      json(response, 200, {
        id: "run_test",
        worker_id: "mcp-test-worker",
        status: "completed",
        trigger_source: "manual",
        runner: "local",
        input: { message: "hello" },
        output: { result: "hello" },
        output_schema: [],
        logs: [],
        artifacts: [],
        approval: null,
        approval_status: "not_required",
        error: null,
        started_at: "2026-05-26T00:00:00Z",
        completed_at: "2026-05-26T00:00:01Z",
        duration_ms: 1000,
        created_at: "2026-05-26T00:00:00Z",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_test/events") {
      sse(response, [
        { type: "status", run_id: "run_test", status: "running" },
        { type: "status", run_id: "run_test", status: "completed" },
        { type: "close" },
      ]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_terminal/events") {
      sse(response, [
        { type: "status", run_id: "run_terminal", status: "completed", completed_at: "2026-05-26T00:00:01Z" },
        { type: "close" },
      ]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_terminal_no_close/events") {
      sse(response, [
        { type: "status", run_id: "run_terminal_no_close", status: "completed", completed_at: "2026-05-26T00:00:01Z" },
      ]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/missing/events") {
      json(response, 404, { detail: "Run not found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/secret_error/events") {
      json(response, 500, { api_key: "sk-test-secret-value" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await readBody(request);
      bodies.push(body);
      sse(response, [
        { type: "text", text: "chat ok" },
        { type: "finish", conversation_id: body.conversation_id || "conv_mock", message_id: "msg_mock" },
      ]);
      return;
    }

    json(response, 404, { detail: "Not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    server,
    seen,
    bodies,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function withClient(mock, secret, fn, entry = "dist/server.js") {
  const client = new Client({ name: "workeros-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      WORKEROS_API_BASE: mock.baseUrl,
      WORKEROS_API_SECRET: secret,
    },
  });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function runCli(args, env = {}, stdin = "") {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
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

test("workeros MCP exposes context tools and covers lifecycle happy paths", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.equal(new Set(names).size, names.length);
    for (const name of [
      "connections.add_mcp",
      "connections.list",
      "contexts.create",
      "contexts.delete",
      "contexts.list",
      "contexts.read",
      "contexts.rollback",
      "contexts.upload",
      "contexts.versions",
      "contexts.write",
      "runs.get",
      "runs.list",
      "runs.watch",
      "secrets.delete",
      "secrets.list",
      "secrets.set",
      "triggers.list",
      "workers.create",
      "workers.delete",
      "workers.get",
      "workers.list",
      "workers.run",
      "workers.update",
      "workers.versions",
      "workers.write_file",
      "workspace.chat",
      "workspace.instructions.get",
      "workspace.instructions.set",
      "workspace.versions",
    ]) {
      assert.ok(names.includes(name), `expected MCP tool ${name}`);
    }
    const workersCreateTool = tools.tools.find((tool) => tool.name === "workers.create");
    assert.match(workersCreateTool.description, /schema_version/);
    assert.match(workersCreateTool.description, /exec/);
    assert.match(workersCreateTool.inputSchema.properties.worker_yml.description, /inputs\.json/);

    const listed = await client.callTool({ name: "workers.list", arguments: {} });
    assert.deepEqual(listed.structuredContent, { data: [] });

    const contexts = await client.callTool({ name: "contexts.list", arguments: {} });
    assert.equal(contexts.structuredContent.data[0].name, "kb-test");

    const contextFile = await client.callTool({ name: "contexts.read", arguments: { name: "kb-test", path: "faq.md" } });
    assert.equal(contextFile.structuredContent.content, "# FAQ\n");

    const writtenContext = await client.callTool({
      name: "contexts.write",
      arguments: { name: "kb-test", path: "notes.txt", content: "hello context" },
    });
    assert.equal(writtenContext.structuredContent.path, "notes.txt");

    const uploadedContext = await client.callTool({
      name: "contexts.upload",
      arguments: { name: "kb-test", path: "deck.pdf", base64_bytes: Buffer.from("pdf bytes").toString("base64") },
    });
    assert.equal(uploadedContext.structuredContent.is_binary, true);

    const created = await client.callTool({
      name: "workers.create",
      arguments: { worker_yml: workerYaml, run_py: runPy },
    });
    assert.equal(created.structuredContent.id, "mcp-test-worker");

    const readWorker = await client.callTool({ name: "workers.get", arguments: { id: "mcp-test-worker" } });
    assert.equal(readWorker.structuredContent.id, "mcp-test-worker");

    const updated = await client.callTool({
      name: "workers.update",
      arguments: {
        id: "mcp-test-worker",
        trigger_type: "schedule",
        cron_expr: "0 9 * * *",
        cron_timezone: "Europe/Berlin",
        input_values: { message: "scheduled" },
        capabilities: { secrets: ["OPENAI_API_KEY"] },
        webhook_secret_rotate: false,
      },
    });
    assert.equal(updated.structuredContent.trigger_type, "schedule");

    const run = await client.callTool({
      name: "workers.run",
      arguments: { id: "mcp-test-worker", inputs: { message: "hello" } },
    });
    assert.equal(run.structuredContent.run_id, "run_test");

    const listedRuns = await client.callTool({ name: "runs.list", arguments: { worker_id: "mcp-test-worker" } });
    assert.equal(listedRuns.structuredContent.data[0].id, "run_test");

    const readRun = await client.callTool({ name: "runs.get", arguments: { id: "run_test" } });
    assert.equal(readRun.structuredContent.status, "completed");
    assert.deepEqual(readRun.structuredContent.output, { result: "hello" });

    const chat = await client.callTool({
      name: "workspace.chat",
      arguments: { message: "hello", conversation_id: "mcp-thread", timeout_ms: 5000 },
    });
    assert.equal(chat.structuredContent.reply, "chat ok");
    assert.deepEqual(mock.bodies.at(-1), {
      message: "hello",
      source: "mcp",
      conversation_id: "mcp-thread",
    });

    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_test", timeout_ms: 5000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assert.deepEqual(watched.structuredContent.events.map((event) => event.data.type), ["status", "status", "close"]);

    const deleted = await client.callTool({ name: "workers.delete", arguments: { id: "mcp-test-worker" } });
    assert.deepEqual(deleted.structuredContent, {});
  });

  assert.deepEqual(mock.seen, [
    "GET /workers",
    "GET /contexts",
    "GET /contexts/kb-test",
    "GET /contexts/kb-test/files/faq.md",
    "PUT /contexts/kb-test/files/notes.txt",
    "PUT /contexts/kb-test/files/deck.pdf",
    "POST /workers",
    "GET /workers/mcp-test-worker",
    "PATCH /workers/mcp-test-worker",
    "POST /workers/mcp-test-worker/runs",
    "GET /runs",
    "GET /runs/run_test",
    "POST /chat",
    "GET /runs/run_test/events",
    "DELETE /workers/mcp-test-worker",
  ]);
});

test("workers.create renders object validation details as JSON, not object string", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const result = await client.callTool({
      name: "workers.create",
      arguments: {
        worker_yml: "name: Bad Worker\nversion: nope\n",
        run_py: "print('x')\n",
      },
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /\\[object Object\\]/);
    assert.match(result.content[0].text, /Schema validation failed/);
    assert.match(result.content[0].text, /Field required/);
  });
});

test("workers.update, workers.delete, and runs.watch surface 404s in tool results", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const update = await client.callTool({ name: "workers.update", arguments: { id: "missing", trigger_type: "manual" } });
    assert.equal(update.isError, true);
    assert.equal(update.structuredContent.status, 404);
    assert.match(update.content[0].text, /Worker not found/);

    const deleted = await client.callTool({ name: "workers.delete", arguments: { id: "missing" } });
    assert.equal(deleted.isError, true);
    assert.equal(deleted.structuredContent.status, 404);
    assert.match(deleted.content[0].text, /Worker not found/);

    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "missing", timeout_ms: 5000 } });
    assert.equal(watched.isError, true);
    assert.equal(watched.structuredContent.status, 404);
    assert.match(watched.content[0].text, /HTTP 404/);
  });
});

test("workers.update, workers.delete, and runs.watch surface auth failures in tool results", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "wrong-secret", async (client) => {
    const update = await client.callTool({ name: "workers.update", arguments: { id: "mcp-test-worker", trigger_type: "manual" } });
    assert.equal(update.isError, true);
    assert.equal(update.structuredContent.status, 401);

    const deleted = await client.callTool({ name: "workers.delete", arguments: { id: "mcp-test-worker" } });
    assert.equal(deleted.isError, true);
    assert.equal(deleted.structuredContent.status, 401);

    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_test", timeout_ms: 5000 } });
    assert.equal(watched.isError, true);
    assert.equal(watched.structuredContent.status, 401);
  });
});

test("API error text redacts secret-like response fields", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "secret_error", timeout_ms: 5000 } });
    assert.equal(watched.isError, true);
    assert.equal(watched.structuredContent.status, 500);
    assert.match(watched.content[0].text, /\[redacted\]/);
    assert.doesNotMatch(watched.content[0].text, /sk-test-secret-value/);
    assert.equal(watched.structuredContent.body.api_key, "[redacted]");
  });
});

test("runs.watch emits already-terminal final state and close event", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_terminal", timeout_ms: 5000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assert.deepEqual(watched.structuredContent.events.map((event) => event.data.type), ["status", "close"]);
  });
});

test("runs.watch returns on terminal status even without a close event", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_terminal_no_close", timeout_ms: 5000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assert.deepEqual(watched.structuredContent.events.map((event) => event.data.type), ["status"]);
  });
});

test("workeros CLI without a subcommand serves MCP over stdio", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "workers.list"), true);
  }, "dist/cli.js");
});

test("workers.create auto-fills capabilities from run.py environment variables", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const created = await client.callTool({
      name: "workers.create",
      arguments: { worker_yml: workerYaml, run_py: runPyWithSecret },
    });
    assert.equal(created.structuredContent.id, "mcp-test-worker");
  });

  assert.match(mock.bodies.at(-1).worker_yml, /capabilities:\n  secrets:\n    - OPENAI_API_KEY/);
});

test("workers.create auto-fills capabilities from worker.yml connection declarations", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const created = await client.callTool({
      name: "workers.create",
      arguments: { worker_yml: workerYamlWithConnection, run_py: runPy },
    });
    assert.equal(created.structuredContent.id, "mcp-test-worker");
  });

  assert.match(mock.bodies.at(-1).worker_yml, /capabilities:\n  connections:\n    - gmail/);
});

test("install subcommand patches agent config idempotently", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-home-"));
  try {
    const claudeDir = join(home, ".claude");
    const configPath = join(claudeDir, "settings.json");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { existing: { command: "true" } } }, null, 2));

    const env = { HOME: home, WORKEROS_API_SECRET: "test-secret" };
    const first = await runCli(["install"], env);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /Installed Workeros MCP config for Claude Code/);
    assert.doesNotMatch(first.stdout, /test-secret/);

    const second = await runCli(["install"], env);
    assert.equal(second.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers.workeros.url, "https://workers-api.floom.dev/mcp-tools/serve");
    assert.equal(config.mcpServers.workeros.headers["x-floom-secret"], "test-secret");
    assert.equal(config.mcpServers.workeros.command, undefined);
    assert.equal(config.mcpServers.workeros.args, undefined);
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ["existing", "workeros"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp add patches agent config", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-add-home-"));
  try {
    const cursorDir = join(home, ".cursor");
    const configPath = join(cursorDir, "mcp.json");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const result = await runCli(["mcp", "add", "--target", "cursor"], {
      HOME: home,
      WORKEROS_API_SECRET: "test-secret",
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Installed Workeros MCP config for Cursor/);
    assert.doesNotMatch(result.stdout, /test-secret/);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers.workeros.url, "https://workers-api.floom.dev/mcp-tools/serve");
    assert.equal(config.mcpServers.workeros.headers["x-floom-secret"], "test-secret");
    assert.equal(config.mcpServers.workeros.command, undefined);
    assert.equal(config.mcpServers.workeros.args, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install subcommand prints manual snippets when no agent config file exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-home-"));
  try {
    const result = await runCli(["install"], { HOME: home, WORKEROS_API_SECRET: "test-secret" });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No supported (agent config file|MCP client config) was found/);
    assert.match(result.stdout, /- ~\/\.claude\/settings\.json/);
    assert.match(result.stdout, /- ~\/\.cursor\/mcp\.json/);
    assert.match(result.stdout, /- ~\/\.continue\/\.continuerc\.json/);
    assert.match(result.stdout, /"url": "https:\/\/workers-api\.floom\.dev\/mcp-tools\/serve"/);
    assert.match(result.stdout, /"<x-floom-secret>"/);
    assert.doesNotMatch(result.stdout, /test-secret/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
