import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("#2272 stdio MCP executes contexts.files, contexts.versions, and contexts.delete", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    seen.push({ method: request.method, path: url.pathname, search: url.search });
    if (request.method === "GET" && url.pathname === "/contexts/managed") {
      return json(response, 200, {
        name: "managed",
        files: [{ path: "nested/notes.md", size: 5, mime_type: "text/markdown" }],
      });
    }
    if (request.method === "GET" && url.pathname === "/contexts/managed/versions") {
      return json(response, 200, [{ id: "abc123", message: "context managed: update" }]);
    }
    if (request.method === "DELETE" && url.pathname === "/contexts/managed/files/nested/notes.md") {
      return json(response, 200, { status: "deleted", path: "nested/notes.md" });
    }
    if (request.method === "DELETE" && url.pathname === "/contexts/managed") {
      return json(response, 200, { status: "deleted", referenced_by: [] });
    }
    return json(response, 404, { detail: "unexpected request" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const home = await mkdtemp(join(tmpdir(), "floom-context-tools-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
  env.WORKEROS_API_BASE = `http://127.0.0.1:${server.address().port}`;
  env.WORKEROS_API_SECRET = "test-secret";
  delete env.WORKEROS_API_TOKEN;
  delete env.FLOOM_TOKEN;

  const client = new Client({ name: "context-tools-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env });
  await client.connect(transport);
  try {
    const files = await client.callTool({ name: "contexts.files", arguments: { name: "managed" } });
    assert.equal(files.isError, undefined);
    assert.deepEqual(files.structuredContent.paths, ["nested/notes.md"]);

    const versions = await client.callTool({ name: "contexts.versions", arguments: { name: "managed", limit: 7 } });
    assert.equal(versions.isError, undefined);
    assert.equal(versions.structuredContent.data[0].id, "abc123");

    const deletedFile = await client.callTool({
      name: "contexts.delete",
      arguments: { name: "managed", path: "nested/notes.md" },
    });
    assert.equal(deletedFile.isError, undefined);
    assert.equal(deletedFile.structuredContent.path, "nested/notes.md");

    const deleted = await client.callTool({ name: "contexts.delete", arguments: { name: "managed" } });
    assert.equal(deleted.isError, undefined);
    assert.equal(deleted.structuredContent.status, "deleted");
  } finally {
    await client.close();
    server.close();
  }

  assert.deepEqual(seen.filter((request) => request.path.startsWith("/contexts/")), [
    { method: "GET", path: "/contexts/managed", search: "" },
    { method: "GET", path: "/contexts/managed/versions", search: "?limit=7" },
    { method: "DELETE", path: "/contexts/managed/files/nested/notes.md", search: "" },
    { method: "DELETE", path: "/contexts/managed", search: "" },
  ]);
});
