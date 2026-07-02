"""Per-run, loop-local OpenAI model provider for the Agents SDK.

WHY THIS EXISTS
---------------
The Agents SDK resolves its OpenAI client lazily through
``agents.models.openai_provider.OpenAIProvider``. When no explicit client is
passed, that provider builds an ``AsyncOpenAI`` backed by a *module-level
global* ``httpx.AsyncClient`` (``OpenAIProvider.shared_http_client()``). An
``httpx.AsyncClient`` binds its connection pool to the event loop that first
performs I/O on it.

Floom runs each agent worker in its OWN fresh event loop (see
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


def _uses_openai_provider(model_name: str | None) -> bool:
    """True when the Agents SDK must resolve this model through OpenAI."""
    if model_name is None:
        return True
    if "/" not in model_name:
        return True
    prefix = model_name.split("/", 1)[0]
    return prefix == "openai"


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

    def _ensure_provider(self, *, needs_openai_client: bool) -> Any:
        if self._provider is not None:
            if not needs_openai_client or self._openai_client is not None:
                return self._provider
            # Rebuild with a loop-local OpenAI client for an OpenAI model after
            # this instance was first used for a non-OpenAI model.
            self._provider = None
        from agents.models.multi_provider import MultiProvider

        if needs_openai_client:
            import httpx
            from openai import AsyncOpenAI

            api_key = _resolve_openai_api_key()
            base_url = os.environ.get("OPENAI_BASE_URL")
            # Fresh httpx client bound to THIS loop. Not the SDK process global.
            self._http_client = httpx.AsyncClient()
            self._openai_client = AsyncOpenAI(
                api_key=api_key,
                base_url=base_url,
                http_client=self._http_client,
            )
            # OpenAI runs keep the loop-local client isolation that prevents
            # cross-loop httpx reuse.
            self._provider = MultiProvider(openai_client=self._openai_client)
        else:
            # Non-OpenAI runs use the SDK's built-in litellm provider. Do not
            # construct AsyncOpenAI here; OpenAI keys are not required for these
            # models and tracing is disabled in the agent driver.
            self._provider = MultiProvider()
        return self._provider

    @property
    def provider(self) -> "LoopLocalModelProvider":
        # Returns self so callers can pass `.provider` as RunConfig.model_provider.
        return self

    # --- ModelProvider protocol -------------------------------------------------
    def get_model(self, model_name: str | None) -> Any:
        return self._ensure_provider(
            needs_openai_client=_uses_openai_provider(model_name)
        ).get_model(model_name)

    @property
    def openai_provider(self) -> Any:
        # Test/diagnostic hook mirroring MultiProvider.openai_provider when the
        # OpenAI provider already exists. The Agents SDK also probes this
        # attribute for optional OpenAI harness metadata before model resolution;
        # do not construct AsyncOpenAI from that probe on non-OpenAI runs.
        if self._provider is None or self._openai_client is None:
            return None
        return self._provider.openai_provider

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
