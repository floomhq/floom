"""Auto-generate Gemini FunctionDeclaration from Python function signatures.

Usage:
    @tool("Search Semantic Scholar for academic papers.")
    def search_semantic_scholar(query: str, max_results: int = 5) -> ...:
        ...

    decl = declaration_from_func(search_semantic_scholar)
    # FunctionDeclaration(name="search_semantic_scholar", description="...", parameters_json_schema={...})

For complex nested schemas, use schema_override on specific params:
    @tool("Ingest regression results.", schema_override={
        "predictors": {
            "type": "array",
            "items": {"type": "object", "properties": {"name": {...}, "coef": {...}}},
        },
    })
"""

import inspect
from typing import Any, Dict, List, Optional, get_type_hints

from google.genai import types

FunctionDeclaration = types.FunctionDeclaration

# Sentinel for "no default"
_MISSING = object()

# Type mapping: Python type annotation -> JSON Schema type
_TYPE_MAP: Dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}


def tool(
    description: str,
    *,
    schema_override: Optional[Dict[str, Any]] = None,
    param_descriptions: Optional[Dict[str, str]] = None,
    param_enums: Optional[Dict[str, list]] = None,
):
    """Decorator to mark a function as a Gemini tool.

    Args:
        description: Tool description shown to Gemini.
        schema_override: Override JSON schema for specific params (for complex nested types).
        param_descriptions: Per-param description overrides. Falls back to docstring parsing.
        param_enums: Per-param enum value lists.
    """
    def decorator(func):
        func._tool_description = description
        func._tool_schema_override = schema_override or {}
        func._tool_param_descriptions = param_descriptions or {}
        func._tool_param_enums = param_enums or {}
        return func
    return decorator


def _python_type_to_json_schema(annotation, param_name: str = "") -> Dict[str, Any]:
    """Convert a Python type annotation to JSON Schema.

    Handles: str, int, float, bool, List[str], List[int], List[float],
    Dict[str, Any], Optional[T].
    """
    if annotation is inspect.Parameter.empty or annotation is None:
        return {"type": "string"}

    # Handle Optional[T] -> T (with nullable)
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", ())

    # typing.Optional[X] is Union[X, None]
    if origin is type(None):
        return {"type": "string"}

    # Check for Optional (Union with None)
    import typing
    if origin is typing.Union and type(None) in args:
        # Get the non-None type
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _python_type_to_json_schema(non_none[0], param_name)
        return {"type": "string"}

    # List[X]
    if origin is list:
        if args:
            item_schema = _python_type_to_json_schema(args[0], param_name)
            return {"type": "array", "items": item_schema}
        return {"type": "array", "items": {"type": "string"}}

    # Dict[str, X]
    if origin is dict:
        return {"type": "object"}

    # Simple types
    if annotation in _TYPE_MAP:
        return {"type": _TYPE_MAP[annotation]}

    # Fallback
    return {"type": "string"}


def declaration_from_func(
    func,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    schema_override: Optional[Dict[str, Any]] = None,
    param_descriptions: Optional[Dict[str, str]] = None,
    param_enums: Optional[Dict[str, list]] = None,
) -> FunctionDeclaration:
    """Generate a FunctionDeclaration from a Python function.

    Reads the function signature, type annotations, and @tool decorator metadata
    to produce a Gemini-compatible FunctionDeclaration.

    Args:
        func: The Python function to generate a declaration for.
        name: Override the function name (default: func.__name__).
        description: Override the description (default: from @tool decorator or docstring).
        schema_override: Override JSON schema for specific params.
        param_descriptions: Per-param description overrides.
        param_enums: Per-param enum lists.

    Returns:
        FunctionDeclaration ready for Gemini API.
    """
    # Get metadata from decorator if present
    tool_desc = getattr(func, "_tool_description", None)
    tool_override = getattr(func, "_tool_schema_override", {})
    tool_param_desc = getattr(func, "_tool_param_descriptions", {})
    tool_param_enums = getattr(func, "_tool_param_enums", {})

    # Merge: explicit args > decorator attrs > defaults
    fn_name = name or func.__name__
    fn_desc = description or tool_desc or (func.__doc__ or "").strip().split("\n")[0] or fn_name
    overrides = {**tool_override, **(schema_override or {})}
    p_descs = {**tool_param_desc, **(param_descriptions or {})}
    p_enums = {**tool_param_enums, **(param_enums or {})}

    # Introspect signature
    sig = inspect.signature(func)
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    properties = {}
    required = []

    for pname, param in sig.parameters.items():
        # Skip 'self'
        if pname == "self":
            continue

        # If there's a full schema override for this param, use it directly
        if pname in overrides:
            prop = dict(overrides[pname])
            if pname in p_descs and "description" not in prop:
                prop["description"] = p_descs[pname]
            properties[pname] = prop
        else:
            # Generate from type annotation
            annotation = hints.get(pname, param.annotation)
            prop = _python_type_to_json_schema(annotation, pname)

            # Add description
            if pname in p_descs:
                prop["description"] = p_descs[pname]

            # Add enum
            if pname in p_enums:
                prop["enum"] = p_enums[pname]

            properties[pname] = prop

        # Determine required: params without defaults are required
        if param.default is inspect.Parameter.empty:
            required.append(pname)

    schema = {
        "type": "object",
        "properties": properties,
    }
    if required:
        schema["required"] = required

    return FunctionDeclaration(
        name=fn_name,
        description=fn_desc,
        parameters_json_schema=schema,
    )


def declarations_from_handlers(
    handlers: Dict[str, Any],
    overrides: Optional[Dict[str, Dict[str, Any]]] = None,
) -> list:
    """Generate FunctionDeclaration list from a function_handlers dict.

    Args:
        handlers: Dict mapping tool names to Python callables.
        overrides: Per-tool override dicts with keys: description, schema_override,
                   param_descriptions, param_enums.

    Returns:
        List of FunctionDeclaration objects.
    """
    overrides = overrides or {}
    declarations = []

    for tool_name, func in handlers.items():
        override = overrides.get(tool_name, {})
        decl = declaration_from_func(
            func,
            name=tool_name,
            description=override.get("description"),
            schema_override=override.get("schema_override"),
            param_descriptions=override.get("param_descriptions"),
            param_enums=override.get("param_enums"),
        )
        declarations.append(decl)

    return declarations
