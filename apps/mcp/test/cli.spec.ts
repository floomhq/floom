import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCliProgram, getPackageVersion } from "../src/cli.js";
import { runWhoamiCommand } from "../src/commands/whoami.js";
import { parseInputAssignments } from "../src/commands/run.js";
import { loadWorkerSource } from "../src/commands/workers.js";

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
  const originalStderr = process.stderr.write.bind(process.stderr);
  let stderr = "";
  try {
    process.env.HOME = home;
    // Capture process.stderr.write (used by log.err/log.warn)
    process.stderr.write = (chunk: Uint8Array | string): boolean => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    const code = await runWhoamiCommand();
    assert.equal(code, 1);
    assert.match(stderr, /Not logged in/);
  } finally {
    process.env.HOME = originalHome;
    process.stderr.write = originalStderr;
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

test("workers push source includes full UTF-8 bundle tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workeros-worker-bundle-"));
  await mkdir(join(dir, "data"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  await mkdir(join(dir, "__pycache__"), { recursive: true });
  await writeFile(join(dir, "worker.yml"), [
    "id: full-bundle",
    "name: full-bundle",
    "runtime: python311",
    "exec:",
    "  runtime: python311",
    "  entry: run.py",
    "",
  ].join("\n"));
  await writeFile(join(dir, "run.py"), "from lib.helper import main\nmain()\n");
  await writeFile(join(dir, "SKILL.md"), "# Full bundle\n");
  await writeFile(join(dir, "data", "cities.json"), "{\"cities\":[]}\n");
  await writeFile(join(dir, "lib", "helper.py"), "def main(): pass\n");
  await writeFile(join(dir, "__pycache__", "ignored.pyc"), "ignored");

  const result = await loadWorkerSource(dir);

  assert.deepEqual(result.errors, []);
  assert.ok(result.source);
  const files = new Map(result.source.files.map((file) => [file.path, file.content]));
  assert.equal(files.get("data/cities.json"), "{\"cities\":[]}\n");
  assert.equal(files.get("lib/helper.py"), "def main(): pass\n");
  assert.equal(files.get("worker.yml")?.includes("full-bundle"), true);
  assert.equal(files.has("__pycache__/ignored.pyc"), false);
});

test("workers source loader accepts TypeScript script workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workeros-worker-ts-"));
  await writeFile(join(dir, "worker.yml"), [
    'schema_version: "0.3"',
    "name: ts-worker",
    "title: TS Worker",
    "description: TypeScript worker",
    "entrypoint: run.ts",
    "exec:",
    "  runtime: node22",
    "  runner: e2b",
    "  entry: run.ts",
    "  command: npx --yes tsx run.ts",
    "  inputs: []",
    "  outputs: []",
    "trigger: { type: manual }",
    "",
  ].join("\n"));
  await writeFile(join(dir, "run.ts"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("result.json", JSON.stringify({ status: "success", outputs: {}, artifacts: [] }));',
    "",
  ].join("\n"));

  const result = await loadWorkerSource(dir);

  assert.deepEqual(result.errors, []);
  assert.ok(result.source);
  assert.equal(result.source.entrypoint, "run.ts");
  assert.equal(result.source.runTs?.includes("result.json"), true);
  const files = new Map(result.source.files.map((file) => [file.path, file.content]));
  assert.equal(files.has("run.ts"), true);
});
