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

async function makeTempHome(apiBase, apiSecret = "test-secret") {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-workers-home-"));
  const configDir = join(home, ".config", "workeros");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "credentials.json"), JSON.stringify({
    api_base: apiBase,
    mode: "oss",
    api_secret: apiSecret,
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
    env: {
      ...process.env,
      WORKEROS_API_BASE: "",
      WORKEROS_API_SECRET: "",
      WORKEROS_API_TOKEN: "",
      FLOOM_API_BASE: "",
      FLOOM_API_SECRET: "",
      ...env,
    },
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

async function startMockApi({ existing = false, putStatus = 200, putDetail = "Unsupported" } = {}) {
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
      json(response, 200, {
        id: "cli-test-worker",
        name: "CLI Test Worker",
        description: "CLI fixture",
        config: {
          runtime: { entrypoint: "run.py" },
          connections: [
            { app: "google_search_console", allowed_tools: ["GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"] },
            "github",
          ],
        },
        recent_runs: [],
      });
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
        json(response, putStatus, { detail: putDetail });
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

test("workers validate rejects Composio CLI subprocess in E2B worker", async () => {
  const dir = await makeWorkerDir({
    workerYml: `${scriptWorkerYml}connections: [gmail]\n`,
    run: `import subprocess\nsubprocess.run(["composio", "execute", "GMAIL_SEND_EMAIL"])\n`,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /shells out to `composio execute`/);
});

test("workers validate does not treat declared secrets as Composio tools", async () => {
  const dir = await makeWorkerDir({
    workerYml: `schema_version: "0.3"
name: cli-test-worker
title: CLI Test Worker
description: Worker used by CLI validation tests.
entrypoint: run.py
exec:
  runtime: python311
  command: python run.py
  entry: run.py
  secrets:
    - OPENAI_API_KEY
capabilities:
  secrets:
    - OPENAI_API_KEY
`,
    run: `import os\nkey = os.environ["OPENAI_API_KEY"]\n`,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Validated cli-test-worker/);
});

test("workers validate ignores inactive run.py when entrypoint is SKILL.md", async () => {
  const dir = await makeWorkerDir({
    workerYml: skillWorkerYml,
    run: `import os\nkey = os.environ["OPENAI_API_KEY"]\n`,
    skill: skillMd,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Validated cli-test-worker/);
  assert.match(result.stdout, /Source\s+SKILL.md/);
});

test("workers validate enforces structured connection tool allowlists", async () => {
  const dir = await makeWorkerDir({
    workerYml: `${scriptWorkerYml}connections:\n  - app: gmail\n    allowed_tools:\n      - GMAIL_FETCH_EMAILS\n`,
    run: `import os\nTOOL = "GMAIL_SEND_EMAIL"\nAPI = os.environ["WORKEROS_API_URL"]\nRUN = os.environ["FLOOM_RUN_ID"]\nurl = f"{API}/runs/{RUN}/composio-execute/{TOOL}"\n`,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /gmail.allowed_tools does not include it/);
});

test("workers validate accepts GSC proxy worker with long app prefix", async () => {
  const dir = await makeWorkerDir({
    workerYml: `${scriptWorkerYml}connections:\n  - app: google_search_console\n    allowed_tools:\n      - GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY\n`,
    run: `import os\nTOOL = "GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"\nAPI = os.environ["WORKEROS_API_URL"]\nRUN = os.environ["FLOOM_RUN_ID"]\nurl = f"{API}/runs/{RUN}/composio-execute/{TOOL}"\n`,
  });
  const result = await runCli(["workers", "validate", dir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Validated cli-test-worker/);
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

test("workers show renders structured connections for humans", async (t) => {
  const mock = await startMockApi({ existing: true });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["workers", "show", "cli-test-worker"], { HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Connections:/);
  assert.match(result.stdout, /google_search_console \(allowed_tools: GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY\)/);
  assert.match(result.stdout, /github/);
  assert.doesNotMatch(result.stdout, /\[object Object\]/);
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

test("workers push accepts FLOOM_API_BASE and FLOOM_API_SECRET env aliases", async (t) => {
  const mock = await startMockApi({ existing: false });
  t.after(() => mock.server.close());
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-workers-empty-home-"));
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], {
    HOME: home,
    FLOOM_API_BASE: mock.baseUrl,
    FLOOM_API_SECRET: "test-secret",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Created cli-test-worker/);
  assert.deepEqual(mock.seen, [
    "GET /workers/cli-test-worker",
    "POST /workers",
  ]);
});

test("workers push reports unreachable API separately from expired auth", async () => {
  const home = await makeTempHome("http://127.0.0.1:9");
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Workeros API is unreachable/);
  assert.match(result.stdout, /WORKEROS_API_BASE\/FLOOM_API_BASE/);
  assert.doesNotMatch(result.stderr, /session expired/i);
});

test("workers push reports 401 as expired auth", async (t) => {
  const mock = await startMockApi({ existing: false });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl, "stale-secret");
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Your session expired/);
  assert.match(result.stdout, /floom login/);
});

test("workers push does not call non-auth 403 an expired session", async (t) => {
  const mock = await startMockApi({
    existing: true,
    putStatus: 403,
    putDetail: "Stock workers cannot be modified",
  });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);
  const dir = await makeWorkerDir();

  const result = await runCli(["workers", "push", dir], { HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Request was forbidden/);
  assert.match(result.stdout, /Stock workers cannot be modified/);
  assert.doesNotMatch(result.stderr, /session expired/i);
});
