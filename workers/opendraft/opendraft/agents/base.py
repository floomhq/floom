"""BaseCodeAgent: Gemini chat loop with function call dispatch and signal parsing."""

import os
import re
import json
import time
import logging
import inspect
import threading
from typing import Any, Callable, Dict, Optional
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue, Empty

from google import genai
from google.genai import types

from opendraft.orchestrator.state import AgentResult
from opendraft.core.retry import RetryConfig, CircuitBreaker, calculate_backoff_delay
from opendraft.core.errors import (
    TransientError,
    TRANSIENT_ERROR_PATTERNS,
    classify_error,
)

logger = logging.getLogger(__name__)

# V3: Cost tracking - prices per 1M tokens (Gemini 3 only)
MODEL_COSTS = {
    "gemini-3-flash-preview": {"input": 0.10, "output": 0.40},
    "gemini-3-pro-preview": {"input": 1.25, "output": 5.00},
    "default": {"input": 0.10, "output": 0.40},
}

def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning("Invalid integer env var %s=%r, using %s", name, value, default)
        return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        logger.warning("Invalid float env var %s=%r, using %s", name, value, default)
        return default


# Gemini transport settings (override via env when needed)
# Increased defaults for reliable API calls (Gemini 3 can be slow)
GEMINI_HTTP_TIMEOUT_MS = max(1_000, _env_int("OPENDRAFT_GEMINI_HTTP_TIMEOUT_MS", 120_000))  # 2 min
GEMINI_HTTP_RETRY_ATTEMPTS = max(1, _env_int("OPENDRAFT_GEMINI_HTTP_RETRY_ATTEMPTS", 3))
AGENT_CALL_TIMEOUT_SECONDS = max(5.0, _env_float("OPENDRAFT_AGENT_CALL_TIMEOUT_SECONDS", 180.0))  # 3 min

# V3.2: Transient retry settings for agent loop (override via env)
DEFAULT_RETRY_CONFIG = RetryConfig(
    max_attempts=max(0, _env_int("OPENDRAFT_TRANSIENT_RETRY_ATTEMPTS", 1)),
    base_delay=max(0.0, _env_float("OPENDRAFT_TRANSIENT_RETRY_BASE_DELAY", 1.0)),
    max_delay=max(0.0, _env_float("OPENDRAFT_TRANSIENT_RETRY_MAX_DELAY", 8.0)),
    jitter_factor=min(1.0, max(0.0, _env_float("OPENDRAFT_TRANSIENT_RETRY_JITTER", 0.1))),
)

# Global circuit breaker for rate limit protection (shared across agents)
_global_circuit_breaker: Optional[CircuitBreaker] = None


def get_circuit_breaker() -> CircuitBreaker:
    """Get or create the global circuit breaker."""
    global _global_circuit_breaker
    if _global_circuit_breaker is None:
        _global_circuit_breaker = CircuitBreaker(
            failure_threshold=5,
            reset_timeout=60.0,
            half_open_max_calls=1,
        )
    return _global_circuit_breaker


# Legacy constants for backwards compatibility
TRANSIENT_ERRORS = TRANSIENT_ERROR_PATTERNS  # Use patterns from core.errors
MAX_RETRIES = DEFAULT_RETRY_CONFIG.max_attempts
RETRY_DELAYS = [5, 15, 30, 60, 120]  # Legacy list, prefer RetryConfig


# Signal constants
SIGNAL_DONE = "DONE"
SIGNAL_RERUN = "RERUN"
SIGNAL_ESCALATE = "ESCALATE"


@dataclass
class ToolConfig:
    """Configuration for which Gemini tools an agent uses.

    All agents use function_calling only. Code execution is handled
    via the local sandbox through the run_code function declaration.
    """
    function_declarations: list = field(default_factory=list)


class BaseCodeAgent:
    """
    Base agent using Gemini's function calling loop.

    Flow:
    1. Configure model with function declarations
    2. Send system prompt + task to Gemini via chat
    3. Handle function calls (including run_code for local sandbox), send results back
    4. Parse SIGNAL keywords in final response (DONE/RERUN/ESCALATE)
    5. Return AgentResult
    """

    def __init__(
        self,
        name: str,
        system_prompt: str,
        tool_config: ToolConfig,
        function_handlers: Dict[str, Callable],
        model_name: str = "gemini-3-flash-preview",
        max_iterations: int = 5,
        client: Optional[genai.Client] = None,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.function_handlers = function_handlers
        self.max_iterations = max_iterations
        self.model_name = model_name

        # V3: Cost tracking
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.api_calls = 0

        # Use provided client or create from config
        self.request_timeout_seconds = AGENT_CALL_TIMEOUT_SECONDS
        if client:
            self.client = client
        else:
            from opendraft.config import get_config
            config = get_config()
            self.client = genai.Client(
                api_key=config.google_api_key,
                http_options={
                    "timeout": GEMINI_HTTP_TIMEOUT_MS,
                    "retry_options": {
                        "attempts": GEMINI_HTTP_RETRY_ATTEMPTS,
                        "initial_delay": 0.5,
                        "max_delay": 5.0,
                        "exp_base": 2.0,
                        "jitter": 0.2,
                    },
                },
            )

        # Build tools list
        self._tools = None
        if tool_config.function_declarations:
            self._tools = [types.Tool(function_declarations=tool_config.function_declarations)]

        # Build config for chat
        self._config = types.GenerateContentConfig(
            system_instruction=system_prompt,
            tools=self._tools,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

    def get_cost(self) -> Dict[str, Any]:
        """Get cost breakdown for this agent run."""
        model_key = self.model_name if self.model_name in MODEL_COSTS else "default"
        costs = MODEL_COSTS[model_key]

        input_cost = (self.total_input_tokens / 1_000_000) * costs["input"]
        output_cost = (self.total_output_tokens / 1_000_000) * costs["output"]
        total_cost = input_cost + output_cost

        return {
            "agent": self.name,
            "model": self.model_name,
            "input_tokens": self.total_input_tokens,
            "output_tokens": self.total_output_tokens,
            "total_tokens": self.total_input_tokens + self.total_output_tokens,
            "api_calls": self.api_calls,
            "input_cost_usd": round(input_cost, 4),
            "output_cost_usd": round(output_cost, 4),
            "total_cost_usd": round(total_cost, 4),
        }

    def _track_usage(self, response) -> None:
        """Extract and track token usage from a Gemini response."""
        self.api_calls += 1
        try:
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                metadata = response.usage_metadata
                if hasattr(metadata, 'prompt_token_count'):
                    self.total_input_tokens += metadata.prompt_token_count or 0
                if hasattr(metadata, 'candidates_token_count'):
                    self.total_output_tokens += metadata.candidates_token_count or 0
        except Exception as e:
            logger.debug("Could not extract token usage: %s", e)

    def _send_message(self, chat, message):
        """Send a chat message with a hard timeout to prevent blocked reads."""
        queue: Queue[tuple[str, Any]] = Queue(maxsize=1)

        def _worker():
            try:
                queue.put(("ok", chat.send_message(message)))
            except Exception as exc:
                queue.put(("err", exc))

        worker = threading.Thread(
            target=_worker,
            daemon=True,
            name=f"{self.name}-send-message",
        )
        worker.start()
        worker.join(timeout=self.request_timeout_seconds)

        if worker.is_alive():
            raise TimeoutError(
                f"Agent {self.name} chat.send_message timed out after "
                f"{self.request_timeout_seconds:.1f}s"
            )

        try:
            status, payload = queue.get_nowait()
        except Empty as exc:
            raise RuntimeError(f"Agent {self.name} send_message returned no result") from exc

        if status == "err":
            raise payload
        return payload

    def run(self, task: str, context: str = "") -> AgentResult:
        """
        Run the agent on a task.

        Args:
            task: The task description/instructions
            context: Additional context from previous agents

        Returns:
            AgentResult with signal, output, and metadata
        """
        full_prompt = task
        if context:
            full_prompt = f"{context}\n\n---\n\nTASK:\n{task}"

        chat = self.client.chats.create(
            model=self.model_name,
            config=self._config,
        )
        all_text_parts = []

        for iteration in range(self.max_iterations):
            try:
                if iteration == 0:
                    response = self._send_message(chat, full_prompt)
                else:
                    response = self._send_message(chat, "Continue working on the task. When finished, end with SIGNAL: DONE")

                # V3: Track token usage
                self._track_usage(response)

                # Check for MALFORMED_FUNCTION_CALL finish reason
                if self._is_malformed_fc(response):
                    logger.warning("Agent %s got MALFORMED_FUNCTION_CALL, asking to retry with simpler calls", self.name)
                    response = self._send_message(chat, 
                        "Your last function call was malformed. Please try again with simpler, "
                        "shorter arguments. If writing a file, break the content into smaller "
                        "pieces or just provide the key content. End with SIGNAL: DONE when finished."
                    )
                    if self._is_malformed_fc(response):
                        logger.warning("Agent %s still malformed, skipping", self.name)
                        continue

                # Process response: handle function calls in a loop
                remaining = self.max_iterations - iteration
                response = self._handle_function_calls(chat, response, remaining_iterations=remaining)

                # Extract text from final response
                text = self._extract_text(response)
                if not text:
                    logger.warning("Agent %s iteration %s produced no text", self.name, iteration)
                    continue
                all_text_parts.append(text)

                # Check for signals
                signal, rerun_target, rerun_reason = self._parse_signal(text)

                if signal == SIGNAL_DONE:
                    cost = self.get_cost()
                    logger.info("Agent %s cost: $%.4f (%s tokens)", self.name, cost['total_cost_usd'], cost['total_tokens'])
                    return AgentResult(
                        agent_name=self.name,
                        signal=SIGNAL_DONE,
                        output="\n\n".join(all_text_parts),
                        metadata={"cost": cost},
                    )
                elif signal == SIGNAL_RERUN:
                    cost = self.get_cost()
                    return AgentResult(
                        agent_name=self.name,
                        signal=SIGNAL_RERUN,
                        output="\n\n".join(all_text_parts),
                        rerun_target=rerun_target,
                        rerun_reason=rerun_reason,
                        metadata={"cost": cost},
                    )
                elif signal == SIGNAL_ESCALATE:
                    cost = self.get_cost()
                    return AgentResult(
                        agent_name=self.name,
                        signal=SIGNAL_ESCALATE,
                        output="\n\n".join(all_text_parts),
                        rerun_reason=rerun_reason,
                        metadata={"cost": cost},
                    )

            except Exception as e:
                error_str = str(e)
                if "MALFORMED_FUNCTION_CALL" in error_str:
                    logger.warning("Agent %s iteration %s: MALFORMED_FUNCTION_CALL, retrying with hint", self.name, iteration)
                    try:
                        response = self._send_message(chat, 
                            "Your last function call was malformed and could not be processed. "
                            "Please try again. If you were trying to write a file with long content, "
                            "break it into smaller chunks. If you've already completed the main work, "
                            "just end with SIGNAL: DONE"
                        )
                        remaining = self.max_iterations - iteration
                        response = self._handle_function_calls(chat, response, remaining_iterations=remaining)
                        text = self._extract_text(response)
                        if text:
                            all_text_parts.append(text)
                        signal, rerun_target, rerun_reason = self._parse_signal(text)
                        if signal == SIGNAL_DONE:
                            return AgentResult(
                                agent_name=self.name, signal=SIGNAL_DONE,
                                output="\n\n".join(all_text_parts),
                                metadata={"cost": self.get_cost()},
                            )
                        elif signal == SIGNAL_RERUN:
                            return AgentResult(
                                agent_name=self.name, signal=SIGNAL_RERUN,
                                output="\n\n".join(all_text_parts),
                                rerun_target=rerun_target, rerun_reason=rerun_reason,
                                metadata={"cost": self.get_cost()},
                            )
                    except Exception as retry_err:
                        logger.error("Agent %s retry also failed: %s", self.name, retry_err)
                    continue
                else:
                    # V3.2: Use RetryConfig and CircuitBreaker for transient errors
                    error_class = classify_error(e)
                    circuit_breaker = get_circuit_breaker()

                    if issubclass(error_class, TransientError):
                        # Check circuit breaker first
                        if not circuit_breaker.allow_request():
                            wait_time = circuit_breaker.time_until_retry() or 60
                            logger.warning(
                                "Agent %s circuit breaker OPEN, waiting %.1fs",
                                self.name, wait_time
                            )
                            time.sleep(min(wait_time, 60))

                        # Record failure and retry with exponential backoff
                        circuit_breaker.record_failure()
                        retried = False
                        retry_config = DEFAULT_RETRY_CONFIG

                        for retry_num in range(retry_config.max_attempts):
                            delay = calculate_backoff_delay(retry_num, retry_config)
                            logger.warning(
                                "Agent %s transient error (attempt %s/%s): %s. Retrying in %.1fs...",
                                self.name, retry_num + 1, retry_config.max_attempts, error_str[:200], delay
                            )
                            time.sleep(delay)
                            try:
                                if iteration == 0:
                                    response = self._send_message(chat, full_prompt)
                                else:
                                    response = self._send_message(chat, 
                                        "Continue working on the task. When finished, end with SIGNAL: DONE"
                                    )
                                remaining = self.max_iterations - iteration
                                response = self._handle_function_calls(
                                    chat, response, remaining_iterations=remaining
                                )
                                text = self._extract_text(response)
                                if text:
                                    all_text_parts.append(text)
                                signal, rerun_target, rerun_reason = self._parse_signal(text)
                                # Record success for circuit breaker
                                circuit_breaker.record_success()
                                if signal == SIGNAL_DONE:
                                    return AgentResult(
                                        agent_name=self.name, signal=SIGNAL_DONE,
                                        output="\n\n".join(all_text_parts),
                                        metadata={"cost": self.get_cost()},
                                    )
                                elif signal == SIGNAL_RERUN:
                                    return AgentResult(
                                        agent_name=self.name, signal=SIGNAL_RERUN,
                                        output="\n\n".join(all_text_parts),
                                        rerun_target=rerun_target, rerun_reason=rerun_reason,
                                        metadata={"cost": self.get_cost()},
                                    )
                                retried = True
                                break  # Retry succeeded, continue main loop
                            except Exception as retry_err:
                                circuit_breaker.record_failure()
                                logger.warning("Agent %s retry %s failed: %s", self.name, retry_num + 1, retry_err)
                                continue
                        if not retried:
                            logger.error("Agent %s exhausted retries for transient error", self.name)
                            all_text_parts.append(f"[Error in iteration {iteration}: {e}]")
                    else:
                        # Permanent error - don't retry
                        logger.error("Agent %s iteration %s permanent error: %s", self.name, iteration, e)
                        all_text_parts.append(f"[Error in iteration {iteration}: {e}]")
                # Continue to next iteration

        # Max iterations reached — treat as DONE
        logger.warning("Agent %s reached max iterations (%s)", self.name, self.max_iterations)
        cost = self.get_cost()
        logger.info("Agent %s cost: $%.4f (%s tokens)", self.name, cost['total_cost_usd'], cost['total_tokens'])
        return AgentResult(
            agent_name=self.name,
            signal=SIGNAL_DONE,
            output="\n\n".join(all_text_parts),
            metadata={"max_iterations_reached": True, "cost": cost},
        )

    def _handle_function_calls(self, chat, response, remaining_iterations: int = 10) -> Any:
        """Handle function calls in a loop until Gemini produces a final text response."""
        max_fc_rounds = min(20, max(3, remaining_iterations * 3))

        for _ in range(max_fc_rounds):
            function_calls = self._extract_function_calls(response)
            if not function_calls:
                return response

            # Execute function calls and collect results
            fc_responses = []
            for fc in function_calls:
                fn_name = fc.name
                fn_args = fc.args if fc.args else {}

                logger.info("Agent %s calling: %s(%s)", self.name, fn_name, json.dumps(fn_args, default=str)[:200])

                if fn_name in self.function_handlers:
                    try:
                        handler = self.function_handlers[fn_name]
                        # Filter args to only include parameters the function accepts
                        sig = inspect.signature(handler)
                        valid_params = set(sig.parameters.keys())
                        # Filter out unexpected kwargs (Gemini sometimes hallucinates params)
                        filtered_args = {k: v for k, v in fn_args.items() if k in valid_params}
                        if len(filtered_args) < len(fn_args):
                            ignored = set(fn_args.keys()) - valid_params
                            logger.debug("Function %s: ignoring unexpected args %s", fn_name, ignored)
                        result = handler(**filtered_args)
                        # Serialize result for Gemini
                        if isinstance(result, (dict, list)):
                            result_str = json.dumps(result, ensure_ascii=False, default=str)
                        else:
                            result_str = str(result)
                    except Exception as e:
                        logger.error("Function %s error: %s", fn_name, e)
                        result_str = json.dumps({"error": str(e)})
                else:
                    result_str = json.dumps({"error": f"Unknown function: {fn_name}"})

                fc_responses.append(
                    types.Part.from_function_response(
                        name=fn_name,
                        response={"result": result_str},
                    )
                )

                # compile_draft / finalize_draft are terminal — return early but let agent continue
                # The agent should output SIGNAL: DONE after compile_draft
                if fn_name in ("compile_draft", "finalize_draft"):
                    logger.info("Agent %s: terminal function %s called.", self.name, fn_name)
                    # Don't return None - let the agent see the result and decide whether to continue

            # Send function results back to Gemini
            response = self._send_message(chat, fc_responses)
            self._track_usage(response)  # V3: Track usage from function call responses

        return response

    def _is_malformed_fc(self, response) -> bool:
        """Check if Gemini returned a MALFORMED_FUNCTION_CALL finish reason."""
        try:
            if not response.candidates:
                return True
            candidate = response.candidates[0]
            fr = getattr(candidate, 'finish_reason', None)
            if fr is not None and str(fr) == 'MALFORMED_FUNCTION_CALL':
                return True
            # Also check the enum value
            if fr == types.FinishReason.MALFORMED_FUNCTION_CALL:
                return True
            # Empty content with no text and no function calls
            if not candidate.content or not candidate.content.parts:
                return True
        except (AttributeError, IndexError):
            return True
        return False

    def _extract_function_calls(self, response) -> list:
        """Extract function calls from a Gemini response."""
        # Use the convenience property if available
        if response.function_calls:
            return response.function_calls
        return []

    def _extract_text(self, response) -> str:
        """Extract text content from a Gemini response."""
        # Use the convenience property
        if response.text:
            return response.text
        # Fallback: iterate parts
        if not response.candidates:
            return ""
        texts = []
        for part in (response.parts or []):
            if hasattr(part, 'text') and part.text:
                texts.append(part.text)
        return "\n".join(texts)

    def _parse_signal(self, text: str) -> tuple:
        """
        Parse SIGNAL keywords from agent output.

        Anchored to line boundaries to avoid matching mid-paragraph text.

        Expected formats:
        - SIGNAL: DONE
        - SIGNAL: RERUN researcher "need more papers on X"
        - SIGNAL: ESCALATE "can't find papers on this subtopic"
        """
        if not text:
            return None, None, None

        # Match SIGNAL: DONE (anchored to line start/end)
        if re.search(r'^\s*SIGNAL:\s*DONE\s*$', text, re.IGNORECASE | re.MULTILINE):
            return SIGNAL_DONE, None, None

        # Match SIGNAL: RERUN <agent> "reason"
        rerun_match = re.search(
            r'^\s*SIGNAL:\s*RERUN\s+(\w+)\s*["\']([^"\']+)["\']\s*$',
            text, re.IGNORECASE | re.MULTILINE
        )
        if rerun_match:
            return SIGNAL_RERUN, rerun_match.group(1), rerun_match.group(2)

        # Match SIGNAL: ESCALATE "reason"
        escalate_match = re.search(
            r'^\s*SIGNAL:\s*ESCALATE\s*["\']([^"\']+)["\']\s*$',
            text, re.IGNORECASE | re.MULTILINE
        )
        if escalate_match:
            return SIGNAL_ESCALATE, None, escalate_match.group(1)

        return None, None, None

    @classmethod
    def load_prompt(cls, prompt_name: str) -> str:
        """Load a system prompt from the prompts/ directory."""
        prompt_dir = Path(__file__).parent.parent / "prompts"
        prompt_file = prompt_dir / f"{prompt_name}.md"
        if prompt_file.exists():
            return prompt_file.read_text(encoding='utf-8')
        raise FileNotFoundError(f"Prompt not found: {prompt_file}")
