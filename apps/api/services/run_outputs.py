"""Run output handling: artifact storage, declared-output materialization,
and output validation (schema substance + worked-example parity).

Extracted verbatim from run_service.py. run_service re-imports these names for
backward compatibility, so every existing ``from run_service import ...`` keeps
working. The run-scope / SSE / now-iso helpers used only by artifact storage are
lazy-imported from run_service to avoid a module-load circular import.
"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any, Callable, Dict

from db.factory import Repositories
from models import WorkerConfig
from runner_utils import ARTIFACTS_DIR

import logging
logger = logging.getLogger("floom.run_service")


_PLACEHOLDER_MARKERS = (
    "i don't have access",
    "i cannot fetch",
    "i can't fetch",
    "please provide an api key",
    "placeholder",
)
_PATH_VALUE_RE = re.compile(r"^(?:\.?/)?(?:out|outputs|output|artifacts|inputs)/[A-Za-z0-9._/@ -]+$")


def _store_run_artifacts(
    run_id: str,
    artifacts: list[Dict[str, Any]],
    log_fn: Callable[[str, str], None],
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    from run_service import _now_iso, _publish_sse, _repos, _run_scope

    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    for art in artifacts:
        try:
            art_id = f"art_{uuid.uuid4().hex[:12]}"
            art_name = art.get("name", "artifact")
            art_type = art.get("type", "file")
            art_path = art.get("path", "")
            art_size = art.get("size_bytes", 0)
            art_created = _now_iso()
            repos_obj.runs.add_artifact(
                user_id=owner_id,
                run_id=run_id,
                artifact_id=art_id,
                name=art_name,
                artifact_type=art_type,
                path=art_path,
                size_bytes=art_size,
                created_at=art_created,
            )
            _publish_sse(run_id, {
                "type": "artifact",
                "run_id": run_id,
                "artifact": {
                    "id": art_id,
                    "name": art_name,
                    "artifact_type": art_type,
                    "size_bytes": art_size,
                    "created_at": art_created,
                },
            })
        except Exception as exc:
            logger.exception("Failed to store artifact")
            log_fn(f"Failed to store artifact: {exc}", level="warning")


def _looks_like_relative_path(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\n" in text or "://" in text or text.startswith("/"):
        return False
    if _PATH_VALUE_RE.fullmatch(text):
        return True
    suffixes = (".md", ".txt", ".json", ".csv", ".html", ".pdf", ".docx")
    return "/" in text and text.lower().endswith(suffixes)


def _placeholder_warning(value: Any, output_name: str) -> str | None:
    if not isinstance(value, str):
        return None
    first = value.strip().lower()[:200]
    if not first:
        return None
    if any(marker in first for marker in _PLACEHOLDER_MARKERS):
        return f"{output_name}: output looks like placeholder/apology content"
    if first.startswith("note:"):
        return f"{output_name}: output starts with Note:"
    return None


def _output_artifact(output: Any, artifacts: list[Dict[str, Any]]) -> Dict[str, Any] | None:
    expected = (getattr(output, "path", None) or "").strip()
    output_name = getattr(output, "name", "")
    for artifact in artifacts:
        names = {
            str(artifact.get("relative_path") or ""),
            str(artifact.get("name") or ""),
        }
        if expected and expected in names:
            return artifact
        if output_name and output_name in names:
            return artifact
        if expected and any(name.endswith(f"/{expected}") for name in names):
            return artifact
    return None


def _candidate_output_path(run_id: str, output: Any, outputs: Dict[str, Any], artifacts: list[Dict[str, Any]]) -> Path | None:
    artifact = _output_artifact(output, artifacts)
    if artifact and artifact.get("path"):
        return Path(str(artifact["path"]))
    # #913: declared/echoed output paths are author-controlled. `root / path`
    # with an absolute path DISCARDS root entirely (pathlib semantics), so a
    # manifest declaring `path: /etc/passwd` pointed the validator at the host
    # filesystem and leaked file contents through smoke-test mismatch errors.
    # Confine both to the run's artifact directory; out-of-bounds paths are
    # treated as "output missing", never read.
    declared_path = getattr(output, "path", None)
    if declared_path:
        try:
            return _safe_artifact_path(run_id, str(declared_path))
        except ValueError:
            return None
    value = outputs.get(getattr(output, "name", ""))
    if isinstance(value, str) and _looks_like_relative_path(value):
        try:
            return _safe_artifact_path(run_id, value.strip())
        except ValueError:
            return None
    return None


def _safe_artifact_path(run_id: str, relative_path: str) -> Path:
    root = (ARTIFACTS_DIR / run_id).resolve()
    target = (root / relative_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError(f"output path escapes artifact directory: {relative_path}")
    return target


def _materialize_declared_file_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> None:
    for output in config.outputs:
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        if kind != "file" or output.name not in outputs or _output_artifact(output, artifacts):
            continue
        relative_path = output.path or f"outputs/{output.name}.txt"
        path = _safe_artifact_path(run_id, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        value = outputs[output.name]
        content = value if isinstance(value, str) else json.dumps(value, indent=2)
        path.write_text(content, encoding="utf-8")
        artifacts.append(
            {
                "name": relative_path,
                "relative_path": relative_path,
                "type": output.media_type or "text/plain",
                "path": str(path),
                "size_bytes": path.stat().st_size,
            }
        )


def _validate_run_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> tuple[str | None, list[str]]:
    warnings: list[str] = []
    for output in config.outputs:
        name = output.name
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        value = outputs.get(name)

        if output.required and name not in outputs:
            return f"output_validation_failed: {name} missing required output", warnings

        if kind == "file":
            if not output.required and name not in outputs and not _output_artifact(output, artifacts):
                continue
            path = _candidate_output_path(run_id, output, outputs, artifacts)
            if path is None:
                return f"output_validation_failed: {name} missing output file", warnings
            if not path.is_file():
                return f"output_validation_failed: {name} file not found at {path.name}", warnings
            size = path.stat().st_size
            if size == 0:
                return f"output_validation_failed: {name} file is empty", warnings
            media_type = (output.media_type or "").lower()
            if media_type == "application/json":
                # A valid, parseable JSON document is a legitimate result at any
                # non-zero size — gate on parseability, never the byte floor.
                try:
                    json.loads(path.read_text(encoding='utf-8'))
                except Exception as exc:
                    return f"output_validation_failed: {name} JSON file is invalid: {exc}", warnings
                continue
            if not media_type:
                # Unknown type: if it parses as JSON, accept as structured data.
                try:
                    json.loads(path.read_text(encoding='utf-8'))
                    continue
                except Exception:
                    pass
            # Non-JSON file (text/csv/etc): a valid, non-empty result of ANY size
            # is legitimate. There is no byte floor — a 36-byte sorted CSV or a
            # short uppercased name list is a correct output. Only truly empty /
            # whitespace-only content fails; near-empty apology/placeholder prose
            # is surfaced as a WARNING, never a hard failure.
            text = path.read_text(errors="ignore")
            if not text.strip():
                return f"output_validation_failed: {name} file is empty", warnings
            warning = _placeholder_warning(text[:1000], name)
            if warning:
                warnings.append(warning)
            continue

        if output.required and (value is None or value == ""):
            return f"output_validation_failed: {name} scalar output is empty", warnings
        if _looks_like_relative_path(value):
            return f"output_validation_failed: {name} scalar output leaked a path string", warnings
        warning = _placeholder_warning(value, name)
        if warning:
            warnings.append(warning)

    return None, warnings


def _smoke_empty_output_error(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> str | None:
    """Smoke-only: a REQUIRED output that parses as an empty JSON container
    (``[]`` / ``{}`` / ``""`` / null) is a green-but-empty no-op at smoke time.

    Returns an error string for the FIRST such output, else None. Only required
    file/scalar outputs are checked; the normal run validator stays unchanged.
    """
    for output in config.outputs:
        if not output.required:
            continue
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        parsed: Any = None
        if kind == "file":
            path = _candidate_output_path(run_id, output, outputs, artifacts)
            if path is None or not path.is_file():
                continue
            text = path.read_text(errors="ignore")
            try:
                parsed = json.loads(text)
            except Exception:
                # Non-JSON text already passed the non-empty check upstream.
                continue
        else:
            parsed = outputs.get(output.name)
        if parsed is None or parsed == [] or parsed == {} or parsed == "":
            return (
                f"output_validation_failed: {output.name} produced an empty result "
                "(the worker ran but did nothing)"
            )
    return None


def _parse_expected_example_output(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list, int, float, bool)):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    for parser in (json.loads,):
        try:
            return parser(text)
        except Exception:
            pass
    try:
        import yaml as pyyaml

        parsed = pyyaml.safe_load(text)
        if parsed is not None:
            return parsed
    except Exception:
        pass
    return text


def _expected_example_output_from_bundle(bundle: Dict[str, Any]) -> Any:
    if "example_output" in bundle:
        return _parse_expected_example_output(bundle.get("example_output"))
    worker_yml = bundle.get("worker_yml")
    if isinstance(worker_yml, str) and worker_yml.strip():
        try:
            import yaml as pyyaml

            raw = pyyaml.safe_load(worker_yml) or {}
            if isinstance(raw, dict):
                return _parse_expected_example_output(raw.get("example_output"))
        except Exception:
            return None
    return None


def _normalize_example_value(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""
        try:
            return json.loads(text)
        except Exception:
            return text
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _example_values_equal(actual: Any, expected: Any) -> bool:
    actual_norm = _normalize_example_value(actual)
    expected_norm = _normalize_example_value(expected)
    if actual_norm == expected_norm:
        return True
    try:
        return float(actual_norm) == float(expected_norm)
    except (TypeError, ValueError):
        return False


def _actual_example_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> Dict[str, Any]:
    actual = dict(outputs or {})
    for output in config.outputs:
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        if kind != "file":
            continue
        path = _candidate_output_path(run_id, output, outputs, artifacts)
        if path is not None and path.is_file():
            actual[output.name] = path.read_text(errors="replace").strip()
    return actual


def _validate_example_output(
    run_id: str,
    config: WorkerConfig,
    bundle: Dict[str, Any],
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> str | None:
    expected = _expected_example_output_from_bundle(bundle)
    if expected is None:
        return None
    actual = _actual_example_outputs(run_id, config, outputs, artifacts)
    if isinstance(expected, dict):
        for name, expected_value in expected.items():
            if name not in actual:
                return f"output_validation_failed: example_output mismatch for {name}: missing actual output"
            if not _example_values_equal(actual.get(name), expected_value):
                return (
                    f"output_validation_failed: example_output mismatch for {name}: "
                    f"expected {expected_value!r}, got {actual.get(name)!r}"
                )
        return None
    if len(config.outputs) == 1:
        name = config.outputs[0].name
        if not _example_values_equal(actual.get(name), expected):
            return (
                f"output_validation_failed: example_output mismatch for {name}: "
                f"expected {expected!r}, got {actual.get(name)!r}"
            )
    return None


