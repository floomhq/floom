import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCredentials } from "../dist/lib/credentials.js";
import { runsShowCommand } from "../dist/commands/runs.js";

// #1732: `runs show` must surface the approval/review link the API now returns
// on the run's approval_trail, so an operator can approve straight from the CLI
// instead of hunting for the URL.

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-runs-show-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = originalHome;
  }
}

function startMockApi(runPayload) {
  const server = createServer((request, response) => {
    if (request.headers["x-floom-secret"] !== "test-secret") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(runPayload));
  });
  server.listen(0);
  return once(server, "listening").then(() => ({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  }));
}

async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    out += typeof chunk === "string" ? chunk : chunk.toString();
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

const LINK = "https://app.example.com/approvals/review?id=apr_1&token=deadbeef";

test("runs show prints the review/approve link when pending approval", async () => {
  await withTempHome(async () => {
    const mock = await startMockApi({
      id: "run_1",
      worker_id: "demo",
      status: "pending_approval",
      approval_trail: { id: "apr_1", status: "pending", link: LINK },
    });
    try {
      await writeCredentials({
        api_base: mock.base,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      const out = await captureStdout(async () => {
        assert.equal(await runsShowCommand("run_1", {}), 0);
      });
      assert.match(out, /Review\/approve at/);
      assert.ok(out.includes(LINK), "expected the review link in output");
    } finally {
      mock.server.close();
    }
  });
});

test("runs show omits the link when the run is not pending approval", async () => {
  await withTempHome(async () => {
    const mock = await startMockApi({
      id: "run_2",
      worker_id: "demo",
      status: "completed",
      approval_trail: { id: "apr_2", status: "approved", link: null },
    });
    try {
      await writeCredentials({
        api_base: mock.base,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      const out = await captureStdout(async () => {
        assert.equal(await runsShowCommand("run_2", {}), 0);
      });
      assert.ok(!out.includes("Review/approve at"), "should not print a link when not pending");
    } finally {
      mock.server.close();
    }
  });
});

test("runs show --json includes the approval link verbatim", async () => {
  await withTempHome(async () => {
    const mock = await startMockApi({
      id: "run_3",
      worker_id: "demo",
      status: "pending_approval",
      approval_trail: { id: "apr_3", status: "pending", link: LINK },
    });
    try {
      await writeCredentials({
        api_base: mock.base,
        mode: "oss",
        api_secret: "test-secret",
        authed_at: new Date().toISOString(),
      });
      const out = await captureStdout(async () => {
        assert.equal(await runsShowCommand("run_3", { json: true }), 0);
      });
      const parsed = JSON.parse(out);
      assert.equal(parsed.approval_trail.link, LINK);
    } finally {
      mock.server.close();
    }
  });
});
