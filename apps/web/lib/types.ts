export interface Worker {
  id: string;
  name: string;
  description?: string;
  status: string;
  trigger_type: string;
  runner: string;
  config: WorkerConfig;
  last_run?: RunSummary;
  recent_runs?: RunSummary[];
}

export interface WorkerConfig {
  id: string;
  name: string;
  description?: string;
  trigger: { type: string; cron?: string; every?: string; at?: string };
  runtime: { type: string; entrypoint: string; runner: string };
  inputs: WorkerInput[];
  secrets: string[];
  outputs: WorkerOutput[];
  approvals: { required: boolean; label?: string };
}

export interface WorkerInput {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  default?: any;
}

export interface WorkerOutput {
  name: string;
  label: string;
  type: string;
}

export interface RunSummary {
  id: string;
  worker_id?: string;
  worker_name?: string;
  status: string;
  trigger_source: string;
  created_at: string;
  approval_status?: string;
}

export interface RunDetail extends RunSummary {
  input: Record<string, any>;
  output: Record<string, any>;
  logs: LogEntry[];
  artifacts: Artifact[];
  approval?: Approval;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

export interface Artifact {
  id: string;
  run_id: string;
  name: string;
  type?: string;
  path: string;
  size_bytes?: number;
  created_at: string;
}

export interface Approval {
  id: string;
  run_id: string;
  worker_id: string;
  worker_name?: string;
  status: string;
  label?: string;
  preview?: string;
  created_at: string;
  decided_at?: string;
}

export interface Secret {
  name: string;
  status: string;
  last_used_at?: string;
  used_by: string[];
}
