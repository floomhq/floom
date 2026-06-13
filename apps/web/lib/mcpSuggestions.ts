// Static MCP install suggestions, per Codex Q1 verdict 2026-05-28:
// flat { npm_package, env_vars } shape. This is the V0 hardcoded registry;
// when the backend ships a /mcp-suggestions endpoint, this file becomes
// the seed payload and the UI swaps to fetching live.
//
// Curation principles:
// - Only MCPs with a maintained npm package, exposing tools agents would
//   actually call inside a Floom worker.
// - env_vars listed are the ONLY ones the MCP needs. Workers can satisfy
//   them via the existing /secrets surface.
// - Description is one line, no marketing.

export interface McpSuggestion {
  name: string;
  npm_package: string;
  description: string;
  env_vars: string[];
  homepage?: string;
}

export const MCP_SUGGESTIONS: McpSuggestion[] = [
  {
    name: "GitHub",
    npm_package: "@modelcontextprotocol/server-github",
    description: "Issues, PRs, files, branches, code search across GitHub repos.",
    env_vars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    name: "Context7",
    npm_package: "@upstash/context7-mcp",
    description: "Pull up-to-date docs and code from any library, indexed by Upstash.",
    env_vars: [],
    homepage: "https://github.com/upstash/context7",
  },
  {
    name: "shadcn",
    npm_package: "shadcn-ui-mcp-server",
    description: "Read shadcn/ui component source so agents can author idiomatic Next.js UI.",
    env_vars: [],
    homepage: "https://github.com/Jpisnice/shadcn-ui-mcp-server",
  },
  {
    name: "Exa",
    npm_package: "exa-mcp-server",
    description: "Neural web search optimized for agents; returns clean text snippets.",
    env_vars: ["EXA_API_KEY"],
    homepage: "https://github.com/exa-labs/exa-mcp-server",
  },
  {
    name: "Linear",
    npm_package: "@tacticlaunch/mcp-linear",
    description: "Create, query, update Linear issues, projects, cycles, comments.",
    env_vars: ["LINEAR_API_KEY"],
    homepage: "https://github.com/tacticlaunch/mcp-linear",
  },
  {
    name: "Stripe",
    npm_package: "@stripe/mcp",
    description: "Customers, charges, subscriptions, products — read + write via Stripe API.",
    env_vars: ["STRIPE_SECRET_KEY"],
    homepage: "https://github.com/stripe/agent-toolkit",
  },
  {
    name: "Playwright",
    npm_package: "@playwright/mcp",
    description: "Headless browser automation: navigate, click, fill, screenshot, scrape.",
    env_vars: [],
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    name: "Filesystem",
    npm_package: "@modelcontextprotocol/server-filesystem",
    description: "Sandbox-scoped read/write of files; safe inside an E2B worker bundle.",
    env_vars: [],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "Slack",
    npm_package: "@modelcontextprotocol/server-slack",
    description: "Post messages, query channels, list users on a Slack workspace.",
    env_vars: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
  },
  {
    name: "Postgres",
    npm_package: "@modelcontextprotocol/server-postgres",
    description: "Read-only SQL over any reachable Postgres database.",
    env_vars: ["POSTGRES_CONNECTION_STRING"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
];

// Lookup helper: does the user have all env_vars set in /secrets?
// The caller fetches the user's secret keys and passes them in.
export function suggestionStatus(s: McpSuggestion, configuredSecrets: Set<string>): "ready" | "needs_secrets" {
  for (const env of s.env_vars) {
    if (!configuredSecrets.has(env)) return "needs_secrets";
  }
  return "ready";
}
