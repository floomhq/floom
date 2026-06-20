"""Server-side PostHog **LLM Observability** — the SOTA core (Track A).

WorkerOS agent-mode workers run their LLM tool loop **on the API host** (the
OpenAI Agents SDK ``Runner.run_streamed`` executes inside the FastAPI process;
provider credentials never enter the tenant e2b sandbox — see
``runner_sandbox/agent_driver.py`` and ``runner_sandbox/loop_local_provider.py``).
That host-side boundary is the clean place to capture canonical AI telemetry at
**call time**: each model call is a *generation*, each tool/sandbox op is a
*span*, the whole run is a *trace*.

This module emits the PostHog AI-Observability event contract on top of the
fail-soft P1 client (``services.analytics_posthog``):

* ``$ai_trace``      — one per run (``$ai_trace_id = run_id``); run-level rollup.
* ``$ai_generation`` — one per model call; model/provider/tokens/cost/latency.
* ``$ai_span``       — one per tool call / sandbox op (``$ai_parent_id`` -> trace).
* ``$exception``     — captured on run crash with type + stack trace (§A4).

Hard contracts (all inherited from ``analytics_posthog``):
1. **Fail-soft / no-op** when ``POSTHOG_API_KEY`` is unset. Nothing emits until
   the Railway env var lands (Federico-gated). Identical behaviour to P1.
2. **Never raises.** Every public function swallows and logs. Telemetry must
   NEVER fail a run.
3. **Host-side only.** The capture key lives in the API process; it is never
   injected into the e2b sandbox env. Tenant sandbox code never emits canonical
   telemetry (it is spoofable / would leak the key) — spec §12.2 gap #3.

Privacy (§A3): **default is METADATA-ONLY.** Prompts, completions, and tool I/O
are MORE sensitive than DOM-replay PII (they carry emails, Slack, secrets pasted
into context). By default this module sends tokens/cost/model/latency and NO
prompt/completion/tool bodies. A per-workspace ``ai_capture_mode`` of ``full``
opts into body capture (truncated + with a best-effort secret scrub); ``redacted``
captures bodies with aggressive redaction. Default ``metadata``.

Cost (§A2): per-generation cost is computed from input/output tokens via
``litellm.cost_per_token`` (litellm is already a dependency and ships a
comprehensive model-pricing map). The run-level ``total_cost_usd`` is the SUM of
child generations — the cost-at-source fix for the null-cost problem, not the
single blended ``cost.py`` rate.
"""
from __future__ import annotations

import logging
import os
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from services import analytics_posthog

logger = logging.getLogger("floom.ai_observability")

# Schema version for the AI-obs property contract (independent of the product
# analytics SCHEMA_VERSION). Bump on a breaking AI-obs property change.
AI_SCHEMA_VERSION = 1

# AI-payload capture modes (§A3). metadata = tokens/cost/model only (default).
CAPTURE_METADATA = "metadata"
CAPTURE_REDACTED = "redacted"
CAPTURE_FULL = "full"
_VALID_CAPTURE_MODES = {CAPTURE_METADATA, CAPTURE_REDACTED, CAPTURE_FULL}

# Hard cap on any captured body length (only when mode != metadata). Bodies are
# truncated to this many chars before send so a giant transcript can't bloat an
# event or smuggle a large secret.
_MAX_BODY_CHARS = 2000

# Sampling knob: fraction of generations/spans to capture (1.0 = all). Trace +
# exception events are ALWAYS captured (never sampled out) so run-level rollups
# and crashes are complete. Env-overridable for the AI-event free-tier ceiling
# (100K AI events/mo; ~30 AI events/run).
_DEFAULT_SAMPLE_RATE = 1.0


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def sample_rate() -> float:
    """Generation/span sampling fraction in [0, 1]. Env: ``POSTHOG_AI_SAMPLE_RATE``."""
    raw = _env("POSTHOG_AI_SAMPLE_RATE")
    if not raw:
        return _DEFAULT_SAMPLE_RATE
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return _DEFAULT_SAMPLE_RATE


def is_enabled() -> bool:
    """True when the underlying PostHog client is live (key present)."""
    return analytics_posthog.is_enabled()


def new_span_id() -> str:
    """Fresh span id (used for generations and spans alike)."""
    return uuid.uuid4().hex


def normalize_capture_mode(mode: Optional[str]) -> str:
    """Coerce a capture-mode string to a known value; default metadata-only."""
    m = (mode or "").strip().lower()
    return m if m in _VALID_CAPTURE_MODES else CAPTURE_METADATA


# ---------------------------------------------------------------------------
# Cost (§A2) — per-generation, from input/output tokens via litellm pricing.
# ---------------------------------------------------------------------------

def generation_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> Optional[float]:
    """USD cost for one generation via ``litellm.cost_per_token``.

    Returns ``None`` when the model id is unknown to litellm (so the caller can
    fall back / leave cost null rather than emit a wrong number). Never raises.
    """
    if not model:
        return None
    try:
        import litellm

        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model,
            prompt_tokens=max(0, int(input_tokens or 0)),
            completion_tokens=max(0, int(output_tokens or 0)),
        )
        return round(float(prompt_cost) + float(completion_cost), 8)
    except Exception:
        # Unknown model / bad id form: don't guess, leave null.
        logger.debug("litellm cost_per_token failed for model=%s", model, exc_info=True)
        return None


def provider_from_model(model: str) -> Optional[str]:
    """Best-effort provider name from a model id (the ``provider/`` prefix or a
    bare-OpenAI heuristic). Metadata only — never affects routing."""
    if not model:
        return None
    m = model.lower()
    if "/" in m:
        prefix = m.split("/", 1)[0]
        # litellm-style nested prefix e.g. litellm/bedrock/... -> take the real one
        if prefix in {"litellm", "openai"} and m.count("/") >= 2:
            return m.split("/")[1]
        return prefix
    if m.startswith(("gpt", "o1", "o3", "o4", "chatgpt")):
        return "openai"
    if "claude" in m or "anthropic" in m:
        return "anthropic"
    return None


# ---------------------------------------------------------------------------
# Trace context — threaded through one run.
# ---------------------------------------------------------------------------

@dataclass
class AITraceContext:
    """Per-run AI-observability context. Carries the trace id + canonical ids,
    accumulates generation/span rollups, and gates body capture by mode.

    Created once at the start of an agent run (host-side) and passed to
    ``capture_generation`` / ``capture_span`` at each call site. ``finish()``
    emits the ``$ai_trace`` rollup. Cheap + safe even when analytics is disabled
    (all emits are no-ops).
    """

    trace_id: str
    run_id: str
    worker_id: str
    workspace_id: str
    owner_id: str
    capture_mode: str = CAPTURE_METADATA
    runner: str = "e2b"
    session_id: Optional[str] = None  # frontend $session_id, when browser-initiated

    # rollup accumulators
    generation_count: int = field(default=0)
    span_count: int = field(default=0)
    error_count: int = field(default=0)
    total_input_tokens: int = field(default=0)
    total_output_tokens: int = field(default=0)
    total_tokens: int = field(default=0)
    total_cost_usd: float = field(default=0.0)
    _cost_known: bool = field(default=False)
    _latencies_ms: List[float] = field(default_factory=list)
    _started_at: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        self.capture_mode = normalize_capture_mode(self.capture_mode)

    # --- shared property scaffolding --------------------------------------
    def _base_ai_props(self, span_id: str, parent_id: Optional[str]) -> Dict[str, Any]:
        props: Dict[str, Any] = {
            "$ai_trace_id": self.trace_id,
            "$ai_span_id": span_id,
            # canonical WorkerOS ids on every AI event for HogQL joins
            "run_id": self.run_id,
            "worker_id": self.worker_id or None,
            "workspace_id": self.workspace_id or None,
            "ai_schema_version": AI_SCHEMA_VERSION,
            "runner": self.runner,
        }
        if parent_id:
            props["$ai_parent_id"] = parent_id
        if self.session_id:
            props["$session_id"] = self.session_id
        return props

    def _groups(self) -> Optional[Dict[str, str]]:
        groups: Dict[str, str] = {}
        if self.workspace_id:
            groups["workspace"] = self.workspace_id
        if self.worker_id:
            groups["worker"] = self.worker_id
        return groups or None

    def _maybe_body(self, value: Any) -> Optional[Any]:
        """Return a body to attach, gated by capture mode. METADATA -> None."""
        if self.capture_mode == CAPTURE_METADATA or value is None:
            return None
        return _prepare_body(value, redact=(self.capture_mode == CAPTURE_REDACTED))

    # --- generation (one model call) --------------------------------------
    def capture_generation(
        self,
        *,
        model: str,
        input_tokens: int,
        output_tokens: int,
        total_tokens: Optional[int] = None,
        cached_input_tokens: int = 0,
        latency_s: Optional[float] = None,
        is_error: bool = False,
        span_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        input_body: Any = None,
        output_body: Any = None,
        http_status: Optional[int] = None,
    ) -> str:
        """Emit a ``$ai_generation`` for one model call and accumulate the rollup.

        Returns the span id (so a caller can chain children). No-op + never
        raises when disabled. Body args are dropped unless capture mode opts in.
        """
        sid = span_id or new_span_id()
        in_tok = max(0, int(input_tokens or 0))
        out_tok = max(0, int(output_tokens or 0))
        tot = int(total_tokens) if total_tokens is not None else (in_tok + out_tok)
        cost = generation_cost_usd(model, in_tok, out_tok)

        # rollup (always, even if this event is sampled out of PostHog, so the
        # trace summary + run cost stay correct).
        self.generation_count += 1
        self.total_input_tokens += in_tok
        self.total_output_tokens += out_tok
        self.total_tokens += tot
        if cost is not None:
            self.total_cost_usd += cost
            self._cost_known = True
        if is_error:
            self.error_count += 1
        if latency_s is not None:
            self._latencies_ms.append(float(latency_s) * 1000.0)

        if not is_enabled() or not _passes_sample():
            return sid

        props = self._base_ai_props(sid, parent_id or self.trace_id)
        props.update(
            {
                "$ai_model": model or None,
                "$ai_provider": provider_from_model(model),
                "$ai_input_tokens": in_tok,
                "$ai_output_tokens": out_tok,
                "$ai_cache_read_input_tokens": int(cached_input_tokens or 0) or None,
                "$ai_total_cost_usd": cost,
                "$ai_is_error": bool(is_error),
                "$ai_http_status": http_status,
            }
        )
        if latency_s is not None:
            props["$ai_latency"] = round(float(latency_s), 4)
        # bodies only when mode opts in
        inp = self._maybe_body(input_body)
        out = self._maybe_body(output_body)
        if inp is not None:
            props["$ai_input"] = inp
        if out is not None:
            props["$ai_output_choices"] = out
        _emit("$ai_generation", self.owner_id, props, self._groups())
        return sid

    # --- span (tool call / sandbox op) ------------------------------------
    def capture_span(
        self,
        *,
        name: str,
        span_type: str = "tool",
        latency_s: Optional[float] = None,
        is_error: bool = False,
        span_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        input_body: Any = None,
        output_body: Any = None,
    ) -> str:
        """Emit a ``$ai_span`` for a tool call / sandbox op. Returns the span id."""
        sid = span_id or new_span_id()
        self.span_count += 1
        if is_error:
            self.error_count += 1
        if latency_s is not None:
            self._latencies_ms.append(float(latency_s) * 1000.0)

        if not is_enabled() or not _passes_sample():
            return sid

        props = self._base_ai_props(sid, parent_id or self.trace_id)
        props.update(
            {
                "$ai_span_name": name or None,
                "$ai_span_type": span_type,
                "$ai_is_error": bool(is_error),
            }
        )
        if latency_s is not None:
            props["$ai_latency"] = round(float(latency_s), 4)
        inp = self._maybe_body(input_body)
        out = self._maybe_body(output_body)
        if inp is not None:
            props["$ai_input_state"] = inp
        if out is not None:
            props["$ai_output_state"] = out
        _emit("$ai_span", self.owner_id, props, self._groups())
        return sid

    # --- rollup --------------------------------------------------------------
    @property
    def rolled_total_cost_usd(self) -> Optional[float]:
        """SUM of child-generation costs, or ``None`` when no cost was known
        for any generation (so the run row stays null rather than showing 0)."""
        return round(self.total_cost_usd, 8) if self._cost_known else None

    def _p95_latency_ms(self) -> Optional[float]:
        if not self._latencies_ms:
            return None
        ordered = sorted(self._latencies_ms)
        idx = min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))
        return round(ordered[idx], 2)

    def summary(self) -> Dict[str, Any]:
        """Trace-derived run rollup. Used to fix run_completed cost/tokens at
        the right layer (§A2). Keys map onto the run-event properties."""
        return {
            "ai_trace_id": self.trace_id,
            "generation_count": self.generation_count,
            "span_count": self.span_count,
            "ai_error_count": self.error_count,
            "total_input_tokens": self.total_input_tokens or None,
            "total_output_tokens": self.total_output_tokens or None,
            "total_tokens": self.total_tokens or None,
            "total_cost_usd": self.rolled_total_cost_usd,
            "p95_step_latency_ms": self._p95_latency_ms(),
        }

    def finish(self, *, status: str = "completed", is_error: bool = False) -> None:
        """Emit the run-level ``$ai_trace`` rollup. Always emitted (not sampled)
        so every run has one trace. No-op + never raises when disabled."""
        if not is_enabled():
            return
        try:
            props = {
                "$ai_trace_id": self.trace_id,
                "$ai_span_id": new_span_id(),
                "run_id": self.run_id,
                "worker_id": self.worker_id or None,
                "workspace_id": self.workspace_id or None,
                "ai_schema_version": AI_SCHEMA_VERSION,
                "runner": self.runner,
                "status": status,
                "$ai_is_error": bool(is_error or self.error_count > 0),
                "duration_ms": int((time.monotonic() - self._started_at) * 1000),
            }
            props.update(
                {k: v for k, v in self.summary().items() if k != "ai_trace_id"}
            )
            if self.session_id:
                props["$session_id"] = self.session_id
            _emit("$ai_trace", self.owner_id, props, self._groups())
        except Exception:  # pragma: no cover - belt-and-suspenders
            logger.debug("AI trace emit failed for run %s", self.run_id, exc_info=True)


# ---------------------------------------------------------------------------
# Error tracking (§A4) — $exception on run crash.
# ---------------------------------------------------------------------------

def capture_exception(
    *,
    owner_id: str,
    exc: BaseException,
    run_id: str,
    worker_id: str = "",
    workspace_id: str = "",
    trace_id: Optional[str] = None,
    error_code: Optional[str] = None,
    error_category: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Capture a PostHog ``$exception`` for a crashed run so failures group into
    issues (type + stack trace), beyond the flat ``run_failed.error_category``.

    Stack-trace text NEVER includes prompt/completion bodies — only Python frames
    + the exception message. No-op + never raises when disabled.
    """
    if not is_enabled() or not owner_id:
        return
    try:
        exc_type = type(exc).__name__
        exc_value = str(exc)
        stack = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )
        if len(stack) > 8000:
            stack = stack[:8000] + "\n…[truncated]"
        props: Dict[str, Any] = {
            # PostHog Error Tracking schema: $exception_list groups by type+message.
            "$exception_list": [
                {
                    "type": exc_type,
                    "value": exc_value,
                    "stacktrace": {"type": "raw", "frames": [], "text": stack},
                }
            ],
            "$exception_type": exc_type,
            "$exception_message": exc_value,
            "run_id": run_id,
            "worker_id": worker_id or None,
            "workspace_id": workspace_id or None,
            "error_code": error_code or None,
            "error_category": error_category or None,
            "ai_schema_version": AI_SCHEMA_VERSION,
        }
        if trace_id:
            props["$ai_trace_id"] = trace_id
        if extra:
            props.update({k: v for k, v in extra.items() if v is not None})
        groups: Dict[str, str] = {}
        if workspace_id:
            groups["workspace"] = workspace_id
        if worker_id:
            groups["worker"] = worker_id
        _emit("$exception", owner_id, props, groups or None)
    except Exception:  # pragma: no cover
        logger.debug("AI $exception emit failed for run %s", run_id, exc_info=True)


# ---------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------

def _passes_sample() -> bool:
    rate = sample_rate()
    if rate >= 1.0:
        return True
    if rate <= 0.0:
        return False
    import random

    return random.random() < rate


def _emit(
    event: str,
    owner_id: str,
    properties: Dict[str, Any],
    groups: Optional[Dict[str, str]],
) -> None:
    """Forward to the P1 client (which injects schema_version/emitter, swallows,
    drops None distinct_id). Never raises."""
    analytics_posthog.capture_event(
        distinct_id=owner_id or "",
        event=event,
        properties=properties,
        groups=groups,
    )


def _prepare_body(value: Any, *, redact: bool) -> Any:
    """Truncate + (optionally) scrub a body before it is attached to an AI event.

    Only called when capture mode != metadata. Even ``full`` mode truncates and
    runs a best-effort secret scrub so a key pasted into context is not echoed
    verbatim into PostHog.
    """
    try:
        text = value if isinstance(value, str) else _coerce_text(value)
    except Exception:
        return None
    if text is None:
        return None
    scrubbed = _scrub_secrets(text)
    if redact:
        scrubbed = _redact_pii(scrubbed)
    if len(scrubbed) > _MAX_BODY_CHARS:
        scrubbed = scrubbed[:_MAX_BODY_CHARS] + "…[truncated]"
    return scrubbed


def _coerce_text(value: Any) -> Optional[str]:
    import json

    try:
        return json.dumps(value, default=str)[: _MAX_BODY_CHARS * 4]
    except Exception:
        return str(value)[: _MAX_BODY_CHARS * 4]


# Reuse the existing secret-scan patterns so AI bodies share one redaction
# source of truth. ``secret_scan`` only *detects* (returns masked findings); we
# apply its patterns as in-place substitutions so the credential never survives
# in the captured body.
def _scrub_secrets(text: str) -> str:
    try:
        from secret_scan import _PATTERNS, mask_secret  # type: ignore

        out = text
        for _name, regex in _PATTERNS:
            out = regex.sub(lambda m: mask_secret(m.group(0)), out)
        return out
    except Exception:
        return text


import re as _re

_EMAIL_RE = _re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = _re.compile(r"\+?\d[\d\s().-]{7,}\d")


def _redact_pii(text: str) -> str:
    text = _EMAIL_RE.sub("[email]", text)
    text = _PHONE_RE.sub("[phone]", text)
    return text
