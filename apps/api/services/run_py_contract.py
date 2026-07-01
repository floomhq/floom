"""Canonical script-mode run.py contract for generated Floom workers."""

RUN_PY_CONTRACT = """=== CANONICAL RUN.PY CONTRACT (script mode) ===
When emitting or repairing run.py, follow this contract exactly:
- Read inputs from inputs.json in the working directory, using UTF-8.
- A scalar input value is already the literal value. Use it directly and never open() it.
- A file input value is already the relative path, for example inputs/csv_file. Open it directly and never prepend inputs/ again.
- Use only the Python standard library unless requirements.txt lists the package.
- Never import dotenv. Read secrets from os.environ, with secrets.json fallback only when needed.
- Import every module referenced by the script.
- Scalar outputs must be literal values in result.json outputs, never file paths.
- File outputs must be written under out/, referenced by relative path in outputs, and listed in artifacts.
- Implement every declared output, not only the first requested result.
- Write result.json to the working directory on both success and error.
- Never write outputs.json or output.json.
- result.json schema is {"status":"success"|"error","outputs":{...},"artifacts":[...],"error":<message-or-null>}.
- End with if __name__ == "__main__": main().
"""

