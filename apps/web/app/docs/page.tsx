import type { Metadata } from "next";
import Link from "next/link";
import { FloomMark } from "@/components/layout/sidebar";

export const metadata: Metadata = {
  title: "WorkerOS — Docs",
  description: "Learn how to create, configure, and run AI workers with WorkerOS.",
};

// -----------------------------------------------------------------------
// /docs — aligned to the v3 design system.
// Fix #7: same tokens/typography/spacing as the v3 landing, not the
// app shell. Standalone route (no sidebar), uses --bg-app / --ink / etc.
// -----------------------------------------------------------------------

const SECTIONS = [
  {
    id: "getting-started",
    title: "Getting started",
    entries: [
      { href: "#hire-a-worker", label: "Hire your first worker" },
      { href: "#what-is-a-worker", label: "What is a worker?" },
      { href: "#workers-vs-runs", label: "Workers vs. runs" },
    ],
  },
  {
    id: "workers",
    title: "Workers",
    entries: [
      { href: "#create-from-prompt", label: "Create from a prompt" },
      { href: "#create-from-file", label: "Create from a file (.md / .py / .zip)" },
      { href: "#triggers", label: "Triggers: schedule, webhook, manual" },
      { href: "#connections", label: "Connections: give workers access to your tools" },
      { href: "#brain", label: "Brain: give workers context and knowledge" },
    ],
  },
  {
    id: "runs",
    title: "Runs",
    entries: [
      { href: "#run-a-worker", label: "Run a worker" },
      { href: "#view-output", label: "View output and artifacts" },
      { href: "#approvals", label: "Approvals: human-in-the-loop" },
    ],
  },
  {
    id: "mcp",
    title: "MCP & integrations",
    entries: [
      { href: "#mcp-target", label: "Use WorkerOS as an MCP server" },
      { href: "#mcp-config", label: "MCP configuration" },
      { href: "#cli", label: "CLI: workeros" },
    ],
  },
];

function McpTargetSection() {
  return (
    <section id="mcp-target" className="pt-10 border-t border-[#E7E0D6]">
      <h2 className="text-[20px] font-semibold text-[#16171A] mb-3">WorkerOS as an MCP server</h2>
      <p className="text-[14px] text-[#6B7280] leading-[1.65] mb-4">
        WorkerOS exposes every worker as an MCP tool. Point Claude Desktop, Cursor, or any MCP
        client at your workspace endpoint and your workers become first-class tools — callable
        directly from your AI assistant.
      </p>

      {/* MCP target picker — styled to match v3 design tokens */}
      <div className="rounded-2xl ring-1 ring-black/[0.06] bg-white overflow-hidden">
        <div className="flex border-b border-[#E7E0D6] overflow-x-auto">
          {["Claude Desktop", "Cursor", "Codex", "VS Code", "Windsurf", "Cline"].map(
            (client, i) => (
              <button
                key={client}
                className={`px-4 py-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
                  i === 0
                    ? "text-[#3E6FE0] border-b-2 border-[#3E6FE0]"
                    : "text-[#6B7280] hover:text-[#16171A]"
                }`}
              >
                {client}
              </button>
            ),
          )}
        </div>
        <div className="p-4 space-y-3">
          <p className="text-[13px] text-[#6B7280]">
            Add the following to your{" "}
            <code className="text-[#16171A] bg-[#F1EEE8] px-1 py-0.5 rounded text-[12px]">
              claude_desktop_config.json
            </code>
            :
          </p>
          <pre className="bg-[#F1EEE8] rounded-xl p-4 text-[12px] font-mono text-[#16171A] overflow-x-auto">
            {`{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros-mcp"],
      "env": {
        "WORKEROS_BASE_URL": "https://workers-api.floom.dev",
        "WORKEROS_TOKEN": "<your-api-token>"
      }
    }
  }
}`}
          </pre>
          <p className="text-[12px] text-[#6B7280]">
            Get your API token in{" "}
            <Link href="/settings" className="text-[#3E6FE0] hover:underline">
              Settings → Developer
            </Link>
            .
          </p>
        </div>
      </div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Nav — same as v3 landing */}
      <header className="sticky top-0 z-50 border-b border-[#E7E0D6] bg-[#FAFAF7]/90 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/v3" className="flex items-center gap-2">
            <FloomMark size={22} />
            <span className="text-[14px] font-semibold tracking-tight text-[#16171A]">WorkerOS</span>
          </Link>
          <nav className="hidden sm:flex items-center gap-6">
            <span className="text-[13px] font-medium text-[#16171A]">Docs</span>
            <Link href="/login" className="text-[13px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Sign in
            </Link>
          </nav>
          <Link
            href="/workers/new"
            className="bg-[#16171A] text-white text-[13px] font-medium px-4 py-2 rounded-[10px] whitespace-nowrap hover:bg-[#2a2b2f] transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-5 py-10 flex gap-10">
        {/* Sidebar TOC */}
        <aside className="hidden lg:block w-52 shrink-0 sticky top-20 self-start">
          <nav className="space-y-4">
            {SECTIONS.map((sec) => (
              <div key={sec.id}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6B7280] mb-1.5">
                  {sec.title}
                </p>
                <div className="space-y-0.5">
                  {sec.entries.map((e) => (
                    <Link
                      key={e.href}
                      href={e.href}
                      className="block text-[12.5px] text-[#6B7280] hover:text-[#16171A] py-0.5 transition-colors"
                    >
                      {e.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 max-w-2xl space-y-10">
          {/* Getting started */}
          <section id="getting-started">
            <h1 className="text-[32px] font-semibold text-[#16171A] tracking-tight mb-2">
              WorkerOS docs
            </h1>
            <p className="text-[15px] text-[#6B7280] leading-[1.65]">
              WorkerOS lets you hire AI workers — jobs that run themselves using your tools, on
              your schedule. Workers read context from your Brain, use connected apps through
              Composio, and surface outputs for review when they need a human decision.
            </p>
          </section>

          <section id="what-is-a-worker" className="pt-6 border-t border-[#E7E0D6]">
            <h2 className="text-[20px] font-semibold text-[#16171A] mb-3">What is a worker?</h2>
            <p className="text-[14px] text-[#6B7280] leading-[1.65]">
              A worker is a job definition: what to do, what tools to use, and when to run. Each
              worker has a <code className="text-[#16171A] bg-[#F1EEE8] px-1 py-0.5 rounded text-[12px]">worker.yml</code>{" "}
              that declares its name, trigger, connections, and instructions. Workers run on
              WorkerOS infrastructure — you never manage servers or cron jobs.
            </p>
          </section>

          <section id="hire-a-worker" className="pt-6 border-t border-[#E7E0D6]">
            <h2 className="text-[20px] font-semibold text-[#16171A] mb-3">Hire your first worker</h2>
            <ol className="space-y-3 text-[14px] text-[#6B7280] leading-[1.65] list-none">
              {[
                <>Go to <Link href="/workers/new" className="text-[#3E6FE0] hover:underline">Workers → New worker</Link>.</>,
                "Describe the job in plain English — e.g. \"Summarise my Granola meetings and post action items to HubSpot daily\".",
                "WorkerOS detects the tools you mentioned and drafts a worker file.",
                "Connect the apps WorkerOS detected (Granola, HubSpot) in the Connections tab.",
                "Set a trigger (daily at 9am, webhook, manual) and save.",
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="size-5 rounded-full bg-[#F1EEE8] text-[#16171A] text-[11px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* MCP target picker — Fix #7: uses v3 tokens */}
          <McpTargetSection />

          <section id="cli" className="pt-10 border-t border-[#E7E0D6]">
            <h2 className="text-[20px] font-semibold text-[#16171A] mb-3">CLI: workeros</h2>
            <p className="text-[14px] text-[#6B7280] leading-[1.65] mb-4">
              The WorkerOS CLI lets you manage workers, switch workspaces, and call your MCP server
              from the terminal.
            </p>
            <pre className="bg-[#F1EEE8] rounded-xl p-4 text-[12px] font-mono text-[#16171A] overflow-x-auto">
              {`npm install -g @floomhq/workeros-mcp\nworkeros --help`}
            </pre>
          </section>
        </main>
      </div>

      {/* Footer */}
      <footer className="border-t border-[#E7E0D6] bg-[#F5F2EE] mt-16">
        <div className="max-w-6xl mx-auto px-5 py-8 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <FloomMark size={18} />
            <span className="text-[12.5px] font-semibold text-[#16171A]">WorkerOS</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/v3" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Home
            </Link>
            <Link href="/privacy" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
