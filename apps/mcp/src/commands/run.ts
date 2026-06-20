import { basename, resolve as resolvePath, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createAuthenticatedClient, FloomApiError } from "../lib/api.js";
import { log, printJson } from "../lib/output.js";

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
  log.heading(`Run ${run.id}`);
  log.kv("Status", run.status);
  if (run.error) {
    log.err(run.error);
  }
  if (run.output && Object.keys(run.output).length) {
    log.blank();
    log.info("Output:");
    for (const [key, value] of Object.entries(run.output)) {
      log.step(`${key}:`);
      if (typeof value === "string") {
        process.stdout.write(value + "\n");
      } else {
        process.stdout.write(JSON.stringify(value, null, 2) + "\n");
      }
    }
  }
  if (savedPaths.length) {
    log.blank();
    log.info("Saved artifacts:");
    for (const path of savedPaths) {
      log.step(path);
    }
  }
}

export async function runWorkerCommand(
  workerId: string,
  options: { input?: string[]; inputsFile?: string; outputDir?: string; json?: boolean },
): Promise<number> {
  const { client } = await createAuthenticatedClient().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      log.err("Not authenticated.");
      log.info("Run: floom login");
      process.exit(1);
    }
    throw error;
  });
  const parsedInputs = parseInputAssignments(options.input || [], options.inputsFile);

  const resolvedInputs: Record<string, unknown> = { ...parsedInputs.values };
  for (const upload of parsedInputs.fileUploads) {
    const absolutePath = resolvePath(upload.path);
    const uploadId = await client.uploadFile(upload.key, absolutePath);
    resolvedInputs[upload.key] = uploadId;
  }

  let started: { run_id?: string; status?: string };
  try {
    started = (await client.requestJson(
      "POST",
      `/workers/${encodeURIComponent(workerId)}/runs`,
      { body: { inputs: resolvedInputs, trigger_source: "manual" } },
    )) as { run_id?: string; status?: string };
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`Worker '${workerId}' not found.`);
      log.info("List available workers: floom workers list");
      return 1;
    }
    if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
      log.err("Your session expired.");
      log.info("Re-run: floom login");
      return 1;
    }
    if (error instanceof FloomApiError && error.status && error.status >= 500) {
      log.err(`API error starting run.`);
      log.info("Check API status, then retry. Report: https://github.com/floomhq/floom/issues");
      return 1;
    }
    throw error;
  }

  const runId = started.run_id;
  if (!runId) {
    throw new Error("Run creation did not return run_id");
  }

  log.step(`Run started: ${runId}`);
  let latest: RunDetail | null = null;
  let lastStatus = "";
  const terminal = new Set(["completed", "failed", "error", "approved", "rejected"]);
  while (true) {
    latest = (await client.requestJson("GET", `/runs/${encodeURIComponent(runId)}`)) as RunDetail;
    if (latest.status !== lastStatus) {
      log.step(`Status: ${latest.status}`);
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
