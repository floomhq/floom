"""Authored-worker registration, manifest normalization, and smoke/repair gate.

Extracted verbatim from run_service.py: the subsystem that takes an
AI-authored (or user-uploaded) worker bundle, normalizes its manifest,
registers it on disk, and proves it runs via a bounded smoke-test + repair
loop before gating it. run_service re-imports these names for backward
compatibility, so every existing ``from run_service import ...`` keeps working.

The handful of run_service-owned helpers this subsystem calls (run-config
loading, output validation, secret resolution) are imported lazily inside the
functions that use them to avoid a module-load circular import.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from contexts import context_scope_for_user, use_context_scope
from db.factory import Repositories
from models import WorkerConfig
from runner_utils import ARTIFACTS_DIR, _validate_output_schema
from worker_registry import WORKERS_DIR

logger = logging.getLogger("floom.run_service")


class InsufficientDiskSpaceError(RuntimeError):
    """Raised when the API refuses run creation because local disk is too full."""


def _minimum_free_disk_bytes() -> int:
    raw = os.environ.get("WORKEROS_MIN_FREE_DISK_BYTES", str(1024 * 1024 * 1024))
    try:
        return max(0, int(raw))
    except ValueError:
        return 1024 * 1024 * 1024


# The meta-worker whose completed runs auto-register the worker they drafted.
# Mirrors main._WORKER_AUTHOR_ID (asserted equal in tests).
_WORKER_AUTHOR_WORKER_ID = "worker-author"


def _find_bundle_artifact(run_id: str, artifacts: list[Dict[str, Any]]) -> Optional[Path]:
    """Locate the worker-author bundle.json on local disk.

    The E2B driver downloads ``out/bundle.json`` into
    ``ARTIFACTS_DIR/<run_id>/out/bundle.json`` and records the artifact with
    ``relative_path == "out/bundle.json"`` and an absolute ``path``. Fall back
    to the conventional location if the artifact list is unexpectedly empty.
    """
    for art in artifacts or []:
        rel = str(art.get("relative_path") or "")
        name = str(art.get("name") or "")
        if rel == "out/bundle.json" or name == "bundle.json" or rel.endswith("/bundle.json"):
            candidate = art.get("path")
            if candidate and Path(candidate).is_file():
                return Path(candidate)
    fallback = (ARTIFACTS_DIR / run_id / "out" / "bundle.json")
    return fallback if fallback.is_file() else None


def _read_authored_bundle(
    run_id: str, artifacts: list[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Re-read the worker-author bundle.json (for the post-registration smoke)."""
    bundle_path = _find_bundle_artifact(run_id, artifacts)
    if bundle_path is None:
        return None
    try:
        data = json.loads(bundle_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _normalize_authored_worker_yml(worker_yml: str, log_fn: Callable[..., None]) -> str:
    """Strip optional metadata that violates the WorkerContract schema so an
    otherwise-valid drafted worker still registers.

    Only touches DISPLAY metadata (lossless to function):
      - ``use_cases``: must be 3-5 non-empty items, else dropped.
      - ``tags``: must be <= 8 flat non-empty strings, else dropped.

    Returns the (possibly rewritten) YAML; on any parse error returns the
    input unchanged so the normal validation path reports the real error.
    """
    try:
        import yaml as pyyaml
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return worker_yml
    if not isinstance(raw, dict):
        return worker_yml

    changed = False

    # #717: the worker-author LLM intermittently emits two REQUIRED-field
    # mistakes that hard-fail WorkerContract validation and dead-end the
    # create-from-prompt flow (worker_creation_failed=true, no worker added):
    #   1. schema_version as a YAML number (0.3) instead of the string "0.3".
    #   2. a missing top-level `version`.
    # Coerce both here (the engine, not the non-deterministic prompt) so a
    # functionally-valid drafted worker registers.
    sv = raw.get("schema_version")
    if sv is not None and not isinstance(sv, str):
        # 0.3 (float) -> "0.3"; 1 (int) -> "1"
        raw["schema_version"] = (
            ("%g" % sv) if isinstance(sv, float) else str(sv)
        )
        changed = True
        log_fn("Coerced numeric schema_version to string on drafted worker (#717)", level="warning")
    if not str(raw.get("version") or "").strip():
        raw["version"] = "0.1.0"
        changed = True
        log_fn("Backfilled missing version on drafted worker (#717)", level="warning")

    use_cases = raw.get("use_cases")
    if use_cases is not None:
        ok = (
            isinstance(use_cases, list)
            and 3 <= len(use_cases) <= 5
            and all(isinstance(u, str) and u.strip() for u in use_cases)
        )
        if not ok:
            raw.pop("use_cases", None)
            changed = True
            log_fn("Dropped invalid use_cases from drafted worker (schema requires 3-5 items)", level="warning")

    tags = raw.get("tags")
    if tags is not None:
        ok = (
            isinstance(tags, list)
            and len(tags) <= 8
            and all(isinstance(t, str) and t.strip() and "/" not in t for t in tags)
        )
        if not ok:
            raw.pop("tags", None)
            changed = True
            log_fn("Dropped invalid tags from drafted worker (schema requires <=8 flat strings)", level="warning")

    # gen-quality (2026-05-29): the LLM makes a small set of recurring
    # input/output DECLARATION mistakes that hard-fail registration and dead-end
    # the operator. We fix the ENGINE (not just the generation prompt, which is
    # non-deterministic), losslessly, for every input and output field:
    #   1. type-in-kind-slot: kind is actually a scalar TYPE value (textarea,
    #      string, number, ...) -> set kind:scalar and move the value to `type`.
    #   2. scalar + file markers: kind:scalar but carries path/media_type and no
    #      type -> the run.py returns the literal value, so resolve to a clean
    #      scalar (strip the stray file markers, default type:string).
    #   3. scalar missing type: kind:scalar (or no kind + no file markers) and no
    #      type -> default type:string.
    _SCALAR_TYPES = {"string", "textarea", "number", "boolean", "select", "url"}

    def _fix_fields(fields: Any) -> bool:
        touched = False
        if not isinstance(fields, list):
            return False
        for field in fields:
            if not isinstance(field, dict):
                continue
            kind = str(field.get("kind") or "").strip().lower()
            ftype = str(field.get("type") or "").strip().lower()
            has_file_markers = bool(field.get("path") or field.get("media_type"))
            # (0) missing kind + file markers (or legacy type:file) -> file.
            # WorkerContractField defaults missing kind to scalar; a generated
            # output like `{media_type, path}` without `kind:file` then rejects
            # as "scalar cannot declare media_type/path". Preserve the functional
            # declaration by making the intended file kind explicit.
            if not kind and (has_file_markers or ftype == "file"):
                field["kind"] = "file"
                kind = "file"
                touched = True
            if kind == "file" and field.get("type") and ftype != "file":
                field.pop("type", None)
                touched = True
            if kind == "file":
                if field.get("media_type") and not field.get("path"):
                    safe_name = str(field.get("name") or "result").strip() or "result"
                    ext = ".json" if str(field.get("media_type")).lower() == "application/json" else ".txt"
                    field["path"] = f"out/{safe_name}{ext}"
                    touched = True
                continue
            # (1) type-in-kind-slot (e.g. kind: textarea) -> kind:scalar + type.
            if kind in _SCALAR_TYPES:
                if not field.get("type"):
                    field["type"] = kind
                field["kind"] = "scalar"
                kind = "scalar"
                touched = True
            # (2) contradictory scalar + file markers -> clean scalar.
            if kind == "scalar" and has_file_markers:
                field.pop("path", None)
                field.pop("media_type", None)
                if not field.get("type"):
                    field["type"] = "string"
                touched = True
                continue
            # (3) scalar missing the required type -> default string.
            is_scalar = kind == "scalar" or (not kind and not has_file_markers)
            if is_scalar and not field.get("type") and not has_file_markers:
                field["type"] = "string"
                touched = True
            if field.get("type") == "select" and not (field.get("options") or field.get("enum")):
                field["type"] = "string"
                touched = True
        return touched

    for block, key in ((raw, "inputs"), (raw, "outputs")):
        if _fix_fields(block.get(key)):
            changed = True
            log_fn(f"Normalized generated {key} kind/type so the worker registers", level="info")
    exec_block = raw.get("exec")
    if isinstance(exec_block, dict):
        for key in ("inputs", "outputs"):
            if _fix_fields(exec_block.get(key)):
                changed = True
                log_fn(f"Normalized generated {key} kind/type so the worker registers", level="info")

    if not changed:
        return worker_yml
    import yaml as pyyaml
    return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)


def _backfill_example_input(worker_yml: str, sample_input_json: Any, log_fn: Callable[..., None]) -> str:
    """Ensure the drafted worker.yml carries an ``example_input`` block so the
    "Fill with sample input" button is one-click runnable, even when the LLM
    omits it (G5 FIX 4).

    The generator already emits ``sample_input_json`` (realistic values used for
    the smoke run). If the worker.yml has no usable ``example_input``, backfill
    it from that sample so EVERY generated worker — including file-input ones —
    ships a runnable sample. Lossless: only adds, never overwrites an existing
    example_input. Returns the (possibly rewritten) YAML; input unchanged on any
    parse error."""
    try:
        import yaml as pyyaml
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return worker_yml
    if not isinstance(raw, dict):
        return worker_yml

    existing = raw.get("example_input")
    if isinstance(existing, dict) and existing:
        return worker_yml  # LLM already supplied one — keep it.

    sample: Optional[Dict[str, Any]] = None
    if isinstance(sample_input_json, str) and sample_input_json.strip():
        try:
            parsed = json.loads(sample_input_json)
            if isinstance(parsed, dict) and parsed:
                sample = parsed
        except json.JSONDecodeError:
            sample = None
    elif isinstance(sample_input_json, dict) and sample_input_json:
        sample = dict(sample_input_json)

    if not sample:
        # Final fallback: synthesize a type-appropriate value for every declared
        # input straight from the worker's own schema, so EVERY worker is
        # one-click runnable even when the LLM returns no sample at all.
        sample = _synthesize_example_input_from_schema(raw)
        if not sample:
            return worker_yml
        log_fn("Synthesized example_input from the worker's input schema (no LLM sample)", level="info")
    else:
        log_fn("Backfilled example_input from sample_input_json so the worker is one-click runnable", level="info")

    raw["example_input"] = sample
    try:
        import yaml as pyyaml
        return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)
    except Exception:
        return worker_yml


def _synthesize_example_input_from_schema(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Build a minimal, type-appropriate example_input from a worker manifest's
    declared inputs. Used as the last-resort sample so file-input workers (and
    any worker) are one-click runnable when no LLM sample is available.

    File inputs get small inline TEXT content (a CSV for text/csv, else a couple
    of plain-text lines); scalars get the same type-appropriate placeholders the
    smoke runner uses. Returns {} when there are no usable inputs."""
    inputs = None
    exec_block = manifest.get("exec")
    if isinstance(exec_block, dict) and isinstance(exec_block.get("inputs"), list):
        inputs = exec_block["inputs"]
    elif isinstance(manifest.get("inputs"), list):
        inputs = manifest["inputs"]
    if not inputs:
        return {}

    sample: Dict[str, Any] = {}
    for inp in inputs:
        if not isinstance(inp, dict):
            continue
        name = inp.get("name")
        if not name:
            continue
        itype = str(inp.get("type") or "").strip().lower()
        kind = str(inp.get("kind") or "").strip().lower()
        media = str(inp.get("media_type") or "").strip().lower()
        is_file = itype == "file" or kind == "file"
        if is_file:
            if "csv" in media:
                sample[name] = "name,value\nalice,1\nbob,2\n"
            elif "json" in media:
                sample[name] = '{"example": "value"}'
            else:
                sample[name] = "alice\nbob\ncharlie\n"
        elif itype in ("list", "array"):
            sample[name] = [3, 1, 2]
        elif itype in ("object", "dict", "json"):
            sample[name] = {"key": "value"}
        elif itype == "number":
            sample[name] = 1
        elif itype == "boolean":
            sample[name] = True
        else:
            sample[name] = "sample"
    return sample


def _register_authored_worker(
    run_id: str,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
) -> Optional[str]:
    """Register the worker drafted by a completed worker-author run.

    Reads the run's ``bundle.json`` artifact (produced by
    ``workers/worker-author/run.py``), assembles the worker bundle files
    (worker.yml + SKILL.md or run.py + requirements.txt), and registers them
    through the shared ``main._register_worker_from_files`` path. Returns the
    new ``worker_id`` (or None if the bundle is missing / invalid — in which
    case the run still completes and the bundle stays viewable).

    Idempotency: if the run output already carries a ``created_worker_id``
    (e.g. a resumed/re-executed run), no second worker is created.
    """
    started_at = time.perf_counter()
    if isinstance(outputs, dict) and outputs.get("created_worker_id"):
        return str(outputs["created_worker_id"])  # already registered

    stage_at = time.perf_counter()
    bundle_path = _find_bundle_artifact(run_id, artifacts)
    if bundle_path is None:
        log_fn("worker-author produced no bundle.json — nothing to register", level="warning")
        return None
    log_fn(f"worker-author registration: found bundle artifact in {time.perf_counter() - stage_at:.2f}s")

    try:
        stage_at = time.perf_counter()
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log_fn(f"worker-author bundle.json unreadable: {exc}", level="warning")
        return None
    if not isinstance(bundle, dict):
        log_fn("worker-author bundle.json is not an object", level="warning")
        return None
    log_fn(f"worker-author registration: parsed bundle in {time.perf_counter() - stage_at:.2f}s")

    # If the author could not produce valid YAML after its retries it embeds an
    # `error`. Don't register a broken worker; leave the run viewable so the
    # operator sees the drafted (broken) bundle. This is the rare degenerate
    # case (LLM retries 3x first).
    if bundle.get("error"):
        log_fn(
            f"worker-author bundle has a validation error, not auto-registering: {bundle['error']}",
            level="warning",
        )
        return None

    worker_yml = (bundle.get("worker_yml") or "").strip()
    if not worker_yml:
        log_fn("worker-author bundle missing worker_yml — nothing to register", level="warning")
        return None

    # Safety-net: the worker-author LLM validates the YAML with its own loose
    # check, which is weaker than the canonical WorkerContract schema enforced
    # at registration. The common drift is OPTIONAL metadata (use_cases must be
    # 3-5 items, tags <= 8 flat strings). Strip violating optional metadata so a
    # functionally-valid worker still registers instead of dead-ending. This is
    # lossless to behaviour (these fields are display metadata only).
    stage_at = time.perf_counter()
    worker_yml = _normalize_authored_worker_yml(worker_yml, log_fn)
    # G5 FIX 4: guarantee a runnable sample even when the LLM omits example_input.
    worker_yml = _backfill_example_input(worker_yml, bundle.get("sample_input_json"), log_fn)
    log_fn(f"worker-author registration: normalized manifest in {time.perf_counter() - stage_at:.2f}s")

    skill_md = bundle.get("skill_md")
    run_code = bundle.get("run_code")
    requirements_txt = bundle.get("requirements_txt")

    # A bundle with NEITHER agent-mode SKILL.md NOR script-mode run.py has nothing
    # executable. Registering it would backfill the placeholder run.py stub, which
    # returns success with empty outputs — i.e. a worker that "runs green" yet does
    # nothing (the worst failure for the operator: it looks ready). Surface as
    # un-registered (the run + drafted bundle stay viewable) instead of shipping a
    # silent no-op. The strengthened generation prompt makes this rare.
    _skill_src = skill_md if isinstance(skill_md, str) else ""
    _code_src = run_code if isinstance(run_code, str) else ""
    if not _skill_src.strip() and not _code_src.strip():
        log_fn(
            "worker-author bundle has neither SKILL.md nor run.py — not registering "
            "a no-op worker; the drafted bundle stays viewable",
            level="warning",
        )
        return None

    # Lazy import: main imports run_service at startup, so importing main here
    # (at run-completion time, long after startup) avoids the circular import.
    import main as _main

    files = [_main.DraftFile(path="worker.yml", content=worker_yml)]
    if isinstance(skill_md, str) and skill_md.strip():
        files.append(_main.DraftFile(path="SKILL.md", content=skill_md))
    if isinstance(run_code, str) and run_code.strip():
        files.append(_main.DraftFile(path="run.py", content=run_code))
    if isinstance(requirements_txt, str) and requirements_txt.strip():
        files.append(_main.DraftFile(path="requirements.txt", content=requirements_txt))

    stage_at = time.perf_counter()
    worker_id = _main._register_worker_from_files(
        files,
        user_id=user_id,
        repos=repos,
        dedupe_id=True,
    )
    log_fn(
        f"Registered worker {worker_id!r} from drafted bundle "
        f"in {time.perf_counter() - stage_at:.2f}s "
        f"(registration total {time.perf_counter() - started_at:.2f}s)"
    )
    return worker_id


# ---------------------------------------------------------------------------
# Post-generation smoke + bounded repair (the wedge safety net, 2026-05-29)
# ---------------------------------------------------------------------------
# A generated SCRIPT-mode worker must be PROVEN to run before the operator is
# told it is ready. After registration we run ONE real E2B smoke execution with
# the bundle's sample input. If it fails with a code-class error, we make a
# bounded repair pass (max 1): feed the run.py + the failure to a focused model
# call, rewrite run.py on disk, re-smoke. We never loop unbounded, never spawn
# more than one sandbox at a time (the smoke runs inline on the author run's
# already-acquired execution slot), and never silently ship a broken worker —
# the outcome is recorded on the author run output as ``smoke``.

_MAX_SMOKE_REPAIRS = 1

# Distinctive prefix of main._DEFAULT_RUN_PY_STUB's comment. A generated script
# worker whose run.py is the placeholder stub does nothing (it writes a success
# result.json with empty outputs and would otherwise PASS the smoke green).
_PLACEHOLDER_RUN_PY_MARKER = "# Script workers read inputs.json"

# Failure error_codes that mean the worker's own code is broken (worth a repair
# attempt). Setup/auth/secret/connection failures are NOT code bugs.
#
# output_validation_failed (2026-05-29, gen-quality): a worker that ran GREEN but
# wrote a PATH into a SCALAR output (or an empty/missing declared output) is a
# CODE bug — the generated logic confused the scalar-vs-file output contract.
# Routing it into the bounded repair loop (with the corrected contract in the
# repair prompt) lets it self-heal instead of gating on the first try. The gate
# remains the fallback if repair still fails (0-silently-broken still HOLDs).
_SMOKE_CODE_FAILURE_CODES = frozenset(
    {"execution_error", "e2b_sandbox_error", "missing_result", "output_validation_failed"}
)

_SMOKE_REPAIR_SYSTEM_PROMPT = (
    "You fix Floom script-mode worker run.py files. The script runs as "
    "`python run.py` in an E2B sandbox and MUST:\n"
    "- read inputs.json via json.load(open('inputs.json'));\n"
    "- treat SCALAR inputs as the literal value inline (never open() them); a "
    "FILE input's value IS already the relative path (e.g. 'inputs/csv_file') so "
    "open(inputs['x']) directly — NEVER os.path.join('inputs', inputs['x']);\n"
    "- use ONLY the Python standard library. NEVER `import dotenv` / "
    "`from dotenv import ...` (it is NOT installed -> ModuleNotFoundError). Read "
    "secrets from os.environ with a secrets.json fallback. If you import any "
    "third-party lib it would also need a requirements entry, so prefer stdlib;\n"
    "- import EVERY module it references (os, json, csv, io, re, statistics, ...);\n"
    "- OUTPUT CONTRACT (scalar vs file — the INVERSE of the input contract). For "
    "each declared output, match its kind:\n"
    "    * SCALAR output (kind 'scalar', no path) -> outputs[name] is the LITERAL "
    "VALUE (a string or number), NOT a path. No out/ file, no artifact. "
    "e.g. outputs={'reversed':'olleh'}. Writing a path string like "
    "'out/reversed.txt' into a scalar output FAILS with 'scalar output leaked a "
    "path string' — return the value itself instead.\n"
    "    * FILE output (kind 'file', has a path) -> write the file under out/ "
    "(mkdir it) and put its RELATIVE PATH in outputs[name] plus one matching "
    "artifacts[] entry, e.g. outputs={'report':'out/report.csv'};\n"
    "- write result.json to the WORKING DIRECTORY ('result.json'), NOT "
    "'out/result.json' (writing it under out/ makes the run produce no result);\n"
    "- result.json schema: {\"status\":\"success\"|\"error\",\"outputs\":"
    "{<name>:<literal-value-for-scalar OR out/path-for-file>},\"artifacts\":"
    "[{\"name\",\"relative_path\",\"type\"}],\"error\":<msg on error>} on BOTH "
    "success and error paths;\n"
    "- end with `if __name__ == \"__main__\": main()`.\n"
    "The failure message tells you exactly what broke — fix THAT. If it says "
    "'scalar output leaked a path string', return the literal value in that "
    "output instead of a path. If it says example_output mismatch, change the "
    "logic so the declared example_input produces the declared example_output. "
    "Return ONLY the corrected, complete run.py file. "
    "No markdown fences, no commentary."
)


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    return stripped


def _build_smoke_inputs(
    config: WorkerConfig,
    bundle: Dict[str, Any],
    tmp_dir: Path,
) -> Dict[str, Any]:
    """Build inputs for the smoke run from the bundle's sample input.

    Scalar inputs use the sample literal (or a deterministic default). File
    inputs are materialised as a temp file (the driver only needs an absolute
    local file path) seeded with the sample value or a small placeholder.
    """
    sample: Dict[str, Any] = {}
    raw_sample = bundle.get("sample_input_json")
    if isinstance(raw_sample, str) and raw_sample.strip():
        try:
            parsed = json.loads(raw_sample)
            if isinstance(parsed, dict):
                sample = parsed
        except json.JSONDecodeError:
            sample = {}
    if not sample and isinstance(bundle.get("example_input"), dict):
        sample = dict(bundle["example_input"])
    if not sample:
        worker_yml = bundle.get("worker_yml")
        if isinstance(worker_yml, str) and worker_yml.strip():
            try:
                import yaml as pyyaml

                raw_manifest = pyyaml.safe_load(worker_yml) or {}
                manifest_sample = (
                    raw_manifest.get("example_input") if isinstance(raw_manifest, dict) else None
                )
                if isinstance(manifest_sample, dict):
                    sample = dict(manifest_sample)
            except Exception:
                sample = {}

    inputs: Dict[str, Any] = {}
    for inp in config.inputs:
        is_file = (inp.type == "file") or (getattr(inp, "kind", None) == "file")
        if is_file:
            seed = sample.get(inp.name)
            content = seed if isinstance(seed, str) and seed.strip() else "sample,value\n1,2\n"
            staged = tmp_dir / f"{inp.name}.dat"
            staged.write_text(content, encoding="utf-8")
            inputs[inp.name] = str(staged.resolve())
            continue
        if inp.name in sample:
            inputs[inp.name] = sample[inp.name]
        elif inp.default is not None:
            inputs[inp.name] = inp.default
        elif inp.required:
            # Deterministic, TYPE-APPROPRIATE placeholder so a required input
            # never blocks the smoke on a missing-input gate AND a list-typed
            # worker is not false-disabled by feeding it a bare string (e.g. a
            # median-of-a-list worker received "sample" and crashed on
            # float("s"), getting wrongly gated). Number/string keep their prior
            # placeholders ("1"/"sample") to avoid regressing existing workers.
            itype = (inp.type or "").strip().lower()
            if itype in ("list", "array"):
                inputs[inp.name] = [3, 1, 2]
            elif itype in ("object", "dict", "json"):
                inputs[inp.name] = {"key": "value"}
            elif itype == "number":
                inputs[inp.name] = 1
            else:
                inputs[inp.name] = "sample"
    return inputs


def _repair_run_py(
    *,
    run_code: str,
    failure: str,
    secrets: Dict[str, str],
    log_fn: Callable[..., None],
    intent: str = "",
) -> Optional[str]:
    """Ask a focused model call to fix a broken script-mode run.py.

    ``intent`` is the worker's own description/long_description so the repair can
    fix UNDER-implementation (declared outputs the generator only partly filled),
    not just syntax/contract bugs.

    Returns the corrected file, or None if no key / call failed / no change.
    """
    import llm
    from codegen_model import chat_completion_codegen, codegen_model

    # Repair uses the platform-configured codegen model and provider credentials from
    # the environment (OpenAI key, or AWS creds for Bedrock), resolved by the seam.
    if not llm.provider_credentials_present(codegen_model()):
        log_fn("Smoke repair skipped: no LLM provider credentials available", level="warning")
        return None
    try:
        user_content = (
            "This run.py failed its first run with:\n"
            f"{failure[:1500]}\n\n"
        )
        if intent:
            # Feed the worker's INTENT so the repair can fix UNDER-implementation
            # (a worker that ran green but only produced part of what the prompt
            # asked for), not just syntax/contract bugs.
            user_content += f"The worker is supposed to do this:\n{intent[:1200]}\n\n"
        user_content += (
            "Here is the current run.py:\n\n"
            f"{run_code[:8000]}\n\n"
            "Return the corrected complete run.py. Implement EVERY declared "
            "output fully — if the task asks for multiple outputs, produce all "
            "of them, not just the first."
        )
        resp = chat_completion_codegen(
            messages=[
                {"role": "system", "content": _SMOKE_REPAIR_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.0,
            max_output_tokens=6000,
        )
        fixed = _strip_code_fences(resp.choices[0].message.content or "")
    except Exception as exc:  # pragma: no cover - network/SDK variance
        log_fn(f"Smoke repair model call failed: {exc}", level="warning")
        return None

    if not fixed or fixed.strip() == run_code.strip():
        return None
    # Reject output that is not syntactically valid Python — never write a worse
    # file over a bad one.
    try:
        import ast

        ast.parse(fixed)
    except SyntaxError:
        log_fn("Smoke repair produced invalid Python; discarding", level="warning")
        return None
    return fixed


def _smoke_and_repair_generated_worker(
    worker_id: str,
    bundle: Dict[str, Any],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
    allow_code_repair: bool = True,
) -> Dict[str, Any]:
    """Prove a generated SCRIPT-mode worker runs; repair (bounded) if it doesn't.

    Returns a small dict suitable for the author run output ``smoke`` field:
      {"status": "passed"|"failed"|"skipped", "reason": <str>, "repairs": <int>}
    Never raises — a smoke failure must not crash the author run.

    ``allow_code_repair`` (least-surprise gate, 2026-05-29): when True (the
    LLM-generated worker-author / draft-from-prompt path) a code-class failure
    triggers the bounded auto-repair of run.py — that self-heal is the product
    wedge. When False (USER-SUPPLIED files via the upload flow) the worker is
    STILL smoked and gated, but the user's run.py is NEVER rewritten: a code
    failure is surfaced as a smoke failure (the caller disables + surfaces the
    calm reason) so the operator edits their own code. Silently mutating
    user-provided code would change its semantics without consent.
    """
    from run_service import (
        _load_worker_recipe,
        _repos,
        _materialize_declared_file_outputs,
        _validate_run_outputs,
        _validate_example_output,
        _smoke_empty_output_error,
        get_secrets_for_worker,
        # Resolved via run_service (not runner_sandbox / this module) so tests
        # that monkeypatch ``run_service.get_sandbox_driver`` / ``_repair_run_py``
        # take effect on the smoke path after the move.
        get_sandbox_driver,
        _repair_run_py,
    )
    started_at = time.perf_counter()
    repos_obj = _repos(repos)
    loaded = _load_worker_recipe(worker_id, repos_obj)
    if not loaded:
        return {"status": "skipped", "reason": "worker recipe not found"}
    config = loaded[1]

    # Gate == runtime (Codex P1, 2026-06-04): a DISABLED worker (manifest
    # ``paused: true`` / ``enabled: false``) is REJECTED by create_run with
    # "Worker is disabled" — so we must NOT smoke it green and let the caller
    # report it "verified runnable". The recipe's instance row carries the
    # effective enabled flag (the manifest's ``paused`` is projected into it).
    # Surface as skipped (not failed): the worker is intentionally off, not broken.
    instance = loaded[2] if len(loaded) > 2 else None
    if isinstance(instance, dict) and instance.get("enabled") is False:
        return {
            "status": "skipped",
            "reason": "worker is disabled (paused) — enable it before it can run",
        }

    runtime = config.runtime
    mode = runtime.mode if runtime else "pure-script"
    entry = (runtime.entrypoint if runtime else "") or ""
    is_script = mode == "pure-script" and entry.lower().endswith(
        (".py", ".sh", ".js")
    )
    if not is_script:
        return {"status": "skipped", "reason": "not a script-mode worker"}

    # A run.py worker whose run.py is the placeholder stub does nothing: the stub
    # writes a success result.json with empty outputs, so a plain smoke run would
    # report PASSED. Catch it BEFORE running (and before the secret/connection
    # skip gates) and surface as failed — the operator must re-generate or edit,
    # never see a green-but-empty worker. Only when the EXECUTED entry is run.py:
    # a run.js / run.sh / multi-file Python worker executes its own entry, and a
    # stale placeholder run.py on disk must NOT fail it (Codex P1 — that would
    # disable a perfectly good Node/shell worker that never runs run.py).
    executes_run_py = entry.strip().lower() == "run.py"
    if executes_run_py:
        try:
            if _PLACEHOLDER_RUN_PY_MARKER in (WORKERS_DIR / worker_id / "run.py").read_text(
                encoding="utf-8"
            ):
                log_fn(
                    "Smoke failed — generated worker has only the placeholder stub, no real code",
                    level="warning",
                )
                return {
                    "status": "failed",
                    "reason": "generation produced no script code — re-generate or edit the worker",
                    "repairs": 0,
                }
        except OSError:
            pass

    secrets = get_secrets_for_worker(worker_id, user_id=user_id, repos=repos_obj)
    missing = [s for s in config.secrets if s not in secrets]
    if missing:
        # Can't prove a run without its credentials; surface, don't fail.
        reason = f"needs a credential before it can run ({', '.join(missing)})"
        log_fn(f"Smoke skipped — generated worker {reason}", level="warning")
        return {"status": "skipped", "reason": reason}

    connection_ids: Dict[str, str] = {}
    if config.connections:
        return {
            "status": "skipped",
            "reason": "needs a connected account before it can run",
        }

    worker_dir = WORKERS_DIR / worker_id
    run_py_path = worker_dir / "run.py"

    repairs = 0
    last_failure = ""
    tmp_root = Path(ARTIFACTS_DIR) / f".smoke-{uuid.uuid4().hex[:12]}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    try:
        runner = runtime.runner if runtime else "e2b"
        timeout_seconds = (
            runtime.limits.timeout_seconds
            if runtime and runtime.limits
            else 120
        )
        # Cap the smoke below a normal run; a generated worker's first proof run
        # must not dominate worker creation latency.
        timeout_seconds = min(int(timeout_seconds), 90)
        log_fn(f"Smoke budget for generated worker is {timeout_seconds}s", level="info")

        while True:
            smoke_inputs = _build_smoke_inputs(config, bundle, tmp_root)
            smoke_run_id = f"smoke_{uuid.uuid4().hex[:16]}"

            def _smoke_log(msg: str, level: str = "debug") -> None:
                log_fn(f"[smoke] {msg}", level=level)

            try:
                driver = get_sandbox_driver(runner, config=config)
                attempt_started_at = time.perf_counter()
                with use_context_scope(context_scope_for_user(user_id)):
                    result = driver.run(
                        worker_id=worker_id,
                        run_id=smoke_run_id,
                        inputs=smoke_inputs,
                        secrets=secrets,
                        log_fn=_smoke_log,
                        trace_id=f"smoke_{uuid.uuid4().hex[:12]}",
                        timeout_seconds=timeout_seconds,
                        config=config,
                        connection_ids=connection_ids,
                        user_id=user_id,
                    )
                log_fn(
                    f"Smoke attempt {repairs + 1} completed in "
                    f"{time.perf_counter() - attempt_started_at:.2f}s",
                    level="info",
                )
            except Exception as exc:  # pragma: no cover - driver/infra variance
                last_failure = str(exc)
                log_fn(f"Smoke run raised: {exc}", level="warning")
                result = None

            substance_error: str | None = None
            if result is not None and result.status not in ("error", "failed"):
                # The worker reported success — but "success" with an empty or
                # missing declared output is a silent no-op (green-but-empty),
                # the worst failure mode for the operator. Validate with the
                # EXACT SAME two-stage gate a real run uses (execute_run): first
                # _validate_output_schema (scalar type/CSV-column/json_required_keys
                # contracts), then _validate_run_outputs (file existence/substance).
                # Running ONLY _validate_run_outputs here let a scalar `type: json`
                # output that is non-empty but not valid JSON pass smoke and then
                # fail every real run with schema_violation — the exact gate-vs-
                # runtime lie this fix exists to kill. Both stages, same order.
                result_outputs = dict(result.outputs or {})
                result_artifacts = list(result.artifacts or [])
                try:
                    _materialize_declared_file_outputs(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )
                except Exception:
                    pass
                substance_error = _validate_output_schema(
                    worker_id, result_outputs, _smoke_log, config=config
                )
                if substance_error is None:
                    substance_error, _smoke_warnings = _validate_run_outputs(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )
                if substance_error is None:
                    substance_error = _validate_example_output(
                        smoke_run_id, config, bundle, result_outputs, result_artifacts
                    )
                if substance_error is None:
                    # A required output that parses as JSON but is an EMPTY
                    # container (``[]`` / ``{}`` / ``""`` / null) is the
                    # green-but-empty no-op: valid JSON, zero substance. The
                    # normal-run validator accepts it (an empty list can be a
                    # legitimate "no results" answer), but at SMOKE time the
                    # sample input is non-trivial, so an empty result means the
                    # generated logic did nothing — route it into the repair loop.
                    substance_error = _smoke_empty_output_error(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )

            if (
                result is not None
                and result.status not in ("error", "failed")
                and substance_error is None
            ):
                msg = (
                    "Smoke passed — generated worker ran successfully"
                    + (f" after {repairs} repair(s)" if repairs else "")
                )
                log_fn(f"{msg} (smoke total {time.perf_counter() - started_at:.2f}s)")
                return {"status": "passed", "reason": "", "repairs": repairs}

            # Failure: decide whether it's a code bug worth repairing.
            if substance_error is not None:
                # Ran green but produced no real output — treat as a code bug so
                # the generator gets a bounded chance to fix the logic.
                last_failure = (
                    f"{substance_error} "
                    "(worker reported success but produced no real output)"
                )
                code_failure = True
            elif result is not None:
                last_failure = (
                    f"{result.error or 'run failed'} "
                    f"(error_code={result.error_code or 'unknown'})"
                )
                code_failure = (result.error_code or "").lower() in _SMOKE_CODE_FAILURE_CODES
            else:
                code_failure = True  # driver raised; treat as code-class

            if not allow_code_repair or not code_failure or repairs >= _MAX_SMOKE_REPAIRS:
                # User-supplied code (allow_code_repair=False) is gated on its
                # first-run result but NEVER rewritten — the operator owns and
                # edits their own run.py. LLM-generated code exhausts its bounded
                # repair budget here too.
                if not allow_code_repair and code_failure:
                    log_fn(
                        "Smoke failed — uploaded worker did not run on first try: "
                        f"{last_failure}. Edit it, then re-run. (Your code was not modified.)",
                        level="warning",
                    )
                else:
                    log_fn(
                        f"Smoke failed — generated worker did not run on first try: {last_failure}",
                        level="warning",
                    )
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            # Bounded repair pass.
            current_code = ""
            try:
                current_code = run_py_path.read_text(encoding="utf-8")
            except OSError:
                pass
            if not current_code:
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            repair_started_at = time.perf_counter()
            fixed = _repair_run_py(
                run_code=current_code,
                failure=last_failure,
                secrets=secrets,
                log_fn=log_fn,
                intent=(getattr(config, "description", None) or "").strip(),
            )
            log_fn(
                f"Smoke repair model step took {time.perf_counter() - repair_started_at:.2f}s",
                level="info",
            )
            if not fixed:
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            # Persist the repaired run.py through the SAME canonical path the
            # editor uses (write disk + invalidate cache + re-discover + persist
            # recipe). The executor reads run.py from disk on every run, so this
            # write is what the next REAL run executes. If persistence FAILS we
            # must NOT keep going: a worker repaired-but-not-persisted is the
            # silently-ships-stale class. Treat it as a smoke failure so the
            # gate disables it instead of presenting unverified disk state.
            try:
                import main as _main

                _main.persist_worker_run_py(worker_id, fixed, user_id=user_id)
            except Exception as persist_exc:
                logger.exception(
                    "Failed to persist smoke repair for worker %s", worker_id
                )
                log_fn(
                    "Smoke failed — could not persist the repaired code: "
                    f"{persist_exc}",
                    level="warning",
                )
                return {
                    "status": "failed",
                    "reason": f"could not persist repaired code: {persist_exc}",
                    "repairs": repairs,
                }
            # Re-load the recipe so the re-smoke runs against the refreshed
            # manifest/config (run.py itself is re-read from disk by the driver).
            loaded = _load_worker_recipe(worker_id, repos_obj) or loaded
            config = loaded[1]
            repairs += 1
            log_fn(f"Smoke repair {repairs}/{_MAX_SMOKE_REPAIRS} applied; re-running", level="info")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _mark_worker_paused_on_disk(worker_id: str, *, paused: bool = True) -> None:
    """Write ``paused: <bool>`` into the worker's manifest (worker.yml) on disk.

    The runtime smoke-disable sets ``workers.enabled = 0`` in the DB, but
    ``_persist_discovered_workers`` recomputes ``enabled`` from the MANIFEST on
    every re-discover (cache invalidation, file save, repair persist) and would
    clobber a DB-only disable back to enabled=1, because the generated manifest
    carries no paused/enabled flag. Persisting ``paused`` into the manifest makes
    the disable durable (`manifest.get("paused") is True` -> enabled_value = 0).
    Best-effort; never raises (the DB enabled=0 stays the primary gate)."""
    import yaml as _pyyaml

    worker_dir = (WORKERS_DIR / worker_id).resolve()
    yml_path = (worker_dir / "worker.yml").resolve()
    try:
        yml_path.relative_to(worker_dir)
    except ValueError:
        return
    try:
        raw = _pyyaml.safe_load(yml_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
        if paused:
            raw["paused"] = True
        else:
            raw.pop("paused", None)
        yml_path.write_text(
            _pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False, encoding='utf-8'),
            encoding="utf-8",
        )
    except Exception:
        logger.warning("Could not write paused flag to manifest for %s", worker_id, exc_info=True)


def smoke_and_gate_generated_worker(
    worker_id: str,
    bundle: Dict[str, Any],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
    allow_code_repair: bool = True,
) -> Dict[str, Any]:
    """Run the smoke+repair safety net AND gate the worker on its result.

    The single safety net for BOTH creation paths (the UI worker-author run and
    the raw /workers/draft-and-create endpoint). After the bounded smoke+repair:

      - smoke ``passed`` / ``skipped``  -> leave the worker enabled (as today).
      - smoke ``failed`` (repairs exhausted) -> DISABLE the worker so the
        dashboard does not count it as healthy and a run on it is gated
        (``worker_disabled``). The worker STAYS editable — never deleted — so
        the operator can review/fix it. The create flow surfaces the smoke
        verdict from the returned dict.

    Returns the same dict ``_smoke_and_repair_generated_worker`` produces
    (``{"status","reason","repairs"}``). Never raises.
    """
    from run_service import _repos
    repos_obj = _repos(repos)
    smoke = _smoke_and_repair_generated_worker(
        worker_id,
        bundle,
        user_id=user_id,
        repos=repos_obj,
        log_fn=log_fn,
        allow_code_repair=allow_code_repair,
    )
    if smoke.get("status") == "failed":
        try:
            # Persist the disable into the MANIFEST first so it survives any
            # re-discover (`_persist_discovered_workers` recomputes enabled from
            # the manifest and would otherwise clobber a DB-only disable back to
            # enabled=1, because the generated manifest carries no enabled flag).
            # Then set the DB flag. Both together make the gate durable — the
            # worker stays disabled until the operator edits/re-enables it.
            # Done inline (not via main.*) so it cannot fail on a cross-module
            # import inside the async to_thread create path.
            _mark_worker_paused_on_disk(worker_id, paused=True)
            repos_obj.workers.update(
                user_id=user_id,
                worker_id=worker_id,
                enabled=False,
            )
            try:
                from worker_registry import invalidate_worker_cache as _invalidate

                _invalidate()
            except Exception:
                pass
            log_fn(
                "Generated worker disabled — its first test run failed: "
                f"{smoke.get('reason') or 'unknown'}. Review and edit it before turning it on.",
                level="warning",
            )
        except Exception:
            logger.exception("Failed to disable smoke-failed worker %s", worker_id)
    return smoke
