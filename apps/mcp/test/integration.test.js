import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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
  runner: local
  inputs:
    - name: message
      type: string
      required: false
  outputs:
    - name: result
      type: string
`;

const runPy = `def run(inputs, context):
    return {"result": inputs.get("message", "ok")}
`;

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

function makeWorkerDetail(id) {
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
  };
}

async function startMockApi() {
  const seen = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers["x-floom-secret"], "test-secret");
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);

    if (request.method === "GET" && url.pathname === "/workers") {
      json(response, 200, []);
      return;
    }

    if (request.method === "POST" && url.pathname === "/workers") {
      const body = await readBody(request);
      assert.equal(body.worker_yml, workerYaml);
      assert.equal(body.run_py, runPy);
      json(response, 200, makeWorkerDetail("mcp-test-worker"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/workers/mcp-test-worker/runs") {
      const body = await readBody(request);
      assert.deepEqual(body.inputs, { message: "hello" });
      json(response, 200, { status: "running", run_id: "run_test" });
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

    json(response, 404, { detail: "Not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    server,
    seen,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("workeros MCP lists, creates, runs, and reads a worker through stdio", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());

  const client = new Client({ name: "workeros-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    env: {
      ...process.env,
      WORKEROS_API_BASE: mock.baseUrl,
      WORKEROS_API_SECRET: "test-secret",
    },
  });
  t.after(async () => {
    await client.close();
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "runs.get",
    "runs.list",
    "runs.watch",
    "workers.create",
    "workers.delete",
    "workers.get",
    "workers.list",
    "workers.run",
    "workers.update",
  ]);

  const listed = await client.callTool({ name: "workers.list", arguments: {} });
  assert.deepEqual(listed.structuredContent, { data: [] });

  const created = await client.callTool({
    name: "workers.create",
    arguments: { worker_yml: workerYaml, run_py: runPy },
  });
  assert.equal(created.structuredContent.id, "mcp-test-worker");

  const run = await client.callTool({
    name: "workers.run",
    arguments: { id: "mcp-test-worker", inputs: { message: "hello" } },
  });
  assert.equal(run.structuredContent.run_id, "run_test");

  const readRun = await client.callTool({
    name: "runs.get",
    arguments: { id: "run_test" },
  });
  assert.equal(readRun.structuredContent.status, "completed");
  assert.deepEqual(readRun.structuredContent.output, { result: "hello" });

  assert.deepEqual(mock.seen, [
    "GET /workers",
    "POST /workers",
    "POST /workers/mcp-test-worker/runs",
    "GET /runs/run_test",
  ]);
});
