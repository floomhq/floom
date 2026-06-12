"""Provider-agnostic web search, exposed as a normal function tool.

OpenAI's hosted ``WebSearchTool`` runs on OpenAI's platform and is rejected by
non-OpenAI providers (Bedrock/Claude, Gemini, Groq) routed through litellm. This
implements web search as a regular tool the model *calls* — our code runs the
search and returns results — so it works on every provider that supports tool
calling.

Backend is chosen by environment, mirroring the LLM provider seam:
  * ``SERPER_API_KEY`` set -> Serper (Google results, cheap, reliable).
  * otherwise            -> DuckDuckGo via ``ddgs`` (free, no key; rate-limited).

Results are capped (default 5) to keep the downstream token cost low — the search
output is fed back to the model as tool input on the next turn and is not cacheable.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

_SERPER_URL = "https://google.serper.dev/search"
DEFAULT_MAX_RESULTS = 5
_HARD_MAX_RESULTS = 10


def backend_name() -> str:
    """The active search backend, for logging/diagnostics."""
    return "serper" if os.environ.get("SERPER_API_KEY") else "duckduckgo"


def _serper_search(query: str, max_results: int) -> List[Dict[str, Any]]:
    import requests

    resp = requests.post(
        _SERPER_URL,
        headers={
            "X-API-KEY": os.environ["SERPER_API_KEY"],
            "Content-Type": "application/json",
        },
        json={"q": query, "num": max_results},
        timeout=15,
    )
    resp.raise_for_status()
    organic = resp.json().get("organic") or []
    return [
        {"title": r.get("title"), "url": r.get("link"), "snippet": r.get("snippet")}
        for r in organic[:max_results]
    ]


def _ddg_search(query: str, max_results: int) -> List[Dict[str, Any]]:
    from ddgs import DDGS

    with DDGS() as ddgs:
        return [
            {"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")}
            for r in ddgs.text(query, max_results=max_results)
        ]


def search(query: str, max_results: int = DEFAULT_MAX_RESULTS) -> List[Dict[str, Any]]:
    """Run a web search via Serper (if ``SERPER_API_KEY`` set) or free DuckDuckGo."""
    n = max(1, min(int(max_results), _HARD_MAX_RESULTS))
    if os.environ.get("SERPER_API_KEY"):
        return _serper_search(query, n)
    return _ddg_search(query, n)


def web_search_tool(max_results: int = DEFAULT_MAX_RESULTS) -> Any:
    """Build the Agents SDK ``FunctionTool`` for web search (works on every provider)."""
    from agents import FunctionTool

    async def _invoke(_ctx: Any, raw_args: str) -> str:
        # Never raise: tool errors are returned as output so the agent can recover.
        try:
            args = json.loads(raw_args or "{}")
            query = (args.get("query") or "").strip()
            if not query:
                return json.dumps({"ok": False, "error": "query is required"})
            results = search(query, max_results=args.get("max_results") or max_results)
            return json.dumps({"ok": True, "results": results})
        except Exception as exc:  # noqa: BLE001 - surface as tool output, never crash the run
            return json.dumps({"ok": False, "error": str(exc)})

    return FunctionTool(
        name="web_search",
        description=(
            "Search the public web and return the top results (title, url, snippet). "
            "Use for current events, recent facts, or anything not already in context."
        ),
        params_json_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query."},
                "max_results": {
                    "type": "integer",
                    "description": f"Max results (1-{_HARD_MAX_RESULTS}).",
                    "default": max_results,
                },
            },
            "required": ["query"],
        },
        on_invoke_tool=_invoke,
        strict_json_schema=False,
    )
