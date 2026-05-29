# CANONICAL run.py CONTRACT — script-mode (exec.entry: "run.py") workers.
#
# This is the SINGLE SOURCE OF TRUTH for the E2B pure-script contract every
# generated script-mode worker must follow. worker-author injects this file
# verbatim into the generation prompt; SKILL.md references it; do not fork it.
#
# How a script-mode worker actually runs (E2B pure-script driver):
#   1. The harness writes `inputs.json` into the working directory.
#      - For a SCALAR input (type: string | textarea | number | boolean |
#        select | url) the value in inputs.json is the LITERAL value inline.
#        Use it directly. NEVER open() a scalar.
#      - For a FILE input (kind: "file") the value is ALREADY the full RELATIVE
#        PATH like "inputs/<input_name>". open() that value DIRECTLY. Do NOT
#        prepend "inputs/" again and do NOT os.path.join("inputs", value) — the
#        value is the path, not a bare filename (that double-prepend is a top crash).
#   2. Secrets are available in os.environ (the harness sets them) and ALSO in a
#      `secrets.json` file. Read os.environ first, fall back to secrets.json.
#      Connections (Composio) are in `connections.json` when present.
#   3. The worker writes its output file(s) under `out/` (mkdir it).
#   4. The worker writes `result.json` IN THE WORKING DIRECTORY (NOT under out/),
#      with the EXACT schema below, on BOTH the success and the error path, then
#      exits 0.
#   5. The module ends with `if __name__ == "__main__": main()`.
#
# result.json schema (written to ./result.json on success AND error):
#   {
#     "status": "success" | "error",
#     "outputs": {"<declared_output_name>": "out/<file>"},   # path under out/
#     "artifacts": [
#       {"name": "out/<file>", "relative_path": "out/<file>", "type": "<media_type>"}
#     ],
#     "error": "<message when status == 'error', else null>"
#   }
#
# HARD RULES (these are the exact mistakes that crash generated workers):
#   - Use ONLY the Python standard library unless you also list the package in
#     requirements.txt. Do NOT `import dotenv` / `from dotenv import ...` — it is
#     NOT preinstalled. Read secrets from os.environ + secrets.json (shown below).
#   - import EVERY module you reference (os, json, csv, io, re, statistics, ...).
#     A missing `import os` is a top generated-worker crash.
#   - Write result.json to "result.json" (the working dir), NEVER "out/result.json".
#   - one declared output -> one out/ file -> one outputs entry + one artifact.
#   - never open() a scalar input value; never hardcode a secret.
#   - always write result.json, even when you bail out early on bad input.
#
# Copy this skeleton and fill in `main()`. Keep it the smallest thing that works.

import json
import os
from pathlib import Path


def _load_secrets():
    """Secrets from os.environ, with a secrets.json fallback. No third-party deps."""
    try:
        with open("secrets.json") as fh:
            file_secrets = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        file_secrets = {}

    def get(name, default=None):
        return os.environ.get(name) or file_secrets.get(name) or default

    return get


def _write_result(status, outputs=None, artifacts=None, error=None):
    # result.json lives in the WORKING DIRECTORY, not out/.
    Path("result.json").write_text(
        json.dumps(
            {
                "status": status,
                "outputs": outputs or {},
                "artifacts": artifacts or [],
                "error": error,
            }
        ),
        encoding="utf-8",
    )


def main():
    # 1) Read inputs.json (always present).
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))

    # 2a) SCALAR input -> use the literal value directly (do NOT open it).
    #     some_text = (inputs.get("text") or "").strip()
    #
    # 2b) FILE input -> the value IS the relative path (e.g. "inputs/csv_file").
    #     open() it directly; never os.path.join("inputs", value).
    #     csv_path = inputs["csv_file"]            # already "inputs/csv_file"
    #     with open(csv_path, "r", encoding="utf-8", errors="replace") as fh:
    #         raw = fh.read()
    #
    # 2c) Secret (declared in exec.secrets) -> via the helper (no dotenv needed).
    #     secret = _load_secrets()
    #     api_key = secret("OPENAI_API_KEY")

    # Validate required inputs; bail out with a result.json on the error path.
    # if not some_text:
    #     _write_result("error", error="Missing required input: text")
    #     return

    # 3) Do the work, then write output file(s) under out/.
    os.makedirs("out", exist_ok=True)
    out_path = "out/result.txt"
    Path(out_path).write_text("replace with the real output", encoding="utf-8")

    # 4) Write result.json (working dir) mapping each output name to its out/ path.
    _write_result(
        "success",
        outputs={"result": out_path},
        artifacts=[{"name": out_path, "relative_path": out_path, "type": "text/plain"}],
    )


if __name__ == "__main__":
    main()
