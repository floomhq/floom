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
from services.worker_access import _mcp_input_schema_from_worker_record

mcp_tools_router = APIRouter()


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
