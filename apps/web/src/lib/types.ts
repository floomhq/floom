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

