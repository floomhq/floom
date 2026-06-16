import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../dist/server.js";

test("redactSecrets redacts secret-looking values in non-sensitive keys", () => {
  const redacted = redactSecrets({
    message: "Authorization: Bearer abcdefghijklmnop",
    url: "https://example.com/callback?token=secret-token&ok=1",
    output: "api_key=sk-1234567890abcdef and ghp_1234567890abcdef",
    nested: [{ text: "password=hunter2" }],
  });

  const rendered = JSON.stringify(redacted);
  assert.match(rendered, /Authorization: \[redacted\]/);
  assert.match(rendered, /token=\[redacted\]/);
  assert.match(rendered, /api_key=\[redacted\]/);
  assert.match(rendered, /password=\[redacted\]/);
  assert.doesNotMatch(rendered, /abcdefghijklmnop|secret-token|hunter2|ghp_1234567890abcdef|sk-1234567890abcdef/);
});
