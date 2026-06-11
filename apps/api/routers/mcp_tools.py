"""MCP tool registration CRUD routes.

``GET/POST /mcp-tools`` and ``PUT/DELETE /mcp-tools/{tool_id}`` (each also
mounted at the legacy ``/mcp/tools`` alias) — registering a worker as an MCP
tool, with the input schema derived from the worker manifest when not supplied.
Extracted verbatim from main.py into an APIRouter. The ``/mcp-tools/serve``
JSON-RPC endpoint stays in main with the MCP serving cluster.

``services.git_service`` (the tools-yml sync) is never purged by fixtures and
resolves git_ops lazily itself, so it is a real module-level import — as are
the ``models`` request/response types and auth/db dependencies used in route
signatures; mcp test fixtures purge ``routers.*`` alongside ``main``.
"""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import ActionResponse, McpToolCreate, McpToolItem, McpToolUpdate
from services.git_service import _sync_workspace_tools_yml

mcp_tools_router = APIRouter()


def _mcp_input_schema_from_worker_record(worker: Dict[str, Any]) -> Dict[str, Any]:
    config = worker.get("config") or {}
    inputs = config.get("inputs") if isinstance(config, dict) else []
    if not isinstance(inputs, list):
        return {"type": "object", "properties": {}}
    properties: Dict[str, Any] = {}
    required: List[str] = []
    type_map = {
        "string": "string",
        "text": "string",
        "markdown": "string",
        "number": "number",
        "integer": "integer",
        "boolean": "boolean",
        "bool": "boolean",
        "object": "object",
        "json": "object",
        "array": "array",
    }
    for item in inputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        raw_type = str(item.get("type") or item.get("kind") or "string").lower()
        prop: Dict[str, Any] = {"type": type_map.get(raw_type, "string")}
        if item.get("description"):
            prop["description"] = str(item["description"])
        if isinstance(item.get("options"), list):
            prop["enum"] = [str(option) for option in item["options"]]
        properties[name] = prop
        if item.get("required"):
            required.append(name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


@mcp_tools_router.get("/mcp-tools", response_model=List[McpToolItem])
@mcp_tools_router.get("/mcp/tools", response_model=List[McpToolItem])
def list_mcp_tools(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[McpToolItem]:
    return repos.mcp_tools.list(user_id=auth.user_id)


@mcp_tools_router.post("/mcp-tools", response_model=McpToolItem)
@mcp_tools_router.post("/mcp/tools", response_model=McpToolItem)
def create_mcp_tool(
    payload: McpToolCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> McpToolItem:
    worker = repos.workers.get(user_id=auth.user_id, worker_id=payload.worker_id)
    if not worker:
        all_workers = repos.workers.list(user_id=auth.user_id)
        worker = next((w for w in all_workers if w["name"] == payload.worker_id), None)
    if not worker:
        raise HTTPException(status_code=404, detail=f"Worker {payload.worker_id!r} not found")

    if repos.mcp_tools.get_by_name(user_id=auth.user_id, name=payload.name):
        raise HTTPException(status_code=409, detail=f"A tool named {payload.name!r} already exists")

    input_schema = payload.input_schema
    if not input_schema:
        input_schema = _mcp_input_schema_from_worker_record(worker)

    result = repos.mcp_tools.create(
        user_id=auth.user_id,
        name=payload.name,
        description=payload.description,
        input_schema=input_schema,
        worker_id=worker["id"],
    )
    _sync_workspace_tools_yml(auth.user_id, repos)
    return result


@mcp_tools_router.put("/mcp-tools/{tool_id}", response_model=McpToolItem)
@mcp_tools_router.put("/mcp/tools/{tool_id}", response_model=McpToolItem)
def update_mcp_tool(
    tool_id: str,
    payload: McpToolUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> McpToolItem:
    if not repos.mcp_tools.get(user_id=auth.user_id, tool_id=tool_id):
        raise HTTPException(status_code=404, detail="MCP tool not found")
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    updated = repos.mcp_tools.update(user_id=auth.user_id, tool_id=tool_id, **updates)
    _sync_workspace_tools_yml(auth.user_id, repos)
    return updated


@mcp_tools_router.delete("/mcp-tools/{tool_id}", response_model=ActionResponse)
@mcp_tools_router.delete("/mcp/tools/{tool_id}", response_model=ActionResponse)
def delete_mcp_tool(
    tool_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    if not repos.mcp_tools.get(user_id=auth.user_id, tool_id=tool_id):
        raise HTTPException(status_code=404, detail="MCP tool not found")
    repos.mcp_tools.delete(user_id=auth.user_id, tool_id=tool_id)
    _sync_workspace_tools_yml(auth.user_id, repos)
    return ActionResponse(status="deleted")
