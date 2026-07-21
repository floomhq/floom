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
from dataclasses import dataclass, replace
from typing import Any, AsyncIterator, Callable, Optional, Sequence

logger = logging.getLogger("floom.runner_sandbox.loop_local_provider")

_UNSET = object()


@dataclass(frozen=True)
class _FallbackTarget:
    name: str
    extra_args: dict[str, Any] | None
    max_tokens: int | None | object = _UNSET


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


class _FallbackModel:
    """Retry one failed model call on a second provider without leaking partial output."""

    def __init__(
        self,
        *,
        primary: Any,
        fallback_factory: Callable[[], Any],
        primary_name: str,
        fallback_name: str,
        should_fallback: Callable[[BaseException], bool],
        fallback_extra_args: dict[str, Any] | None = None,
        fallback_max_tokens: int | None | object = _UNSET,
        operation_name: str = "Chat",
        exhausted_marker: str | None = "chat model fallback exhausted",
        exhausted_marker_requires_retryable: bool = False,
        on_fallback: Callable[[str, str], None] | None = None,
    ) -> None:
        self._primary = primary
        self._fallback_factory = fallback_factory
        self._fallback: Any = None
        self._fallback_active = False
        self._primary_name = primary_name
        self._fallback_name = fallback_name
        self._should_fallback = should_fallback
        self._fallback_extra_args = fallback_extra_args
        self._fallback_max_tokens = fallback_max_tokens
        self._operation_name = operation_name
        self._exhausted_marker = exhausted_marker
        self._exhausted_marker_requires_retryable = exhausted_marker_requires_retryable
        self._on_fallback = on_fallback

    def _get_fallback(self) -> Any:
        if self._fallback is None:
            self._fallback = self._fallback_factory()
        return self._fallback

    def get_retry_advice(self, request: Any) -> Any:
        model = (
            self._fallback
            if self._fallback_active and self._fallback is not None
            else self._primary
        )
        get_advice = getattr(model, "get_retry_advice", None)
        return get_advice(request) if callable(get_advice) else None

    def _fallback_call(
        self, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> tuple[tuple[Any, ...], dict[str, Any]]:
        fallback_args = list(args)
        fallback_kwargs = dict(kwargs)
        if len(fallback_args) > 2 and fallback_args[2] is not None:
            fallback_args[2] = self._fallback_model_settings(fallback_args[2])
        elif fallback_kwargs.get("model_settings") is not None:
            fallback_kwargs["model_settings"] = self._fallback_model_settings(
                fallback_kwargs["model_settings"]
            )
        return tuple(fallback_args), fallback_kwargs

    def _fallback_model_settings(self, model_settings: Any) -> Any:
        replacements: dict[str, Any] = {"extra_args": self._fallback_extra_args}
        if self._fallback_max_tokens is not _UNSET:
            primary_max_tokens = getattr(model_settings, "max_tokens", None)
            replacements["max_tokens"] = (
                min(primary_max_tokens, self._fallback_max_tokens)
                if primary_max_tokens is not None and self._fallback_max_tokens is not None
                else self._fallback_max_tokens
            )
        return replace(model_settings, **replacements)

    def _raise_fallback_error(self, fallback_exc: BaseException) -> None:
        if self._exhausted_marker is None or (
            self._exhausted_marker_requires_retryable
            and not self._should_fallback(fallback_exc)
        ):
            raise fallback_exc
        raise RuntimeError(self._exhausted_marker) from fallback_exc

    def _activate_fallback(self) -> None:
        self._fallback_active = True
        if self._on_fallback is not None:
            try:
                self._on_fallback(self._primary_name, self._fallback_name)
            except Exception:
                logger.debug("Fallback activation callback failed", exc_info=True)

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        if self._fallback_active:
            fallback_args, fallback_kwargs = self._fallback_call(args, kwargs)
            try:
                return await self._get_fallback().get_response(*fallback_args, **fallback_kwargs)
            except Exception as fallback_exc:
                self._raise_fallback_error(fallback_exc)
        try:
            return await self._primary.get_response(*args, **kwargs)
        except Exception as exc:
            if not self._should_fallback(exc):
                raise
            logger.warning(
                "%s model %s failed with a retryable provider error; retrying model call on %s",
                self._operation_name,
                self._primary_name,
                self._fallback_name,
            )
            self._activate_fallback()
            fallback_args, fallback_kwargs = self._fallback_call(args, kwargs)
            try:
                return await self._get_fallback().get_response(*fallback_args, **fallback_kwargs)
            except Exception as fallback_exc:
                logger.error(
                    "%s fallback model %s failed after primary model %s",
                    self._operation_name,
                    self._fallback_name,
                    self._primary_name,
                    exc_info=True,
                )
                self._raise_fallback_error(fallback_exc)

    async def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        buffered: list[Any] = []
        if self._fallback_active:
            fallback_args, fallback_kwargs = self._fallback_call(args, kwargs)
            try:
                async for event in self._get_fallback().stream_response(
                    *fallback_args, **fallback_kwargs
                ):
                    buffered.append(event)
            except Exception as fallback_exc:
                self._raise_fallback_error(fallback_exc)
            for event in buffered:
                yield event
            return
        try:
            async for event in self._primary.stream_response(*args, **kwargs):
                buffered.append(event)
        except Exception as exc:
            if not self._should_fallback(exc):
                raise
            logger.warning(
                "%s model %s stream failed with a retryable provider error; restarting model call on %s",
                self._operation_name,
                self._primary_name,
                self._fallback_name,
            )
            self._activate_fallback()
            fallback_args, fallback_kwargs = self._fallback_call(args, kwargs)
            buffered = []
            try:
                async for event in self._get_fallback().stream_response(
                    *fallback_args, **fallback_kwargs
                ):
                    buffered.append(event)
            except Exception as fallback_exc:
                logger.error(
                    "%s fallback model %s stream failed after primary model %s",
                    self._operation_name,
                    self._fallback_name,
                    self._primary_name,
                    exc_info=True,
                )
                self._raise_fallback_error(fallback_exc)
        for event in buffered:
            yield event


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

    def __init__(
        self,
        *,
        fallback_model_name: str | None = None,
        fallback_model_names: Sequence[str] | None = None,
        should_fallback: Callable[[BaseException], bool] | None = None,
        fallback_extra_args: dict[str, Any] | None = None,
        fallback_extra_args_by_model: Sequence[dict[str, Any] | None] | None = None,
        fallback_max_tokens: int | None | object = _UNSET,
        fallback_max_tokens_by_model: Sequence[int | None] | None = None,
        fallback_operation_name: str = "Chat",
        fallback_exhausted_marker: str | None = "chat model fallback exhausted",
        fallback_exhausted_marker_requires_retryable: bool = False,
        on_fallback: Callable[[str, str], None] | None = None,
    ) -> None:
        self._provider: Any = None
        self._openai_client: Any = None
        self._http_client: Any = None
        self._should_fallback = should_fallback
        self._fallback_operation_name = fallback_operation_name
        self._fallback_exhausted_marker = fallback_exhausted_marker
        self._fallback_exhausted_marker_requires_retryable = (
            fallback_exhausted_marker_requires_retryable
        )
        self._on_fallback = on_fallback
        self._fallback_models: dict[str | None, Any] = {}
        if fallback_model_names is None:
            self._fallback_targets = (
                [
                    _FallbackTarget(
                        name=fallback_model_name,
                        extra_args=fallback_extra_args,
                        max_tokens=fallback_max_tokens,
                    )
                ]
                if fallback_model_name
                else []
            )
        else:
            names = list(fallback_model_names)
            extra_args = (
                list(fallback_extra_args_by_model)
                if fallback_extra_args_by_model is not None
                else [None] * len(names)
            )
            max_tokens: list[int | None | object] = (
                list(fallback_max_tokens_by_model)
                if fallback_max_tokens_by_model is not None
                else [_UNSET] * len(names)
            )
            if len(extra_args) != len(names) or len(max_tokens) != len(names):
                raise ValueError("Fallback model settings must match fallback model count")
            self._fallback_targets = [
                _FallbackTarget(name=name, extra_args=extra, max_tokens=maximum)
                for name, extra, maximum in zip(names, extra_args, max_tokens)
            ]

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
    def _build_fallback_chain(
        self,
        *,
        primary: Any,
        primary_name: str,
        targets: Sequence[_FallbackTarget],
        target_index: int = 0,
    ) -> Any:
        if target_index >= len(targets):
            return primary
        target = targets[target_index]

        def fallback_factory() -> Any:
            fallback = self._ensure_provider(
                needs_openai_client=_uses_openai_provider(target.name)
            ).get_model(target.name)
            return self._build_fallback_chain(
                primary=fallback,
                primary_name=target.name,
                targets=targets,
                target_index=target_index + 1,
            )

        last_target = target_index == len(targets) - 1
        return _FallbackModel(
            primary=primary,
            fallback_factory=fallback_factory,
            primary_name=primary_name,
            fallback_name=target.name,
            should_fallback=self._should_fallback,
            fallback_extra_args=target.extra_args,
            fallback_max_tokens=target.max_tokens,
            operation_name=self._fallback_operation_name,
            exhausted_marker=(
                self._fallback_exhausted_marker if last_target else None
            ),
            exhausted_marker_requires_retryable=(
                self._fallback_exhausted_marker_requires_retryable if last_target else False
            ),
            on_fallback=self._on_fallback,
        )

    def get_model(self, model_name: str | None) -> Any:
        if model_name in self._fallback_models:
            return self._fallback_models[model_name]
        primary = self._ensure_provider(
            needs_openai_client=_uses_openai_provider(model_name)
        ).get_model(model_name)
        targets = [target for target in self._fallback_targets if target.name != model_name]
        if not targets or not self._should_fallback:
            return primary
        model = self._build_fallback_chain(
            primary=primary,
            primary_name=model_name or "default",
            targets=targets,
        )
        self._fallback_models[model_name] = model
        return model

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
