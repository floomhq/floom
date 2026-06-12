export const metadata = {
  title: "Privacy — Floom",
  description: "How Floom handles data.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Privacy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Last updated 2026-05-29.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-relaxed">
        <p>
          Floom is open-source software that runs AI workers on
          infrastructure operated by whoever deploys it. This instance is a
          single-tenant deployment: it stores data for one account owner and
          is not a multi-user service collecting third-party personal data.
        </p>

        <h2 className="text-base font-medium pt-2">What is stored</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Workers and runs</strong> — worker definitions, run inputs,
            step logs, tool calls, outputs, errors, and cost, in a local SQLite
            database on the server.
          </li>
          <li>
            <strong>Secrets</strong> — API keys and credentials you add are
            stored on the server so workers can use them. They are write-only
            through the API: values are never returned to the browser.
          </li>
          <li>
            <strong>Connections</strong> — OAuth connections (via Composio) and
            MCP endpoints you authorize, referenced by internal identifiers.
            OAuth access tokens are held by the connection provider, not in this
            database.
          </li>
          <li>
            <strong>Conversations and brain packs</strong> — workspace agent
            chat history and any brain-pack files you create.
          </li>
          <li>
            <strong>Artifacts</strong> — files produced by runs, stored on the
            server filesystem.
          </li>
        </ul>

        <h2 className="text-base font-medium pt-2">Where it runs</h2>
        <p>
          Workers execute in ephemeral E2B sandbox microVMs, never in the API
          process. Platform infrastructure secrets (the shared API secret,
          Composio key, E2B key) are never injected into worker sandboxes.
        </p>

        <h2 className="text-base font-medium pt-2">Third parties</h2>
        <p>
          To run workers, this instance may send data to the model and tool
          providers you configure — for example OpenAI (LLM calls), E2B
          (sandbox execution), and Composio (connections). Data sent to those
          providers is governed by their own terms and privacy policies.
        </p>

        <h2 className="text-base font-medium pt-2">Retention and deletion</h2>
        <p>
          The account owner controls retention. Runs, secrets, connections,
          conversations, and brain packs can be deleted through the app or by
          removing them from the server. There is no separate data-export
          requirement because the owner already controls the database and
          filesystem directly.
        </p>

        <p className="text-muted-foreground pt-2">
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
