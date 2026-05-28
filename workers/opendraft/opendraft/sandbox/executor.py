"""Fallback local sandbox for code execution.

Only used if Gemini's native code_execution + function_calling can't coexist
in the same request. In that case, we run code locally with restricted globals.
"""

import ast
import io
import sys
import logging
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Safe builtins whitelist
SAFE_BUILTINS = {
    'abs', 'all', 'any', 'bool', 'chr', 'dict', 'dir', 'divmod',
    'enumerate', 'filter', 'float', 'format', 'frozenset',
    'hasattr', 'hash', 'hex', 'int', 'isinstance', 'issubclass', 'iter',
    'len', 'list', 'map', 'max', 'min', 'next', 'oct', 'ord', 'pow',
    'print', 'range', 'repr', 'reversed', 'round', 'set', 'slice',
    'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
}

# Safe modules that can be imported
SAFE_MODULES = {'math', 'json', 're', 'collections', 'itertools', 'functools', 'datetime', 'statistics'}

# Forbidden attribute names (prevent sandbox escape)
FORBIDDEN_ATTRS = {
    '__globals__', '__code__', '__closure__', '__self__',
    '__dict__', '__class__', '__subclasses__', '__bases__',
    '__mro__', '__init_subclass__', '__set_name__',
    '__reduce__', '__reduce_ex__', '__getstate__', '__setstate__',
    'gi_frame', 'gi_code', 'f_globals', 'f_locals', 'f_builtins',
    'co_consts', 'func_globals', 'func_code',
}

# Forbidden AST node types
FORBIDDEN_NODES = {
    ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith, ast.Await,
}

# Max output size (characters)
MAX_OUTPUT_SIZE = 50_000


class SandboxSecurityError(Exception):
    """Raised when sandbox security policy is violated."""
    pass


class SandboxTimeoutError(Exception):
    """Raised when sandbox execution exceeds timeout."""
    pass


class _ASTValidator(ast.NodeVisitor):
    """Walk AST to detect potentially dangerous patterns."""

    def visit_Attribute(self, node):
        if isinstance(node.attr, str) and node.attr in FORBIDDEN_ATTRS:
            raise SandboxSecurityError(
                f"Access to '{node.attr}' is not allowed in sandbox"
            )
        self.generic_visit(node)

    def visit_Name(self, node):
        forbidden_names = {'exec', 'eval', 'compile', 'open', 'input',
                          '__import__', 'globals', 'locals', 'vars',
                          'breakpoint', 'exit', 'quit', 'help',
                          'getattr', 'setattr', 'delattr'}
        if node.id in forbidden_names:
            raise SandboxSecurityError(
                f"Use of '{node.id}' is not allowed in sandbox"
            )
        self.generic_visit(node)

    def generic_visit(self, node):
        if type(node) in FORBIDDEN_NODES:
            raise SandboxSecurityError(
                f"'{type(node).__name__}' is not allowed in sandbox"
            )
        super().generic_visit(node)


def _validate_code(code: str) -> ast.Module:
    """Parse and validate code against security policy. Returns AST if safe."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise SandboxSecurityError(f"Syntax error: {e}")

    validator = _ASTValidator()
    validator.visit(tree)
    return tree


class LocalSandbox:
    """
    Restricted Python execution sandbox.

    Provides safe code execution with:
    - AST validation (blocks dangerous patterns)
    - Whitelisted builtins (no eval/exec/open/getattr)
    - Whitelisted imports only
    - Output capture with size limit
    - Timeout enforcement via threading
    """

    def __init__(self, tools: Optional[Dict[str, Any]] = None):
        """
        Args:
            tools: Dict of function_name -> callable to inject into the sandbox namespace.
        """
        self.tools = tools or {}

    def execute(self, code: str, timeout: float = 30.0) -> Dict[str, Any]:
        """
        Execute Python code in a restricted environment.

        Args:
            code: Python code to execute
            timeout: Maximum execution time in seconds

        Returns:
            Dict with 'output' (stdout), 'error' (stderr/exception), 'result' (last expression)
        """
        result = {
            'output': '',
            'error': None,
            'result': None,
        }

        # Step 1: Validate AST
        try:
            _validate_code(code)
        except SandboxSecurityError as e:
            result['error'] = f"SecurityError: {e}"
            return result

        # Step 2: Build restricted globals
        builtins_dict = __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)
        safe_builtins = {k: builtins_dict[k] for k in SAFE_BUILTINS if k in builtins_dict}

        # Add safe __import__
        original_import = builtins_dict.get('__import__', __import__)

        def safe_import(name, *args, **kwargs):
            if name not in SAFE_MODULES:
                raise ImportError(f"Import of '{name}' is not allowed in sandbox")
            return original_import(name, *args, **kwargs)

        safe_builtins['__import__'] = safe_import

        restricted_globals = {
            '__builtins__': safe_builtins,
            '__name__': '__sandbox__',
        }

        # Inject tools
        for name, func in self.tools.items():
            restricted_globals[name] = func

        # Step 3: Execute with timeout
        captured_output = io.StringIO()
        old_stdout = sys.stdout
        exec_error = [None]

        def _run():
            try:
                sys.stdout = captured_output
                exec(code, restricted_globals)
            except Exception as e:
                exec_error[0] = f"{type(e).__name__}: {e}"
            finally:
                sys.stdout = old_stdout

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            # Thread didn't finish in time — can't kill it cleanly in Python,
            # but we return the timeout error and the thread will eventually die
            # as a daemon when the process exits
            result['error'] = f"TimeoutError: Code execution exceeded {timeout}s limit"
            result['output'] = captured_output.getvalue()[:MAX_OUTPUT_SIZE]
            return result

        output = captured_output.getvalue()
        if len(output) > MAX_OUTPUT_SIZE:
            output = output[:MAX_OUTPUT_SIZE] + f"\n... (truncated at {MAX_OUTPUT_SIZE} chars)"

        result['output'] = output
        if exec_error[0]:
            result['error'] = exec_error[0]

        return result
