// #1808: the CLI must render the binary name the user actually invoked
// (argv[0]) in error hints, the doctor header, and the generated completion
// script — not a hardcoded `floom`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const CLI_PATH = join(process.cwd(), "dist", "cli.js");

// Spawn the CLI through a tiny wrapper whose basename is `name`, mirroring the
// bin path the user invoked without requiring symlink privileges on Windows.
async function runAs(name, args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "workeros-cmdname-"));
  const wrapperPath = join(dir, name);
  const childEnv = { ...env };
  if (childEnv.HOME && !Object.hasOwn(childEnv, "XDG_CONFIG_HOME")) {
    childEnv.XDG_CONFIG_HOME = join(childEnv.HOME, ".config");
  }
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    wrapperPath,
    [
      "import { fileURLToPath } from 'node:url';",
      `import { main } from ${JSON.stringify(pathToFileURL(CLI_PATH).href)};`,
      "await main([process.argv[0], fileURLToPath(import.meta.url), ...process.argv.slice(2)]);",
      "",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [wrapperPath, ...args], {
    env: {
      ...process.env,
      WORKEROS_API_BASE: "",
      WORKEROS_API_SECRET: "",
      WORKEROS_API_TOKEN: "",
      FLOOM_API_BASE: "",
      FLOOM_API_SECRET: "",
      ...childEnv,
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

test("completion powershell binds to the invoked binary name (workeros)", async () => {
  const result = await runAs("workeros", ["completion", "powershell"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /# workeros PowerShell completion/);
  assert.match(result.stdout, /Register-ArgumentCompleter -Native -CommandName workeros/);
  assert.doesNotMatch(result.stdout, /floom/);

  const pwsh = await runAs("workeros", ["completion", "pwsh"]);
  assert.equal(pwsh.code, 0);
  assert.match(pwsh.stdout, /Register-ArgumentCompleter -Native -CommandName workeros/);
});

test("completion keeps the legacy floom name when invoked as floom", async () => {
  const result = await runAs("floom", ["completion", "bash"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /complete -F _floom_completion floom/);
});

test("login help shows hosted default and local override", async () => {
  const result = await runAs("floom", ["login", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--cloud\s+Authenticate against a hosted Floom instance \(default\)/);
  assert.match(result.stdout, /--local\s+Authenticate against a local\/self-hosted Floom API/);
});

test("package README documents hosted login default", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\*\*Hosted\*\* \(default\)/);
  assert.match(readme, /hosted Floom Cloud by default/);
  assert.match(readme, /floom login --local/);
  assert.doesNotMatch(readme, /Self-hosted\*\* \(default\)/);
  assert.doesNotMatch(readme, /floom login --api/);
});

test("bundled Floom skill opens with hosted cloud guidance", () => {
  const skill = readFileSync(new URL("../assets/floom-skill.md", import.meta.url), "utf8");
  const firstGuidance = skill.split("---", 3)[2].trimStart().split("\n").slice(0, 4).join("\n");
  assert.match(firstGuidance, /You are using HOSTED Floom/);
  assert.match(firstGuidance, /Do NOT set up or configure self-hosting/);
  assert.match(firstGuidance, /do NOT create\/edit a \.env/);
  assert.match(firstGuidance, /do NOT run a local server/);
  assert.match(firstGuidance, /Everything runs on Floom's cloud; you only use the MCP tools/);
});

test("install success prompt is concise and launch-safe", () => {
  const src = readFileSync(new URL("../src/commands/mcp.ts", import.meta.url), "utf8");
  const prompt = src.slice(
    src.indexOf("function logInstallSuccessNextStep"),
    src.indexOf("// HTTP MCP config"),
  ).replace(/\r\n/g, "\n");
  assert.match(prompt, /Floom is ready/);
  assert.match(prompt, /Installed MCP for your agent/);
  assert.match(prompt, /log\.blank\(\);\n  log\.step\("Installed MCP for your agent"\);/);
  assert.match(prompt, /log\.info\('  "Use Floom to create and run my first read-only worker\."'\);/);
  assert.match(prompt, /Use Floom to create and run my first read-only worker/);
  assert.doesNotMatch(prompt, /workeros-api\.floom\.dev/);
  assert.doesNotMatch(prompt, /Do not set up self-hosting/);
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

test("doctor warning summary does not claim all checks passed", () => {
  const src = readFileSync(new URL("../src/commands/doctor.ts", import.meta.url), "utf8");
  assert.match(src, /All required checks passed/);
  assert.match(src, /optional warning/);
});

test("bare floom in a terminal prints onboarding help and exits zero", async (t) => {
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
  await main(["node", "floom"]);
  process.stdout.write = originalWrite;

  const output = chunks.join("");
  assert.equal(process.exitCode, originalExitCode);
  assert.match(output, /Floom .* run AI workers in the cloud/);
  assert.match(output, /Usage: floom/);
  assert.match(output, /floom mcp install --target <client>/);
});
