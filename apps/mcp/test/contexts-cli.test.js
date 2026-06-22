// #1741: brain packs/context folders must be provisionable from the CLI, not
// only through MCP/API. These tests pin the CLI-to-REST contract.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCredentials } from "../dist/lib/credentials.js";
import {
  contextsCreateCommand,
  contextsDeleteCommand,
  contextsDeleteFileCommand,
  contextsListCommand,
  contextsReadCommand,
  contextsRollbackCommand,
  contextsUploadCommand,
  contextsVersionsCommand,
  contextsWriteCommand,
} from "../dist/commands/contexts.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "workeros-contexts-cli-"));
  const saved = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "WORKEROS_API_TOKEN",
    "WORKEROS_API_SECRET",
    "FLOOM_API_SECRET",
    "WORKEROS_API_BASE",
    "FLOOM_API_BASE",
    "WORKEROS_WORKSPACE_ID",
    "WORKEROS_WORKSPACE_NAME",
    "WORKEROS_CLOUD",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeOssCreds(apiBase) {
  await writeCredentials({
    api_base: apiBase,
    mode: "oss",
    api_secret: "test-secret",
    authed_at: new Date().toISOString(),
  });
}

async function withStubServer(fn) {
  const calls = [];
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      const body = contentType.includes("application/json") && raw.length
        ? JSON.parse(raw.toString("utf8"))
        : raw.toString("utf8");
      calls.push({ method: req.method, url: req.url, headers: req.headers });
      bodies.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");

      if (req.method === "GET" && req.url === "/contexts") {
        res.end(JSON.stringify([{ name: "crm", file_count: 1, writeable: true, sensitive: false }]));
        return;
      }
      if (req.method === "POST" && req.url === "/contexts/crm") {
        res.end(JSON.stringify({ name: "crm", files: [] }));
        return;
      }
      if (req.method === "GET" && req.url === "/contexts/crm/files/facts.md") {
        res.end(JSON.stringify({ path: "facts.md", content: "hello\n", is_binary: false }));
        return;
      }
      if (req.method === "PUT" && req.url === "/contexts/crm/files/facts.md") {
        res.end(JSON.stringify({ path: "facts.md", size: 5 }));
        return;
      }
      if (req.method === "POST" && req.url === "/contexts/crm/upload") {
        assert.match(contentType, /multipart\/form-data/);
        assert.match(body, /filename="notes.txt"/);
        assert.match(body, /path_prefix/);
        assert.match(body, /nested/);
        res.end(JSON.stringify({ written_paths: ["nested/notes.txt"] }));
        return;
      }
      if (req.method === "GET" && req.url === "/contexts/crm/versions?limit=5") {
        res.end(JSON.stringify([{ sha: "abc123", message: "context crm: update" }]));
        return;
      }
      if (req.method === "POST" && req.url === "/contexts/crm/rollback/abc123") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "DELETE" && req.url === "/contexts/crm/files/facts.md") {
        res.end(JSON.stringify({ name: "crm" }));
        return;
      }
      if (req.method === "DELETE" && req.url === "/contexts/crm?force=true") {
        res.end(JSON.stringify({ name: "crm", deleted: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, calls, bodies);
  } finally {
    server.close();
  }
}

test("contexts CLI mirrors the context REST API", async () => {
  await withTempHome(async (home) => {
    await withStubServer(async (base, calls, bodies) => {
      await writeOssCreds(base);
      const uploadFile = join(home, "notes.txt");
      await writeFile(uploadFile, "notes");

      assert.equal(await contextsListCommand({ json: true }), 0);
      assert.equal(await contextsCreateCommand("crm", { writeable: true, sensitive: false, json: true }), 0);
      assert.equal(await contextsReadCommand("crm", "facts.md", { json: true }), 0);
      assert.equal(await contextsWriteCommand("crm", "facts.md", { content: "hello", json: true }), 0);
      assert.equal(await contextsUploadCommand("crm", uploadFile, { path: "nested/notes.txt", json: true }), 0);
      assert.equal(await contextsVersionsCommand("crm", { limit: 5, json: true }), 0);
      assert.equal(await contextsRollbackCommand("crm", "abc123", { json: true }), 0);
      assert.equal(await contextsDeleteFileCommand("crm", "facts.md", { json: true }), 0);
      assert.equal(await contextsDeleteCommand("crm", { force: true, json: true }), 0);

      assert.equal(calls[0].headers["x-floom-secret"], "test-secret");
      assert.deepEqual(
        bodies.find((call) => call.method === "POST" && call.url === "/contexts/crm")?.body,
        { writeable: true, sensitive: false },
      );
      assert.deepEqual(
        bodies.find((call) => call.method === "PUT" && call.url === "/contexts/crm/files/facts.md")?.body,
        { content: "hello" },
      );
      assert.ok(calls.some((call) => call.method === "DELETE" && call.url === "/contexts/crm?force=true"));
    });
  });
});
