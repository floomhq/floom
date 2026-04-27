export type InputType = 'text' | 'textarea' | 'url' | 'number' | 'enum' | 'boolean' | 'date' | 'file' | 'file/csv' | 'file/image' | 'file/pdf' | 'file/audio' | 'array' | 'object';
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
    network?: {
        allowed_domains: string[];
    };
    render?: RenderConfig;
    max_run_retention_days?: number;
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
export type AppVisibilityState = 'private' | 'link' | 'invited' | 'pending_review' | 'public_live' | 'changes_requested';
export type LegacyAppVisibility = 'public' | 'auth-required';
export type AppVisibility = AppVisibilityState | LegacyAppVisibility;
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
    visibility: AppVisibility;
    link_share_token: string | null;
    link_share_requires_auth: 0 | 1;
    review_submitted_at: string | null;
    review_decided_at: string | null;
    review_decided_by: string | null;
    review_comment: string | null;
    is_async: 0 | 1;
    webhook_url: string | null;
    timeout_ms: number | null;
    retries: number;
    async_mode: AsyncMode | null;
    max_run_retention_days: number | null;
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
    workspace_id: string | null;
    user_id: string | null;
    device_id: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
}
export interface JobListFilter {
    slug?: string;
    app_id?: string;
    status?: JobStatus;
    limit?: number;
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
export interface AppReviewRecord {
    id: string;
    workspace_id: string;
    app_slug: string;
    user_id: string;
    rating: number;
    title: string | null;
    body: string | null;
    created_at: string;
    updated_at: string;
}
export interface AppReviewListFilter {
    app_slug?: string;
    workspace_id?: string;
    user_id?: string;
    limit?: number;
    offset?: number;
}
export interface StudioAppSummaryRecord {
    id: string;
    slug: string;
    name: string;
    icon: string | null;
    publish_status: string | null;
    visibility: string | null;
    created_at: string;
    updated_at: string;
    last_run_at: string | null;
    runs_7d: number;
}
export interface StudioAppSummaryFilter {
    workspace_id: string;
    author?: string | null;
}
export interface SecretRecord {
    id: string;
    name: string;
    value: string;
    app_id: string | null;
    created_at: string;
}
export type SecretPolicy = 'user_vault' | 'creator_override';
export interface AdminSecretMetadata {
    key: string;
    updated_at: string;
}
export interface CreatorPolicyMetadata {
    key: string;
    policy: SecretPolicy;
}
export interface EncryptedSecretRecord {
    workspace_id: string;
    key: string;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    encrypted_dek: string;
    created_at: string;
    updated_at: string;
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
    image?: string | null;
    is_admin?: 0 | 1;
    deleted_at?: string | null;
    delete_at?: string | null;
    composio_user_id?: string | null;
    created_at: string;
}
export type AgentTokenScope = 'read' | 'read-write' | 'publish-only';
export interface AgentTokenRecord {
    id: string;
    prefix: string;
    hash: string;
    label: string;
    scope: AgentTokenScope;
    workspace_id: string;
    user_id: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
    rate_limit_per_minute: number;
}
export interface RunThreadRecord {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}
export interface RunTurnRecord {
    id: string;
    thread_id: string;
    turn_index: number;
    kind: 'user' | 'assistant';
    payload: string;
    created_at: string;
}
export type WorkspaceMemberRole = 'admin' | 'editor' | 'viewer';
export type WorkspaceRole = WorkspaceMemberRole | 'guest';
export interface WorkspaceMemberRecord {
    workspace_id: string;
    user_id: string;
    role: WorkspaceMemberRole | string;
    joined_at: string;
}
export interface WorkspaceMemberWithUserRecord extends WorkspaceMemberRecord {
    email: string | null;
    name: string | null;
}
export interface WorkspaceInviteRecord {
    id: string;
    workspace_id: string;
    email: string;
    role: WorkspaceRole;
    invited_by_user_id: string;
    token: string;
    status: 'pending' | 'accepted' | 'revoked' | 'expired';
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
}
export interface AppMemoryRecord {
    workspace_id: string;
    app_slug: string;
    user_id: string;
    device_id: string | null;
    key: string;
    value: string;
    updated_at: string;
}
export type ConnectionOwnerKind = 'device' | 'user';
export type ConnectionStatus = 'pending' | 'active' | 'revoked' | 'expired';
export interface ConnectionRecord {
    id: string;
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    provider: string;
    composio_connection_id: string;
    composio_account_id: string;
    status: ConnectionStatus;
    metadata_json: string | null;
    created_at: string;
    updated_at: string;
}
export type AppInviteState = 'pending_email' | 'pending_accept' | 'accepted' | 'revoked' | 'declined';
export interface AppInviteRecord {
    id: string;
    app_id: string;
    invited_user_id: string | null;
    invited_email: string | null;
    state: AppInviteState;
    created_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
    invited_by_user_id: string;
    invited_user_name?: string | null;
    invited_user_email?: string | null;
}
export interface LinkShareRecord {
    app_id: string;
    app_slug: string;
    visibility: AppVisibility;
    link_share_token: string | null;
    link_share_requires_auth: 0 | 1;
    updated_at: string;
}
export interface VisibilityAuditRecord {
    id: string;
    app_id: string;
    from_state: string | null;
    to_state: string;
    actor_user_id: string;
    reason: string;
    metadata: string | null;
    created_at: string;
}
export type TriggerType = 'schedule' | 'webhook';
export interface TriggerRecord {
    id: string;
    app_id: string;
    user_id: string;
    workspace_id: string;
    action: string;
    inputs: string;
    trigger_type: TriggerType;
    cron_expression: string | null;
    tz: string | null;
    webhook_secret: string | null;
    webhook_url_path: string | null;
    next_run_at: number | null;
    last_fired_at: number | null;
    enabled: 0 | 1;
    retry_policy: string | null;
    created_at: number;
    updated_at: number;
}
export interface SessionContext {
    workspace_id: string;
    user_id: string;
    device_id: string;
    is_authenticated: boolean;
    auth_user_id?: string;
    auth_session_id?: string;
    email?: string;
    agent_token_id?: string;
    agent_token_scope?: AgentTokenScope;
    agent_token_rate_limit_per_minute?: number;
}
export interface AdapterHealth {
    ok: boolean;
    details?: Record<string, unknown>;
}
export interface AdapterLifecycle {
    ready?(): Promise<void>;
    health?(): Promise<AdapterHealth>;
    close?(): Promise<void>;
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
export interface RuntimeExecutionContext {
    runId?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
}
export interface AppListFilter {
    workspace_id?: string;
    visibility?: AppVisibility;
    category?: string;
    featured?: boolean;
    limit?: number;
    offset?: number;
}
export interface RunListFilter {
    app_id?: string;
    workspace_id?: string;
    user_id?: string;
    device_id?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
}
export interface RuntimeAdapter extends AdapterLifecycle {
    execute(app: AppRecord, manifest: NormalizedManifest, action: string, inputs: Record<string, unknown>, secrets: Record<string, string>, ctx: SessionContext, onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void, runContext?: RuntimeExecutionContext): Promise<RuntimeResult>;
}
export interface StorageAdapter extends AdapterLifecycle {
    getApp(slug: string): Promise<AppRecord | undefined>;
    getAppById(id: string): Promise<AppRecord | undefined>;
    listApps(filter?: AppListFilter, ctx?: SessionContext): Promise<AppRecord[]>;
    createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): Promise<AppRecord>;
    updateApp(slug: string, patch: Partial<AppRecord>): Promise<AppRecord | undefined>;
    deleteApp(slug: string): Promise<boolean>;
    createRun(input: {
        id: string;
        app_id: string;
        thread_id?: string | null;
        action: string;
        inputs: Record<string, unknown> | null;
        workspace_id?: string;
        user_id?: string | null;
        device_id?: string | null;
    }): Promise<RunRecord>;
    getRun(id: string): Promise<RunRecord | undefined>;
    listRuns(filter?: RunListFilter, ctx?: SessionContext): Promise<RunRecord[]>;
    updateRun(id: string, patch: {
        status?: RunStatus;
        outputs?: unknown;
        error?: string | null;
        error_type?: ErrorType | null;
        upstream_status?: number | null;
        logs?: string;
        duration_ms?: number | null;
        finished?: boolean;
        is_public?: 0 | 1 | boolean;
    }): Promise<void>;
    listStudioAppSummaries(filter: StudioAppSummaryFilter, ctx?: SessionContext): Promise<StudioAppSummaryRecord[]>;
    createAppReview(input: AppReviewRecord): Promise<AppReviewRecord>;
    getAppReview(id: string): Promise<AppReviewRecord | undefined>;
    listAppReviews(filter?: AppReviewListFilter, ctx?: SessionContext): Promise<AppReviewRecord[]>;
    updateAppReview(id: string, patch: Pick<AppReviewRecord, 'rating'> & Partial<Pick<AppReviewRecord, 'title' | 'body' | 'updated_at'>>): Promise<AppReviewRecord | undefined>;
    deleteAppReview(id: string): Promise<boolean>;
    createRunThread(input: {
        id: string;
        title?: string | null;
        workspace_id?: string;
        user_id?: string | null;
        device_id?: string | null;
    }): Promise<RunThreadRecord>;
    getRunThread(id: string): Promise<RunThreadRecord | undefined>;
    listRunTurns(thread_id: string, ctx?: SessionContext): Promise<RunTurnRecord[]>;
    appendRunTurn(input: {
        id: string;
        thread_id: string;
        kind: RunTurnRecord['kind'];
        payload: string;
    }): Promise<RunTurnRecord>;
    updateRunThread(id: string, patch: {
        title?: string | null;
    }): Promise<RunThreadRecord | undefined>;
    createAgentToken(input: AgentTokenRecord): Promise<AgentTokenRecord>;
    listAgentTokensForUser(user_id: string, ctx?: SessionContext): Promise<AgentTokenRecord[]>;
    getAgentTokenForUser(id: string, user_id: string): Promise<AgentTokenRecord | undefined>;
    revokeAgentTokenForUser(id: string, user_id: string, revoked_at: string): Promise<AgentTokenRecord | undefined>;
    createJob(input: Omit<JobRecord, 'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status' | 'workspace_id' | 'user_id' | 'device_id'> & {
        status?: JobStatus;
        workspace_id?: string | null;
        user_id?: string | null;
        device_id?: string | null;
    }): Promise<JobRecord>;
    getJob(id: string): Promise<JobRecord | undefined>;
    listJobs(filter?: JobListFilter): Promise<JobRecord[]>;
    claimJob(id: string): Promise<JobRecord | undefined>;
    claimNextJob(): Promise<JobRecord | undefined>;
    updateJob(id: string, patch: Partial<JobRecord>): Promise<void>;
    markJobComplete(id: string, outputs: unknown, run_id: string | null): Promise<JobRecord | undefined>;
    markJobFailed(id: string, error: unknown, run_id: string | null): Promise<JobRecord | undefined>;
    cancelJob(id: string): Promise<JobRecord | undefined>;
    getWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
    getWorkspaceBySlug(slug: string): Promise<WorkspaceRecord | undefined>;
    createWorkspace(input: {
        id: string;
        slug: string;
        name: string;
        plan: string;
    }): Promise<WorkspaceRecord>;
    updateWorkspace(id: string, patch: Partial<Pick<WorkspaceRecord, 'name' | 'slug' | 'plan' | 'wrapped_dek'>>): Promise<WorkspaceRecord | undefined>;
    deleteWorkspace(id: string): Promise<boolean>;
    listWorkspacesForUser(user_id: string, ctx?: SessionContext): Promise<Array<WorkspaceRecord & {
        role: WorkspaceRole;
    }>>;
    addUserToWorkspace(workspace_id: string, user_id: string, role: WorkspaceMemberRole): Promise<WorkspaceMemberRecord>;
    updateWorkspaceMemberRole(workspace_id: string, user_id: string, role: WorkspaceMemberRole): Promise<WorkspaceMemberRecord | undefined>;
    removeUserFromWorkspace(workspace_id: string, user_id: string): Promise<boolean>;
    getWorkspaceMemberRole(workspace_id: string, user_id: string): Promise<WorkspaceMemberRole | null>;
    countWorkspaceAdmins(workspace_id: string): Promise<number>;
    listWorkspaceMembers(workspace_id: string, ctx?: SessionContext): Promise<WorkspaceMemberWithUserRecord[]>;
    getActiveWorkspaceId(user_id: string): Promise<string | null>;
    setActiveWorkspace(user_id: string, workspace_id: string): Promise<void>;
    clearActiveWorkspaceForWorkspace(workspace_id: string): Promise<void>;
    createWorkspaceInvite(input: Omit<WorkspaceInviteRecord, 'created_at' | 'accepted_at'>): Promise<WorkspaceInviteRecord>;
    getPendingWorkspaceInviteByToken(token: string): Promise<WorkspaceInviteRecord | undefined>;
    listWorkspaceInvites(workspace_id: string, ctx?: SessionContext): Promise<WorkspaceInviteRecord[]>;
    deletePendingWorkspaceInvites(workspace_id: string, email: string): Promise<number>;
    markWorkspaceInviteStatus(id: string, status: WorkspaceInviteRecord['status']): Promise<void>;
    acceptWorkspaceInvite(id: string): Promise<void>;
    revokeWorkspaceInvite(workspace_id: string, invite_id: string): Promise<boolean>;
    getUser(id: string): Promise<UserRecord | undefined>;
    getUserByEmail(email: string): Promise<UserRecord | undefined>;
    findUserByUsername(username: string): Promise<Pick<UserRecord, 'id' | 'email' | 'name'> | undefined>;
    searchUsers(query: string, limit?: number): Promise<Array<Pick<UserRecord, 'id' | 'email' | 'name'>>>;
    createUser(input: UserWriteInput): Promise<UserRecord>;
    upsertUser(input: UserWriteInput, updateColumns: UserWriteColumn[]): Promise<UserRecord>;
    getAppMemory(row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>): Promise<AppMemoryRecord | undefined>;
    upsertAppMemory(input: Omit<AppMemoryRecord, 'updated_at'>): Promise<AppMemoryRecord>;
    deleteAppMemory(row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>): Promise<boolean>;
    listAppMemory(workspace_id: string, app_slug: string, user_id: string, keys?: string[], ctx?: SessionContext): Promise<AppMemoryRecord[]>;
    listConnections(input: {
        workspace_id: string;
        owner_kind: ConnectionOwnerKind;
        owner_id: string;
        status?: ConnectionStatus;
    }, ctx?: SessionContext): Promise<ConnectionRecord[]>;
    getConnection(id: string): Promise<ConnectionRecord | undefined>;
    getConnectionByOwnerProvider(input: {
        workspace_id: string;
        owner_kind: ConnectionOwnerKind;
        owner_id: string;
        provider: string;
    }): Promise<ConnectionRecord | undefined>;
    getConnectionByOwnerComposioId(input: {
        workspace_id: string;
        owner_kind: ConnectionOwnerKind;
        owner_id: string;
        composio_connection_id: string;
    }): Promise<ConnectionRecord | undefined>;
    upsertConnection(input: Omit<ConnectionRecord, 'created_at' | 'updated_at'>): Promise<ConnectionRecord>;
    updateConnection(id: string, patch: Partial<Pick<ConnectionRecord, 'status' | 'metadata_json' | 'composio_connection_id' | 'composio_account_id'>>): Promise<ConnectionRecord | undefined>;
    deleteConnection(id: string): Promise<boolean>;
    getLinkShareByAppSlug(slug: string): Promise<LinkShareRecord | undefined>;
    updateAppSharing(app_id: string, patch: Partial<Pick<AppRecord, 'visibility' | 'link_share_token' | 'link_share_requires_auth' | 'publish_status' | 'review_submitted_at' | 'review_decided_at' | 'review_decided_by' | 'review_comment'>>): Promise<AppRecord | undefined>;
    createVisibilityAudit(input: Omit<VisibilityAuditRecord, 'created_at'>): Promise<VisibilityAuditRecord>;
    listVisibilityAudit(app_id?: string | null, ctx?: SessionContext): Promise<VisibilityAuditRecord[]>;
    listAppInvites(app_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]>;
    upsertAppInvite(input: Omit<AppInviteRecord, 'id' | 'created_at' | 'accepted_at' | 'revoked_at'> & {
        id: string;
    }): Promise<AppInviteRecord>;
    revokeAppInvite(invite_id: string, app_id: string): Promise<AppInviteRecord | undefined>;
    acceptAppInvite(invite_id: string, user_id: string): Promise<{
        invite: AppInviteRecord | undefined;
        changed: boolean;
    }>;
    declineAppInvite(invite_id: string, user_id: string): Promise<AppInviteRecord | undefined>;
    linkPendingEmailAppInvites(user_id: string, email: string): Promise<number>;
    listPendingAppInvitesForUser(user_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]>;
    userHasAcceptedAppInvite(app_id: string, user_id: string): Promise<boolean>;
    createTrigger(input: TriggerRecord): Promise<TriggerRecord>;
    getTrigger(id: string): Promise<TriggerRecord | undefined>;
    getTriggerByWebhookPath(path: string): Promise<TriggerRecord | undefined>;
    listTriggersForUser(user_id: string, ctx?: SessionContext): Promise<TriggerRecord[]>;
    listTriggersForApp(app_id: string, ctx?: SessionContext): Promise<TriggerRecord[]>;
    listDueTriggers(now_ms: number, ctx?: SessionContext): Promise<TriggerRecord[]>;
    updateTrigger(id: string, patch: Partial<TriggerRecord>): Promise<TriggerRecord | undefined>;
    deleteTrigger(id: string): Promise<boolean>;
    markTriggerFired(id: string, now_ms: number): Promise<void>;
    advanceTriggerSchedule(id: string, next_run_at: number, now_ms: number, expected_next_run_at?: number | null, fire?: boolean): Promise<boolean>;
    recordTriggerWebhookDelivery(trigger_id: string, request_id: string, now_ms: number, ttl_ms: number): Promise<boolean>;
    listAdminSecrets(app_id?: string | null, ctx?: SessionContext): Promise<SecretRecord[]>;
    upsertAdminSecret(name: string, value: string, app_id?: string | null): Promise<void>;
    deleteAdminSecret(name: string, app_id?: string | null): Promise<boolean>;
    getEncryptedSecret(ctx: {
        workspace_id: string;
    }, key: string): Promise<EncryptedSecretRecord | undefined>;
    setEncryptedSecret(ctx: {
        workspace_id: string;
    }, key: string, payload: {
        ciphertext: string;
        nonce: string;
        auth_tag: string;
        encrypted_dek: string;
    }): Promise<void>;
    listEncryptedSecrets(ctx: {
        workspace_id: string;
    }): Promise<Array<{
        key: string;
        updated_at: string;
    }>>;
    deleteEncryptedSecret(ctx: {
        workspace_id: string;
    }, key: string): Promise<boolean>;
    getUserSecretRow?(workspace_id: string, user_id: string, key: string): SecretCiphertextRow | undefined;
    listUserSecretRows?(workspace_id: string, user_id: string, keys: string[], ctx?: SessionContext): SecretCiphertextRow[];
    listUserSecretMetadata?(workspace_id: string, user_id: string, ctx?: SessionContext): Array<{
        key: string;
        updated_at: string;
    }>;
    upsertUserSecretRow?(row: SecretCiphertextWriteInput): void;
    deleteUserSecretRow?(workspace_id: string, user_id: string, key: string): boolean;
    setSecretPolicy?(app_id: string, key: string, policy: 'user_vault' | 'creator_override'): void;
    upsertCreatorSecretRow?(row: CreatorSecretCiphertextWriteInput): void;
    listCreatorOverrideSecretRowsForRun?(app_id: string, keys: string[], ctx?: SessionContext): CreatorSecretCiphertextRow[];
}
export interface SecretCiphertextRow {
    workspace_id: string;
    user_id: string;
    key: string;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    encrypted_dek: string | null;
    updated_at: string;
}
export type SecretCiphertextWriteInput = Omit<SecretCiphertextRow, 'updated_at'>;
export interface CreatorSecretCiphertextRow {
    app_id: string;
    workspace_id: string;
    key: string;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    encrypted_dek: string | null;
    updated_at: string;
}
export type CreatorSecretCiphertextWriteInput = Omit<CreatorSecretCiphertextRow, 'updated_at'>;
export interface UserWriteInput {
    id: string;
    workspace_id?: string | null;
    email?: string | null;
    name?: string | null;
    auth_provider?: string;
    auth_subject?: string | null;
    image?: string | null;
    is_admin?: 0 | 1;
    composio_user_id?: string | null;
}
export type UserWriteColumn = Exclude<keyof UserWriteInput, 'id'>;
export interface AuthAdapter extends AdapterLifecycle {
    getSession(request: Request): Promise<SessionContext | null>;
    mountHttp?(app: unknown, basePath: string): void | Promise<void>;
    signIn(input: {
        email: string;
        password?: string;
    }): Promise<AuthSessionResult | AuthMagicLinkSentResult>;
    signUp(input: {
        email: string;
        password?: string;
        name?: string;
    }): Promise<AuthSessionResult | AuthMagicLinkSentResult>;
    verifyMagicLink?(token: string): Promise<AuthSessionResult | null>;
    signOut(session: SessionContext): Promise<void>;
    onUserDelete(cb: (user_id: string) => void | Promise<void>): void;
}
export interface AuthSessionResult {
    session: SessionContext;
    set_cookie?: string;
    token?: string;
    user_id?: string;
    session_token?: string;
}
export interface AuthMagicLinkSentResult {
    status: 'magic-link-sent';
    email: string;
}
export interface SecretsAdapter extends AdapterLifecycle {
    get(ctx: SessionContext, key: string): Promise<string | null>;
    set(ctx: SessionContext, key: string, plaintext: string): Promise<void>;
    delete(ctx: SessionContext, key: string): Promise<boolean>;
    list(ctx: SessionContext): Promise<Array<{
        key: string;
        updated_at: string;
    }>>;
    setAdminSecret(app_id: string | null, key: string, plaintext: string): Promise<void>;
    getAdminSecret(app_id: string | null, key: string): Promise<string | null>;
    listAdminSecrets(app_id: string | null): Promise<AdminSecretMetadata[]>;
    deleteAdminSecret(app_id: string | null, key: string): Promise<boolean>;
    setCreatorPolicy(app_id: string, key: string, policy: SecretPolicy): Promise<void>;
    getCreatorPolicy(app_id: string, key: string): Promise<SecretPolicy | null>;
    listCreatorPolicies(app_id: string): Promise<CreatorPolicyMetadata[]>;
    deleteCreatorPolicy(app_id: string, key: string): Promise<boolean>;
    loadUserVaultForRun(ctx: SessionContext, keys: string[]): Promise<Record<string, string>>;
    loadCreatorOverrideForRun(app_id: string, workspace_id: string, keys: string[]): Promise<Record<string, string>>;
    setCreatorOverrideSecret(ctx: {
        workspace_id: string;
    }, appId: string, envKey: string, plaintext: string): Promise<void>;
    getCreatorOverrideSecret(ctx: {
        workspace_id: string;
    }, appId: string, envKey: string): Promise<string | null>;
    listCreatorOverrideSecretsForRun(ctx: {
        workspace_id: string;
    }, appId: string, envKeys: string[]): Promise<Record<string, string>>;
    deleteCreatorOverrideSecret(ctx: {
        workspace_id: string;
    }, appId: string, envKey: string): Promise<boolean>;
}
export interface ObservabilityAdapter extends AdapterLifecycle {
    captureError(err: unknown, context?: Record<string, unknown>): void;
    increment(metric: string, amount?: number, tags?: Record<string, string>): void;
    timing(metric: string, ms: number, tags?: Record<string, string>): void;
    gauge(metric: string, value: number, tags?: Record<string, string>): void;
}
