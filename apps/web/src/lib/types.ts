// Shared frontend types. Mirrors the server's API response shapes.

export type InputType =
  | 'text'
  | 'textarea'
  | 'url'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'date'
  | 'file';

export type OutputType =
  | 'text'
  | 'json'
  | 'table'
  | 'number'
  | 'html'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'file';

export interface InputSpec {
  name: string;
  type: InputType;
  label: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  placeholder?: string;
  description?: string;
}

export interface OutputSpec {
  name: string;
  type: OutputType;
  label: string;
  description?: string;
}

export interface ActionSpec {
  label: string;
  description?: string;
  inputs: InputSpec[];
  outputs: OutputSpec[];
}

export interface NormalizedManifest {
  name: string;
  description: string;
  actions: Record<string, ActionSpec>;
  runtime: 'python' | 'node';
  python_dependencies: string[];
  node_dependencies: Record<string, string>;
  secrets_needed: string[];
  manifest_version: '1.0' | '2.0';
}

export interface HubApp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  author: string | null;
  icon: string | null;
  actions: string[];
  runtime: string;
  created_at: string;
  /**
   * Pinned to the top of the store. Backend default order is
   * `featured DESC, avg_run_ms ASC, created_at DESC, name ASC` so the
   * frontend does not have to re-sort when this flag is set.
   */
  featured?: boolean;
  /**
   * Rolling average run time in milliseconds (last 20 successful runs).
   * Null until at least one successful run has been recorded.
   */
  avg_run_ms?: number | null;
  /**
   * Optional: if the app is blocked in this self-host environment
   * (e.g. `flyfast` pending internal flight-search infra), the reason is
   * surfaced here and rendered as a warning pill on the store card.
   * Absence = app is runnable.
   */
  blocked_reason?: string;
}

export interface AppDetail extends HubApp {
  manifest: NormalizedManifest;
}

export interface PickResult {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  confidence: number;
}

export interface ParseResult {
  app_slug: string;
  action: string;
  inputs: Record<string, unknown>;
  confidence: number;
  reasoning: string;
}

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout';

export interface RunRecord {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  status: RunStatus;
  error: string | null;
  error_type: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  logs: string;
}

// ---------- W4-minimal: session + dashboard types ----------

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface SessionWorkspace {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
}

export interface SessionMePayload {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    is_local: boolean;
  };
  active_workspace: SessionWorkspace;
  workspaces: SessionWorkspace[];
  cloud_mode: boolean;
}

export interface MeRunSummary {
  id: string;
  action: string;
  status: RunStatus;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_type: string | null;
  app_slug: string | null;
  app_name: string | null;
  app_icon: string | null;
}

export interface MeRunDetail extends MeRunSummary {
  app_id: string;
  thread_id: string | null;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  logs: string;
}

export interface ReviewSummary {
  count: number;
  avg: number;
}

export interface Review {
  id: string;
  app_slug: string;
  rating: number;
  title: string | null;
  body: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRecord {
  id: string;
  provider: string;
  owner_kind: 'device' | 'user';
  status: 'pending' | 'active' | 'revoked' | 'expired';
  composio_connection_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface DetectedApp {
  slug: string;
  name: string;
  description: string;
  actions: Array<{ name: string; label: string; description?: string }>;
  auth_type: string | null;
  category: string | null;
  openapi_spec_url: string;
  tools_count: number;
  secrets_needed: string[];
}

export interface CreatorApp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  author: string | null;
  status: string;
  app_type: string;
  openapi_spec_url: string | null;
  created_at: string;
  updated_at: string;
  run_count: number;
  last_run_at: string | null;
}

export interface CreatorRun {
  id: string;
  action: string;
  status: RunStatus;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_type: string | null;
  caller_hash: string;
  is_self: boolean;
}
