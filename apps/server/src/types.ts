// Shared types for the floom-chat backend.
// A trimmed subset of the marketplace schema — chat-app only needs apps,
// runs, secrets, hub_entries, embeddings, and chat threads.

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
  apt_packages?: string[];
}

export type AuthType =
  | 'bearer'
  | 'apikey'
  | 'basic'
  | 'oauth2_client_credentials'
  | 'none';

export interface AuthConfig {
  /** For auth: apikey — which HTTP header name carries the key. */
  apikey_header?: string;
  /** For auth: oauth2_client_credentials — token endpoint URL. */
  oauth2_token_url?: string;
  /** For auth: oauth2_client_credentials — space-separated scopes. */
  oauth2_scopes?: string;
}

export type AsyncMode = 'poll' | 'webhook' | 'stream';

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  manifest: string; // JSON-stringified NormalizedManifest
  status: 'active' | 'deploying' | 'failed';
  docker_image: string | null;
  code_path: string;
  category: string | null;
  author: string | null;
  icon: string | null;
  // proxied-mode fields (nullable for docker apps)
  app_type: 'docker' | 'proxied';
  base_url: string | null;
  auth_type: AuthType | null;
  auth_config: string | null; // JSON-stringified AuthConfig
  openapi_spec_url: string | null;
  openapi_spec_cached: string | null; // JSON-stringified OpenAPI spec
  visibility: 'public' | 'auth-required';
  // Async job queue fields (v0.3.0). is_async comes back from SQLite as 0/1.
  is_async: 0 | 1;
  webhook_url: string | null;
  timeout_ms: number | null;
  retries: number;
  async_mode: AsyncMode | null;
  created_at: string;
  updated_at: string;
}

// ---------- jobs (v0.3.0) ----------

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface JobRecord {
  id: string;
  slug: string;
  app_id: string;
  action: string;
  status: JobStatus;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  run_id: string | null;
  webhook_url: string | null;
  timeout_ms: number;
  max_retries: number;
  attempts: number;
  per_call_secrets_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout';

export type ErrorType =
  | 'timeout'
  | 'runtime_error'
  | 'missing_secret'
  | 'oom'
  | 'build_error';

export interface RunRecord {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: string | null;
  outputs: string | null;
  logs: string;
  status: RunStatus;
  error: string | null;
  error_type: ErrorType | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface SecretRecord {
  id: string;
  name: string;
  value: string;
  app_id: string | null;
  created_at: string;
}

export interface ChatThreadRecord {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatTurnRecord {
  id: string;
  thread_id: string;
  turn_index: number;
  kind: 'user' | 'assistant';
  // JSON blob capturing the turn payload. Shape varies by kind:
  //   user:      { text: string }
  //   assistant: { app_slug?, inputs?, run_id?, summary?, error?, parsed? }
  payload: string;
  created_at: string;
}
