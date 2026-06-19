"""Unit tests for the provider-agnostic web_search function tool (apps/api/web_search.py).

No network: Serper is mocked at requests.post, DuckDuckGo at ddgs.DDGS.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import web_search  # noqa: E402


def _ddgs_mock(text_results):
    inst = MagicMock()
    inst.__enter__.return_value = inst
    inst.__exit__.return_value = False
    inst.text.return_value = text_results
    return inst


def test_backend_name(monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    assert web_search.backend_name() == "duckduckgo"
    monkeypatch.setenv("SERPER_API_KEY", "k")
    assert web_search.backend_name() == "serper"


def test_search_uses_serper_when_key_set(monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "k")
    fake = MagicMock()
    fake.raise_for_status.return_value = None
    fake.json.return_value = {
        "organic": [
            {"title": "T1", "link": "http://a", "snippet": "s1"},
            {"title": "T2", "link": "http://b", "snippet": "s2"},
        ]
    }
    with patch("requests.post", return_value=fake) as post:
        out = web_search.search("hello", max_results=2)
    assert out == [
        {"title": "T1", "url": "http://a", "snippet": "s1"},
        {"title": "T2", "url": "http://b", "snippet": "s2"},
    ]
    _, kwargs = post.call_args
    assert kwargs["headers"]["X-API-KEY"] == "k"
    assert kwargs["json"]["q"] == "hello"


def test_search_uses_ddg_when_no_key(monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    inst = _ddgs_mock([{"title": "D1", "href": "http://x", "body": "b1"}])
    with patch("ddgs.DDGS", return_value=inst):
        out = web_search.search("hi", max_results=3)
    assert out == [{"title": "D1", "url": "http://x", "snippet": "b1"}]


def test_search_caps_max_results(monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    captured = {}
    inst = _ddgs_mock([])

    def _text(q, max_results):
        captured["n"] = max_results
        return []

    inst.text.side_effect = _text
    with patch("ddgs.DDGS", return_value=inst):
        web_search.search("q", max_results=999)
    assert captured["n"] == 10  # hard cap


def test_tool_invoke_returns_results():
    tool = web_search.web_search_tool()
    with patch("web_search.search", return_value=[{"title": "T", "url": "u", "snippet": "s"}]):
        out = asyncio.run(tool.on_invoke_tool(None, json.dumps({"query": "x"})))
    body = json.loads(out)
    assert body["ok"] is True
    assert body["results"][0]["url"] == "u"


def test_tool_invoke_requires_query():
    tool = web_search.web_search_tool()
    out = asyncio.run(tool.on_invoke_tool(None, json.dumps({"query": "  "})))
    body = json.loads(out)
    assert body["ok"] is False
    assert "query is required" in body["error"]


def test_tool_invoke_never_raises_on_backend_error():
    tool = web_search.web_search_tool()
    with patch("web_search.search", side_effect=RuntimeError("boom")):
        out = asyncio.run(tool.on_invoke_tool(None, json.dumps({"query": "x"})))
    body = json.loads(out)
    assert body["ok"] is False
    assert "boom" in body["error"]
