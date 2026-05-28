"""Code execution via local sandbox for Gemini function calling."""

from opendraft.sandbox.executor import LocalSandbox


class CodeExecOps:
    """Code execution operations using the local sandbox."""

    def __init__(self):
        self.sandbox = LocalSandbox()

    def run_code(self, code: str) -> str:
        """Execute Python code in a restricted sandbox. Returns output."""
        result = self.sandbox.execute(code)
        output_parts = []
        if result['output']:
            output_parts.append(result['output'])
        if result['error']:
            output_parts.append(f"Error: {result['error']}")
        return "\n".join(output_parts) if output_parts else "(no output)"
