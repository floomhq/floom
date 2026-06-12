import { redirect } from "next/navigation";

// Full-page MCP detail is intentionally gone. The split-pane detail in
// `ConnectionsCollection` owns `api.connections.list`, `Test connection`,
// `Remove`, `mcpServers`/Claude Desktop JSON config, and the `MCP servers`
// navigation context before this route redirects to `/connections?sel=<id>`.
export default async function McpConnectionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/connections?sel=${encodeURIComponent(id)}`);
}
