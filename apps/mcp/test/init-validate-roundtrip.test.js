import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function runCli(args) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FLOOM_CLI_TELEMETRY_DISABLED: "1" },
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

test("every worker template initializes to a valid worker", async () => {
  const listed = await runCli(["workers", "templates", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr || listed.stdout);
  const templates = JSON.parse(listed.stdout).templates;
  assert.ok(templates.length > 0, "listWorkerTemplates() returned no templates");

  for (const template of templates) {
    const dir = await mkdtemp(join(tmpdir(), `floom-init-${template.id}-`));
    const initialized = await runCli(["init", dir, "--template", template.id, "--json"]);
    assert.equal(initialized.code, 0, `${template.id} init failed: ${initialized.stderr || initialized.stdout}`);

    const validated = await runCli(["workers", "validate", dir, "--json"]);
    assert.equal(validated.code, 0, `${template.id} validate failed: ${validated.stderr || validated.stdout}`);
    const result = JSON.parse(validated.stdout);
    assert.equal(result.valid, true, `${template.id} validation errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, [], `${template.id} returned validation errors`);
  }
});
