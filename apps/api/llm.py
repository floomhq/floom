"""Provider-agnostic LLM access for the Floom backend.

A single seam so every model call can target the configured provider by model id.
Worker agents default to AWS Bedrock; OpenAI remains available by setting an
OpenAI model id and key. Other litellm-supported providers (e.g. Anthropic
Claude) are selected by changing the model env vars and supplying that
provider's credentials.

Model id conventions
--------------------
* Bare OpenAI model (``gpt-5.5``, ``gpt-5.4-mini``) -> OpenAI. Needs ``OPENAI_API_KEY``.
* Provider-prefixed id (``bedrock/us.anthropic.claude-sonnet-4-6``) -> that provider
  via litellm. Bedrock additionally needs AWS credentials and ``AWS_REGION_NAME``.

Why litellm: it is the supported multi-provider extra of ``openai-agents`` (already a
dependency). The agent loop routes ``litellm/``-prefixed models through the SDK's
``MultiProvider``; one-shot calls go through ``litellm.completion``, which returns
OpenAI-shaped responses. One code path serves every provider.
"""
from __future__ import annotations

import logging
import re as _re
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger("workeros.llm")

# #951/#870: provider failure classification. Quota/auth failures get a
# distinct degraded-mode message + an ops-alertable ERROR log; raw provider
# text (account status, key fragments, model ids) never reaches a client.
_PROVIDER_OUTAGE_RE = _re.compile(
    r"insufficient_quota|invalid_api_key|incorrect api key|authenticationerror"
    r"|billing|exceeded your current quota|rate.?limit|429|401",
    _re.IGNORECASE,
)
_PROVIDER_ERROR_RE = _re.compile(
    r"error code: \d{3}|openai|anthropic|litellm|bedrock|api.?connection",
    _re.IGNORECASE,
)
_PROVIDER_FALLBACK_RE = _re.compile(
    r"invalid api key|api[_ -]?key|authentication|permission|unauthorized|forbidden"
    r"|billing|quota|exceeded your current quota|rate.?limit|resource_exhausted"
    r"|credential|access.?denied|unrecognizedclient|expiredtoken|security token"
    r"|429|401|403",
    _re.IGNORECASE,
)


def is_llm_provider_outage(exc: BaseException | str) -> bool:
    """True for quota/auth/rate-limit failures — the 'Emily is down' class (#870)."""
    return bool(_PROVIDER_OUTAGE_RE.search(str(exc)))


def safe_llm_error_message(exc: BaseException | str, *, action: str = "This request") -> str:
    """User-safe message for a failed LLM call; never echoes provider details.

    Full detail goes to the server log only. Quota/auth outages additionally
    emit an `LLM_PROVIDER_ALERT` ERROR record so ops alerting can key on it.
    """
    text = str(exc)
    if "chat model fallback exhausted" in text.lower():
        logger.error("LLM_PROVIDER_ALERT chat fallback exhausted (%s)", action)
        return (
            f"{action} hit a temporary capacity issue after retrying another provider. "
            "Please try again."
        )
    if is_llm_provider_outage(text):
        logger.error("LLM_PROVIDER_ALERT quota/auth failure (%s): %s", action, text)
        return (
            f"{action} is temporarily unavailable because of an AI provider "
            "account issue. The team has been alerted. Please try again soon."
        )
    if _PROVIDER_ERROR_RE.search(text):
        logger.error("LLM provider error (%s): %s", action, text)
        return f"{action} failed upstream. Please try again."
    return f"{action} failed. Please try again."


def is_litellm_model(model: str) -> bool:
    """True when ``model`` targets a non-OpenAI provider and needs litellm routing.

    Bare names (``gpt-5.5``) and the explicit ``openai/`` prefix are native OpenAI;
    anything else carrying a ``provider/`` prefix (``bedrock/``, ``anthropic/`` ...)
    is a litellm route.
    """
    if "/" not in model:
        return False
    return not model.startswith(("openai/", "litellm/openai/"))


def _is_direct_gemini_api_key_model(model: str) -> bool:
    normalized = model.lower()
    if normalized.startswith("litellm/"):
        normalized = normalized.removeprefix("litellm/")
    return normalized.startswith("gemini/")


def _gemini_primary_key() -> str | None:
    import os

    return (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip() or None


def _gemini_fallback_key() -> str | None:
    import os

    return (
        os.environ.get("GEMINI_API_KEY_FALLBACK")
        or os.environ.get("GOOGLE_API_KEY_FALLBACK")
        or ""
    ).strip() or None


def _should_retry_gemini_with_fallback(exc: BaseException) -> bool:
    return should_retry_chat_with_fallback(exc)


def should_retry_chat_with_fallback(exc: BaseException) -> bool:
    """True when a chat provider failure is safe to retry on another model."""
    return bool(_PROVIDER_FALLBACK_RE.search(str(exc)))


def agent_model(model: str) -> str:
    """Normalize ``model`` for the OpenAI Agents SDK ``MultiProvider``.

    Non-OpenAI providers are routed through the SDK's litellm provider via the
    ``litellm/`` prefix; bare / ``openai/`` ids run on the native OpenAI provider.
    Idempotent: an already-``litellm/``-prefixed id is returned unchanged.
    """
    if model.startswith("litellm/"):
        return model
    return f"litellm/{model}" if is_litellm_model(model) else model


def provider_credentials_present(model: str) -> bool:
    """True when environment credentials for ``model``'s provider are configured.

    Lets endpoints fail fast with a clear message instead of a deep SDK error.
    OpenAI -> ``OPENAI_API_KEY`` / ``PLATFORM_OPENAI_API_KEY``. Bedrock -> AWS
    credentials. Other litellm providers return True (the call surfaces any auth
    error itself).
    """
    import os

    if is_litellm_model(model):
        if _is_direct_gemini_api_key_model(model):
            return bool(_gemini_primary_key() or _gemini_fallback_key())
        if "bedrock" in model.lower():
            has_credentials = bool(
                os.environ.get("AWS_ACCESS_KEY_ID")
                or os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
                or os.environ.get("AWS_PROFILE")
            )
            has_region = bool(
                os.environ.get("AWS_REGION_NAME")
                or os.environ.get("AWS_REGION")
                or os.environ.get("AWS_DEFAULT_REGION")
            )
            return has_credentials and has_region
        return True
    return bool(
        os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY")
    )


def _is_anthropic_model(model: str) -> bool:
    m = model.lower()
    return "anthropic" in m or "claude" in m


def with_prompt_cache(
    messages: Sequence[Dict[str, Any]], model: str
) -> List[Dict[str, Any]]:
    """Mark the leading system context cacheable on providers billed per cached token.

    Anthropic / Bedrock charge separately for cached input (up to ~90% cheaper) but
    require explicit ``cache_control`` breakpoints; the static system prompt + tool
    schemas re-sent every turn of an agent loop are the high-value target. OpenAI
    caches prefixes automatically, so this is a no-op there. Returns a new list; the
    input is not mutated.
    """
    if not _is_anthropic_model(model):
        return list(messages)
    out: List[Dict[str, Any]] = []
    cached = False
    for msg in messages:
        if not cached and msg.get("role") == "system" and isinstance(msg.get("content"), str):
            msg = {
                **msg,
                "content": [
                    {
                        "type": "text",
                        "text": msg["content"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            }
            cached = True
        out.append(msg)
    return out


def cache_control_extra_args(model: str) -> Optional[Dict[str, Any]]:
    """``ModelSettings.extra_args`` that cache the static system prompt in agent loops.

    For Anthropic / Bedrock (cached input billed separately), tell litellm to inject a
    cache_control breakpoint on the system message, so the large static system prompt
    and tool context is cached and re-read across the agent loop's turns (up to ~90%
    off those input tokens). The Agents SDK ``LitellmModel`` forwards ``extra_args``
    straight to ``litellm.acompletion``. Returns None for providers that cache
    automatically (OpenAI), so it is safe to pass unconditionally.
    """
    if not _is_anthropic_model(model):
        return None
    return {"cache_control_injection_points": [{"location": "message", "role": "system"}]}


def completion(
    *,
    model: str,
    messages: Sequence[Dict[str, Any]],
    cache_prompt: bool = False,
    **kwargs: Any,
) -> Any:
    """One-shot chat/JSON completion routed to OpenAI or any litellm provider by model id.

    Returns an OpenAI-shaped response (``.choices[0].message.content`` / ``.tool_calls``).
    Credentials and region are read from the environment by litellm (``OPENAI_API_KEY``;
    AWS creds + ``AWS_REGION_NAME`` for Bedrock). Pass ``cache_prompt=True`` to mark the
    system prefix cacheable on providers that support it.
    """
    import os

    import litellm

    msgs = with_prompt_cache(messages, model) if cache_prompt else list(messages)
    # Bridge Floom's reserved platform key name onto the standard OPENAI_API_KEY
    # that litellm reads. Bedrock / other providers authenticate via their own env
    # credentials (e.g. AWS creds + AWS_REGION_NAME) and need no api_key here.
    if not is_litellm_model(model) and "api_key" not in kwargs:
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY")
        if key:
            kwargs["api_key"] = key
    if is_litellm_model(model) and _is_direct_gemini_api_key_model(model) and "api_key" not in kwargs:
        primary_key = _gemini_primary_key()
        fallback_key = _gemini_fallback_key()
        if primary_key:
            kwargs["api_key"] = primary_key
        try:
            return litellm.completion(model=model, messages=msgs, **kwargs)
        except Exception as exc:  # noqa: BLE001 - litellm/provider exception classes vary
            if not fallback_key or fallback_key == primary_key or not _should_retry_gemini_with_fallback(exc):
                raise
            logger.warning("Gemini primary key failed; retrying with fallback key for model %s", model)
            retry_kwargs = {**kwargs, "api_key": fallback_key}
            return litellm.completion(model=model, messages=msgs, **retry_kwargs)
    return litellm.completion(model=model, messages=msgs, **kwargs)


def embedding(
    *,
    model: str,
    input: Any,
    **kwargs: Any,
) -> Any:
    """Embedding call routed through the same provider credential path.

    The default deployment path uses OpenAI-compatible embeddings. Provider
    credentials stay in the API process; workers call the run-scoped proxy.
    """
    import os

    import litellm

    if not is_litellm_model(model) and "api_key" not in kwargs:
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY")
        if key:
            kwargs["api_key"] = key
    return litellm.embedding(model=model, input=input, **kwargs)
