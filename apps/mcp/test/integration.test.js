import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
entrypoint: run.py
trigger:
  type: manual
exec:
  mode: pure-script
  entry: run.py
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

const runPy = `import json
from pathlib import Path


inputs_path = Path("inputs.json")
inputs = json.loads(inputs_path.read_text(encoding="utf-8")) if inputs_path.exists() else {}
Path("result.json").write_text(
    json.dumps({"status": "success", "outputs": {"result": inputs.get("message", "ok")}, "artifacts": [], "error": None}),
    encoding="utf-8",
)
`;

const runPyWithSecret = `import os
import json
from pathlib import Path

key = os.environ["OPENAI_API_KEY"]
Path("result.json").write_text(
    json.dumps({"status": "success", "outputs": {"result": key[:0]}, "artifacts": [], "error": None}),
    encoding="utf-8",
)
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

function assertHasCompletedStatusEvent(events) {
  assert.ok(
    events.some((event) => event.data.type === "status" && event.data.status === "completed"),
    "expected at least one completed status event",
  );
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
    runner: "e2b",
    config: {
      id,
      name: "MCP Test Worker",
      description: "Tiny worker created through the MCP integration test.",
      trigger: { type: "manual" },
      runtime: { type: "python", entrypoint: "run.py", runner: "e2b" },
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

    if (request.method === "POST" && url.pathname === "/contexts/versioned-test") {
      const body = await readBody(request);
      bodies.push(body);
      json(response, 200, {
        name: "versioned-test",
        file_count: 0,
        total_size_bytes: 0,
        updated_at: "2026-05-28T00:00:00Z",
        writeable: Boolean(body.writeable),
        sensitive: Boolean(body.sensitive),
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

    if (request.method === "POST" && url.pathname === "/workers/mcp-test-worker/share-link") {
      json(response, 200, {
        token: "fls_mcpTestShareToken",
        url: "https://floom.dev/s/fls_mcpTestShareToken",
        entity_type: "worker",
      });
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
      assert.equal(body.trigger_source, "mcp");
      json(response, 200, { status: "running", run_id: "run_test" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/telemetry/mcp-tool") {
      const body = await readBody(request);
      bodies.push(body);
      empty(response, 204);
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
        trigger_source: "mcp",
        runner: "e2b",
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

    if (request.method === "GET" && url.pathname === "/runs/run_sse_timeout/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(`data: ${JSON.stringify({ type: "status", run_id: "run_sse_timeout", status: "running" })}\n\n`);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_sse_timeout") {
      json(response, 200, {
        id: "run_sse_timeout",
        worker_id: "mcp-test-worker",
        status: "completed",
        output: { result: "finished while SSE was stale" },
      });
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

async function withClient(mock, secret, fn, entry = "dist/server.js", extraEnv = {}) {
  const client = new Client({ name: "workeros-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      WORKEROS_API_BASE: mock.baseUrl,
      WORKEROS_API_SECRET: secret,
      FLOOM_CLI_TELEMETRY_DISABLED: "1",
      ...extraEnv,
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
  const childEnv = { ...env };
  if (childEnv.HOME && !Object.hasOwn(childEnv, "XDG_CONFIG_HOME")) {
    childEnv.XDG_CONFIG_HOME = join(childEnv.HOME, ".config");
  }
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...childEnv },
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
      "workers.contract",
      "workers.list",
      "workers.run",
      "workers.share",
      "workers.templates.get",
      "workers.templates.list",
      "workers.update",
      "workers.validate",
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
    const workersRunTool = tools.tools.find((tool) => tool.name === "workers.run");
    assert.ok(workersRunTool);
    assert.equal("trigger_source" in workersRunTool.inputSchema.properties, false);

    const contract = await client.callTool({ name: "workers.contract", arguments: {} });
    assert.equal(contract.structuredContent.schema_version, "0.3");
    assert.match(contract.content[0].text, /result\.json/);

    const templates = await client.callTool({ name: "workers.templates.list", arguments: {} });
    assert.equal(templates.structuredContent.templates.some((template) => template.id === "python-script"), true);

    const template = await client.callTool({ name: "workers.templates.get", arguments: { id: "python-script" } });
    assert.match(template.structuredContent.worker_yml, /schema_version: "0\.3"/);
    assert.match(template.structuredContent.run_py, /result\.json/);

    const validation = await client.callTool({
      name: "workers.validate",
      arguments: { worker_yml: workerYaml, run_py: runPy },
    });
    assert.equal(validation.structuredContent.valid, true);

    const listed = await client.callTool({ name: "workers.list", arguments: {} });
    assert.deepEqual(listed.structuredContent, { data: [] });

    const contexts = await client.callTool({ name: "contexts.list", arguments: {} });
    assert.equal(contexts.structuredContent.data[0].name, "kb-test");

    await client.callTool({
      name: "contexts.create",
      arguments: { name: "versioned-test", writeable: true, sensitive: false },
    });
    assert.deepEqual(mock.bodies.at(-1), { writeable: true, sensitive: false });

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

    const shared = await client.callTool({ name: "workers.share", arguments: { id: "mcp-test-worker" } });
    assert.equal(shared.structuredContent.entity_type, "worker");
    assert.equal(shared.structuredContent.url, "https://floom.dev/s/fls_mcpTestShareToken");

    const run = await client.callTool({
      name: "workers.run",
      arguments: { id: "mcp-test-worker", inputs: { message: "hello" } },
    });
    assert.equal(run.structuredContent.run_id, "run_test");
    assert.equal(JSON.parse(run.content[0].text).run_id, "run_test");
    assert.doesNotMatch(run.content[0].text, /Worker run started/);

    const listedRuns = await client.callTool({ name: "runs.list", arguments: { worker_id: "mcp-test-worker" } });
    assert.equal(listedRuns.structuredContent.data[0].id, "run_test");

    const readRun = await client.callTool({ name: "runs.get", arguments: { id: "run_test" } });
    assert.equal(readRun.structuredContent.status, "completed");
    assert.deepEqual(readRun.structuredContent.output_preview.fields.result.content, "hello");
    assert.equal(readRun.structuredContent.output_preview.fields.result.truncated, false);

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
    assertHasCompletedStatusEvent(watched.structuredContent.events);

    const deleted = await client.callTool({ name: "workers.delete", arguments: { id: "mcp-test-worker" } });
    assert.deepEqual(deleted.structuredContent, {});
  });

  assert.deepEqual(mock.seen, [
    "GET /workers",
    "GET /contexts",
    "POST /contexts/versioned-test",
    "GET /contexts/kb-test",
    "GET /contexts/kb-test/files/faq.md",
    "PUT /contexts/kb-test/files/notes.txt",
    "PUT /contexts/kb-test/files/deck.pdf",
    "POST /workers",
    "GET /workers/mcp-test-worker",
    "PATCH /workers/mcp-test-worker",
    "POST /workers/mcp-test-worker/share-link",
    "POST /workers/mcp-test-worker/runs",
    "GET /runs",
    "GET /runs/run_test",
    "POST /chat",
    "GET /runs/run_test/events",
    "DELETE /workers/mcp-test-worker",
  ]);
});

test("stdio MCP emits sanitized tool telemetry", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(
    mock,
    "test-secret",
    async (client) => {
      const listed = await client.callTool({ name: "workers.list", arguments: {} });
      assert.deepEqual(listed.structuredContent, { data: [] });
    },
    "dist/server.js",
    { FLOOM_CLI_TELEMETRY_DISABLED: "0" },
  );

  assert.deepEqual(mock.seen, ["GET /workers", "POST /telemetry/mcp-tool"]);
  const event = mock.bodies.at(-1);
  assert.equal(event.tool_name, "workers.list");
  assert.equal(event.success, true);
  assert.equal(event.auth_method, "mcp_stdio");
  assert.equal(event.is_custom_tool, false);
  assert.equal(typeof event.duration_ms, "number");
  assert.equal("inputs" in event, false);
  assert.equal("arguments" in event, false);
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
    assert.match(result.content[0].text, /Worker draft validation failed/);
    assert.match(JSON.stringify(result.structuredContent.body), /schema_version/);
  });
});

test("workers.validate catches empty outputs for declared script outputs", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const result = await client.callTool({
      name: "workers.validate",
      arguments: {
        worker_yml: workerYaml,
        run_py: `import json
from pathlib import Path
Path("result.json").write_text(json.dumps({"status": "success", "outputs": {}, "artifacts": []}), encoding="utf-8")
`,
      },
    });
    assert.equal(result.structuredContent.valid, false);
    assert.match(JSON.stringify(result.structuredContent.errors), /empty outputs object/);
  });
});

test("workers.create refuses script workers that omit declared outputs", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const result = await client.callTool({
      name: "workers.create",
      arguments: {
        worker_yml: workerYaml,
        run_py: `import json
from pathlib import Path
Path("result.json").write_text(json.dumps({"status": "success", "outputs": {"other": "ok"}, "artifacts": []}), encoding="utf-8")
`,
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 400);
    assert.match(JSON.stringify(result.structuredContent.body), /declared output result does not appear in run\.py/);
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

test("runs.watch emits already-terminal final state", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_terminal", timeout_ms: 5000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assertHasCompletedStatusEvent(watched.structuredContent.events);
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

test("runs.watch does a final run status check before timing out", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_sse_timeout", timeout_ms: 1000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assert.equal(watched.structuredContent.run.output.result, "finished while SSE was stale");
  });

  const seen = mock.seen.filter((entry) => entry.includes("run_sse_timeout"));
  assert.equal(seen[0], "GET /runs/run_sse_timeout/events");
  assert.ok(seen.includes("GET /runs/run_sse_timeout"));
});

test("runs.watch polls run detail while SSE remains open and stale", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const watched = await client.callTool({ name: "runs.watch", arguments: { id: "run_sse_timeout", timeout_ms: 5000 } });
    assert.equal(watched.structuredContent.status, "completed");
    assert.equal(watched.structuredContent.run.output.result, "finished while SSE was stale");
  });

  const seen = mock.seen.filter((entry) => entry.includes("run_sse_timeout"));
  assert.equal(seen[0], "GET /runs/run_sse_timeout/events");
  assert.ok(seen.includes("GET /runs/run_sse_timeout"));
});

test("workeros CLI without a subcommand serves MCP over stdio", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "workers.list"), true);
  }, "dist/cli.js");
});

test("published workeros-mcp bin wrapper serves MCP over stdio", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  await withClient(mock, "test-secret", async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "workers.list"), true);
  }, "bin/workeros-mcp");
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
    assert.match(first.stdout, /Installed Floom MCP config for Claude Code/);
    assert.doesNotMatch(first.stdout, /test-secret/);

    const second = await runCli(["install"], env);
    assert.equal(second.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers.floom.url, "https://localhost:8000/mcp-tools/serve");
    assert.equal(config.mcpServers.floom.headers["x-floom-secret"], "test-secret");
    assert.equal(config.mcpServers.floom.command, undefined);
    assert.equal(config.mcpServers.floom.args, undefined);
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ["existing", "floom"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("credentials migrate from legacy workeros path and logout clears both paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-home-"));
  try {
    const legacyDir = join(home, ".config", "workeros");
    const floomDir = join(home, ".config", "floom");
    const legacyPath = join(legacyDir, "credentials.json");
    const floomPath = join(floomDir, "credentials.json");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(floomDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
      api_base: "http://legacy.example.test",
      api_secret: "legacy-secret",
      authed_at: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(floomPath, JSON.stringify({
      api_base: "http://new.example.test",
      mode: "oss",
      api_secret: "new-secret",
      authed_at: "2026-01-01T00:00:00.000Z",
    }));

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    try {
      const { readCredentials, clearCredentials } = await import("../dist/lib/credentials.js");
      const preferred = await readCredentials();
      assert.equal(preferred.api_base, "http://new.example.test");
      assert.equal(preferred.api_secret, "new-secret");

      await rm(floomPath, { force: true });
      const legacy = await readCredentials();
      assert.equal(legacy.api_base, "http://legacy.example.test");
      assert.equal(legacy.api_secret, "legacy-secret");

      assert.equal(await clearCredentials(), true);
      await assert.rejects(readFile(legacyPath, "utf8"));
      await assert.rejects(readFile(floomPath, "utf8"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("credentials honor XDG_CONFIG_HOME before HOME config", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-home-"));
  const xdg = await mkdtemp(join(tmpdir(), "workeros-mcp-xdg-"));
  try {
    const homeDir = join(home, ".config", "workeros");
    const xdgDir = join(xdg, "workeros");
    await mkdir(homeDir, { recursive: true });
    await mkdir(xdgDir, { recursive: true });
    await writeFile(join(homeDir, "credentials.json"), JSON.stringify({
      api_base: "http://home.example.test",
      api_secret: "home-secret",
      authed_at: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(join(xdgDir, "credentials.json"), JSON.stringify({
      api_base: "http://xdg.example.test",
      mode: "oss",
      api_secret: "xdg-secret",
      authed_at: "2026-01-01T00:00:00.000Z",
    }));

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const { readCredentials } = await import("../dist/lib/credentials.js");
      const credentials = await readCredentials();
      assert.equal(credentials.api_base, "http://xdg.example.test");
      assert.equal(credentials.api_secret, "xdg-secret");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
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
    assert.match(result.stdout, /Installed Floom MCP config for Cursor/);
    assert.doesNotMatch(result.stdout, /test-secret/);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers.floom.url, "https://localhost:8000/mcp-tools/serve");
    assert.equal(config.mcpServers.floom.headers["x-floom-secret"], "test-secret");
    assert.equal(config.mcpServers.floom.command, undefined);
    assert.equal(config.mcpServers.floom.args, undefined);
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp install generic redacts credentials by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-generic-home-"));
  try {
    const result = await runCli(["mcp", "install", "--target", "generic"], {
      HOME: home,
      WORKEROS_API_SECRET: "test-secret",
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"x-floom-secret": "<x-floom-secret>"/);
    assert.doesNotMatch(result.stdout, /test-secret/);
    assert.match(result.stdout, /Credentials are redacted by default/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp install generic requires explicit show-token for live credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-mcp-generic-show-home-"));
  try {
    const result = await runCli(["mcp", "install", "--target", "generic", "--show-token"], {
      HOME: home,
      WORKEROS_API_SECRET: "test-secret",
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"x-floom-secret": "test-secret"/);
    assert.match(result.stderr, /Printing a live credential/);
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
    assert.match(result.stdout, /"url": "https:\/\/localhost:8000\/mcp-tools\/serve"/);
    assert.match(result.stdout, /"<x-floom-secret>"/);
    assert.doesNotMatch(result.stdout, /test-secret/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
