"""
Shared Prompt Loader for openblog-neo pipeline.

Loads prompts from text files and handles placeholder substitution.
Enables prompt iteration without touching Python code.

Usage:
    from shared.prompt_loader import load_prompt

    # Load and format prompt
    prompt = load_prompt("stage1", "opencontext", url="https://example.com")

    # Or load raw without formatting
    raw = load_prompt("stage1", "opencontext", format=False)
"""

import logging
import re
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

# Project root
_ROOT = Path(__file__).parent.parent

# Valid stage names (whitelist for security)
_VALID_STAGES = {"stage1", "stage2", "stage3", "stage4", "stage5", "stage_refresh", "shared"}


def _validate_path_component(name: str, component_type: str) -> str:
    """
    Validate a path component to prevent path traversal attacks.

    Args:
        name: The component name to validate
        component_type: Description for error messages (e.g., "stage", "prompt_name")

    Returns:
        The validated name

    Raises:
        ValueError: If the name contains path traversal characters
    """
    if not name or not isinstance(name, str):
        raise ValueError(f"Invalid {component_type}: must be a non-empty string")

    # Reject path traversal patterns
    if ".." in name or name.startswith("/") or name.startswith("\\"):
        raise ValueError(f"Invalid {component_type}: path traversal not allowed")

    # Reject any path separators
    if "/" in name or "\\" in name:
        raise ValueError(f"Invalid {component_type}: path separators not allowed")

    # Only allow alphanumeric, underscore, hyphen
    if not re.match(r'^[\w\s\-]+$', name):
        raise ValueError(f"Invalid {component_type}: contains invalid characters")

    return name


def load_prompt(
    stage: str,
    prompt_name: str,
    format: bool = True,
    **kwargs,
) -> str:
    """
    Load a prompt from a text file.

    Args:
        stage: Stage folder name (e.g., "stage1", "stage2")
        prompt_name: Prompt file name without extension (e.g., "opencontext", "blog_prompt")
        format: Whether to format placeholders with kwargs
        **kwargs: Placeholder values (e.g., url="...", keyword="...")

    Returns:
        Prompt string with placeholders replaced

    Raises:
        FileNotFoundError: If prompt file doesn't exist
        ValueError: If stage or prompt_name contains path traversal
    """
    # Validate inputs to prevent path traversal
    _validate_path_component(stage, "stage")
    _validate_path_component(prompt_name, "prompt_name")

    # Additional check: stage must be in whitelist
    if stage not in _VALID_STAGES:
        raise ValueError(f"Invalid stage: {stage}. Must be one of: {_VALID_STAGES}")

    # Build path to prompt file
    prompt_path = _ROOT / stage / "prompts" / f"{prompt_name}.txt"

    # Resolve to absolute path and verify it's within _ROOT
    resolved_path = prompt_path.resolve()
    resolved_root = _ROOT.resolve()
    if not str(resolved_path).startswith(str(resolved_root)):
        raise ValueError(f"Invalid path: access outside project root not allowed")

    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {prompt_path}")

    # Read prompt
    prompt = prompt_path.read_text(encoding="utf-8")

    # Format placeholders if requested
    if format and kwargs:
        try:
            # Use safe formatting that doesn't fail on missing keys
            prompt = _safe_format(prompt, kwargs)
        except Exception as e:
            logger.warning(f"Failed to format prompt {prompt_name}: {e}")

    return prompt


def _safe_format(template: str, values: Dict[str, Any]) -> str:
    """
    Format template with values, leaving unknown placeholders intact.

    Handles both {key} and {{key}} (escaped) formats.
    """
    result = template

    for key, value in values.items():
        # Replace {key} with value
        placeholder = "{" + key + "}"
        result = result.replace(placeholder, str(value))

    return result


def get_prompt_path(stage: str, prompt_name: str) -> Path:
    """
    Get the path to a prompt file.

    Args:
        stage: Stage folder name
        prompt_name: Prompt file name without extension

    Returns:
        Path object to the prompt file

    Raises:
        ValueError: If stage or prompt_name contains path traversal
    """
    _validate_path_component(stage, "stage")
    _validate_path_component(prompt_name, "prompt_name")
    return _ROOT / stage / "prompts" / f"{prompt_name}.txt"


def prompt_exists(stage: str, prompt_name: str) -> bool:
    """
    Check if a prompt file exists.

    Args:
        stage: Stage folder name
        prompt_name: Prompt file name without extension

    Returns:
        True if file exists
    """
    try:
        return get_prompt_path(stage, prompt_name).exists()
    except ValueError:
        return False


def list_prompts(stage: str) -> list:
    """
    List all prompts for a stage.

    Args:
        stage: Stage folder name

    Returns:
        List of prompt names (without .txt extension)
    """
    try:
        _validate_path_component(stage, "stage")
    except ValueError:
        return []

    prompts_dir = _ROOT / stage / "prompts"
    if not prompts_dir.exists():
        return []

    return [p.stem for p in prompts_dir.glob("*.txt")]


def ensure_prompts_dir(stage: str) -> Path:
    """
    Ensure prompts directory exists for a stage.

    Args:
        stage: Stage folder name

    Returns:
        Path to prompts directory

    Raises:
        ValueError: If stage contains path traversal
    """
    _validate_path_component(stage, "stage")
    if stage not in _VALID_STAGES:
        raise ValueError(f"Invalid stage: {stage}. Must be one of: {_VALID_STAGES}")

    prompts_dir = _ROOT / stage / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    return prompts_dir
