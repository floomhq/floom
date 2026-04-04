"use node";

import { internalAction } from "./_generated/server";
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

export const executeRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const wallStart = Date.now();

    // 1. Fetch run record
    const run = await ctx.runQuery(internal.runs.getInternal, {
      runId: args.runId,
    });
    if (!run) throw new Error("Run not found");

    // 2. Fetch version (code + manifest)
    const version = await ctx.runQuery(internal.runs.getVersionInternal, {
      versionId: run.versionId,
    });
    if (!version) throw new Error("Version not found");

    // 3. Mark as running
    await ctx.runMutation(internal.runs.updateRunStatus, {
      runId: args.runId,
      status: "running",
    });

    // 4. Fetch decrypted org secrets for E2B env vars
    const secrets = (await ctx.runQuery(internal.secrets.listDecrypted, {
      automationId: run.automationId,
    })) as Record<string, string>;

    const manifest = version.manifest as { python_dependencies?: string[] };
    const deps = manifest.python_dependencies ?? [];

    let sandbox: Sandbox | null = null;
    let logs = "";

    try {
      // 5. Create E2B sandbox (code-interpreter template — has pandas, numpy, pillow, etc. pre-installed)
      sandbox = await Sandbox.create({
        apiKey: process.env.E2B_API_KEY,
        envs: secrets,
        timeoutMs: EXECUTION_TIMEOUT_S * 1000,
      });

      // 6. Install Python dependencies
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

      // 7. Resolve file inputs: replace R2 keys with presigned GET URLs
      const resolvedInputs = { ...(run.inputs as Record<string, unknown>) };
      const manifestInputs =
        (manifest as { inputs?: { name: string; type: string }[] }).inputs ?? [];
      for (const mi of manifestInputs) {
        const val = resolvedInputs[mi.name];
        if (mi.type === "file" && typeof val === "string" && !val.startsWith("http")) {
          // R2 key from form upload — resolve to presigned GET URL
          resolvedInputs[mi.name] = await generateDownloadUrl(val, 600);
        }
      }

      // 8. Write + execute user code
      const code = buildExecutionCode(version.code, resolvedInputs);
      await sandbox.files.write("/home/user/run.py", code);

      const result = await sandbox.commands.run("python3 /home/user/run.py", {
        timeoutMs: EXECUTION_TIMEOUT_S * 1000,
      });

      logs = result.stdout ?? "";
      if (result.stderr) logs += `\n[stderr]\n${result.stderr}`;

      // 8. Non-zero exit = user code error
      if (result.exitCode !== 0) {
        const stderr = result.stderr ?? "";
        let errorType: "syntax_error" | "runtime_error" | "missing_secret" =
          "runtime_error";
        if (/SyntaxError/i.test(stderr)) errorType = "syntax_error";
        else if (/KeyError.*SECRET_/i.test(stderr)) errorType = "missing_secret";

        await ctx.runMutation(internal.runs.finishRun, {
          runId: args.runId,
          status: "error",
          errorType,
          error: stderr || `Exit code ${result.exitCode}`,
          outputs: null,
          logs,
          durationMs: Date.now() - wallStart,
        });
        return;
      }

      // 9. Parse last stdout line as JSON output
      const lastLine =
        (result.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
      let outputs: unknown;
      try {
        outputs = JSON.parse(lastLine);
      } catch {
        outputs = { result: lastLine || logs };
      }

      await ctx.runMutation(internal.runs.finishRun, {
        runId: args.runId,
        status: "success",
        errorType: null,
        error: null,
        outputs,
        logs,
        durationMs: Date.now() - wallStart,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        msg.toLowerCase().includes("timeout") ||
        msg.toLowerCase().includes("timed out");

      await ctx.runMutation(internal.runs.finishRun, {
        runId: args.runId,
        status: isTimeout ? "timeout" : "error",
        errorType: isTimeout ? "timeout" : "sandbox_error",
        error: msg,
        outputs: null,
        logs,
        durationMs: Date.now() - wallStart,
      });
    } finally {
      if (sandbox) {
        try {
          await sandbox.kill();
        } catch {
          // Ignore sandbox cleanup errors
        }
      }
    }
  },
});
