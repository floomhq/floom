import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCredentials } from "../dist/lib/credentials.js";
import {
  runsApproveCommand,
  runsCancelCommand,
  runsRejectCommand,
} from "../dist/commands/runs.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-runs-actions-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = originalHome;
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function startMockApi() {
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const body = request.method === "POST" ? await readBody(request) : {};
    calls.push({ method: request.method, path: url.pathname, body, headers: request.headers });
    if (request.headers["x-floom-secret"] !== "test-secret") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", run_id: "run_followup" }));
  });
  server.listen(0);
  await once(server, "listening");
  return { server, calls, base: `http://127.0.0.1:${server.address().port}` };
}

test("runs approve posts to run approval endpoint with comment and edited output", async () => {
  await withTempHome(async () => {
    const mock = await startMockApi();
    try {
      await writeCredentials({
        api_base: mock.base,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      const code = await runsApproveCommand("run_1", {
        comment: "looks good",
        edit: "{\"answer\":42}",
      });
      assert.equal(code, 0);
      assert.equal(mock.calls[0].method, "POST");
      assert.equal(mock.calls[0].path, "/runs/run_1/approve");
      assert.deepEqual(mock.calls[0].body, {
        comment: "looks good",
        edited_output: { answer: 42 },
      });
    } finally {
      mock.server.close();
    }
  });
});

test("runs reject and cancel post to lifecycle endpoints", async () => {
  await withTempHome(async () => {
    const mock = await startMockApi();
    try {
      await writeCredentials({
        api_base: mock.base,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      assert.equal(await runsRejectCommand("run_2", { reason: "wrong" }), 0);
      assert.equal(await runsCancelCommand("run_3", {}), 0);
      assert.equal(mock.calls[0].path, "/runs/run_2/reject");
      assert.deepEqual(mock.calls[0].body, { reason: "wrong" });
      assert.equal(mock.calls[1].path, "/runs/run_3/cancel");
      assert.deepEqual(mock.calls[1].body, {});
    } finally {
      mock.server.close();
    }
  });
});
