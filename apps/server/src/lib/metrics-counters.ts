// Tiny in-memory counters for metrics that aren't derivable from SQLite.
//
// Two maps today:
//   - `mcpToolCalls`:   tool_name → total call count
//   - `rateLimitHits`:  scope → total 429 responses emitted
//
// Reset on process restart, same as the rate-limit store. Good enough for
// internal-tooling scale; swap for Redis / StatsD when we shard.

type ToolName = string;
type RateLimitScope = 'ip' | 'user' | 'app' | 'agent_token' | 'mcp_ingest';

const mcpToolCalls = new Map<ToolName, number>();
const rateLimitHits = new Map<RateLimitScope, number>();

export function recordMcpToolCall(toolName: string): void {
  if (!toolName) return;
  mcpToolCalls.set(toolName, (mcpToolCalls.get(toolName) || 0) + 1);
}

export function recordRateLimitHit(scope: RateLimitScope): void {
  rateLimitHits.set(scope, (rateLimitHits.get(scope) || 0) + 1);
}

export function snapshotMcpToolCalls(): Record<string, number> {
  return Object.fromEntries(mcpToolCalls);
}

export function snapshotRateLimitHits(): Record<string, number> {
  return Object.fromEntries(rateLimitHits);
}

/** Test-only: reset both counters. */
export function __resetCountersForTests(): void {
  mcpToolCalls.clear();
  rateLimitHits.clear();
}
