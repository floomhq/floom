# Verification Plan: Git-backed Workspace Issues

This document outlines the design, implementation plan, and concrete verification steps for introducing Git-backed workspace issues for workspace assets.

## 1. Storage Model & Frontmatter Schema

Issues are stored as Markdown files with YAML frontmatter under `.floom/issues/` in the workspace Git repository.

### File Structure
- Main issue file: `.floom/issues/ISSUE-XXXX.md`
- Comments file: `.floom/issues/ISSUE-XXXX.comments.ndjson` (newline-delimited JSON for simple append operations)

### Frontmatter Schema
```yaml
---
id: ISSUE-0001
status: open
title: Gmail inbox worker failed twice
asset_type: worker
asset_id: gmail-inbox-manager
source: run_failure
labels:
  - needs-attention
  - worker
created_by: user_123
created_at: "2026-06-21T19:00:00Z"
updated_at: "2026-06-21T19:00:00Z"
---

Issue body goes here.
```

### Comments Schema (NDJSON)
Each line in `.floom/issues/ISSUE-XXXX.comments.ndjson` is a JSON object:
```json
{"id": "comment_1", "created_by": "user_123", "created_at": "2026-06-21T19:05:00Z", "body": "I am looking into this failure."}
```

---

## 2. Core Service Design (`services.workspace_issues`)

The core service should be implemented in `services/workspace_issues.py` (or similar backend service directory) and provide the following interface:

```python
class WorkspaceIssueStore:
    def __init__(self, workspace_path: str, git_service):
        self.workspace_path = workspace_path
        self.git_service = git_service
        self.issues_dir = os.path.join(workspace_path, ".floom", "issues")

    def create_issue(self, title: str, body: str, asset_type: str = None, asset_id: str = None, labels: list = None, created_by: str = None) -> dict:
        """Generates a stable issue ID, writes the markdown file, and commits via git_service."""
        pass

    def list_issues(self, state: str = None, asset_type: str = None, asset_id: str = None) -> list:
        """Parses all issue files under .floom/issues/ and filters them."""
        pass

    def get_issue(self, issue_id: str) -> dict:
        """Retrieves a single issue and its comments."""
        pass

    def update_issue(self, issue_id: str, updates: dict) -> dict:
        """Updates frontmatter/body and commits the changes."""
        pass

    def add_comment(self, issue_id: str, body: str, created_by: str) -> dict:
        """Appends a comment to the NDJSON file and commits."""
        pass
```

---

## 3. API Endpoints

The following REST endpoints should be exposed by the API:

- `GET /workspace/issues?state=&asset_type=&asset_id=`
- `GET /workspace/issues/{id}`
- `POST /workspace/issues`
- `POST /workspace/issues/{id}/comments`
- `PATCH /workspace/issues/{id}`

---

## 4. Emily Tools Integration

Emily should be equipped with tools to interact with workspace issues:
- `list_workspace_issues(state, asset_type, asset_id)`
- `create_workspace_issue(title, body, asset_type, asset_id)`
- `comment_on_workspace_issue(issue_id, body)`
- `update_workspace_issue_status(issue_id, status)`

---

## 5. Verification Steps

To verify the implementation, the following test cases must be executed:

### Test Case 1: Issue Creation and Git Commit
1. Call `POST /workspace/issues` with a payload binding it to a worker asset.
2. Verify that a file `.floom/issues/ISSUE-0001.md` is created with correct frontmatter.
3. Verify that a Git commit is automatically created with a message like `docs(issues): create ISSUE-0001`.

### Test Case 2: Listing and Filtering
1. Create multiple issues bound to different assets (e.g., `worker:gmail-inbox-manager`, `context:policies/refund.md`).
2. Query `GET /workspace/issues?asset_type=worker&asset_id=gmail-inbox-manager`.
3. Verify only the matching issue is returned.

### Test Case 3: Commenting
1. Call `POST /workspace/issues/ISSUE-0001/comments` with a comment body.
2. Verify that `.floom/issues/ISSUE-0001.comments.ndjson` is created/appended to.
3. Verify that the comment is returned in `GET /workspace/issues/ISSUE-0001`.

### Test Case 4: Emily Interaction
1. Ask Emily: "What issues are open for the gmail-inbox-manager worker?"
2. Verify Emily calls the `list_workspace_issues` tool and reports the correct issue.
