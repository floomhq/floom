#!/usr/bin/env node
/*
 * ax-eval CI runner (Path B: Claude Code headless).
 *
 * Spawns N Claude Code `--print` invocations in parallel against Floom, collects
 * each session JSONL log, runs ax-eval's `extract_metrics.py` on each, then
 * writes a result.json matching the ax-eval schema plus a Markdown scorecard
 * for `docs/ax-scores/`.
 *
 * Why not the interactive ax-eval skill? That harness spawns subagents via the
 * Agent tool inside a running Claude Code session — interactive-only. CI is not
 * interactive. The headless `claude --print --output-format stream-json` path
 * writes the same JSONL shape ax-eval's `extract_metrics.py` already parses,
 * just without the `agentId` field (we inject it ourselves).
 *
 * Runs locally with the same semantics as CI. Just:
 *   ANTHROPIC_API_KEY=... node scripts/ax-eval-ci.mjs
 *
 * Env (all optional, defaults match ax-eval SKILL.md):
 *   AX_EVAL_N_AGENTS      default 10
 *   AX_EVAL_MODEL         default claude-opus-4-7
 *   AX_EVAL_MAX_TURNS     default 40
 *   AX_EVAL_MAX_BUDGET    default 4 (USD per agent)
 *   AX_EVAL_ROUND         default ci-local-${now}
 *   AX_EVAL_TOOL_SLUG     default floom
 *   AX_EVAL_TASK          see TASK below
 *   AX_EVAL_OUT_DIR       default ./ax-eval-output
 *   AX_EVAL_TIMEOUT_SEC   default 900 (15min per agent)
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------- config ----------
const TASK =
  process.env.AX_EVAL_TASK ||
  "Publish this OpenAPI spec as a shareable app: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml";

const TOOL_SLUG = process.env.AX_EVAL_TOOL_SLUG || "floom";
const TOOL_NAME = "Floom";
const TOOL_INSTALL = "npx -y floom-cli";
const N_AGENTS = parseInt(process.env.AX_EVAL_N_AGENTS || "10", 10);
const MODEL = process.env.AX_EVAL_MODEL || "claude-opus-4-7";
const MAX_TURNS = parseInt(process.env.AX_EVAL_MAX_TURNS || "40", 10);
const MAX_BUDGET_USD = parseFloat(process.env.AX_EVAL_MAX_BUDGET || "4");
const TIMEOUT_SEC = parseInt(process.env.AX_EVAL_TIMEOUT_SEC || "900", 10);
const ROUND = process.env.AX_EVAL_ROUND || `ci-local-${Math.floor(Date.now() / 1000)}`;
const OUT_DIR = path.resolve(process.env.AX_EVAL_OUT_DIR || "./ax-eval-output");
const TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
const PROMPT = `${TASK} using ${TOOL_NAME}`;

// Repo root ax-eval clone (fetched by the workflow, can also be local for dev runs).
const AX_EVAL_DIR =
  process.env.AX_EVAL_DIR || path.resolve(process.cwd(), ".ax-eval-src");
const EXTRACT_SCRIPT = path.join(AX_EVAL_DIR, "scripts", "extract_metrics.py");
const RESULT_SCHEMA_VERSION = 1;

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugSegment(p) {
  // Claude writes logs to ~/.claude/projects/{cwd with '/' -> '-'}/...
  return p.replace(/\//g, "-");
}

function pct(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * q);
  return sorted[idx];
}

function modeFirstCmd(firstCmds) {
  const counts = new Map();
  for (const c of firstCmds) {
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  if (counts.size === 0) return "(none) (0/" + firstCmds.length + ")";
  const [cmd, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${cmd} (${n}/${firstCmds.length})`;
}

// ---------- run one agent ----------
async function runAgent(i, runDir) {
  const sessionId = randomUUID();
  const agentDir = await mkdtemp(path.join(tmpdir(), `ax-agent-${i}-`));
  const streamLog = path.join(runDir, "stream", `agent-${i}.stream.jsonl`);
  await mkdir(path.dirname(streamLog), { recursive: true });

  const started = Date.now();
  // Pass the prompt as the positional arg to claude.
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--allowed-tools",
    TOOLS.join(","),
    "--model",
    MODEL,
    "--session-id",
    sessionId,
    "--max-budget-usd",
    String(MAX_BUDGET_USD),
    "--permission-mode",
    "bypassPermissions",
    "--bare",
    PROMPT,
  ];

  const env = {
    ...process.env,
    // Strict isolation: no project/user settings, no MCP servers, no hooks.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };

  const child = spawn("claude", args, {
    cwd: agentDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const { writeStream } = await import("node:fs").then((m) => ({
    writeStream: m.createWriteStream(streamLog),
  }));
  child.stdout.pipe(writeStream);
  const stderrChunks = [];
  child.stderr.on("data", (c) => stderrChunks.push(c));

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_SEC * 1000);

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(killer);

  const sessionLogPath = path.join(
    process.env.HOME,
    ".claude",
    "projects",
    slugSegment(agentDir),
    `${sessionId}.jsonl`,
  );

  return {
    agentIndex: i,
    sessionId,
    sessionLogPath,
    streamLog,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    cwd: agentDir,
  };
}

// ---------- metrics extraction (wraps the python script) ----------
async function extractMetrics(agent) {
  // Prefer the python script for deterministic parity with ax-eval. Fall back
  // to a minimal inline parser if the session file is missing.
  if (!existsSync(agent.sessionLogPath)) {
    return {
      agent_id: null,
      source: agent.sessionLogPath,
      duration_sec: 0,
      tool_calls: 0,
      errors: 0,
      interruptions: 0,
      interruption_details: [],
      first_3_commands: [],
      tool_breakdown: {},
      scores: { friction: 0, speed: 0, efficiency: 0, errorRecovery: 0, final: 0 },
      _session_missing: true,
    };
  }

  return new Promise((resolve, reject) => {
    const p = spawn("python3", [EXTRACT_SCRIPT, agent.sessionLogPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => err.push(c));
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `extract_metrics.py failed (exit ${code}) for agent ${agent.agentIndex}: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
      }
      try {
        const line = Buffer.concat(out).toString("utf8").trim().split("\n")[0];
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- success judging (lightweight: non-error stop + tool activity) ----------
// A dedicated judge subagent is overkill for CI. We mark success when the
// session ended with stop_reason=end_turn, had at least one tool call, and had
// no timeout/exit error. This tracks the SKILL's intent without requiring a
// second LLM pass per agent (keeps cost predictable).
async function judgeAgent(agent, metrics) {
  if (agent.timedOut) {
    return { success: false, success_reason: "agent run timed out" };
  }
  if (agent.exitCode !== 0) {
    return {
      success: false,
      success_reason: `claude exited non-zero (${agent.exitCode})`,
    };
  }
  if (metrics._session_missing) {
    return { success: false, success_reason: "no session log written" };
  }
  if (metrics.tool_calls === 0) {
    return { success: false, success_reason: "agent made no tool calls" };
  }
  // Look at the final assistant message in the session log.
  try {
    const raw = await readFile(agent.sessionLogPath, "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const lastAssistant = [...events].reverse().find((e) => e.type === "assistant");
    const stop = lastAssistant?.message?.stop_reason;
    if (stop !== "end_turn") {
      return {
        success: false,
        success_reason: `final stop_reason=${stop || "unknown"}`,
      };
    }
    return {
      success: true,
      success_reason: `end_turn after ${metrics.tool_calls} tool calls, ${metrics.errors} errors`,
    };
  } catch (e) {
    return { success: false, success_reason: `judge read failed: ${e.message}` };
  }
}

// ---------- main ----------
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }
  if (!existsSync(EXTRACT_SCRIPT)) {
    console.error(
      `extract_metrics.py not found at ${EXTRACT_SCRIPT}. Set AX_EVAL_DIR to your ax-eval checkout.`,
    );
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const runDir = path.join(OUT_DIR, `${ts.replace(/[:]/g, "-")}_${ROUND}`);
  const transcriptsDir = path.join(runDir, "transcripts");
  await mkdir(transcriptsDir, { recursive: true });

  console.log(
    `ax-eval CI: spawning ${N_AGENTS} agents (${MODEL}, max ${MAX_TURNS} turns, $${MAX_BUDGET_USD} budget each)`,
  );
  console.log(`  task: ${TASK}`);
  console.log(`  round: ${ROUND}`);
  console.log(`  out:   ${runDir}`);

  // Spawn all N in parallel. Claude's API is rate-limited per key; if we see
  // errors in practice, stagger with small delays.
  const agentPromises = [];
  for (let i = 1; i <= N_AGENTS; i++) {
    agentPromises.push(runAgent(i, runDir));
    await sleep(400); // gentle stagger to avoid rate-limit bursts
  }
  const agents = await Promise.all(agentPromises);

  // Archive every session log into transcripts/ (schema-matching filename).
  for (const a of agents) {
    if (existsSync(a.sessionLogPath)) {
      await copyFile(
        a.sessionLogPath,
        path.join(transcriptsDir, `agent-${a.agentIndex}.jsonl`),
      );
    }
  }

  // Extract metrics + judge each agent.
  const scored = [];
  for (const a of agents) {
    let metrics;
    try {
      metrics = await extractMetrics(a);
    } catch (e) {
      console.error(`agent ${a.agentIndex}: extract failed: ${e.message}`);
      metrics = {
        agent_id: null,
        source: a.sessionLogPath,
        duration_sec: 0,
        tool_calls: 0,
        errors: 0,
        interruptions: 0,
        interruption_details: [],
        first_3_commands: [],
        tool_breakdown: {},
        scores: { friction: 0, speed: 0, efficiency: 0, errorRecovery: 0, final: 0 },
        _session_missing: true,
      };
    }
    const verdict = await judgeAgent(a, metrics);
    scored.push({
      id: a.agentIndex,
      success: verdict.success,
      success_reason: verdict.success_reason,
      duration_sec: metrics.duration_sec,
      tool_calls: metrics.tool_calls,
      interruptions: metrics.interruptions,
      interruption_details: metrics.interruption_details,
      errors: metrics.errors,
      scores: metrics.scores,
      first_3_commands: metrics.first_3_commands,
    });
    console.log(
      `  agent ${a.agentIndex}: ${verdict.success ? "OK" : "FAIL"} final=${metrics.scores.final} cmds=${metrics.tool_calls} dur=${metrics.duration_sec}s`,
    );
  }

  // Summary.
  const finals = scored.map((s) => s.scores.final).sort((a, b) => a - b);
  const summary = {
    success_rate: scored.filter((s) => s.success).length / scored.length,
    median_final: pct(finals, 0.5),
    p25_final: pct(finals, 0.25),
    p75_final: pct(finals, 0.75),
    common_first_command: modeFirstCmd(scored.map((s) => s.first_3_commands[0] || "")),
  };

  const result = {
    schema: RESULT_SCHEMA_VERSION,
    tool: {
      slug: TOOL_SLUG,
      name: TOOL_NAME,
      version: process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : "local",
      install: TOOL_INSTALL,
    },
    task: TASK,
    round: ROUND,
    ts,
    config: {
      agent_model: MODEL,
      agent_count: N_AGENTS,
      temperature: 0,
      tools: TOOLS,
      mcp_servers: [],
      system_prompt: null,
      max_turns: MAX_TURNS,
      prompt_template: "{task} using {tool}",
      docs_included: false,
      overrides: {},
    },
    agents: scored,
    summary,
  };

  await writeFile(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(`\nresult: median_final=${summary.median_final} success=${Math.round(summary.success_rate * 100)}%`);
  console.log(`wrote ${path.join(runDir, "result.json")}`);

  // Also emit a machine-readable summary for the workflow to consume.
  const summaryPath = path.join(runDir, "ci-summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        median_final: summary.median_final,
        p25_final: summary.p25_final,
        p75_final: summary.p75_final,
        success_rate: summary.success_rate,
        common_first_command: summary.common_first_command,
        n_agents: N_AGENTS,
        round: ROUND,
        ts,
        run_dir: runDir,
      },
      null,
      2,
    ),
  );

  // Scorecard markdown for docs/ax-scores/.
  const badgeColor =
    summary.median_final >= 80 ? "brightgreen" : summary.median_final >= 60 ? "orange" : "red";
  const rows = scored
    .map(
      (s) =>
        `| ${s.id} | ${s.tool_calls} | ${s.duration_sec} | ${s.interruptions} | ${s.errors} | ${s.scores.friction} | ${s.scores.speed} | ${s.scores.efficiency} | ${s.scores.errorRecovery} | ${s.scores.final} | ${s.success ? "OK" : "X"} |`,
    )
    .join("\n");
  const md = `# ax-eval — ${ROUND}

- **Date:** ${ts}
- **Tool:** ${TOOL_NAME} (\`${TOOL_SLUG}\`), version \`${result.tool.version}\`
- **Task:** ${TASK}
- **Agents:** ${N_AGENTS} × \`${MODEL}\` (max ${MAX_TURNS} turns, $${MAX_BUDGET_USD}/agent budget)
- **docs_included:** \`false\` (tests discoverability)

## Summary

| metric | value |
|---|---|
| median final | **${summary.median_final}** (![badge](https://img.shields.io/badge/AX-${summary.median_final}-${badgeColor})) |
| p25 / p75 final | ${summary.p25_final} / ${summary.p75_final} |
| success rate | ${Math.round(summary.success_rate * 100)}% (${scored.filter((s) => s.success).length}/${N_AGENTS}) |
| common first command | \`${summary.common_first_command}\` |

## Scorecard

| Agent | Cmds | Dur(s) | Intr | Err | Friction | Speed | Eff | ErrRec | Final | OK |
|-------|------|--------|------|-----|----------|-------|-----|--------|-------|-----|
${rows}

## How to read

See [docs/ax-scores/README.md](./README.md) and the [ax-eval README](https://github.com/team2027/ax-eval).

## Transcripts

Full per-agent JSONL session logs are kept as workflow artifacts for 30 days under the name \`ax-eval-${ROUND}\`.
`;
  const mdPath = path.join(runDir, "scorecard.md");
  await writeFile(mdPath, md);

  console.log(`scorecard: ${mdPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
