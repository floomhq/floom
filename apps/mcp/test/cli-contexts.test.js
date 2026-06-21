import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// #1741 — `floom contexts` headless brain-pack provisioning.

async function makeTempHome(apiBase, apiSecret = "test-secret") {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-contexts-home-"));
  const configDir = join(home, ".config", "floom");
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

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMockApi() {
  const seen = [];
  const state = { contexts: { existing: { files: {} } }, lastPut: null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);

    if (request.headers["x-floom-secret"] !== "test-secret") {
      json(response, 401, { detail: "Unauthorized" });
      return;
    }

    // List
    if (request.method === "GET" && url.pathname === "/contexts") {
      json(response, 200, Object.keys(state.contexts).map((name) => ({
        name,
        file_count: Object.keys(state.contexts[name].files).length,
        total_size_bytes: 0,
        writeable: false,
      })));
      return;
    }

    // Create
    let match = url.pathname.match(/^\/contexts\/([^/]+)$/);
    if (match && request.method === "POST") {
      const name = decodeURIComponent(match[1]);
      if (state.contexts[name]) {
        json(response, 409, { detail: "Context already exists" });
        return;
      }
      await readRawBody(request);
      state.contexts[name] = { files: {} };
      json(response, 200, { name, file_count: 0, total_size_bytes: 0, writeable: false, files: [] });
      return;
    }

    // Get detail
    if (match && request.method === "GET") {
      const name = decodeURIComponent(match[1]);
      const ctx = state.contexts[name];
      if (!ctx) {
        json(response, 404, { detail: "Context not found" });
        return;
      }
      const files = Object.entries(ctx.files).map(([path, bytes]) => ({
        path, size: bytes.length, mime_type: "text/plain", is_binary: false,
      }));
      json(response, 200, {
        name, file_count: files.length, total_size_bytes: 0, writeable: false, files,
      });
      return;
    }

    // Delete
    if (match && request.method === "DELETE") {
      const name = decodeURIComponent(match[1]);
      if (!state.contexts[name]) {
        json(response, 404, { detail: "Context not found" });
        return;
      }
      delete state.contexts[name];
      json(response, 200, { status: "deleted", referenced_by: [] });
      return;
    }

    // File PUT / GET
    match = url.pathname.match(/^\/contexts\/([^/]+)\/files\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const filePath = match[2].split("/").map(decodeURIComponent).join("/");
      const ctx = state.contexts[name];
      if (!ctx) {
        json(response, 404, { detail: "Context not found" });
        return;
      }
      if (request.method === "PUT") {
        const body = await readRawBody(request);
        state.lastPut = { contentType: request.headers["content-type"], body };
        ctx.files[filePath] = body;
        json(response, 200, { path: filePath, size: body.length, mime_type: "text/plain", is_binary: false, updated_at: "now" });
        return;
      }
      if (request.method === "GET") {
        const bytes = ctx.files[filePath];
        if (!bytes) {
          json(response, 404, { detail: "File not found" });
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(bytes);
        return;
      }
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
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("contexts create then push uploads file bytes verbatim", async () => {
  const api = await startMockApi();
  try {
    const home = await makeTempHome(api.baseUrl);
    const created = await runCli(["contexts", "create", "crm-brain"], { HOME: home });
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /Created context crm-brain/);
    assert.ok(api.state.contexts["crm-brain"], "context was created server-side");

    const localFile = join(home, "playbook.md");
    await writeFile(localFile, "# CRM Playbook\nalways follow up.\n");
    const pushed = await runCli(
      ["contexts", "push", "crm-brain", "docs/playbook.md", localFile],
      { HOME: home },
    );
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.match(pushed.stdout, /Pushed docs\/playbook\.md to context crm-brain/);
    // The raw bytes must round-trip (not JSON-wrapped).
    assert.equal(
      api.state.contexts["crm-brain"].files["docs/playbook.md"].toString("utf8"),
      "# CRM Playbook\nalways follow up.\n",
    );
    assert.ok(api.seen.includes("PUT /contexts/crm-brain/files/docs/playbook.md"));
    assert.ok(!(api.state.lastPut.contentType || "").includes("application/json"));
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
});

test("contexts list shows created contexts", async () => {
  const api = await startMockApi();
  try {
    const home = await makeTempHome(api.baseUrl);
    const result = await runCli(["contexts", "list"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /existing/);
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
});

test("contexts pull downloads a file", async () => {
  const api = await startMockApi();
  try {
    api.state.contexts.existing.files["notes.txt"] = Buffer.from("hello world");
    const home = await makeTempHome(api.baseUrl);
    const dest = join(home, "out.txt");
    const result = await runCli(
      ["contexts", "pull", "existing", "notes.txt", "-o", dest],
      { HOME: home },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(dest, "utf8"), "hello world");
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
});

test("contexts push to a missing context reports 404", async () => {
  const api = await startMockApi();
  try {
    const home = await makeTempHome(api.baseUrl);
    const localFile = join(home, "x.txt");
    await writeFile(localFile, "data");
    const result = await runCli(
      ["contexts", "push", "ghost", "a.txt", localFile],
      { HOME: home },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not found/);
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
});

test("contexts delete removes a context with --yes", async () => {
  const api = await startMockApi();
  try {
    const home = await makeTempHome(api.baseUrl);
    const result = await runCli(["contexts", "delete", "existing", "--yes"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Deleted context existing/);
    assert.ok(!api.state.contexts.existing, "context removed server-side");
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
});
