// #1455: the MCP server must send x-workeros-workspace on worker mutations in
// cloud mode (it omitted it before, so every cloud worker write 400'd). This
// drives the real built dist/server.js over stdio against a mock API and asserts
// the header (and the PAT) arrive on each worker-write request.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WS = "ws_test_123";
const PAT = "wos_test_pat";

const workerYaml = `schema_version: "0.3"
name: ws-header-worker
title: WS Header Worker
description: Worker for the #1455 workspace-header test.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs:
    - name: result
      type: string
`;
const runPy = `def run(inputs, context):\n    return {"result": "ok"}\n`;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMock() {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ method: req.method, path: url.pathname, headers: req.headers });
    // Minimal happy-path responses so the tools complete.
    if (req.method === "POST" && url.pathname.endsWith("/workers")) {
      return json(res, 200, { id: "ws-header-worker", name: "WS Header Worker" });
    }
    if (url.pathname.includes("/workers/")) {
      return json(res, 200, { id: "ws-header-worker", name: "WS Header Worker" });
    }
    return json(res, 200, { ok: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("#1455 MCP sends x-workeros-workspace on worker writes in cloud mode", async () => {
  const mock = await startMock();
  const home = await mkdtemp(join(tmpdir(), "wos-wsh-"));
  // Clean env: cloud mode via PAT + workspace id, NO api secret, isolated HOME so
  // no real credentials.json interferes.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WORKEROS_API_SECRET;
  delete env.FLOOM_API_SECRET;
  env.WORKEROS_API_BASE = mock.baseUrl;
  env.WORKEROS_API_TOKEN = PAT;
  env.WORKEROS_WORKSPACE_ID = WS;

  const client = new Client({ name: "wsh-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env });
  await client.connect(transport);
  try {
    await client.callTool({ name: "workers.create", arguments: { worker_yml: workerYaml, run_py: runPy } });
    await client.callTool({ name: "workers.update", arguments: { id: "ws-header-worker", trigger_type: "manual" } });
    await client.callTool({ name: "workers.delete", arguments: { id: "ws-header-worker" } });
  } finally {
    await client.close();
    mock.server.close();
  }

  // Every request the MCP server made to a /workers route must carry BOTH the PAT
  // and the workspace header (the bug: the header was missing on these).
  const workerReqs = mock.seen.filter((r) => r.path.includes("/workers"));
  assert.ok(workerReqs.length >= 1, "expected at least one /workers request");
  for (const r of workerReqs) {
    assert.equal(r.headers["x-workeros-workspace"], WS, `missing/wrong workspace header on ${r.method} ${r.path}`);
    assert.equal(r.headers["x-floom-token"], PAT, `missing PAT on ${r.method} ${r.path}`);
  }
});

test("#1455 reads also carry the workspace header (consistency)", async () => {
  const mock = await startMock();
  const home = await mkdtemp(join(tmpdir(), "wos-wsh-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WORKEROS_API_SECRET;
  delete env.FLOOM_API_SECRET;
  env.WORKEROS_API_BASE = mock.baseUrl;
  env.WORKEROS_API_TOKEN = PAT;
  env.WORKEROS_WORKSPACE_ID = WS;

  const client = new Client({ name: "wsh-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env });
  await client.connect(transport);
  try {
    await client.callTool({ name: "workers.list", arguments: {} });
  } finally {
    await client.close();
    mock.server.close();
  }
  const reqs = mock.seen.filter((r) => r.path.includes("/workers"));
  assert.ok(reqs.length >= 1);
  for (const r of reqs) {
    assert.equal(r.headers["x-workeros-workspace"], WS);
  }
});
