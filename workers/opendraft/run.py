from __future__ import annotations

import json
import logging
import os
import shutil
import time
import traceback
import zipfile
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv

    load_dotenv(".env.local")
except ImportError:
    pass


OUT_DIR = Path("out")
WORKSPACE_DIR = Path("workspace")
DEFAULT_MODEL_NAME = "gemini-3.1-pro-preview"


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _normalize_choice(value: Any, allowed: set[str], default: str) -> str:
    if value is None:
        return default
    text = str(value).strip()
    for option in allowed:
        if text.lower() == option.lower():
            return option
    raise ValueError(f"Invalid value {text!r}; expected one of: {', '.join(sorted(allowed))}")


def _artifact(path: Path, media_type: str) -> dict[str, Any]:
    relative = path.as_posix()
    return {
        "name": relative,
        "type": media_type,
        "path": relative,
        "relative_path": relative,
        "size_bytes": path.stat().st_size,
    }


def _zip_workspace(zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if WORKSPACE_DIR.exists():
            for file_path in sorted(WORKSPACE_DIR.rglob("*")):
                if file_path.is_file():
                    archive.write(file_path, file_path.as_posix())
        for file_path in sorted(OUT_DIR.rglob("*")):
            if file_path.is_file() and file_path != zip_path:
                archive.write(file_path, file_path.as_posix())


def _copy_if_exists(source: Path, destination: Path) -> bool:
    if not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return True


def _write_result(
    *,
    status: str,
    outputs: dict[str, Any],
    artifacts: list[dict[str, Any]],
    error: str | None = None,
    error_code: str | None = None,
) -> None:
    payload = {
        "status": status,
        "outputs": outputs,
        "artifacts": artifacts,
    }
    if error:
        payload["error"] = error
    if error_code:
        payload["error_code"] = error_code
    _write_json(Path("result.json"), payload)


def _collect_existing_artifacts(paths: dict[str, tuple[Path, str]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    outputs: dict[str, Any] = {}
    artifacts: list[dict[str, Any]] = []
    for name, (path, media_type) in paths.items():
        if path.is_file():
            outputs[name] = path.as_posix()
            artifacts.append(_artifact(path, media_type))
    return outputs, artifacts


def _attempt_exports(topic: str, export_pdf: bool, export_docx: bool, final_markdown: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "pdf": {"requested": export_pdf, "success": False, "path": None, "error": None},
        "docx": {"requested": export_docx, "success": False, "path": None, "error": None},
    }

    if export_pdf:
        pdf_path = OUT_DIR / "final_draft.pdf"
        try:
            from opendraft.export.pdf import export_pdf as opendraft_export_pdf

            success = opendraft_export_pdf(final_markdown, pdf_path, title=topic)
            report["pdf"].update({
                "success": bool(success and pdf_path.is_file()),
                "path": pdf_path.as_posix() if pdf_path.is_file() else None,
            })
            if not report["pdf"]["success"]:
                report["pdf"]["error"] = "OpenDraft PDF exporter returned false or did not create the file."
        except Exception as exc:
            report["pdf"]["error"] = f"{type(exc).__name__}: {exc}"

    if export_docx:
        docx_path = OUT_DIR / "final_draft.docx"
        try:
            from opendraft.export.docx import export_docx as opendraft_export_docx

            success = opendraft_export_docx(final_markdown, docx_path, title=topic)
            report["docx"].update({
                "success": bool(success and docx_path.is_file()),
                "path": docx_path.as_posix() if docx_path.is_file() else None,
            })
            if not report["docx"]["success"]:
                report["docx"]["error"] = "OpenDraft DOCX exporter returned false or did not create the file."
        except Exception as exc:
            report["docx"]["error"] = f"{type(exc).__name__}: {exc}"

    return report


def main() -> None:
    started = time.monotonic()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    inputs = _read_json("inputs.json", {})
    secrets = _read_json("secrets.json", {})
    if not os.environ.get("GOOGLE_API_KEY") and secrets.get("GOOGLE_API_KEY"):
        os.environ["GOOGLE_API_KEY"] = str(secrets["GOOGLE_API_KEY"])
    if not os.environ.get("GOOGLE_API_KEY"):
        raise ValueError("GOOGLE_API_KEY is required for the real OpenDraft engine.")

    topic = str(inputs.get("topic") or "").strip()
    if not topic:
        raise ValueError("Input 'topic' is required.")

    citation_style = _normalize_choice(
        inputs.get("citation_style"),
        {"APA 7th", "IEEE", "Chicago", "MLA"},
        "APA 7th",
    )
    language = _normalize_choice(
        inputs.get("language"),
        {"english", "german", "spanish", "french"},
        "english",
    )
    model_name = (
        str(inputs.get("model_name") or "").strip()
        or os.environ.get("OPENDRAFT_GEMINI_MODEL")
        or DEFAULT_MODEL_NAME
    )
    export_pdf = _as_bool(inputs.get("export_pdf"), True)
    export_docx = _as_bool(inputs.get("export_docx"), True)
    enable_citation_verification = _as_bool(inputs.get("enable_citation_verification"), True)
    os.environ["ENABLE_CITATION_VERIFICATION"] = "true" if enable_citation_verification else "false"

    phase_events: list[dict[str, Any]] = []
    write_events: list[dict[str, Any]] = []

    def on_phase_start(num: int, total: int, name: str, desc: str) -> None:
        print(f"[opendraft] phase {num}/{total} start: {name} - {desc}", flush=True)
        phase_events.append({"event": "start", "num": num, "total": total, "name": name, "description": desc})

    def on_phase_complete(num: int, total: int, name: str, result: Any) -> None:
        signal = getattr(result, "signal", None)
        metadata = getattr(result, "metadata", {}) or {}
        print(f"[opendraft] phase {num}/{total} complete: {name} - signal={signal}", flush=True)
        phase_events.append({
            "event": "complete",
            "num": num,
            "total": total,
            "name": name,
            "signal": signal,
            "timed_out": bool(metadata.get("timed_out")),
            "cost": metadata.get("cost"),
            "output_chars": len(getattr(result, "output", "") or ""),
        })

    def on_write(filename: str, word_count: int) -> None:
        print(f"[opendraft] wrote {filename} ({word_count} words)", flush=True)
        write_events.append({"filename": filename, "word_count": word_count})

    from opendraft.generate import generate_draft

    final_draft = generate_draft(
        topic=topic,
        citation_style=citation_style,
        language=language,
        model_name=model_name,
        workspace_dir=WORKSPACE_DIR,
        on_phase_start=on_phase_start,
        on_phase_complete=on_phase_complete,
        on_write=on_write,
    )

    if not final_draft:
        for candidate in (WORKSPACE_DIR / "final_draft.md", WORKSPACE_DIR / "compiled_draft.md", WORKSPACE_DIR / "draft.md"):
            if candidate.is_file():
                final_draft = candidate.read_text(encoding="utf-8")
                break
    if not final_draft:
        raise RuntimeError("OpenDraft completed without producing final draft text.")

    final_markdown = OUT_DIR / "final_draft.md"
    final_markdown.write_text(final_draft, encoding="utf-8")

    _copy_if_exists(WORKSPACE_DIR / "citation_database.json", OUT_DIR / "citation_database.json")
    export_report = _attempt_exports(topic, export_pdf, export_docx, final_markdown)
    _write_json(OUT_DIR / "export_report.json", export_report)

    duration_seconds = round(time.monotonic() - started, 2)
    metadata = {
        "engine": "federicodeponte/opendraft",
        "mode": "real_engine",
        "topic": topic,
        "citation_style": citation_style,
        "language": language,
        "model_name": model_name,
        "duration_seconds": duration_seconds,
        "word_count": len(final_draft.split()),
        "char_count": len(final_draft),
        "phase_events": phase_events,
        "write_events": write_events,
        "workspace_files": sorted(
            path.relative_to(WORKSPACE_DIR).as_posix()
            for path in WORKSPACE_DIR.rglob("*")
            if path.is_file()
        ),
        "export_report": export_report,
    }
    _write_json(OUT_DIR / "run_metadata.json", metadata)

    _zip_workspace(OUT_DIR / "opendraft_workspace.zip")

    outputs, artifacts = _collect_existing_artifacts({
        "final_draft": (OUT_DIR / "final_draft.md", "text/markdown"),
        "run_metadata": (OUT_DIR / "run_metadata.json", "application/json"),
        "export_report": (OUT_DIR / "export_report.json", "application/json"),
        "citation_database": (OUT_DIR / "citation_database.json", "application/json"),
        "workspace_archive": (OUT_DIR / "opendraft_workspace.zip", "application/zip"),
        "pdf": (OUT_DIR / "final_draft.pdf", "application/pdf"),
        "docx": (
            OUT_DIR / "final_draft.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
    })
    outputs.update({
        "word_count": metadata["word_count"],
        "duration_seconds": duration_seconds,
        "pdf_export_success": export_report["pdf"]["success"],
        "docx_export_success": export_report["docx"]["success"],
    })
    _write_result(status="success", outputs=outputs, artifacts=artifacts)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        error_payload = {
            "error": str(exc),
            "type": type(exc).__name__,
            "traceback": traceback.format_exc(),
        }
        _write_json(OUT_DIR / "error_report.json", error_payload)
        try:
            _zip_workspace(OUT_DIR / "opendraft_workspace.zip")
        except Exception:
            pass
        outputs, artifacts = _collect_existing_artifacts({
            "error_report": (OUT_DIR / "error_report.json", "application/json"),
            "workspace_archive": (OUT_DIR / "opendraft_workspace.zip", "application/zip"),
        })
        _write_result(
            status="error",
            outputs=outputs,
            artifacts=artifacts,
            error=str(exc),
            error_code="opendraft_real_engine_failed",
        )
