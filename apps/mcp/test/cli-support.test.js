import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// #806 — integration tests for the `floom support` group + `floom feedback`,
// mirroring cli-workers.test.js (OSS-mode credentials + a mock HTTP API). The
// CLI hits /support/* directly in OSS mode (the /api prefix is hosted-only).

async function makeTempHome(apiBase, apiSecret = "test-secret") {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-support-home-"));
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

async function runCli(args, env = {}) {
  const childEnv = { ...env };
  if (childEnv.HOME && !Object.hasOwn(childEnv, "XDG_CONFIG_HOME")) {
    childEnv.XDG_CONFIG_HOME = join(childEnv.HOME, ".config");
  }
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKEROS_API_BASE: "",
      WORKEROS_API_SECRET: "",
      WORKEROS_API_TOKEN: "",
      FLOOM_API_BASE: "",
      FLOOM_API_SECRET: "",
      WORKEROS_SESSION_TRANSCRIPT: "",
      CLAUDE_SESSION_TRANSCRIPT: "",
      ...childEnv,
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
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const TICKET = {
  id: "tkt_1",
  workspace_id: "ws_0123456789abcd",
  opened_via: "cli",
  subject: "Login is broken",
  status: "open",
  severity: "high",
  unread_for_opener: false,
  messages: [
    { id: "m1", author_kind: "opener", body: "It fails", created_at: "2026-06-27T00:00:00Z" },
    { id: "m2", author_kind: "staff", body: "Looking into it", created_at: "2026-06-27T01:00:00Z" },
  ],
};

async function startMockApi({ getTicketStatus = 200 } = {}) {
  const seen = [];
  const bodies = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);

    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/support/tickets") {
      bodies.push(await readBody(request));
      json(response, 201, { ...TICKET, subject: "Filed" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/support/tickets") {
      json(response, 200, { tickets: [{ ...TICKET, unread_for_opener: true }], unread_count: 1 });
      return;
    }
    if (request.method === "GET" && url.pathname === "/support/tickets/tkt_1") {
      if (getTicketStatus !== 200) {
        json(response, getTicketStatus, { detail: "ticket not found" });
        return;
      }
      json(response, 200, TICKET);
      return;
    }
    if (request.method === "POST" && url.pathname === "/support/tickets/tkt_1/messages") {
      bodies.push(await readBody(request));
      json(response, 201, TICKET);
      return;
    }
    if (request.method === "POST" && url.pathname === "/support/tickets/tkt_1/ack") {
      json(response, 200, { ...TICKET, unread_for_opener: false });
      return;
    }
    json(response, 404, { detail: "Not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, seen, bodies, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("support file posts a ticket with opened_via=cli and prints the deep link", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(
    ["support", "file", "--subject", "Login is broken", "--body", "It fails", "--severity", "high"],
    { HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Filed ticket tkt_1/);
  assert.match(result.stdout, /\/app\/support\/tkt_1/);
  assert.deepEqual(mock.seen, ["POST /support/tickets"]);
  assert.deepEqual(mock.bodies[0], {
    subject: "Login is broken",
    body: "It fails",
    severity: "high",
    opened_via: "cli",
  });
});

test("support file folds --operation/--error-code into the first message body", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(
    ["support", "file", "--subject", "Run failed", "--operation", "worker.run", "--error-code", "E_TIMEOUT"],
    { HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(mock.bodies[0].body, /Operation: worker\.run/);
  assert.match(mock.bodies[0].body, /Error code: E_TIMEOUT/);
});

test("support file requires a subject", async () => {
  const result = await runCli(["support", "file", "--body", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /required option .*--subject|--subject is required/);
});

test("support file requires body or context", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["support", "file", "--subject", "Empty"], { HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Provide --body/);
  assert.deepEqual(mock.seen, []);
});

test("support file rejects an invalid severity before the request", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(
    ["support", "file", "--subject", "x", "--body", "y", "--severity", "urgent"],
    { HOME: home },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--severity must be one of/);
  assert.deepEqual(mock.seen, []);
});

test("support list renders a table and the unread count", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["support", "list"], { HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /tkt_1/);
  assert.match(result.stdout, /unread replies/);
  assert.deepEqual(mock.seen, ["GET /support/tickets"]);
});

test("support get renders the message thread", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["support", "get", "tkt_1"], { HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Login is broken/);
  assert.match(result.stdout, /Support · 2026-06-27T01:00:00Z/);
  assert.match(result.stdout, /Looking into it/);
});

test("support get reports a missing ticket as not found", async (t) => {
  const mock = await startMockApi({ getTicketStatus: 404 });
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["support", "get", "tkt_1"], { HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Ticket 'tkt_1' not found/);
});

test("support reply requires --body and posts a message", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const missing = await runCli(["support", "reply", "tkt_1"], { HOME: home });
  assert.equal(missing.code, 1);

  const ok = await runCli(["support", "reply", "tkt_1", "--body", "thanks"], { HOME: home });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Replied to tkt_1/);
  assert.deepEqual(mock.bodies[0], { body: "thanks" });
});

test("support ack clears the unread flag", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["support", "ack", "tkt_1"], { HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Cleared unread flag on tkt_1/);
  assert.deepEqual(mock.seen, ["POST /support/tickets/tkt_1/ack"]);
});

test("feedback files a ticket with the session transcript attached", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);
  const transcriptPath = join(home, "session.jsonl");
  await writeFile(transcriptPath, '{"role":"user","content":"UNIQUE_TRANSCRIPT_MARKER"}\n');

  const result = await runCli(
    ["feedback", "--message", "The output was wrong", "--transcript", transcriptPath],
    { HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Filed feedback tkt_1/);
  assert.match(result.stdout, /session transcript/i);
  const body = mock.bodies[0];
  assert.equal(body.opened_via, "cli");
  assert.equal(body.subject, "The output was wrong");
  assert.match(body.body, /The output was wrong/);
  assert.match(body.body, /UNIQUE_TRANSCRIPT_MARKER/);
});

test("feedback --no-transcript files without a transcript", async (t) => {
  const mock = await startMockApi();
  t.after(() => mock.server.close());
  // Temp HOME → no ~/.claude/projects to auto-locate, and --no-transcript skips
  // the lookup entirely, so the body is exactly the message.
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(
    ["feedback", "--message", "Just a note", "--no-transcript"],
    { HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  const body = mock.bodies[0];
  assert.equal(body.body, "Just a note");
});
