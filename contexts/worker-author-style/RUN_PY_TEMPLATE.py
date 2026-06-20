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
#      Connections (Composio) are in `connections.json` when present. Call
#      Composio through the Floom proxy, never by shelling out to the CLI.
#   3. The worker writes its output file(s) under `out/` (mkdir it).
#   4. The worker writes `result.json` IN THE WORKING DIRECTORY (NOT under out/),
#      with the EXACT schema below, on BOTH the success and the error path, then
#      exits 0.
#   5. The module ends with `if __name__ == "__main__": main()`.
#
# result.json schema (written to ./result.json on success AND error):
#   {
#     "status": "success" | "error",
#     "outputs": {"<declared_output_name>": <value>},
#     "artifacts": [
#       {"name": "out/<file>", "relative_path": "out/<file>", "type": "<media_type>"}
#     ],
#     "error": "<message when status == 'error', else null>"
#   }
#
# OUTPUT CONTRACT — scalar vs file (the EXACT INVERSE of the input contract; a
# top generated-worker failure is writing a PATH into a SCALAR output):
#   - SCALAR output (worker.yml output has kind: "scalar", NO `path:`):
#       outputs[<name>] MUST be the LITERAL VALUE — a string or number — NEVER a
#       path. A scalar output needs NO out/ file and NO artifact entry.
#         GOOD:  _write_result("success", outputs={"reversed": "olleh"})
#         BAD:   _write_result("success", outputs={"reversed": "out/reversed.txt"})
#       Writing a path into a scalar output fails validation with
#       "scalar output leaked a path string".
#   - FILE output (worker.yml output has kind: "file" and a `path:`):
#       write the file under out/ and put its RELATIVE PATH in outputs[<name>]
#       PLUS one matching artifacts[] entry.
#         GOOD:  outputs={"report": "out/report.csv"},
#                artifacts=[{"name":"out/report.csv","relative_path":"out/report.csv","type":"text/csv"}]
#   Match each output's declared kind: scalar -> literal value, file -> out/ path.
#
# HARD RULES (these are the exact mistakes that crash generated workers):
#   - Use ONLY the Python standard library unless you also list the package in
#     requirements.txt. Do NOT `import dotenv` / `from dotenv import ...` — it is
#     NOT preinstalled. Read secrets from os.environ + secrets.json (shown below).
#   - import EVERY module you reference (os, json, csv, io, re, statistics, ...).
#     A missing `import os` is a top generated-worker crash.
#   - Write result.json to "result.json" (the working dir), NEVER "out/result.json".
#   - SCALAR output -> outputs[name] is the literal VALUE (no out/ file, no artifact).
#     FILE output -> one out/ file -> one outputs entry (the path) + one artifact.
#   - never open() a scalar input value; never hardcode a secret.
#   - always write result.json, even when you bail out early on bad input.
#   - never run `composio execute` with subprocess. E2B has no Composio CLI and
#     COMPOSIO_API_KEY stays on the API host.
#
# Copy this skeleton and fill in `main()`. Keep it the smallest thing that works.

import json
import os
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError


def _load_secrets():
    """Secrets from os.environ, with a secrets.json fallback. No third-party deps."""
    try:
        with open("secrets.json") as fh:
            file_secrets = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        file_secrets = {}

    def get(name, default=None):
        return os.environ.get(name) or file_secrets.get(name) or default


def _load_connections():
    try:
        with open("connections.json") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def composio_execute(app, tool_slug, arguments):
    """Execute a declared Composio tool through the Floom API proxy."""
    run_id = os.environ.get("FLOOM_RUN_ID", "")
    api_url = os.environ.get("WORKEROS_API_URL", "https://localhost:8000").rstrip("/")
    run_token = os.environ.get("WORKEROS_RUN_TOKEN", "")
    connection_id = str(_load_connections().get(app) or "").strip()
    if not run_id:
        raise RuntimeError("FLOOM_RUN_ID is not set")
    if not connection_id:
        raise RuntimeError(f"{app} connection is not active")

    headers = {"Content-Type": "application/json"}
    if run_token:
        headers["X-Floom-Run-Token"] = run_token

    body = json.dumps({
        "connected_account_id": connection_id,
        "arguments": arguments,
    }).encode("utf-8")
    req = urlrequest.Request(
        f"{api_url}/runs/{run_id}/composio-execute/{tool_slug}",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Composio proxy HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Composio proxy failed: {exc}") from exc

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

    # 3) Do the work.
    result_value = "replace with the real output"

    # 4a) SCALAR output (kind: "scalar") -> put the LITERAL VALUE inline. NO out/
    #     file, NO artifact. This is the common case (reverse/sort/sum/title-case
    #     a string or number). Match the declared output name from worker.yml.
    _write_result("success", outputs={"result": result_value})

    # 4b) FILE output (kind: "file") -> write the file under out/ and put its
    #     RELATIVE PATH in outputs PLUS a matching artifact. Use THIS branch ONLY
    #     when the output is declared kind: "file":
    #     os.makedirs("out", exist_ok=True)
    #     out_path = "out/result.csv"
    #     Path(out_path).write_text(result_value, encoding="utf-8")
    #     _write_result(
    #         "success",
    #         outputs={"result": out_path},
    #         artifacts=[{"name": out_path, "relative_path": out_path, "type": "text/csv"}],
    #     )


if __name__ == "__main__":
    main()


# =============================================================================
# WORKED EXAMPLES — copy the one that matches the task, then adapt.
# These cover the historical first-run failure classes. Each shows the FULL
# main() body so the scalar-vs-file output contract is unmissable.
# =============================================================================
#
# --- Example 1: reverse a string  (SCALAR input -> SCALAR output) -----------
#   worker.yml: input "text" kind:scalar type:string; output "reversed"
#               kind:scalar type:string (NO path).
# def main():
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     text = str(inputs.get("text") or "")
#     _write_result("success", outputs={"reversed": text[::-1]})
#
# --- Example 2: sort a CSV by column 2  (FILE input -> FILE output) ---------
#   worker.yml: input "csv_file" kind:file path:inputs/csv_file;
#               output "sorted_csv" kind:file media_type:text/csv path:out/sorted.csv.
# def main():
#     import csv
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     with open(inputs["csv_file"], newline="", encoding="utf-8") as fh:
#         rows = list(csv.reader(fh))
#     header, body = rows[0], rows[1:]
#     body.sort(key=lambda r: r[1])           # column 2 (zero-based index 1)
#     os.makedirs("out", exist_ok=True)
#     out_path = "out/sorted.csv"
#     with open(out_path, "w", newline="", encoding="utf-8") as fh:
#         csv.writer(fh).writerows([header] + body)
#     _write_result("success", outputs={"sorted_csv": out_path},
#                   artifacts=[{"name": out_path, "relative_path": out_path, "type": "text/csv"}])
#
# --- Example 3: min/max/mean/median  (SCALAR input -> JSON FILE output) -----
#   A structured result is a FILE output media_type:application/json path:out/stats.json
#   (declaring stats as a scalar would force you to stuff JSON in a string —
#   prefer a json file output for objects). Implement ALL declared stats.
# def main():
#     import statistics
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     raw = str(inputs.get("numbers") or "")
#     nums = [float(x) for x in raw.replace(",", " ").split()]
#     stats = {
#         "min": min(nums), "max": max(nums),
#         "mean": statistics.mean(nums), "median": statistics.median(nums),
#     }
#     os.makedirs("out", exist_ok=True)
#     out_path = "out/stats.json"
#     Path(out_path).write_text(json.dumps(stats), encoding="utf-8")
#     _write_result("success", outputs={"stats": out_path},
#                   artifacts=[{"name": out_path, "relative_path": out_path, "type": "application/json"}])
#
# --- Example 4: dedupe lines  (SCALAR input -> FILE output) -----------------
#   output "deduped" kind:file media_type:text/plain path:out/deduped.txt.
# def main():
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     lines = str(inputs.get("text") or "").splitlines()
#     seen, kept = set(), []
#     for ln in lines:
#         if ln not in seen:
#             seen.add(ln); kept.append(ln)
#     os.makedirs("out", exist_ok=True)
#     out_path = "out/deduped.txt"
#     Path(out_path).write_text("\n".join(kept), encoding="utf-8")
#     _write_result("success", outputs={"deduped": out_path},
#                   artifacts=[{"name": out_path, "relative_path": out_path, "type": "text/plain"}])
#
# --- Example 5: extract emails  (SCALAR input -> SCALAR output) -------------
#   output "emails" kind:scalar type:string (a comma-joined literal, NOT a path).
# def main():
#     import re
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     text = str(inputs.get("text") or "")
#     found = re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
#     _write_result("success", outputs={"emails": ", ".join(found)})
#
# --- Example 6: word + char + sentence count  (SCALAR -> JSON FILE) ---------
#   The prompt asks for THREE counts: implement ALL THREE. Under-implementing
#   (returning only word_count) is a top "ran green but incomplete" failure.
# def main():
#     import re
#     inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
#     text = str(inputs.get("text") or "")
#     counts = {
#         "words": len(text.split()),
#         "chars": len(text),
#         "sentences": len([s for s in re.split(r"[.!?]+", text) if s.strip()]),
#     }
#     os.makedirs("out", exist_ok=True)
#     out_path = "out/counts.json"
#     Path(out_path).write_text(json.dumps(counts), encoding="utf-8")
#     _write_result("success", outputs={"counts": out_path},
#                   artifacts=[{"name": out_path, "relative_path": out_path, "type": "application/json"}])
