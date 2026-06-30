import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FloomApiClient } from "../dist/lib/api.js";
import { getAnonymousDistinctId } from "../dist/lib/telemetry-config.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "floom-telemetry-"));
  const saved = {};
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "DO_NOT_TRACK"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("anonymous distinct_id is stable per install", async () => {
  await withTempHome(async (home) => {
    const first = await getAnonymousDistinctId();
    const second = await getAnonymousDistinctId();
    assert.equal(first, second);
    assert.match(first, /^anon_[0-9a-f-]{36}$/);
    const raw = await readFile(join(home, ".config", "floom", "telemetry.json"), "utf8");
    assert.equal(JSON.parse(raw).anonymous_distinct_id, first);
  });
});

test("Node CLI API client sends source and DNT headers", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: new URL(req.url, "http://127.0.0.1").pathname, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  await withTempHome(async () => {
    process.env.DO_NOT_TRACK = "1";
    const client = new FloomApiClient(base, {
      api_base: base,
      mode: "oss",
      api_secret: "test-secret",
      authed_at: new Date().toISOString(),
    });
    await client.requestJson("GET", "/system/info");
  });
  server.close();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-floom-source"], "cli");
  assert.equal(seen[0].headers["x-floom-do-not-track"], "1");
});
