export const metadata = {
  title: "Privacy - WorkerOS Cloud",
  description: "How WorkerOS Cloud handles workspace data and telemetry.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Privacy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Last updated 2026-06-01.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-relaxed">
        <p>
          WorkerOS Cloud stores workspace data so workers, the workspace agent,
          and connected tools can operate across sessions. Data is scoped by
          workspace and authenticated user.
        </p>

        <h2 className="pt-2 text-base font-medium">What is stored</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Workers and runs</strong> - worker definitions, inputs, run
            logs, tool calls, outputs, errors, schedules, approvals, and
            artifacts.
          </li>
          <li>
            <strong>Brain packs</strong> - files and notes added to workspace
            knowledge packs, plus version history where enabled.
          </li>
          <li>
            <strong>Connections and secrets</strong> - OAuth connection metadata,
            MCP server configuration, secret names, and encrypted secret values.
            Secret values are write-only through the browser.
          </li>
          <li>
            <strong>Workspace agent data</strong> - instructions, resolved
            prompts, conversations, channel wiring, and tool configuration.
          </li>
          <li>
            <strong>Product telemetry</strong> - page views, safe UI interaction
            events, error events, and coarse environment details such as
            viewport size and timezone. Telemetry is sanitized server-side:
            token-shaped strings, email addresses, and sensitive property keys
            are redacted before storage.
          </li>
        </ul>

        <h2 className="pt-2 text-base font-medium">Where data is stored</h2>
        <p>
          Cloud workspace records are stored in Supabase with row-level
          workspace/user policies. Workers execute in E2B sandbox microVMs.
          Connected-tool actions may be brokered through Composio or MCP
          servers configured by the workspace.
        </p>

        <h2 className="pt-2 text-base font-medium">Third parties</h2>
        <p>
          WorkerOS can send data to providers selected for a workspace, including
          model providers, E2B, Composio, OAuth providers such as Google or
          Slack, MCP servers, and transactional email providers when email is
          enabled. Those providers process data under their own terms.
        </p>

        <h2 className="pt-2 text-base font-medium">Controls</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Telemetry preferences, export, and deletion are available through the telemetry API.</li>
          <li>Workspace API tokens are scoped to one workspace and can be revoked.</li>
          <li>Secrets can be deleted or rotated by the workspace owner.</li>
          <li>Workers, runs, approvals, and brain-pack files can be deleted from the app.</li>
        </ul>

        <p className="pt-2 text-muted-foreground">
          See also the{" "}
          <a className="underline" href="/terms">
            Terms
          </a>
          .
        </p>
      </div>
    </div>
  );
}
