import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function makeTempHome(apiBase) {
  const home = await mkdtemp(join(tmpdir(), "floom-contexts-read-home-"));
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

async function runCli(args, home) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      WORKEROS_API_BASE: "",
      WORKEROS_API_SECRET: "",
      WORKEROS_API_TOKEN: "",
      FLOOM_API_BASE: "",
      FLOOM_API_SECRET: "",
      FLOOM_CLI_TELEMETRY_DISABLED: "1",
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

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMockApi(file, rawBody) {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);
    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/contexts/test-pack") {
      json(response, 200, { name: "test-pack", files: [file] });
      return;
    }
    if (request.method === "GET" && url.pathname === `/contexts/test-pack/files/${file.path}`) {
      response.writeHead(200, { "content-type": file.mime_type });
      response.end(rawBody);
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

test("contexts read prints raw JSON text instead of a binary notice", async (t) => {
  const content = '{"known_key":"known value"}\n';
  const mock = await startMockApi({
    path: "state.json",
    is_binary: false,
    mime_type: "application/json",
    size: Buffer.byteLength(content),
  }, content);
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["contexts", "read", "test-pack", "state.json"], home);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /"known_key":"known value"/);
  assert.doesNotMatch(result.stdout, /Binary file\./);
  assert.equal(result.stderr, "");
  assert.deepEqual(mock.seen, [
    "GET /contexts/test-pack",
    "GET /contexts/test-pack/files/state.json",
  ]);
});

test("contexts read prints raw markdown text instead of a binary notice", async (t) => {
  const content = "# Known heading\n\nMarkdown body.\n";
  const mock = await startMockApi({
    path: "notes.md",
    is_binary: false,
    mime_type: "text/markdown",
    size: Buffer.byteLength(content),
  }, content);
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["contexts", "read", "test-pack", "notes.md"], home);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /# Known heading/);
  assert.match(result.stdout, /Markdown body\./);
  assert.doesNotMatch(result.stdout, /Binary file\./);
  assert.equal(result.stderr, "");
});

test("contexts read reports genuinely binary files without downloading bytes", async (t) => {
  const mock = await startMockApi({
    path: "pixel.png",
    is_binary: true,
    mime_type: "image/png",
    size: 8,
    download_url: "https://example.test/download/pixel.png",
  }, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01, 0x02]));
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["contexts", "read", "test-pack", "pixel.png"], home);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Binary file\./);
  assert.match(result.stdout, /https:\/\/example\.test\/download\/pixel\.png/);
  assert.match(result.stdout, /image\/png/);
  assert.doesNotMatch(result.stdout, /PNG/);
  assert.equal(result.stderr, "");
  assert.deepEqual(mock.seen, ["GET /contexts/test-pack"]);
});

test("contexts read returns a clear non-zero error when metadata has no matching file", async (t) => {
  const mock = await startMockApi({
    path: "other.txt",
    is_binary: false,
    mime_type: "text/plain",
    size: 5,
  }, "other");
  t.after(() => mock.server.close());
  const home = await makeTempHome(mock.baseUrl);

  const result = await runCli(["contexts", "read", "test-pack", "missing.txt"], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Context file test-pack\/missing\.txt was not found\./);
  assert.deepEqual(mock.seen, ["GET /contexts/test-pack"]);
});
