"""Emily worker authoring: manifest -> run.py generation and smoke gating.

The codegen + canonicalization + smoke-and-gate pipeline Emily uses when it
creates or updates a worker. Extracted verbatim from chat_service.py; self-contained
(stdlib + lazily-imported engine modules), no chat_service dependency. chat_service
re-imports these names.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("floom.chat")


def _generate_run_py_from_manifest(
    worker_id: str,
    manifest: Dict[str, Any],
    user_id: str,
    log_fn,
    *,
    force: bool = False,
) -> bool:
    """Synthesise a real run.py for a manifest-only worker, replacing the no-op stub.

    Emily produces a worker.yml but no code, so the registered bundle carries the
    placeholder run.py (``_DEFAULT_RUN_PY_STUB``). This drives the SAME codegen
    engine the smoke-repair loop uses (``run_service._repair_run_py``) with the
    worker's description as intent and the manifest as context, then persists the
    generated code through the canonical editor path (``main.persist_worker_run_py``)
    so the next run executes it. Returns True if real code was written.

    Best-effort: returns False on any failure (no OPENAI_API_KEY, codegen error,
    no placeholder present) — the caller still runs the smoke gate, which will
    disable the worker and surface the reason if it remains a no-op.
    """
    try:
        from worker_registry import WORKERS_DIR
        from run_service import _repair_run_py, _PLACEHOLDER_RUN_PY_MARKER
        from main import persist_worker_run_py
    except Exception:
        return False

    run_py_path = WORKERS_DIR / worker_id / "run.py"
    try:
        current = run_py_path.read_text(encoding="utf-8")
    except OSError:
        return False
    # Create only generates when the file is the no-op placeholder. Update can
    # force regeneration because Emily edits the manifest, not run.py; preserving
    # stale generated code makes behavior changes silently no-op at runtime.
    if not force and _PLACEHOLDER_RUN_PY_MARKER not in current:
        return False

    import yaml as _yaml
    import json as _json

    intent_parts = [
        str(manifest.get("description") or "").strip(),
        str(manifest.get("long_description") or "").strip(),
    ]
    intent = "\n".join(p for p in intent_parts if p) or str(
        manifest.get("title") or manifest.get("name") or worker_id
    )
    # Give the generator the full manifest so it implements EVERY declared input
    # and output, not just the description prose.
    try:
        manifest_yaml = _yaml.safe_dump(manifest, sort_keys=False)
    except Exception:
        manifest_yaml = _json.dumps(manifest, default=str)
    failure = (
        "The worker has only a placeholder run.py that returns empty outputs, so "
        "it produces none of its declared outputs. Implement the worker from its "
        "manifest below. Read inputs from inputs.json and write result.json "
        "with {\"status\",\"outputs\",\"artifacts\"}, filling EVERY declared "
        f"output.\n\nWorker manifest:\n{manifest_yaml[:4000]}"
    )

    secrets: Dict[str, str] = {}
    try:
        from run_service import get_secrets_for_worker
        secrets = get_secrets_for_worker(worker_id, user_id=user_id) or {}
    except Exception:
        secrets = {}

    fixed = _repair_run_py(
        run_code=current,
        failure=failure,
        secrets=secrets,
        log_fn=log_fn,
        intent=intent,
    )
    if not fixed:
        log_fn("run.py generation produced no code; smoke gate will disable worker", "warning")
        return False
    try:
        persist_worker_run_py(worker_id, fixed, user_id=user_id)
    except Exception as exc:
        log_fn(f"could not persist generated run.py: {exc}", "warning")
        return False
    action = "regenerated" if force else "generated"
    log_fn(f"{action} real run.py from manifest", "info")
    return True


def _canonicalize_emily_exec_command(
    yaml_text: str, existing_files: Optional[set] = None
) -> str:
    """Force a manifest-authored (Emily) worker onto a SINGLE execution path.

    Root cause of "Emily-created workers fail every real run despite the smoke
    gate reporting passed" (ISSUES.md #E1): Emily authors a *manifest*, not code.
    The runnable code is the generated ``run.py``. But ``exec.command`` OVERRIDES
    ``run.py`` in the E2B driver (``e2b_driver.py``: ``command = config.runtime.command``).
    When Emily — trying to self-repair a failing worker via ``workers__update`` —
    writes an inline ``exec.command`` heredoc, that heredoc becomes a SECOND,
    conflicting execution definition that wins over the generated ``run.py``. Her
    heredoc does not know the ``{status, outputs, artifacts}`` result.json contract
    (it lives only in the codegen prompt), so it writes the wrong shape and every
    real run fails validation, while the generated ``run.py`` is silently ignored.

    The discriminator is "does the worker's execution reference a REAL authored
    source file present on disk?":

      * LEGIT authored worker — any command or entry (in ``exec``, ``runtime``, or
        the legacy top-level ``entrypoint``) references a script file that EXISTS in
        ``existing_files`` (e.g. ``command: node run.js`` / ``entry: run.js`` with
        run.js on disk, with or without args, with ``./`` prefixes). The manifest is
        returned UNCHANGED — we never strip or rewrite a worker that has its own
        real code. This is robust to every authored shape (entry-based, command-only,
        runtime.command, args, ``./run.js``, multi-file Python).
      * MANIFEST-ONLY / DIVERGENT worker — no command or entry references an existing
        script file (the create case where Emily supplies only worker.yml, OR an
        Emily ``workers__update`` heredoc whose target file does not exist). Here we
        STRIP every ``command`` (an inline heredoc that would shadow the generated
        run.py) and redirect every ORPHANED non-run.py script entry to ``run.py`` so
        the generated run.py is the single executed script.

    Agent/skill-mode workers (``entry: SKILL.md`` / any ``.md``) carry no script and
    are LEFT UNTOUCHED.

    ``existing_files`` is the worker's actual on-disk file set on update (so real
    code is detected and preserved) and empty on create (the tool supplies no script
    source, so an orphaned heredoc/entry is always neutralised).

    Returns the (possibly rewritten) YAML text. Best-effort: on any parse error
    the original text is returned unchanged (the downstream parser will surface a
    clean validation error).
    """
    import yaml as _yaml

    existing = {str(f).strip() for f in (existing_files or set())}

    try:
        raw = _yaml.safe_load(yaml_text)
    except Exception:
        return yaml_text
    if not isinstance(raw, dict):
        return yaml_text

    import shlex as _shlex

    def _is_script_path(value: Any) -> bool:
        return isinstance(value, str) and value.strip().lower().endswith((".py", ".sh", ".js"))

    def _normalize_ref(value: str) -> str:
        # Strip a leading "./" so "./run.js" matches the on-disk "run.js".
        v = value.strip()
        return v[2:] if v.startswith("./") else v

    def _safe_split(text: str) -> list:
        # shlex handles quoted paths; fall back to plain split on malformed quoting.
        try:
            return _shlex.split(text)
        except Exception:
            return text.split()

    def _token_matches_source(tok: str) -> bool:
        """A single command/entry token references real on-disk source."""
        ref = _normalize_ref(tok)
        if ref in existing:
            return True
        # `python -m pkg.mod` -> a token like "pkg.mod" backs onto pkg/mod.py or
        # pkg/mod/__main__.py. Conservatively recognise both layouts so a legit
        # package-entry worker is preserved (Codex P1: python -m pkgworker).
        if ref and "/" not in ref and "." in ref:
            mod_path = ref.replace(".", "/")
            if f"{mod_path}.py" in existing or f"{mod_path}/__main__.py" in existing:
                return True
        elif ref and "/" not in ref:
            if f"{ref}.py" in existing or f"{ref}/__main__.py" in existing:
                return True
        return False

    def _references_existing_source() -> bool:
        """True iff ANY command/entry/entrypoint references real source present on
        disk — i.e. this is a legit authored worker we must leave entirely alone.
        Handles bare entries, command-only (with args / ./ prefixes / quoting),
        and `python -m <module>` package entries."""
        candidates: list = []
        for block_key in ("exec", "runtime"):
            block = raw.get(block_key)
            if isinstance(block, dict):
                candidates.append(("entry", block.get("entry")))
                candidates.append(("entry", block.get("entrypoint")))
                candidates.append(("command", block.get("command")))
        candidates.append(("entry", raw.get("entrypoint")))
        candidates.append(("command", raw.get("command")))
        for kind, cand in candidates:
            if not isinstance(cand, str) or not cand.strip():
                continue
            if kind == "entry":
                # A bare entry path references its own file directly.
                if _token_matches_source(cand):
                    return True
                continue
            # command: inspect every token (after the interpreter), incl. -m module.
            tokens = _safe_split(cand)
            for i, tok in enumerate(tokens):
                # `-m <module>` form: check the following token as a module.
                if tok == "-m" and i + 1 < len(tokens):
                    if _token_matches_source(tokens[i + 1]):
                        return True
                if _token_matches_source(tok):
                    return True
        return False

    # LEGIT authored worker: its execution references real on-disk source. Do not
    # touch it — stripping/rewriting would break a hand-authored run.js / node /
    # multi-file / package Python worker (Codex P1: command-only, args, ./run.js,
    # runtime.*, python -m pkg).
    if _references_existing_source():
        return yaml_text

    # MANIFEST-ONLY / DIVERGENT: no real source backs the declared execution.
    # Strip every command (heredoc shadow) and redirect orphaned script entries to
    # the generated run.py.
    changed = False
    for block_key in ("exec", "runtime"):
        block = raw.get(block_key)
        if isinstance(block, dict) and "command" in block:
            block.pop("command", None)
            changed = True
    if "command" in raw and isinstance(raw.get("command"), str):
        raw.pop("command", None)
        changed = True

    def _orphaned_script_entry(value: Any) -> bool:
        if not _is_script_path(value):
            return False
        ref = _normalize_ref(value)
        return ref != "run.py" and ref not in existing

    for block_key in ("exec", "runtime"):
        block = raw.get(block_key)
        if isinstance(block, dict):
            if _orphaned_script_entry(block.get("entry")):
                block["entry"] = "run.py"
                changed = True
            if _orphaned_script_entry(block.get("entrypoint")):
                block["entrypoint"] = "run.py"
                changed = True
    if _orphaned_script_entry(raw.get("entrypoint")):
        raw["entrypoint"] = "run.py"
        changed = True

    if not changed:
        return yaml_text
    try:
        return _yaml.safe_dump(raw, sort_keys=False, default_flow_style=False)
    except Exception:
        return yaml_text


def _manifest_executes_run_py(manifest: Dict[str, Any]) -> bool:
    """True iff the worker's EXECUTED entry is ``run.py`` (and nothing else signals
    a different executable).

    The run.py-specific machinery (stub backfill, codegen-from-manifest, the
    placeholder-marker smoke preflight) only makes sense for a manifest-only
    Python worker whose executed script IS ``run.py``. A worker whose entry is
    ``run.js`` / ``run.sh`` / a multi-file Python entry / ``SKILL.md`` — declared in
    ``exec``, ``runtime`` (incl. legacy ``runtime.entrypoint`` / ``runtime.command``),
    or the top-level ``entrypoint`` / ``command`` — must NOT get a run.py stub
    backfilled or be codegen'd/placeholder-gated on run.py; that would disable a
    perfectly good worker (Codex P1). We treat the worker as a run.py worker only
    when NO command/entry signals a non-run.py script.
    """
    def _norm(v: Any) -> Optional[str]:
        if not isinstance(v, str) or not v.strip():
            return None
        ref = v.strip()
        return ref[2:] if ref.startswith("./") else ref

    def _is_script_path(v: Optional[str]) -> bool:
        return isinstance(v, str) and v.lower().endswith((".py", ".sh", ".js"))

    # Resolve the EFFECTIVE entry exactly like the schema's precedence: an explicit
    # entry (exec/runtime/top-level) wins; else a command's script token; else the
    # canonical script default run.py. The worker is a run.py worker ONLY when that
    # resolved entry is literally run.py. An agent worker (entry: SKILL.md / any
    # non-script entry) is NOT a run.py worker (a missing extension / .md must never
    # fall through to "run.py" — Codex P1).
    # Precedence: exec.entry (canonical schema signal, S11) -> top-level entrypoint
    # -> runtime.entry/entrypoint.
    exec_block = manifest.get("exec") if isinstance(manifest.get("exec"), dict) else {}
    runtime_block = manifest.get("runtime") if isinstance(manifest.get("runtime"), dict) else {}
    explicit_entries = [
        _norm(exec_block.get("entry")),
        _norm(manifest.get("entrypoint")),
        _norm(exec_block.get("entrypoint")),
        _norm(runtime_block.get("entry")),
        _norm(runtime_block.get("entrypoint")),
    ]
    for e in explicit_entries:
        if e is not None:
            # First explicit entry signal decides (any non-run.py entry, incl.
            # SKILL.md/*.md, means NOT a run.py worker).
            return e == "run.py"

    # No explicit entry: the COMMAND defines the executable. A run.py worker's
    # canonical command is exactly "python run.py". Any other command — a script
    # token that is not run.py (node run.js), OR a non-script invocation
    # (python -m pkgworker, ./bin/start) — means this is NOT a run.py worker, so the
    # run.py machinery must not touch it (Codex P1: python -m package gate==runtime).
    for src in (manifest.get("exec"), manifest.get("runtime"), manifest):
        cmd = src.get("command") if isinstance(src, dict) else None
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        toks = cmd.strip().split()
        # A script token decides directly.
        script_tok = next((_norm(t) for t in toks if _is_script_path(_norm(t))), None)
        if script_tok is not None:
            return script_tok == "run.py"
        # No script token (e.g. python -m module): a run.py worker would never
        # author this, so treat it as a non-run.py executable.
        return False

    # Nothing specified at all: the schema default for a script worker is run.py.
    return True


def _smoke_gate_emily_worker(
    worker_id: str,
    manifest: Dict[str, Any],
    user_id: str,
) -> tuple[Optional[str], Optional[str]]:
    """Synthesise run.py from the manifest, then smoke-gate against the REAL run path.

    Shared by ``workers__create`` and ``workers__update`` so a worker can never be
    persisted by EITHER tool while it silently fails every real run. The gate uses
    the SAME ``driver.run`` + ``_validate_run_outputs`` path a real run uses
    (``run_service.smoke_and_gate_generated_worker``), so a ``passed`` verdict
    means the next real run passes too (gate == runtime). A ``failed`` verdict
    DISABLES the worker (kept editable) and is surfaced to the operator.

    Returns ``(smoke_status, smoke_reason)``. ``smoke_status`` is one of
    ``"passed" | "failed" | "skipped" | "errored"`` — never ``None``, so the
    caller can NEVER report "verified runnable" for a worker whose runtime
    validation did not actually run (``errored`` = the smoke infra raised;
    ``skipped`` = the gate could not prove the worker, e.g. missing
    secret/connection). Both are reported honestly, not as verified. Never raises.
    """
    smoke_status: str = "errored"
    smoke_reason: Optional[str] = None
    try:
        from run_service import smoke_and_gate_generated_worker
        from main import get_worker_config_for_run
        from db import get_repositories

        repos = get_repositories()

        sample_input = None
        try:
            cfg = get_worker_config_for_run(worker_id)
            sample_input = getattr(cfg, "example_input", None)
        except Exception:
            sample_input = None
        bundle: Dict[str, Any] = {}
        if isinstance(sample_input, dict):
            bundle["example_input"] = sample_input
        try:
            import yaml as _yaml

            bundle["worker_yml"] = _yaml.safe_dump(manifest, sort_keys=False)
        except Exception:
            bundle["worker_yml"] = json.dumps(manifest, default=str)

        def _smoke_log(msg: str, level: str = "info") -> None:
            logger.info("emily worker smoke %s: %s", worker_id, msg)

        # Emily authors a MANIFEST, not code, so a manifest-only PYTHON worker
        # (entry: run.py) ships the no-op placeholder run.py. Synthesise real
        # run.py FROM THE MANIFEST first (codegen, the same engine the smoke-repair
        # uses), persist it through the canonical editor path, and only THEN smoke.
        # The placeholder check inside _generate_run_py_from_manifest no-ops when
        # real code already exists. Skip this for non-run.py workers (run.js /
        # run.sh / multi-file Python / SKILL.md): they have their OWN entry source
        # and must NOT be codegen'd into a run.py they do not execute (Codex P1).
        if _manifest_executes_run_py(manifest):
            _generate_run_py_from_manifest(worker_id, manifest, user_id, _smoke_log)

        smoke = smoke_and_gate_generated_worker(
            worker_id,
            bundle,
            user_id=user_id,
            repos=repos,
            log_fn=_smoke_log,
            allow_code_repair=True,
        )
        if isinstance(smoke, dict):
            smoke_status = smoke.get("status") or "errored"
            smoke_reason = smoke.get("reason")
    except Exception:
        logger.exception("emily worker smoke+gate failed for %s", worker_id)
        smoke_status = "errored"
        smoke_reason = "could not run the verification test for this worker"
    return smoke_status, smoke_reason


def _emily_worker_result_message(
    worker_id: str, verb: str, smoke_status: Optional[str], smoke_reason: Optional[str]
) -> Dict[str, Any]:
    """Build the tool result for a create/update, HONEST about whether the worker
    was actually proven runnable.

    Only a ``"passed"`` smoke means "verified runnable". A ``"failed"`` worker is
    DISABLED. A ``"skipped"`` / ``"errored"`` worker was NOT validated at runtime,
    so we must NOT claim it is verified — that is exactly the passing-gate-that-
    lies failure mode. We surface the honest state so Emily tells the operator the
    truth (e.g. "created, but I could not test it yet because it needs a secret").
    """
    base = {"ok": True, "worker_id": worker_id, "smoke_status": smoke_status}
    if smoke_status == "failed":
        return {
            **base,
            "message": (
                f"Worker '{worker_id}' was {verb} but its test run failed "
                f"({smoke_reason or 'unknown'}); it is disabled until it runs clean. "
                "Adjust the worker, then re-run."
            ),
        }
    if smoke_status == "passed":
        return {**base, "message": f"Worker '{worker_id}' {verb} and verified runnable."}
    if smoke_status == "skipped":
        # A skip can mean "intentionally off" (paused/disabled) or "can't prove
        # yet" (needs a secret/connection). In both cases runtime validation did
        # NOT run, so never claim verified. Don't assert "enabled" — a disabled
        # worker's skip reason already explains it is off.
        return {
            **base,
            "message": (
                f"Worker '{worker_id}' was {verb}, but I could NOT verify it runs yet "
                f"({smoke_reason or 'verification was skipped'}). It is untested — "
                "run it once to confirm it works."
            ),
        }
    # errored / unknown: the verification machinery itself failed; do not claim runnable.
    return {
        **base,
        "message": (
            f"Worker '{worker_id}' was {verb}, but the verification test could not be run "
            f"({smoke_reason or 'verification error'}). It is enabled but UNVERIFIED — "
            "run it once and check the result before relying on it."
        ),
    }


