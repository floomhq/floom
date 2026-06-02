"use client";

// V5: the MCP/CLI tool catalog rendered in Settings -> API access. There is no
// backend endpoint that returns the live tool list (the /system/workspace-agent
// endpoint returns the *agent's* management tools, a different set), so this is
// a curated mirror of the canonical tool names shipped by the MCP server. Source
// of truth: apps/mcp/README.md "## Tools" + apps/mcp/src tool registrations
// (verified 2026-06-02). Keep in sync if the MCP tool surface changes.

const TOOL_GROUPS: { group: string; tools: { name: string; description: string }[] }[] = [
  {
    group: "Workers",
    tools: [
      { name: "workers.list", description: "List available Workeros workers." },
      { name: "workers.get", description: "Read one worker, including config and recent run metadata." },
      { name: "workers.create", description: "Create a script-mode worker from worker_yml and run_py." },
      { name: "workers.update", description: "Patch trigger, cron, default inputs, capabilities, or rotate webhook secret." },
      { name: "workers.delete", description: "Delete a worker and dependent run data." },
      { name: "workers.run", description: "Start a manual worker run with input values." },
      { name: "workers.write_file", description: "Write or update a file in a worker bundle." },
      { name: "workers.logs", description: "Fetch cross-run log history, filterable by level and time." },
      { name: "workers.stats", description: "7-day run statistics for a specific worker." },
      { name: "workers.timeseries", description: "Daily run counts and success/failure trend over N days." },
      { name: "workers.sample_input", description: "Get example input values for a worker's fields." },
      { name: "workers.archive", description: "Archive a worker (reversible)." },
      { name: "workers.restore", description: "Restore an archived worker to active status." },
      { name: "workers.reload", description: "Reload all workers from disk (OSS self-hosted)." },
      { name: "workers.versions", description: "List saved versions of a worker." },
      { name: "workers.rollback", description: "Restore a worker to a previous version." },
      { name: "workers.alerts.list", description: "List configured alerts for a worker." },
      { name: "workers.alerts.create", description: "Add a failure/approval/success alert via webhook or email." },
      { name: "workers.alerts.delete", description: "Remove a worker alert." },
    ],
  },
  {
    group: "Runs",
    tools: [
      { name: "runs.list", description: "List runs, optionally filtered by worker id or status." },
      { name: "runs.get", description: "Read one run with logs, outputs, artifacts, and approval state." },
      { name: "runs.watch", description: "Stream SSE run events until a terminal state." },
      { name: "runs.cancel", description: "Cancel an in-progress run." },
      { name: "runs.replay", description: "Replay a completed or failed run with the same inputs." },
    ],
  },
  {
    group: "Approvals",
    tools: [
      { name: "approvals.list", description: "List pending approval requests across all workers." },
      { name: "approvals.approve", description: "Approve a pending run so it continues executing." },
      { name: "approvals.reject", description: "Reject a pending run, stopping it." },
    ],
  },
  {
    group: "Secrets",
    tools: [
      { name: "secrets.list", description: "List secret names and status." },
      { name: "secrets.set", description: "Create or update a secret value." },
      { name: "secrets.delete", description: "Delete a secret." },
      { name: "secrets.test", description: "Verify a secret exists without revealing its value." },
    ],
  },
  {
    group: "Connections",
    tools: [
      { name: "connections.list", description: "List configured app connections." },
      { name: "connections.add_mcp", description: "Add an MCP server connection." },
      { name: "connections.delete", description: "Remove a connection." },
      { name: "connections.status", description: "Check connection health and auth status." },
      { name: "connections.test", description: "Run a live connectivity check on a connection." },
    ],
  },
  {
    group: "Contexts (Brain Packs)",
    tools: [
      { name: "contexts.list", description: "List context folders." },
      { name: "contexts.create", description: "Create a new brain pack context." },
      { name: "contexts.delete", description: "Delete a brain pack and all its files." },
      { name: "contexts.read", description: "Read a file from a context." },
      { name: "contexts.write", description: "Create or update a file in a context." },
      { name: "contexts.upload", description: "Upload a binary file to a context." },
      { name: "contexts.delete_file", description: "Delete a specific file from a context." },
      { name: "contexts.versions", description: "List saved versions of a brain pack." },
      { name: "contexts.rollback", description: "Restore a brain pack to a previous version." },
    ],
  },
  {
    group: "Triggers & Integrations",
    tools: [
      { name: "triggers.list", description: "List integration triggers, globally or per worker/app." },
      { name: "integrations.catalog", description: "Browse all available integrations." },
    ],
  },
  {
    group: "Workspace",
    tools: [
      { name: "workspace.chat", description: "Send a message to the workspace agent and get a reply." },
      { name: "workspace.instructions.get", description: "Read current workspace agent system prompt." },
      { name: "workspace.instructions.set", description: "Update workspace agent system prompt." },
      { name: "workspace.versions", description: "List version history of workspace instructions." },
      { name: "workspace.rollback", description: "Restore workspace instructions to a previous version." },
    ],
  },
  {
    group: "Conversations",
    tools: [
      { name: "conversations.list", description: "List past workspace agent conversations." },
      { name: "conversations.get", description: "Retrieve a full conversation by ID." },
    ],
  },
  {
    group: "System",
    tools: [
      { name: "system.overview", description: "Full workspace dashboard — health, runs, pending approvals, alerts." },
      { name: "system.stats", description: "7-day aggregate run statistics across the whole workspace." },
      { name: "system.info", description: "Platform version and configuration flags." },
      { name: "system.alerts", description: "Active system-wide alerts." },
    ],
  },
];

const TOTAL_TOOLS = TOOL_GROUPS.reduce((sum, g) => sum + g.tools.length, 0);

export function McpToolCatalog() {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-foreground">
          MCP &amp; CLI tools{" "}
          <span className="font-normal text-muted-foreground">({TOTAL_TOOLS})</span>
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Every tool the Workeros MCP server and CLI expose to connected agents. Custom MCP
          tools you add live under{" "}
          <a href="/connections/mcp" className="font-medium text-foreground underline underline-offset-2">
            Connections → MCP
          </a>
          .
        </p>
      </div>

      <div className="space-y-6">
        {TOOL_GROUPS.map((group) => (
          <div key={group.group} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.group}
            </h3>
            <div className="divide-y divide-line rounded-[var(--radius-button)] border border-line">
              {group.tools.map((tool) => (
                <div key={tool.name} className="px-3 py-2.5">
                  <code className="text-xs font-medium text-foreground">{tool.name}</code>
                  <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
