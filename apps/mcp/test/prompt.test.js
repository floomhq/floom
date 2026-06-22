import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { promptYesNo } from "../dist/lib/prompt.js";

function fakeTTYWritable() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  stream.text = () => chunks.join("");
  return stream;
}

function fakeTTYReadable() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

test("promptYesNo renders the question on stderr, never stdout", async () => {
  const input = fakeTTYReadable();
  const data = fakeTTYWritable(); // stands in for stdout
  const prompt = fakeTTYWritable(); // stands in for stderr

  const answered = promptYesNo("Delete worker x? [y/N] ", false, { input, data, prompt });
  // Answer once the prompt has been issued.
  setImmediate(() => input.write("y\n"));
  const result = await answered;

  assert.equal(result, true);
  assert.match(prompt.text(), /Delete worker x\?/);
  assert.doesNotMatch(data.text(), /Delete worker x\?/);
  assert.equal(data.text(), "");
});

test("promptYesNo returns the default without prompting when stdout is not a TTY", async () => {
  const input = fakeTTYReadable();
  const data = new PassThrough(); // piped stdout: isTTY is undefined
  const prompt = fakeTTYWritable();

  const result = await promptYesNo("Delete worker x? [y/N] ", false, { input, data, prompt });

  assert.equal(result, false);
  assert.equal(prompt.text(), "");
});
