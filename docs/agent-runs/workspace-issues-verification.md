# Verification Plan: Workspace Issues (GitHub-backed Issue Tracking)

This document outlines the architecture, API design, UI/UX flow, Emily tools integration, and verification steps for the **Workspace Issues** feature. Since this is a broad, cross-cutting feature spanning backend models, GitHub integration, REST APIs, frontend UI, and Emily agent tools, this document serves as the canonical implementation blueprint and verification guide.

## 1. Product Model & Schema

### Backend Issue Projection Model
To support fast UI rendering and filtering, Floom will maintain a lightweight projection/cache of GitHub issues associated with the workspace.

```python
class WorkspaceIssue(BaseModel):
    id: str  # Floom internal issue ID (e.g., "iss_abc123")
    workspace_id: str
    github_issue_number: int
    github_url: str
    title: str
    body: str
    state: Literal["open", "closed"]
    labels: List[str]
    asset_type: Optional[Literal["worker", "context", "connection", "run", "approval", "mcp"]] = None
    asset_id: Optional[str] = None
    created_by: str  # User ID or "emily"
    created_at: datetime
    updated_at: datetime
```

### Metadata Marker Format
Floom metadata is stored in the GitHub issue body as a hidden HTML comment block:

```markdown
<!-- floom:issue
workspace_id: ws_123
asset_type: worker
asset_id: gmail-inbox-manager
source: run_failure
-->
```

## 2. GitHub Integration Adapter

The integration uses the workspace's tracked GitHub repository.

- **Create Issue**: Emits the metadata block at the end of the issue body and applies labels: `floom`, `workspace`, and the specific asset type (e.g., `worker`, `run`).
- **Sync/Read**: Parses the metadata block from the issue body to reconstruct the `asset_type` and `asset_id` bindings.
- **Comments**: Appends comments directly to the GitHub issue.
- **State Management**: Closes or reopens issues via GitHub API.

## 3. API Contracts

### `GET /workspace/issues`
Query parameters:
- `state`: `open` | `closed` | `all`
- `asset_type`: `worker` | `context` | `run` | etc.
- `asset_id`: string

Response:
```json
[
  {
    "id": "iss_123",
    "workspace_id": "ws_abc",
    "github_issue_number": 42,
    "github_url": "https://github.com/org/repo/issues/42",
    "title": "Gmail connection expired",
    "body": "The connection needs reconnecting.",
    "state": "open",
    "labels": ["floom", "connection", "needs-attention"],
    "asset_type": "connection",
    "asset_id": "gmail",
    "created_by": "u_1",
    "created_at": "2026-06-19T12:00:00Z",
    "updated_at": "2026-06-19T12:00:00Z"
  }
]
```

### `POST /workspace/issues`
Request body:
```json
{
  "title": "Worker failed twice this week",
  "body": "Detailed description of the failure.",
  "asset_type": "worker",
  "asset_id": "gmail-inbox-manager"
}
```

### `POST /workspace/issues/{id}/comments`
Request body:
```json
{
  "body": "I am looking into this failure now."
}
```

### `PATCH /workspace/issues/{id}`
Request body:
```json
{
  "title": "Updated title",
  "state": "closed"
}
```

## 4. UI/UX Specifications

### Workspace-level Issues View
- Located at `/workspace/issues`.
- Displays a list of all issues with filters for `state` and `asset_type`.
- Shows GitHub issue badges, labels, and links.

### Asset-scoped Panels
- **Worker Detail Page**: An "Issues" tab showing open/closed issues bound to `worker:<worker_id>`. Includes a "Create Issue" button.
- **Context Detail Page**: An "Issues" tab showing issues bound to `context:<context_id>`.
- **Run Detail Page**: A "Create Issue" action on failed runs, pre-populating the issue with run details and binding it to `run:<run_id>`.

## 5. Emily Agent Tools

Emily should be equipped with the following tools to interact with workspace issues:

1. `list_workspace_issues(state: str, asset_type: str, asset_id: str)`
2. `create_workspace_issue(title: str, body: str, asset_type: str, asset_id: str)`
3. `comment_on_workspace_issue(issue_id: str, body: str)`
4. `close_workspace_issue(issue_id: str)`

## 6. Verification Steps

### Test Case 1: Issue Creation & GitHub Sync
1. Call `POST /workspace/issues` with asset binding `worker:gmail-inbox-manager`.
2. Verify that a GitHub issue is created in the tracked repository.
3. Verify that the GitHub issue body contains the correct `<!-- floom:issue ... -->` metadata block.
4. Verify that the labels `floom`, `worker` are applied.

### Test Case 2: Metadata Parsing
1. Fetch issues via `GET /workspace/issues?asset_type=worker&asset_id=gmail-inbox-manager`.
2. Verify that the returned issue correctly parses the metadata from GitHub and populates `asset_type` and `asset_id`.

### Test Case 3: Commenting & Closing
1. Call `POST /workspace/issues/{id}/comments` and verify the comment appears on GitHub.
2. Call `PATCH /workspace/issues/{id}` with `{"state": "closed"}` and verify the issue is closed on GitHub.

### Test Case 4: Emily Tool Execution
1. Ask Emily: "What issues are open for the gmail-inbox-manager worker?"
2. Verify Emily calls `list_workspace_issues` with the correct parameters and presents the results.
3. Ask Emily: "Create an issue for this worker because it failed to parse the inbox."
4. Verify Emily calls `create_workspace_issue` and confirms creation.
