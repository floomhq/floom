import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptWorkerYml = `schema_version: "0.3"
name: cli-test-worker
title: CLI Test Worker
description: Worker used by CLI push tests.
entrypoint: run.py
exec:
  runtime: python311
  command: python run.py
  entry: run.py
`;

const skillWorkerYml = `schema_version: "0.3"
name: cli-test-worker
title: CLI Test Worker
description: Worker used by CLI push tests.
entrypoint: SKILL.md
exec:
  runtime: python311
  entry: SKILL.md
`;

const runPy = `def run(inputs, context):
    return {"ok": True}
`;

const skillMd = `# CLI Test Worker

Return a compact JSON result.
`;

async function makeTempHome(apiBase) {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-workers-home-"));
  const configDir = join(home, ".config", "workeros");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "credentials.json"), JSON.stringify({
    api_base: apiBase,
    mode: "oss",
    api_secret: "test-secret",
    authed_at: new Date().toISOString(),
  }, null, 2));
  return home;
}

async function makeWorkerDir(options = {}) {
  const workerYml = options.workerYml ?? scriptWorkerYml;
  const run = Object.hasOwn(options, "run") ? options.run : runPy;
  const skill = options.skill;
  const dir = await mkdtemp(join(tmpdir(), "workeros-cli-worker-"));
  await writeFile(join(dir, "worker.yml"), workerYml);
  if (run !== undefined) {
    await writeFile(join(dir, "run.py"), run);
  }
  if (skill !== undefined) {
    await writeFile(join(dir, "SKILL.md"), skill);
  }
  return dir;
}

async function runCli(args, env = {}) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMockApi({ existing = false, putStatus = 200 } = {}) {
  const seen = [];
  const bodies = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);

    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workers/cli-test-worker") {
      if (!existing) {
        json(response, 404, { detail: "Worker not found" });
        return;
      }
      json(response, 200, { id: "cli-test-worker", name: "CLI Test Worker" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/workers") {
      const body = await readBody(request);
      bodies.push(body);
      json(response, 200, { id: "cli-test-worker", name: "CLI Test Worker" });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/workers/cli-test-worker") {
      const body = await readBody(request);
      bodies.push(body);
      if (putStatus !== 200) {
        json(response, putStatus, { detail: "Unsupported" });
        return;
      }
      json(response, 200, { id: "cli-test-worker", name: "CLI Test Worker" });
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

test("workers validate accepts worker.yml plus run.py", async () => {
  const dir = await makeWorkerDir();
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Validated cli-test-worker/);
  assert.match(result.stdout, /Runtime\s+python311/);
  assert.equal(result.stderr, "");
});

test("workers validate rejects missing runtime", async () => {
  const dir = await makeWorkerDir({
    workerYml: "name: cli-test-worker\ntitle: CLI Test Worker\n",
    run: runPy,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /runtime field/);
});

test("workers push creates a new worker with POST /workers", async (t) => {
  const mock = await startMockApi({ existing: false });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Created cli-test-worker/);
  assert.deepEqual(mock.seen, [
    "GET /workers/cli-test-worker",
    "POST /workers",
  ]);
  assert.match(mock.bodies[0].worker_yml, /name: cli-test-worker/);
  assert.match(mock.bodies[0].run_py, /def run/);
  assert.equal(mock.bodies[0].skill_md, undefined);
});

test("workers push updates an existing worker with PUT /workers/:id", async (t) => {
  const mock = await startMockApi({ existing: true });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);
  const dir = await makeWorkerDir({ workerYml: skillWorkerYml, run: undefined, skill: skillMd });

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Updated cli-test-worker/);
  assert.deepEqual(mock.seen, [
    "GET /workers/cli-test-worker",
    "PUT /workers/cli-test-worker",
  ]);
  assert.match(mock.bodies[0].worker_yml, /entrypoint: SKILL.md/);
  assert.equal(mock.bodies[0].run_py, "");
  assert.match(mock.bodies[0].skill_md, /CLI Test Worker/);
});

test("workers push reports unsupported in-place source updates", async (t) => {
  const mock = await startMockApi({ existing: true, putStatus: 405 });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not support in-place worker source updates/);
  assert.deepEqual(mock.seen, [
    "GET /workers/cli-test-worker",
    "PUT /workers/cli-test-worker",
  ]);
});
