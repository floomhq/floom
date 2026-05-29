"""Per-run, loop-local OpenAI model provider for the Agents SDK.

WHY THIS EXISTS
---------------
The Agents SDK resolves its OpenAI client lazily through
``agents.models.openai_provider.OpenAIProvider``. When no explicit client is
passed, that provider builds an ``AsyncOpenAI`` backed by a *module-level
global* ``httpx.AsyncClient`` (``OpenAIProvider.shared_http_client()``). An
``httpx.AsyncClient`` binds its connection pool to the event loop that first
performs I/O on it.

Workeros runs each agent worker in its OWN fresh event loop (see
``AgentDriver._run_coro_sync`` -> ``asyncio.run`` in a thread). The chat path
runs on the persistent uvicorn loop. All of them share the single global httpx
client. When one run's loop closes (or when a run on loop A reuses a client
already bound to loop B), the shared streaming client hits
``RuntimeError: Event loop is closed``. Solo runs always pass; 2+ overlapping
runs intermittently fail.

THE FIX (per-run isolation)
---------------------------
Build a FRESH ``AsyncOpenAI`` client wrapping a FRESH ``httpx.AsyncClient``
INSIDE the run's own loop, hand it to the SDK via ``RunConfig.model_provider``,
and close both when the run finishes. No loop-bound async resource is shared
across runs, so a closing loop can never poison a concurrent one.

Construction of the underlying ``AsyncOpenAI`` is LAZY (built on first
``get_model``) so that runs whose model is never resolved (e.g. tests that stub
the SDK transport, or runs that fail before any model call) do not require an
``OPENAI_API_KEY`` to be present.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("floom.runner_sandbox.loop_local_provider")


def _resolve_openai_api_key() -> Optional[str]:
    """Resolve the OpenAI API key the same way the SDK default would."""
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    try:
        from agents.models import _openai_shared

        return _openai_shared.get_default_openai_key()
    except Exception:  # pragma: no cover - defensive
        return None


class LoopLocalModelProvider:
    """A ModelProvider bound to a per-run AsyncOpenAI + httpx client.

    Construct INSIDE the target event loop. The underlying clients are created
    lazily on the first ``get_model`` call (i.e. when the SDK actually needs to
    talk to OpenAI), so paths that never resolve a model never build a client.
    ``await aclose()`` before the loop is torn down to release the httpx
    connection pool cleanly (no "Event loop is closed" warnings, no leaked
    sockets).

    The instance itself satisfies the SDK ``ModelProvider`` protocol via
    ``get_model``, so it can be passed directly as ``RunConfig.model_provider``.
    """

    def __init__(self) -> None:
        self._provider: Any = None
        self._openai_client: Any = None
        self._http_client: Any = None

    def _ensure_provider(self) -> Any:
        if self._provider is not None:
            return self._provider
        import httpx
        from openai import AsyncOpenAI
        from agents.models.multi_provider import MultiProvider

        api_key = _resolve_openai_api_key()
        base_url = os.environ.get("OPENAI_BASE_URL")
        # Fresh httpx client bound to THIS loop. Not the SDK process global.
        self._http_client = httpx.AsyncClient()
        self._openai_client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            http_client=self._http_client,
        )
        # MultiProvider preserves the SDK's prefix routing (openai/, litellm/,
        # any-llm/) while pinning the OpenAI provider to our per-run client.
        self._provider = MultiProvider(openai_client=self._openai_client)
        return self._provider

    @property
    def provider(self) -> "LoopLocalModelProvider":
        # Returns self so callers can pass `.provider` as RunConfig.model_provider.
        return self

    # --- ModelProvider protocol -------------------------------------------------
    def get_model(self, model_name: str | None) -> Any:
        return self._ensure_provider().get_model(model_name)

    @property
    def openai_provider(self) -> Any:
        # Test/diagnostic hook mirroring MultiProvider.openai_provider. Forces
        # lazy construction so callers can inspect the per-run OpenAI client.
        return self._ensure_provider().openai_provider

    async def aclose(self) -> None:
        """Close the per-run OpenAI + httpx client. Idempotent, never raises."""
        if self._openai_client is not None:
            try:
                await self._openai_client.close()
            except Exception:  # pragma: no cover - best effort teardown
                logger.debug("Per-run OpenAI client close failed", exc_info=True)
        if self._http_client is not None:
            try:
                await self._http_client.aclose()
            except Exception:  # pragma: no cover - best effort teardown
                logger.debug("Per-run httpx client close failed", exc_info=True)
