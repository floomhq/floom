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

``chat_completion_codegen`` wraps ``client.chat.completions.create`` so callers
never have to know whether the configured model wants ``max_tokens`` or
``max_completion_tokens`` — it picks the right one from the model name and
retries once on the well-known "use max_completion_tokens instead" 400 so an
ops model override (e.g. back to a gpt-4 family model) keeps working.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

# The strongest chat-capable coder reachable on the prod OPENAI_API_KEY as of
# 2026-05-29. Override with the WORKEROS_CODEGEN_MODEL env var (ops-tunable).
DEFAULT_CODEGEN_MODEL = "gpt-5.1"

_CODEGEN_MODEL_ENV = "WORKEROS_CODEGEN_MODEL"


def codegen_model() -> str:
    """Return the configured code-generation model (env override or default)."""
    value = (os.environ.get(_CODEGEN_MODEL_ENV) or "").strip()
    return value or DEFAULT_CODEGEN_MODEL


def _uses_max_completion_tokens(model: str) -> bool:
    """gpt-5.x / o-series reasoning models require ``max_completion_tokens``.

    The legacy gpt-4 / gpt-4o family still uses ``max_tokens``. Detect by name
    so an ops override to either family sends the right parameter.
    """
    m = model.lower()
    return m.startswith(("gpt-5", "o1", "o3", "o4"))


def chat_completion_codegen(
    client: Any,
    *,
    messages: List[Dict[str, Any]],
    max_output_tokens: int,
    temperature: float = 0.2,
    response_format: Dict[str, Any] | None = None,
    model: str | None = None,
) -> Any:
    """Call chat.completions with the codegen model, param-compatible across families.

    Picks ``max_completion_tokens`` vs ``max_tokens`` from the model name, and
    self-heals on the OpenAI 400 that names the other parameter (so a model
    override never silently breaks generation).
    """
    chosen = model or codegen_model()
    token_kwarg = (
        "max_completion_tokens" if _uses_max_completion_tokens(chosen) else "max_tokens"
    )

    def _create(token_param: str, *, include_temperature: bool = True) -> Any:
        kwargs: Dict[str, Any] = {
            "model": chosen,
            "messages": messages,
            token_param: max_output_tokens,
        }
        if include_temperature:
            kwargs["temperature"] = temperature
        if response_format is not None:
            kwargs["response_format"] = response_format
        return client.chat.completions.create(**kwargs)

    try:
        return _create(token_kwarg)
    except Exception as exc:  # noqa: BLE001 - inspect the message, then retry once
        msg = str(exc).lower()
        if "max_completion_tokens" in msg and token_kwarg == "max_tokens":
            return _create("max_completion_tokens")
        if "max_tokens" in msg and token_kwarg == "max_completion_tokens":
            return _create("max_tokens")
        if (
            "temperature" in msg
            and (
                "unsupported" in msg
                or "does not support" in msg
                or "only the default" in msg
            )
        ):
            return _create(token_kwarg, include_temperature=False)
        raise
