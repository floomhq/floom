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
- **Run Detail Page**: Displays associated issues and allows creating a new issue directly from a failed run.

## 5. Emily Tools Integration

Emily can interact with workspace issues using the following tools:
- `list_workspace_issues`: Retrieves issues filtered by state or asset.
- `create_workspace_issue`: Creates a new issue with appropriate metadata.
- `add_issue_comment`: Adds a comment to an existing issue.
- `update_workspace_issue`: Updates the state or title of an issue.

## 6. Verification Steps

### Automated Tests
- Verify that creating an issue correctly appends the metadata block.
- Verify that syncing parses the metadata block and reconstructs the bindings.
- Verify that the API endpoints return the correct status codes and payloads.

### Manual Verification
1. Navigate to `/workspace/issues` and verify the list of issues is displayed.
2. Filter issues by state and asset type.
3. Create a new issue from a worker detail page and verify it is linked correctly.
4. Close an issue and verify the state updates to `closed` on both Floom and GitHub.