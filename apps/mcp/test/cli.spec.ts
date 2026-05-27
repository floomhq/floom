import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCliProgram, getPackageVersion } from "../src/cli.js";
import { runWhoamiCommand } from "../src/commands/whoami.js";
import { parseInputAssignments } from "../src/commands/run.js";

test("floom --version prints package version", async () => {
  const program = buildCliProgram();
  let stdout = "";
  program.configureOutput({ writeOut: (value) => { stdout += value; } });
  program.exitOverride();
  await assert.rejects(
    () => program.parseAsync(["node", "floom", "--version"], { from: "user" }),
    (error: unknown) => (
      error instanceof Error && "code" in error && (error as { code?: string }).code === "commander.version"
    ),
  );
  assert.match(stdout, new RegExp(getPackageVersion().replace(/\./g, "\\.")));
});

test("floom whoami without creds returns exit code 1", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-cli-home-"));
  const originalHome = process.env.HOME;
  const originalError = console.error;
  let stderr = "";
  try {
    process.env.HOME = home;
    console.error = (...args: unknown[]) => {
      stderr += `${args.map(String).join(" ")}\n`;
    };
    const code = await runWhoamiCommand();
    assert.equal(code, 1);
    assert.match(stderr, /Not logged in/);
  } finally {
    process.env.HOME = originalHome;
    console.error = originalError;
  }
});

test("floom run parses --input key=value and --input file=@path", async () => {
  const tempFile = join(await mkdtemp(join(tmpdir(), "workeros-run-input-")), "cv.pdf");
  await writeFile(tempFile, "pdf-bytes");
  const parsed = parseInputAssignments([
    "name=Alice",
    `cv=@${tempFile}`,
  ]);
  assert.equal(parsed.values.name, "Alice");
  assert.deepEqual(parsed.fileUploads, [{ key: "cv", path: tempFile }]);
});
