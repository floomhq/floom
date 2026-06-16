#!/usr/bin/env python3
"""Authenticated cloud/engine critical smoke runner.

Environment:
  WORKEROS_SMOKE_API_BASE       Backend API base URL. Required.
  WORKEROS_SMOKE_WEB_BASE       Optional frontend base URL for proxy smoke.
  WORKEROS_SMOKE_TOKEN          Required auth token.
  WORKEROS_SMOKE_TOKEN_KIND     "pat" (x-floom-token) or "bearer". Default: pat.
  WORKEROS_SMOKE_WORKSPACE      Optional workspace id/header.
  WORKEROS_SMOKE_MUTATE         Set "1" to create/edit/run/share/export test data.
  WORKEROS_SMOKE_ALLOW_PROD     Required with MUTATE=1 against floom.dev hosts.
  WORKEROS_SMOKE_INCLUDE_CHAT   Include /chat when mutating. Default: 1.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any


TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled", "error", "timed_out", "timeout"}


@dataclass
class Response:
    status: int
    body: str
    headers: dict[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        if not self.body:
            return None
        return json.loads(self.body)


@dataclass
class Config:
    api_base: str
    token: str
    token_kind: str = "pat"
    workspace_id: str | None = None
    web_base: str | None = None
    mutate: bool = False
    allow_prod: bool = False
    include_chat: bool = True
    timeout_seconds: float = 30.0
    poll_timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> "Config":
        api_base = _required_env("WORKEROS_SMOKE_API_BASE").rstrip("/")
        token = _required_env("WORKEROS_SMOKE_TOKEN")
        token_kind = (os.environ.get("WORKEROS_SMOKE_TOKEN_KIND") or "pat").strip().lower()
        if token_kind not in {"pat", "bearer"}:
            raise SmokeError("WORKEROS_SMOKE_TOKEN_KIND must be 'pat' or 'bearer'")
        web_base = (os.environ.get("WORKEROS_SMOKE_WEB_BASE") or "").strip().rstrip("/") or None
        return cls(
            api_base=api_base,
            token=token,
            token_kind=token_kind,
            workspace_id=(os.environ.get("WORKEROS_SMOKE_WORKSPACE") or "").strip() or None,
            web_base=web_base,
            mutate=_truthy(os.environ.get("WORKEROS_SMOKE_MUTATE")),
            allow_prod=_truthy(os.environ.get("WORKEROS_SMOKE_ALLOW_PROD")),
            include_chat=_truthy(os.environ.get("WORKEROS_SMOKE_INCLUDE_CHAT"), default=True),
            timeout_seconds=float(os.environ.get("WORKEROS_SMOKE_TIMEOUT_SECONDS") or "30"),
            poll_timeout_seconds=float(os.environ.get("WORKEROS_SMOKE_POLL_TIMEOUT_SECONDS") or "120"),
        )


class SmokeError(RuntimeError):
    pass


class HttpClient:
    def __init__(self, config: Config):
        self.config = config

    def request(
        self,
        method: str,
        path_or_url: str,
        *,
        json_body: Any | None = None,
        auth: bool = True,
        expected: set[int] | None = None,
    ) -> Response:
        url = path_or_url if path_or_url.startswith("http") else f"{self.config.api_base}{path_or_url}"
        data = None
        headers = {"accept": "application/json"}
        if auth:
            headers.update(_auth_headers(self.config))
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.config.timeout_seconds) as resp:
                response = Response(
                    status=int(resp.status),
                    body=resp.read().decode("utf-8", errors="replace"),
                    headers={k.lower(): v for k, v in resp.headers.items()},
                )
        except urllib.error.HTTPError as exc:
            response = Response(
                status=int(exc.code),
                body=exc.read().decode("utf-8", errors="replace"),
                headers={k.lower(): v for k, v in exc.headers.items()},
            )
        except Exception as exc:
            raise SmokeError(f"{method.upper()} {url} failed: {exc}") from exc
        if expected is not None and response.status not in expected:
            raise SmokeError(f"{method.upper()} {url} returned {response.status}: {response.body[:500]}")
        return response


def _required_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise SmokeError(f"{name} is required")
    return value


def _truthy(value: str | None, *, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _auth_headers(config: Config) -> dict[str, str]:
    headers: dict[str, str] = {}
    if config.token_kind == "bearer":
        headers["authorization"] = f"Bearer {config.token}"
    else:
        headers["x-floom-token"] = config.token
    if config.workspace_id:
        headers["x-workeros-workspace"] = config.workspace_id
    return headers


def _is_prod_url(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return host.endswith(".floom.dev")


def _assert_mutation_allowed(config: Config) -> None:
    if config.mutate and _is_prod_url(config.api_base) and not config.allow_prod:
        raise SmokeError(
            "Refusing mutating smoke against floom.dev without WORKEROS_SMOKE_ALLOW_PROD=1"
        )


def _expect_json_object(response: Response, label: str) -> dict[str, Any]:
    payload = response.json()
    if not isinstance(payload, dict):
        raise SmokeError(f"{label} did not return a JSON object")
    return payload


def _expect_json_list(response: Response, label: str) -> list[Any]:
    payload = response.json()
    if not isinstance(payload, list):
        raise SmokeError(f"{label} did not return a JSON list")
    return payload


def _expect_json_collection(response: Response, label: str) -> list[Any]:
    payload = response.json()
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "results", "workspaces", "workers", "runs"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise SmokeError(f"{label} did not return a JSON collection")


def run_smoke(config: Config, client: HttpClient | None = None) -> list[str]:
    _assert_mutation_allowed(config)
    client = client or HttpClient(config)
    passed: list[str] = []

    def step(name: str, fn) -> Any:
        result = fn()
        print(f"ok  {name}")
        passed.append(name)
        return result

    step("api health", lambda: client.request("GET", "/healthz", auth=False, expected={200}))
    step("auth workspaces", lambda: _expect_json_collection(client.request("GET", "/api/workspaces", expected={200}), "workspaces"))
    step("workers list", lambda: _expect_json_collection(client.request("GET", "/api/workers", expected={200}), "workers"))
    step("runs list", lambda: _expect_json_collection(client.request("GET", "/api/runs", expected={200}), "runs"))
    if config.workspace_id:
        step("mcp tools/list", lambda: _smoke_mcp_tools(client, config.workspace_id))
    else:
        print("skip mcp tools/list (WORKEROS_SMOKE_WORKSPACE not set)")
    if config.web_base:
        step(
            "frontend proxy health",
            lambda: client.request("GET", f"{config.web_base}/app/api/proxy/healthz", auth=False, expected={200, 401}),
        )

    if not config.mutate:
        print("skip mutating cloud/engine checks (set WORKEROS_SMOKE_MUTATE=1)")
        return passed

    smoke_id = f"cloud-smoke-{int(time.time())}"
    worker_id: str | None = None
    run_id: str | None = None
    share_token: str | None = None
    try:
        worker_id = step("worker create", lambda: _smoke_create_worker(client, smoke_id))
        step("worker detail", lambda: client.request("GET", f"/api/workers/{_q(worker_id)}", expected={200}))
        step("worker file edit", lambda: _smoke_edit_worker(client, worker_id, smoke_id))
        step("worker versions", lambda: _smoke_worker_versions(client, worker_id))
        run_id = step("worker run", lambda: _smoke_create_run(client, worker_id, smoke_id))
        step("run reaches terminal", lambda: _poll_run_terminal(client, run_id, config.poll_timeout_seconds))
        step("run export", lambda: client.request("POST", "/api/runs/export", json_body={"run_ids": [run_id]}, expected={200}))
        share_token = step("run share", lambda: _smoke_run_share(client, run_id))
        step(
            "public run share",
            lambda: client.request(
                "GET",
                f"/api/runs/public/{_q(run_id)}?token={_q(share_token)}",
                auth=False,
                expected={200},
            ),
        )
        if config.include_chat:
            step("chat", lambda: _smoke_chat(client, smoke_id))
    finally:
        if share_token and run_id:
            _cleanup("delete run share", lambda: client.request("DELETE", f"/api/runs/{_q(run_id)}/share-link", expected={200, 204, 404}))
        if worker_id:
            _cleanup("delete worker", lambda: client.request("DELETE", f"/api/workers/{_q(worker_id)}", expected={200, 204, 404}))
    return passed


def _smoke_mcp_tools(client: HttpClient, workspace_id: str) -> None:
    body = {"jsonrpc": "2.0", "id": "smoke-tools", "method": "tools/list", "params": {}}
    payload = _expect_json_object(
        client.request("POST", f"/mcp/{_q(workspace_id)}", json_body=body, expected={200}),
        "mcp tools/list",
    )
    if payload.get("error"):
        raise SmokeError(f"mcp tools/list returned error: {payload['error']}")


def _smoke_worker_yml(smoke_id: str) -> str:
    return "\n".join(
        [
            'schema_version: "0.3"',
            f'name: "{smoke_id}"',
            f'title: "Cloud smoke {smoke_id}"',
            'description: "Safe cloud smoke worker"',
            'version: "0.1.0"',
            "exec:",
            '  entry: "run.py"',
            '  command: "python run.py"',
            '  runtime: "python311"',
            '  runner: "e2b"',
            "  inputs: []",
            "  outputs:",
            '    - name: "result"',
            '      kind: "scalar"',
            '      type: "object"',
            "trigger:",
            '  type: "manual"',
            "limits:",
            "  max_tool_iterations: 1",
            "  max_output_tokens: 512",
            "",
        ]
    )


def _smoke_create_worker(client: HttpClient, smoke_id: str) -> str:
    worker_yml = _smoke_worker_yml(smoke_id)
    run_py = _smoke_run_py(smoke_id)
    payload = _expect_json_object(
        client.request(
            "POST",
            "/api/workers",
            json_body={"worker_yml": worker_yml, "run_py": run_py, "skill_md": "# Cloud smoke\n"},
            expected={200, 201},
        ),
        "worker create",
    )
    worker_id = str(payload.get("id") or smoke_id)
    if not worker_id:
        raise SmokeError("worker create response did not include id")
    return worker_id


def _smoke_run_py(smoke_id: str) -> str:
    return "\n".join(
        [
            "import json",
            "from pathlib import Path",
            "",
            "inputs_path = Path('inputs.json')",
            "inputs = json.loads(inputs_path.read_text()) if inputs_path.exists() else {}",
            "Path('result.json').write_text(json.dumps({",
            "    'status': 'success',",
            f"    'outputs': {{'result': {{'ok': True, 'smoke_id': {smoke_id!r}, 'inputs': inputs}}}},",
            "    'artifacts': [],",
            "}))",
            "",
        ]
    )


def _smoke_edit_worker(client: HttpClient, worker_id: str, smoke_id: str) -> None:
    client.request(
        "PUT",
        f"/api/workers/{_q(worker_id)}/files",
        json_body={
            "files": [
                {"path": "worker.yml", "content": _smoke_worker_yml(smoke_id)},
                {"path": "run.py", "content": _smoke_run_py(f"{smoke_id}-edited")},
                {"path": "SKILL.md", "content": "# Cloud smoke\n"},
            ]
        },
        expected={200},
    )


def _smoke_worker_versions(client: HttpClient, worker_id: str) -> None:
    versions = _expect_json_list(
        client.request("GET", f"/api/workers/{_q(worker_id)}/versions?limit=5", expected={200}),
        "worker versions",
    )
    if not versions:
        raise SmokeError("worker versions returned an empty list")


def _smoke_create_run(client: HttpClient, worker_id: str, smoke_id: str) -> str:
    payload = _expect_json_object(
        client.request(
            "POST",
            f"/api/workers/{_q(worker_id)}/runs",
            json_body={"inputs": {"smoke": smoke_id}, "trigger_source": "manual"},
            expected={200, 201},
        ),
        "worker run",
    )
    run_id = str(payload.get("run_id") or payload.get("id") or "")
    if not run_id:
        raise SmokeError("worker run response did not include run_id/id")
    return run_id


def _poll_run_terminal(client: HttpClient, run_id: str, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    last_status = ""
    while time.time() < deadline:
        payload = _expect_json_object(client.request("GET", f"/api/runs/{_q(run_id)}", expected={200}), "run detail")
        last_status = str(payload.get("status") or "").lower()
        if last_status in TERMINAL_RUN_STATUSES:
            if last_status not in {"completed"}:
                raise SmokeError(f"run {run_id} ended with status={last_status}: {payload.get('error')}")
            return
        time.sleep(3)
    raise SmokeError(f"run {run_id} did not reach terminal status before timeout; last={last_status!r}")


def _smoke_run_share(client: HttpClient, run_id: str) -> str:
    payload = _expect_json_object(
        client.request("POST", f"/api/runs/{_q(run_id)}/share-link", expected={200, 201}),
        "run share",
    )
    token = str(payload.get("token") or "")
    if not token:
        raise SmokeError("run share response did not include token")
    return token


def _smoke_chat(client: HttpClient, smoke_id: str) -> None:
    response = client.request(
        "POST",
        "/api/chat",
        json_body={
            "message": f"Smoke check {smoke_id}. Reply briefly.",
            "source": "web",
        },
        expected={200},
    )
    if not response.body.strip():
        raise SmokeError("/chat returned an empty body")


def _cleanup(name: str, fn) -> None:
    try:
        fn()
        print(f"ok  cleanup {name}")
    except Exception as exc:
        print(f"WARN cleanup {name} failed: {exc}", file=sys.stderr)


def _q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def main() -> int:
    try:
        passed = run_smoke(Config.from_env())
    except SmokeError as exc:
        print(f"SMOKE FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"SMOKE PASSED: {len(passed)} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
