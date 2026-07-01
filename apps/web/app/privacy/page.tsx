export const metadata = {
  title: "Privacy | Floom",
  description: "How Floom handles data.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Last updated 2026-07-01.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-relaxed">
        <p>
          Floom runs AI workers for your workspace. This policy describes Floom
          Cloud and the Floom web, CLI, and MCP experiences. If you self-host
          Floom, your deployment operator controls where that data is stored.
        </p>

        <h2 className="pt-2 text-base font-medium">Information we store</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account and workspace data</strong>: your account identity,
            workspace membership, settings, CLI/MCP tokens, and audit-relevant
            product events.
          </li>
          <li>
            <strong>Workers and runs</strong>: worker definitions, run inputs,
            step logs, tool calls, outputs, errors, schedules, approvals, and
            cost or usage metadata.
          </li>
          <li>
            <strong>Secrets</strong>: API keys and credentials you add are stored
            so workers can use them. Secret values are write-only through the
            API and are not returned to the browser after creation.
          </li>
          <li>
            <strong>Connections</strong>: OAuth connections, MCP endpoints, and
            connected-account metadata needed to let workers use the tools you
            authorize.
          </li>
          <li>
            <strong>Conversations and Library folders</strong>: workspace agent
            chat history, instructions, uploaded files, and generated artifacts.
          </li>
        </ul>

        <h2 className="pt-2 text-base font-medium">How workers use data</h2>
        <p>
          Workers may send relevant inputs, files, prompts, outputs, and tool
          requests to model, sandbox, connection, email, calendar, messaging, or
          other providers you connect. Those providers process data under their
          own terms and privacy policies.
        </p>

        <h2 className="pt-2 text-base font-medium">CLI and MCP access</h2>
        <p>
          Approving a CLI or MCP device creates a token for that client. The
          client can act in the workspace according to the tools available to
          it until you revoke the token, remove the MCP config, or disconnect
          the client.
        </p>

        <h2 className="pt-2 text-base font-medium">Analytics and diagnostics</h2>
        <p>
          Floom may collect product analytics, usage counts, latency, errors,
          and coarse feature events to improve reliability and onboarding. These
          events are designed to avoid raw worker inputs, outputs, secrets, and
          file contents.
        </p>

        <h2 className="pt-2 text-base font-medium">Retention and deletion</h2>
        <p>
          Workspace admins can delete workers, runs, conversations, Library
          folders, secrets, connections, and tokens through the product where
          those controls are available. Some logs, backups, security records,
          billing records, or abuse-prevention records may be retained for a
          limited period as needed to operate the service.
        </p>

        <h2 className="pt-2 text-base font-medium">Security</h2>
        <p>
          Floom separates hosted service credentials from worker runtime
          execution. Workers run in isolated sandboxes and should receive only
          the credentials or connected-tool access needed for the task.
        </p>

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
