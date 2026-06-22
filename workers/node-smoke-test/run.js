// Tiny Node worker — proves Floom installs package.json deps + runs node22.
// No secrets, no external API calls, no network state.

import fs from "node:fs/promises";
import { nanoid } from "nanoid";

async function main() {
  const result = {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    generated_id: nanoid(),
    env_keys_visible: Object.keys(process.env)
      .filter((k) => k.startsWith("FLOOM_"))
      .sort(),
  };
  await fs.mkdir("out", { recursive: true });
  await fs.writeFile("out/result.json", JSON.stringify(result, null, 2));
  await fs.writeFile("result.json", JSON.stringify({
    status: "completed",
    outputs: { result: "out/result.json" },
    artifacts: [],
  }));
  console.log("node-smoke-test ok:", JSON.stringify(result));
}

main().catch((err) => {
  fs.writeFile("result.json", JSON.stringify({
    status: "error",
    outputs: {},
    error: String(err?.stack || err),
  })).finally(() => process.exit(1));
});
