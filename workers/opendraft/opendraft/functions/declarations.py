"""Auto-generated FunctionDeclaration schemas for Gemini function calling.

Instead of 1800+ lines of hand-written declarations, this module generates
FunctionDeclaration objects from Python function signatures + override metadata.

Usage in agents:
    from opendraft.functions.declarations import get_tools_for_handlers
    declarations = get_tools_for_handlers(function_handlers)
"""

from typing import Any, Dict

from opendraft.functions.tool_decorator import declaration_from_func, declarations_from_handlers
from opendraft.functions.tool_overrides import TOOL_OVERRIDES


def get_tools_for_handlers(handlers: Dict[str, Any]) -> list:
    """Generate FunctionDeclaration list from a function_handlers dict.

    This is the primary API. Each agent passes its function_handlers dict
    and gets back a list of FunctionDeclaration objects.

    Args:
        handlers: Dict mapping tool names to Python callables.

    Returns:
        List of FunctionDeclaration objects for Gemini.
    """
    return declarations_from_handlers(handlers, overrides=TOOL_OVERRIDES)
