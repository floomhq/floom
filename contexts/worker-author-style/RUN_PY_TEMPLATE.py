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
#      - For a FILE input (kind: "file") the value is a RELATIVE PATH like
#        "inputs/<input_name>". open() THAT path to read the uploaded bytes.
#   2. Secrets are in os.environ (the harness writes `.env.local`; call
#      load_dotenv(".env.local")). A `secrets.json` file is a fallback.
#      Connections (Composio) are in `connections.json` when present.
#   3. The worker writes its output file(s) under `out/` (mkdir it).
#   4. The worker writes `result.json` with the EXACT schema below on BOTH the
#      success and the error path, then exits 0.
#   5. The module ends with `if __name__ == "__main__": main()`.
#
# result.json schema (write it on success AND error):
#   {
#     "status": "success" | "error",
#     "outputs": {"<declared_output_name>": "out/<file>"},   # path under out/
#     "artifacts": [
#       {"name": "out/<file>", "relative_path": "out/<file>", "type": "<media_type>"}
#     ],
#     "error": "<message when status == 'error', else omit/null>"
#   }
#
# HARD RULES:
#   - import EVERY module you reference (os, json, csv, io, re, statistics, ...).
#     A missing `import os` is the #1 generated-worker crash.
#   - one declared output -> one out/ file -> one outputs entry + one artifact.
#   - never open() a scalar input value; never hardcode a secret.
#   - always write result.json, even when you bail out early on bad input.
#
# Copy this skeleton and fill in `main()`. Keep it the smallest thing that works.

import json
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; secrets.json fallback covers it


def _write_result(status, outputs=None, artifacts=None, error=None):
    payload = {"status": status, "outputs": outputs or {}, "artifacts": artifacts or []}
    if error:
        payload["error"] = error
    Path("result.json").write_text(json.dumps(payload), encoding="utf-8")


def main():
    # 1) Read inputs.json (always present).
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))

    # 2a) SCALAR input -> use the literal value directly (do NOT open it).
    #     some_text = (inputs.get("text") or "").strip()
    #
    # 2b) FILE input  -> the value is a relative path under inputs/; open it.
    #     csv_path = inputs.get("csv_file")
    #     with open(csv_path, "r", encoding="utf-8", errors="replace") as fh:
    #         raw = fh.read()
    #
    # 2c) Secret (declared in exec.secrets) -> os.environ.
    #     api_key = os.environ.get("OPENAI_API_KEY")

    # Validate required inputs; bail out with a result.json on the error path.
    # if not some_text:
    #     _write_result("error", error="Missing required input: text")
    #     return

    # 3) Do the work, then write output file(s) under out/.
    os.makedirs("out", exist_ok=True)
    out_path = "out/result.txt"
    Path(out_path).write_text("replace with the real output", encoding="utf-8")

    # 4) Write result.json mapping each declared output name to its out/ path.
    _write_result(
        "success",
        outputs={"result": out_path},
        artifacts=[{"name": out_path, "relative_path": out_path, "type": "text/plain"}],
    )


if __name__ == "__main__":
    main()
