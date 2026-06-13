import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def send(handler, body, status=200):
    data = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


CONNECTIONS = [
    {
        "id": "local-gmail",
        "app_name": "gmail",
        "composio_connection_id": "ca_gmail",
        "status": "active",
        "created_at": "2026-05-20T10:00:00Z",
        "updated_at": "2026-05-20T10:05:00Z",
    },
    {
        "id": "local-slack",
        "app_name": "slack",
        "composio_connection_id": "ca_slack",
        "status": "active",
        "created_at": "2026-05-19T10:00:00Z",
        "updated_at": "2026-05-19T10:05:00Z",
    },
]

WORKERS = [
    {
        "id": "gmail_intake_brief",
        "name": "Gmail intake brief",
        "status": "healthy",
        "trigger_type": "manual",
        "runner": "local",
    }
]

WORKER_DETAIL = {
    **WORKERS[0],
    "config": {
        "id": "gmail_intake_brief",
        "name": "Gmail intake brief",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
        "inputs": [],
        "secrets": [],
        "connections": ["gmail"],
        "outputs": [],
        "approvals": {"required": False},
    },
    "recent_runs": [
        {
            "id": "run-gmail",
            "worker_id": "gmail_intake_brief",
            "status": "completed",
            "trigger_source": "manual",
            "approval_status": "not_required",
            "created_at": "2026-05-24T12:22:00Z",
            "completed_at": "2026-05-24T12:23:00Z",
        }
    ],
}

ACCOUNTS = {
    "ca_gmail": {
        "id": "ca_gmail",
        "auth_config": {"id": "ac_gmail"},
        "email": "owner@example.com",
        "user_id": "federico",
    },
    "ca_slack": {
        "id": "ca_slack",
        "auth_config": {"id": "ac_slack"},
        "email": "ops@floom.dev",
        "user_id": "federico",
    },
}

SCOPES = {
    "ac_gmail": [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/drive.file",
    ],
    "ac_slack": ["channels:read", "chat:write", "users:read"],
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/connections":
            send(self, CONNECTIONS)
        elif path == "/workers":
            send(self, WORKERS)
        elif path == "/workers/gmail_intake_brief":
            send(self, WORKER_DETAIL)
        elif path.startswith("/api/v3/connected_accounts/"):
            send(self, ACCOUNTS.get(path.rsplit("/", 1)[-1], {}))
        elif path.startswith("/api/v3/auth_configs/"):
            auth_id = path.rsplit("/", 1)[-1]
            send(self, {"id": auth_id, "scopes": SCOPES.get(auth_id, [])})
        else:
            send(self, {"detail": "not found", "path": path}, 404)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    port = int(os.environ.get("MOCK_CONNECTIONS_API_PORT", "8037"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
