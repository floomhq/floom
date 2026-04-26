export type InputType = 'text' | 'textarea' | 'url' | 'number' | 'enum' | 'boolean' | 'date' | 'file';
export type OutputType = 'text' | 'json' | 'table' | 'number' | 'html' | 'markdown' | 'pdf' | 'image' | 'file';
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
    secrets_needed?: string[];
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
    memory_keys?: string[];
    blocked_reason?: string;
    license?: string;
    render?: RenderConfig;
    primary_action?: string;
}
export interface RenderConfig {
    output_component?: string;
    [key: string]: unknown;
}
export type AuthType = 'bearer' | 'apikey' | 'basic' | 'oauth2_client_credentials' | 'none';
export interface AuthConfig {
    apikey_header?: string;
    oauth2_token_url?: string;
    oauth2_scopes?: string;
}
export type AsyncMode = 'poll' | 'webhook' | 'stream';
export interface AppRecord {
    id: string;
    slug: string;
    name: string;
    description: string;
    manifest: string;
    status: 'active' | 'deploying' | 'failed';
    docker_image: string | null;
    code_path: string;
    category: string | null;
    author: string | null;
    icon: string | null;
    app_type: 'docker' | 'proxied';
    base_url: string | null;
    auth_type: AuthType | null;
    auth_config: string | null;
    openapi_spec_url: string | null;
    openapi_spec_cached: string | null;
    visibility: 'public' | 'auth-required' | 'private';
    is_async: 0 | 1;
    webhook_url: string | null;
    timeout_ms: number | null;
    retries: number;
    async_mode: AsyncMode | null;
    workspace_id: string;
    memory_keys: string | null;
    featured: 0 | 1;
    avg_run_ms: number | null;
    publish_status: 'draft' | 'pending_review' | 'published' | 'rejected';
    thumbnail_url: string | null;
    stars: number;
    hero: 0 | 1;
    created_at: string;
    updated_at: string;
}
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
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
export type ErrorType = 'timeout' | 'runtime_error' | 'missing_secret' | 'oom' | 'build_error' | 'user_input_error' | 'auth_error' | 'upstream_outage' | 'network_unreachable' | 'floom_internal_error' | 'app_unavailable';
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
    upstream_status: number | null;
    duration_ms: number | null;
    started_at: string;
    finished_at: string | null;
    workspace_id?: string;
    user_id?: string | null;
    device_id?: string | null;
    is_public?: 0 | 1;
}
export interface SecretRecord {
    id: string;
    name: string;
    value: string;
    app_id: string | null;
    created_at: string;
}
export interface WorkspaceRecord {
    id: string;
    slug: string;
    name: string;
    plan: string;
    wrapped_dek: string | null;
    created_at: string;
}
export interface UserRecord {
    id: string;
    workspace_id: string | null;
    email: string | null;
    name: string | null;
    auth_provider: string;
    auth_subject: string | null;
    created_at: string;
}
export type WorkspaceMemberRole = 'admin' | 'editor' | 'viewer';
export type WorkspaceRole = WorkspaceMemberRole | 'guest';
export interface SessionContext {
    workspace_id: string;
    user_id: string;
    device_id: string;
    is_authenticated: boolean;
    auth_user_id?: string;
    auth_session_id?: string;
    email?: string;
}
export interface RuntimeResult {
    status: RunStatus;
    outputs: unknown;
    error?: string;
    error_type?: ErrorType;
    upstream_status?: number;
    duration_ms: number;
    logs: string;
}
export interface AppListFilter {
    workspace_id?: string;
    visibility?: 'public' | 'auth-required' | 'private';
    category?: string;
    featured?: boolean;
    limit?: number;
    offset?: number;
}
export interface RunListFilter {
    app_id?: string;
    workspace_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
}
export interface RuntimeAdapter {
    execute(app: AppRecord, manifest: NormalizedManifest, action: string, inputs: Record<string, unknown>, secrets: Record<string, string>, ctx: SessionContext, onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void): Promise<RuntimeResult>;
}
export interface StorageAdapter {
    getApp(slug: string): AppRecord | undefined;
    getAppById(id: string): AppRecord | undefined;
    listApps(filter?: AppListFilter): AppRecord[];
    createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): AppRecord;
    updateApp(slug: string, patch: Partial<AppRecord>): AppRecord | undefined;
    deleteApp(slug: string): boolean;
    createRun(input: {
        id: string;
        app_id: string;
        thread_id?: string | null;
        action: string;
        inputs: Record<string, unknown> | null;
    }): RunRecord;
    getRun(id: string): RunRecord | undefined;
    listRuns(filter?: RunListFilter): RunRecord[];
    updateRun(id: string, patch: {
        status?: RunStatus;
        outputs?: unknown;
        error?: string | null;
        error_type?: ErrorType | null;
        upstream_status?: number | null;
        logs?: string;
        duration_ms?: number | null;
        finished?: boolean;
    }): void;
    createJob(input: Omit<JobRecord, 'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'> & {
        status?: JobStatus;
    }): JobRecord;
    getJob(id: string): JobRecord | undefined;
    claimNextJob(): JobRecord | undefined;
    updateJob(id: string, patch: Partial<JobRecord>): void;
    getWorkspace(id: string): WorkspaceRecord | undefined;
    listWorkspacesForUser(user_id: string): Array<WorkspaceRecord & {
        role: WorkspaceRole;
    }>;
    getUser(id: string): UserRecord | undefined;
    getUserByEmail(email: string): UserRecord | undefined;
    createUser(input: UserWriteInput): UserRecord;
    upsertUser(input: UserWriteInput, updateColumns: UserWriteColumn[]): UserRecord;
    listAdminSecrets(app_id?: string | null): SecretRecord[];
    upsertAdminSecret(name: string, value: string, app_id?: string | null): void;
    deleteAdminSecret(name: string, app_id?: string | null): boolean;
}
export interface UserWriteInput {
    id: string;
    workspace_id?: string | null;
    email?: string | null;
    name?: string | null;
    auth_provider?: string;
    auth_subject?: string | null;
    image?: string | null;
    composio_user_id?: string | null;
}
export type UserWriteColumn = Exclude<keyof UserWriteInput, 'id'>;
export interface AuthAdapter {
    getSession(request: Request): Promise<SessionContext | null>;
    signIn(input: {
        email: string;
        password: string;
    }): Promise<{
        session: SessionContext;
        set_cookie?: string;
        token?: string;
    }>;
    signUp(input: {
        email: string;
        password: string;
        name?: string;
    }): Promise<{
        session: SessionContext;
        set_cookie?: string;
        token?: string;
    }>;
    signOut(session: SessionContext): Promise<void>;
    onUserDelete(cb: (user_id: string) => void | Promise<void>): void;
}
export interface SecretsAdapter {
    get(ctx: SessionContext, key: string): string | null;
    set(ctx: SessionContext, key: string, plaintext: string): void;
    delete(ctx: SessionContext, key: string): boolean;
    list(ctx: SessionContext): Array<{
        key: string;
        updated_at: string;
    }>;
    loadUserVaultForRun(ctx: SessionContext, keys: string[]): Record<string, string>;
    loadCreatorOverrideForRun(app_id: string, workspace_id: string, keys: string[]): Record<string, string>;
}
export interface ObservabilityAdapter {
    captureError(err: unknown, context?: Record<string, unknown>): void;
    increment(metric: string, amount?: number, tags?: Record<string, string>): void;
    timing(metric: string, ms: number, tags?: Record<string, string>): void;
    gauge(metric: string, value: number, tags?: Record<string, string>): void;
}
