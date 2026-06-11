"""Provider-agnostic LLM access for the workerOS backend.

A single seam so every model call can target OpenAI (the zero-config default) or
any litellm-supported provider (e.g. AWS Bedrock / Anthropic Claude) chosen purely
by the configured *model id*. No provider is hardcoded: switch by changing the
model env vars and supplying that provider's credentials.

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

from typing import Any, Dict, List, Sequence


def is_litellm_model(model: str) -> bool:
    """True when ``model`` targets a non-OpenAI provider and needs litellm routing.

    Bare names (``gpt-5.5``) and the explicit ``openai/`` prefix are native OpenAI;
    anything else carrying a ``provider/`` prefix (``bedrock/``, ``anthropic/`` ...)
    is a litellm route.
    """
    if "/" not in model:
        return False
    return not model.startswith(("openai/", "litellm/openai/"))


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
        if "bedrock" in model.lower():
            return bool(
                os.environ.get("AWS_ACCESS_KEY_ID")
                or os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
                or os.environ.get("AWS_PROFILE")
            )
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
    # Bridge workerOS's reserved platform key name onto the standard OPENAI_API_KEY
    # that litellm reads. Bedrock / other providers authenticate via their own env
    # credentials (e.g. AWS creds + AWS_REGION_NAME) and need no api_key here.
    if not is_litellm_model(model) and "api_key" not in kwargs:
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY")
        if key:
            kwargs["api_key"] = key
    return litellm.completion(model=model, messages=msgs, **kwargs)
