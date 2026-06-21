// #1808: the CLI must render the binary name the user actually invoked
// (argv[0]) in error hints, the doctor header, and the generated completion
// script — not a hardcoded `floom`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI_PATH = join(process.cwd(), "dist", "cli.js");

// Spawn the CLI through a symlink whose basename is `name`, mirroring how npm
// installs the `workeros` / `floom` bins (both point at dist/cli.js).
async function runAs(name, args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "workeros-cmdname-"));
  const linkPath = join(dir, name);
  await symlink(CLI_PATH, linkPath);
  const child = spawn(process.execPath, [linkPath, ...args], {
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

test("completion bash binds to the invoked binary name (workeros)", async () => {
  const result = await runAs("workeros", ["completion", "bash"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /# workeros bash completion/);
  assert.match(result.stdout, /_workeros_completion\(\)/);
  assert.match(result.stdout, /complete -F _workeros_completion workeros/);
  assert.doesNotMatch(result.stdout, /floom/);
});

test("completion zsh/fish bind to the invoked binary name (workeros)", async () => {
  const zsh = await runAs("workeros", ["completion", "zsh"]);
  assert.equal(zsh.code, 0);
  assert.match(zsh.stdout, /#compdef workeros/);
  assert.match(zsh.stdout, /compdef _workeros workeros/);
  assert.doesNotMatch(zsh.stdout, /floom/);

  const fish = await runAs("workeros", ["completion", "fish"]);
  assert.equal(fish.code, 0);
  assert.match(fish.stdout, /complete -c workeros/);
  assert.doesNotMatch(fish.stdout, /floom/);
});

test("completion keeps the legacy floom name when invoked as floom", async () => {
  const result = await runAs("floom", ["completion", "bash"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /complete -F _floom_completion floom/);
});

test("auth error hint uses the invoked binary name (workeros login)", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-cmdname-home-"));
  const result = await runAs("workeros", ["whoami"], { HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Run: workeros login/);
  assert.doesNotMatch(result.stdout, /floom login/);
});

test("doctor header uses the invoked binary name (workeros doctor)", async () => {
  const home = await mkdtemp(join(tmpdir(), "workeros-cmdname-doctor-"));
  // Point at a closed local port so checkApiReachable fails fast (ECONNREFUSED).
  const result = await runAs("workeros", ["doctor"], {
    HOME: home,
    WORKEROS_API_BASE: "http://127.0.0.1:9",
  });
  assert.match(result.stdout, /workeros doctor/);
  assert.doesNotMatch(result.stdout, /Floom doctor/);
});

test("bare command in a terminal prints help and exits non-zero", async (t) => {
  // main() gates the help-vs-MCP-server choice on process.stdin.isTTY; MCP
  // clients launch with a piped stdin (covered by integration.test.js).
  const { main } = await import("../dist/cli.js");
  const originalIsTTY = process.stdin.isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExitCode = process.exitCode;
  const chunks = [];
  t.after(() => {
    process.stdin.isTTY = originalIsTTY;
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  });

  process.stdin.isTTY = true;
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  await main(["node", "workeros"]);
  process.stdout.write = originalWrite;

  const output = chunks.join("");
  assert.equal(process.exitCode, 1);
  assert.match(output, /Usage: workeros/);
});
