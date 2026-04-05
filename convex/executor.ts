"use node";

import { ActionCtx, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Sandbox } from "@e2b/code-interpreter";
import { generateDownloadUrl } from "./files";

const EXECUTION_TIMEOUT_S = 5 * 60; // 5 minutes

// Build the Python glue that wraps user code, injects inputs, serializes outputs.
function buildExecutionCode(userCode: string, inputs: unknown): string {
  // Escape single quotes in the JSON so it's safe inside python single-quoted string
  const inputsJson = JSON.stringify(inputs ?? {})
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

  return `
import json as _json

${userCode}

class _PlatformEncoder(_json.JSONEncoder):
    def default(self, obj):
        import datetime as _dt, decimal as _dec, uuid as _uuid
        if isinstance(obj, (_dt.date, _dt.datetime)):
            return obj.isoformat()
        if isinstance(obj, _dec.Decimal):
            return float(obj)
        if isinstance(obj, _uuid.UUID):
            return str(obj)
        try:
            import numpy as _np
            if isinstance(obj, _np.integer): return int(obj)
            if isinstance(obj, _np.floating): return float(obj)
            if isinstance(obj, _np.ndarray): return obj.tolist()
        except ImportError:
            pass
        return super().default(obj)

_inputs = _json.loads('${inputsJson}')
_result = run(**_inputs)
print(_json.dumps(_result, cls=_PlatformEncoder))
`;
}

type FinishResult = {
  status: "success" | "error" | "timeout";
  errorType:
    | "timeout"
    | "syntax_error"
    | "runtime_error"
    | "missing_secret"
    | "sandbox_error"
    | null;
  error: string | null;
  outputs: unknown;
  logs: string;
  durationMs: number;
};

/**
 * Shared sandbox execution logic used by both normal runs and test runs.
 */
async function executeInSandbox(params: {
  code: string;
  manifest: { python_dependencies?: string[]; inputs?: Array<{ name: string; type: string }> };
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
}): Promise<FinishResult> {
  const wallStart = Date.now();
  const { code, manifest, inputs, secrets } = params;
  const deps = manifest.python_dependencies ?? [];

  let sandbox: Sandbox | null = null;
  let logs = "";

  try {
    sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      envs: secrets,
      timeoutMs: EXECUTION_TIMEOUT_S * 1000,
    });

    // Install Python dependencies
    if (deps.length > 0) {
      const pkgList = deps.map((d) => JSON.stringify(d)).join(" ");
      const installOut = await sandbox.commands.run(
        `python3 -m pip install -q ${pkgList}`,
        { timeoutMs: 60_000 }
      );
      if (installOut.exitCode !== 0) {
        throw new Error(
          `Dependency install failed: ${installOut.stderr ?? "unknown error"}`
        );
      }
    }

    // Resolve file inputs: replace R2 keys with presigned GET URLs
    const resolvedInputs = { ...inputs };
    const manifestInputs = manifest.inputs ?? [];
    for (const mi of manifestInputs) {
      const val = resolvedInputs[mi.name];
      if (mi.type === "file" && typeof val === "string" && !val.startsWith("http")) {
        resolvedInputs[mi.name] = await generateDownloadUrl(val, 600);
      }
    }

    // Write + execute user code
    const execCode = buildExecutionCode(code, resolvedInputs);
    await sandbox.files.write("/home/user/run.py", execCode);

    const result = await sandbox.commands.run("python3 /home/user/run.py", {
      timeoutMs: EXECUTION_TIMEOUT_S * 1000,
    });

    logs = result.stdout ?? "";
    if (result.stderr) logs += `\n[stderr]\n${result.stderr}`;

    // Non-zero exit = user code error
    if (result.exitCode !== 0) {
      const stderr = result.stderr ?? "";
      let errorType: "syntax_error" | "runtime_error" | "missing_secret" =
        "runtime_error";
      if (/SyntaxError/i.test(stderr)) errorType = "syntax_error";
      else if (/KeyError.*SECRET_/i.test(stderr)) errorType = "missing_secret";

      return {
        status: "error",
        errorType,
        error: stderr || `Exit code ${result.exitCode}`,
        outputs: null,
        logs,
        durationMs: Date.now() - wallStart,
      };
    }

    // Parse last stdout line as JSON output
    const lastLine =
      (result.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
    let outputs: unknown;
    try {
      outputs = JSON.parse(lastLine);
    } catch {
      outputs = { result: lastLine || logs };
    }

    return {
      status: "success",
      errorType: null,
      error: null,
      outputs,
      logs,
      durationMs: Date.now() - wallStart,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.toLowerCase().includes("timeout") ||
      msg.toLowerCase().includes("timed out");

    return {
      status: isTimeout ? "timeout" : "error",
      errorType: isTimeout ? "timeout" : "sandbox_error",
      error: msg,
      outputs: null,
      logs,
      durationMs: Date.now() - wallStart,
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        // Ignore sandbox cleanup errors
      }
    }
  }
}

// Execute a deployed automation run (code from artifacts via automationVersions).
export const executeRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.runs.getInternal, {
      runId: args.runId,
    });
    if (!run) throw new Error("Run not found");

    const version = await ctx.runQuery(internal.runs.getVersionInternal, {
      versionId: run.versionId,
    });
    if (!version) throw new Error("Version not found");

    // Fetch artifact for code+manifest
    const artifact = await ctx.runQuery(internal.artifacts.get, {
      id: version.artifactId,
    });
    if (!artifact) {
      await ctx.runMutation(internal.runs.finishRun, {
        runId: args.runId,
        status: "error",
        errorType: "sandbox_error",
        error: "Artifact not found",
        outputs: null,
        logs: "",
        durationMs: 0,
      });
      return;
    }

    await ctx.runMutation(internal.runs.updateRunStatus, {
      runId: args.runId,
      status: "running",
    });

    const secrets = (await ctx.runQuery(internal.secrets.listDecrypted, {
      automationId: run.automationId,
    })) as Record<string, string>;

    const result = await executeInSandbox({
      code: artifact.code,
      manifest: artifact.manifest as { python_dependencies?: string[]; inputs?: Array<{ name: string; type: string }> },
      inputs: run.inputs as Record<string, unknown>,
      secrets,
    });

    await ctx.runMutation(internal.runs.finishRun, {
      runId: args.runId,
      ...result,
    });
  },
});

// Execute a test run (code from artifacts).
export const executeTestRun = internalAction({
  args: { testRunId: v.id("testRuns") },
  handler: async (ctx, args) => {
    const testRun = await ctx.runQuery(internal.testRuns.getInternal, {
      testRunId: args.testRunId,
    });
    if (!testRun) throw new Error("Test run not found");

    // Fetch artifact for code+manifest
    const artifact = await ctx.runQuery(internal.artifacts.get, {
      id: testRun.artifactId,
    });
    if (!artifact) {
      await ctx.runMutation(internal.testRuns.finishTestRun, {
        testRunId: args.testRunId,
        status: "error",
        errorType: "sandbox_error",
        error: "Artifact not found",
        outputs: null,
        logs: "",
        durationMs: 0,
      });
      return;
    }

    await ctx.runMutation(internal.testRuns.updateStatus, {
      testRunId: args.testRunId,
      status: "running",
    });

    const secrets = (await ctx.runQuery(internal.secrets.listDecryptedByOrg, {
      orgId: testRun.orgId,
    })) as Record<string, string>;

    const result = await executeInSandbox({
      code: artifact.code,
      manifest: artifact.manifest as { python_dependencies?: string[]; inputs?: Array<{ name: string; type: string }> },
      inputs: testRun.inputs as Record<string, unknown>,
      secrets,
    });

    await ctx.runMutation(internal.testRuns.finishTestRun, {
      testRunId: args.testRunId,
      ...result,
    });
  },
});
