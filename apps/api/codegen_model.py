"""Single source of truth for the code-generation / repair LLM model.

The prompt-to-worker wedge depends on three OpenAI calls that all generate or
repair Python ``run.py`` code:

  1. ``workers/worker-author/run.py`` — the meta-worker that drafts the bundle
     (runs in an E2B sandbox; ``WORKEROS_CODEGEN_MODEL`` is propagated there).
  2. ``apps/api/run_service.py`` ``_repair_run_py`` — the bounded smoke-repair.
  3. ``apps/api/main.py`` ``_call_draft_llm`` — ``/workers/draft-from-prompt``.

Historically all three used ``gpt-4o-mini`` (a weak coder), which gated ~half of
awkward plain-English prompts on the first pass. They now share ONE strong
code-capable model via ``codegen_model()`` so generation + draft + repair agree
and the choice is tunable from one place (env ``WORKEROS_CODEGEN_MODEL``).

gpt-5.x calling differences (verified 2026-05-29 against the prod key and
again on 2026-06-05 for ``gpt-5.5``):
  - The chat-completions param is ``max_completion_tokens``, NOT ``max_tokens``
    (gpt-5.1 returns HTTP 400 for ``max_tokens``).
  - ``gpt-5.1-codex`` is NOT a chat model (v1/chat/completions rejects it); the
    strongest chat-capable coder reachable on this key is ``gpt-5.1``.
  - Some gpt-5.x models accept only default temperature, so this helper retries
    once without ``temperature`` when the API rejects a non-default value.

``chat_completion_codegen`` routes through the provider-agnostic ``llm`` seam, so
one code path serves OpenAI and any litellm provider (e.g. Bedrock / Claude),
selected by ``WORKEROS_CODEGEN_MODEL``. litellm normalizes the token parameter
across providers, so callers always pass ``max_output_tokens``.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

# The strongest chat-capable coder reachable on the prod OPENAI_API_KEY as of
# 2026-05-29. Override with the WORKEROS_CODEGEN_MODEL env var (ops-tunable).
DEFAULT_CODEGEN_MODEL = "gpt-5.5"

_CODEGEN_MODEL_ENV = "WORKEROS_CODEGEN_MODEL"


def codegen_model() -> str:
    """Return the configured code-generation model (env override or default)."""
    value = (os.environ.get(_CODEGEN_MODEL_ENV) or "").strip()
    return value or DEFAULT_CODEGEN_MODEL


def chat_completion_codegen(
    *,
    messages: List[Dict[str, Any]],
    max_output_tokens: int,
    temperature: float = 0.2,
    response_format: Dict[str, Any] | None = None,
    model: str | None = None,
    cache_prompt: bool = True,
) -> Any:
    """Run the code-generation model, provider-agnostic via the ``llm`` seam.

    Routes to OpenAI or any litellm provider (e.g. Bedrock / Claude) purely by the
    configured model id (``WORKEROS_CODEGEN_MODEL``). litellm normalizes the token
    parameter across providers, so callers always pass ``max_output_tokens``.
    Returns an OpenAI-shaped response (``.choices[0].message.content``). The static
    system prefix is marked cacheable (no-op on OpenAI; up to ~90% off on
    Anthropic/Bedrock). Retries once without ``temperature`` for models that only
    accept the default.
    """
    import llm

    chosen = model or codegen_model()
    kwargs: Dict[str, Any] = {
        "model": chosen,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "cache_prompt": cache_prompt,
    }
    if response_format is not None:
        kwargs["response_format"] = response_format

    try:
        return llm.completion(temperature=temperature, **kwargs)
    except Exception as exc:  # noqa: BLE001 - some models reject a non-default temperature
        if "temperature" in str(exc).lower():
            return llm.completion(**kwargs)
        raise
