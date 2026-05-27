import { basename, resolve as resolvePath, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createAuthenticatedClient } from "../lib/api.js";
import { printJson } from "../lib/output.js";

type ParsedInputs = {
  values: Record<string, unknown>;
  fileUploads: Array<{ key: string; path: string }>;
};

type RunDetail = {
  id: string;
  status: string;
  output?: Record<string, unknown>;
  error?: string | null;
  artifacts?: Array<{ id: string; name?: string }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseKeyValue(raw: string): { key: string; value: string } {
  const index = raw.indexOf("=");
  if (index <= 0) {
    throw new Error(`Invalid --input ${raw}. Expected key=value.`);
  }
  return { key: raw.slice(0, index).trim(), value: raw.slice(index + 1) };
}

export function parseInputAssignments(inputs: string[] = [], inputsFile?: string): ParsedInputs {
  const values: Record<string, unknown> = {};
  const fileUploads: Array<{ key: string; path: string }> = [];

  if (inputsFile) {
    const raw = readFileSync(inputsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inputs file must contain a JSON object");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.startsWith("@")) {
        fileUploads.push({ key, path: value.slice(1) });
      } else {
        values[key] = value;
      }
    }
  }

  for (const item of inputs) {
    const { key, value } = parseKeyValue(item);
    if (value.startsWith("@")) {
      fileUploads.push({ key, path: value.slice(1) });
    } else {
      values[key] = value;
    }
  }

  return { values, fileUploads };
}

function printPrettyRun(run: RunDetail, savedPaths: string[]): void {
  console.log(`Run ${run.id}: ${run.status}`);
  if (run.error) {
    console.error(run.error);
  }
  if (run.output && Object.keys(run.output).length) {
    console.log("");
    console.log("Output:");
    for (const [key, value] of Object.entries(run.output)) {
      console.log(`- ${key}:`);
      if (typeof value === "string") {
        console.log(value);
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
    }
  }
  if (savedPaths.length) {
    console.log("");
    console.log("Saved artifacts:");
    for (const path of savedPaths) {
      console.log(`- ${path}`);
    }
  }
}

export async function runWorkerCommand(
  workerId: string,
  options: { input?: string[]; inputsFile?: string; outputDir?: string; json?: boolean },
): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const parsedInputs = parseInputAssignments(options.input || [], options.inputsFile);

  const resolvedInputs: Record<string, unknown> = { ...parsedInputs.values };
  for (const upload of parsedInputs.fileUploads) {
    const absolutePath = resolvePath(upload.path);
    const uploadId = await client.uploadFile(upload.key, absolutePath);
    resolvedInputs[upload.key] = uploadId;
  }

  const started = (await client.requestJson(
    "POST",
    `/workers/${encodeURIComponent(workerId)}/runs`,
    { body: { inputs: resolvedInputs, trigger_source: "manual" } },
  )) as { run_id?: string; status?: string };

  const runId = started.run_id;
  if (!runId) {
    throw new Error("Run creation did not return run_id");
  }

  let latest: RunDetail | null = null;
  let lastStatus = "";
  const terminal = new Set(["completed", "failed", "error", "approved", "rejected"]);
  while (true) {
    latest = (await client.requestJson("GET", `/runs/${encodeURIComponent(runId)}`)) as RunDetail;
    if (latest.status !== lastStatus) {
      console.log(`Run ${runId} status: ${latest.status}`);
      lastStatus = latest.status;
    }
    if (terminal.has(latest.status)) break;
    await sleep(2000);
  }

  const savedPaths: string[] = [];
  if (options.outputDir && latest?.artifacts?.length) {
    const outputDir = resolvePath(options.outputDir);
    await mkdir(outputDir, { recursive: true });
    for (const artifact of latest.artifacts) {
      const name = basename(artifact.name || `${artifact.id}.bin`);
      const targetPath = join(outputDir, name);
      const bytes = await client.requestBuffer(
        "GET",
        `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
      );
      await writeFile(targetPath, bytes);
      savedPaths.push(targetPath);
    }
  }

  if (!latest) {
    throw new Error("Run polling ended without a run payload");
  }

  if (options.json) {
    printJson(latest);
  } else {
    printPrettyRun(latest, savedPaths);
  }

  const success = latest.status === "completed" || latest.status === "approved" || latest.status === "success";
  return success ? 0 : 1;
}
