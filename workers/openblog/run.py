from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
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
ENGINE_DIR = Path(__file__).resolve().parent / "engine"
ARTICLE_EXPORT_DIR = OUT_DIR / "articles"
IMAGE_EXPORT_DIR = OUT_DIR / "images"
DEFAULT_EXPORT_FORMATS = ["html", "markdown", "json", "csv", "xlsx", "pdf"]
EXPORT_MEDIA_TYPES = {
    "html": "text/html",
    "markdown": "text/markdown",
    "json": "application/json",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
}


if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


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


def _as_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if value in (None, ""):
        return default
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"Expected integer between {minimum} and {maximum}, got {parsed}")
    return parsed


def _parse_keywords(raw: Any, default_word_count: int, batch_instructions: str | None) -> list[Any]:
    if isinstance(raw, list):
        items = raw
    else:
        text = str(raw or "").strip()
        if not text:
            return []
        items = [line.strip() for line in text.replace(",", "\n").splitlines()]

    parsed: list[Any] = []
    for item in items:
        if isinstance(item, dict):
            keyword = str(item.get("keyword") or "").strip()
            if keyword:
                entry = dict(item)
                entry["keyword"] = keyword
                entry.setdefault("word_count", default_word_count)
                if batch_instructions and not entry.get("keyword_instructions"):
                    entry["keyword_instructions"] = batch_instructions
                parsed.append(entry)
        else:
            keyword = str(item or "").strip()
            if keyword:
                entry: dict[str, Any] = {"keyword": keyword, "word_count": default_word_count}
                if batch_instructions:
                    entry["keyword_instructions"] = batch_instructions
                parsed.append(entry)
    return parsed


def _parse_export_formats(raw: Any) -> list[str]:
    if raw in (None, ""):
        return list(DEFAULT_EXPORT_FORMATS)
    if isinstance(raw, list):
        values = raw
    else:
        values = str(raw).replace(",", " ").split()
    formats: list[str] = []
    for value in values:
        fmt = str(value).strip().lower()
        if not fmt:
            continue
        if fmt not in EXPORT_MEDIA_TYPES:
            raise ValueError(f"Unsupported export format {fmt!r}")
        if fmt not in formats:
            formats.append(fmt)
    return formats or list(DEFAULT_EXPORT_FORMATS)


def _artifact(path: Path, media_type: str) -> dict[str, Any]:
    relative = path.as_posix()
    return {
        "name": relative,
        "type": media_type,
        "path": relative,
        "relative_path": relative,
        "size_bytes": path.stat().st_size,
    }


def _write_result(
    *,
    status: str,
    outputs: dict[str, Any],
    artifacts: list[dict[str, Any]],
    error: str | None = None,
    error_code: str | None = None,
) -> None:
    payload = {"status": status, "outputs": outputs, "artifacts": artifacts}
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


def _zip_directory(source_dir: Path, zip_path: Path) -> bool:
    if not source_dir.exists():
        return False
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_file() and file_path != zip_path:
                archive.write(file_path, file_path.relative_to(source_dir).as_posix())
    return True


def _copy_file(source: Path, destination: Path) -> bool:
    if not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return True


def _first_successful_article(result: dict[str, Any]) -> dict[str, Any] | None:
    for article_result in result.get("results") or []:
        if article_result.get("article") and not article_result.get("error"):
            return article_result
    return None


def _copy_first_exports(result: dict[str, Any]) -> dict[str, str]:
    copied: dict[str, str] = {}
    first = _first_successful_article(result)
    if not first:
        return copied
    for fmt, raw_path in (first.get("exported_files") or {}).items():
        source = Path(str(raw_path))
        suffix = source.suffix or f".{fmt}"
        target = OUT_DIR / f"article{suffix}"
        if _copy_file(source, target):
            copied[fmt] = target.as_posix()
    return copied


def _write_markdown_bundle(result: dict[str, Any], copied_exports: dict[str, str]) -> Path:
    markdown_path = OUT_DIR / "markdown.md"
    if copied_exports.get("markdown"):
        _copy_file(Path(copied_exports["markdown"]), markdown_path)
        return markdown_path

    first = _first_successful_article(result)
    if first and first.get("article"):
        from app import article_to_markdown

        markdown_path.write_text(article_to_markdown(first["article"]), encoding="utf-8")
        return markdown_path

    markdown_path.write_text("", encoding="utf-8")
    return markdown_path


def _write_preview_html(copied_exports: dict[str, str]) -> Path | None:
    if not copied_exports.get("html"):
        return None
    preview_path = OUT_DIR / "preview.html"
    _copy_file(Path(copied_exports["html"]), preview_path)
    return preview_path


def _copy_generated_images(result: dict[str, Any]) -> list[dict[str, Any]]:
    image_artifacts: list[dict[str, Any]] = []
    IMAGE_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    for article_result in result.get("results") or []:
        slug = str(article_result.get("slug") or article_result.get("keyword") or "article")
        for image in article_result.get("images") or []:
            raw_url = str(image.get("url") or "")
            source = Path(raw_url)
            if not source.is_file():
                continue
            position = str(image.get("position") or "image")
            destination = IMAGE_EXPORT_DIR / f"{slug}-{position}{source.suffix or '.img'}"
            _copy_file(source, destination)
            artifact = {
                "keyword": article_result.get("keyword"),
                "position": position,
                "source_path": raw_url,
                "artifact_path": destination.as_posix(),
                "size_bytes": destination.stat().st_size,
            }
            image["artifact_path"] = destination.as_posix()
            image_artifacts.append(artifact)
    return image_artifacts


def _build_export_report(
    result: dict[str, Any],
    requested_formats: list[str],
    skip_images: bool,
    image_artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    articles = result.get("results") or []
    successful = [article for article in articles if article.get("article") and not article.get("error")]
    format_report: dict[str, Any] = {}
    for fmt in requested_formats:
        missing = []
        present = []
        for article in successful:
            path = (article.get("exported_files") or {}).get(fmt)
            if path and Path(str(path)).is_file():
                present.append({"keyword": article.get("keyword"), "path": str(path), "size_bytes": Path(str(path)).stat().st_size})
            else:
                missing.append(article.get("keyword"))
        format_report[fmt] = {
            "requested": True,
            "success": bool(successful) and not missing,
            "present": present,
            "missing_keywords": missing,
        }

    expected_images = 0 if skip_images else len(successful) * 3
    return {
        "articles_total": result.get("articles_total"),
        "articles_successful": result.get("articles_successful"),
        "articles_failed": result.get("articles_failed"),
        "formats": format_report,
        "images": {
            "requested": not skip_images,
            "expected": expected_images,
            "copied": len(image_artifacts),
            "success": skip_images or len(image_artifacts) >= expected_images,
            "artifacts": image_artifacts,
        },
    }


async def _run_openblog(
    *,
    keywords: list[Any],
    company_url: str,
    language: str,
    market: str,
    skip_images: bool,
    max_parallel: int,
    export_formats: list[str],
) -> dict[str, Any]:
    from run_pipeline import run_pipeline

    return await run_pipeline(
        keywords=keywords,
        company_url=company_url,
        language=language,
        market=market,
        skip_images=skip_images,
        max_parallel=max_parallel,
        output_dir=ARTICLE_EXPORT_DIR,
        export_formats=export_formats,
    )


def main() -> None:
    started = time.monotonic()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ARTICLE_EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    inputs = _read_json("inputs.json", {})
    secrets = _read_json("secrets.json", {})
    if not os.environ.get("GEMINI_API_KEY") and secrets.get("GEMINI_API_KEY"):
        os.environ["GEMINI_API_KEY"] = str(secrets["GEMINI_API_KEY"])
    if not os.environ.get("GEMINI_API_KEY"):
        raise ValueError("GEMINI_API_KEY is required for the real OpenBlog engine.")

    company_url = str(inputs.get("url") or inputs.get("company_url") or "").strip()
    if not company_url:
        raise ValueError("Input 'url' is required.")
    if not company_url.startswith(("http://", "https://")):
        company_url = f"https://{company_url}"

    language = str(inputs.get("language") or "en").strip() or "en"
    market = str(inputs.get("market") or "US").strip() or "US"
    default_word_count = _as_int(inputs.get("default_word_count") or inputs.get("word_count"), 2000, 500, 10000)
    batch_instructions = str(inputs.get("batch_instructions") or "").strip() or None
    keywords = _parse_keywords(inputs.get("keywords"), default_word_count, batch_instructions)
    if not keywords:
        raise ValueError("Input 'keywords' is required.")

    skip_images = _as_bool(inputs.get("skip_images"), False)
    max_parallel = _as_int(inputs.get("max_parallel"), 3, 1, 10)
    export_formats = _parse_export_formats(inputs.get("export_formats"))
    model_name = str(inputs.get("model_name") or os.environ.get("GEMINI_MODEL") or "gemini-3-flash-preview").strip()
    os.environ["GEMINI_MODEL"] = model_name

    print(
        "[openblog] starting real pipeline: "
        f"url={company_url} keywords={len(keywords)} skip_images={skip_images} "
        f"formats={','.join(export_formats)} model={model_name}",
        flush=True,
    )

    result = asyncio.run(_run_openblog(
        keywords=keywords,
        company_url=company_url,
        language=language,
        market=market,
        skip_images=skip_images,
        max_parallel=max_parallel,
        export_formats=export_formats,
    ))

    image_artifacts = _copy_generated_images(result)
    copied_exports = _copy_first_exports(result)
    markdown_path = _write_markdown_bundle(result, copied_exports)
    preview_path = _write_preview_html(copied_exports)

    duration_seconds = round(time.monotonic() - started, 2)
    result["duration_seconds_wrapper"] = duration_seconds
    result["image_artifacts"] = image_artifacts
    _write_json(OUT_DIR / "raw.json", result)

    export_report = _build_export_report(result, export_formats, skip_images, image_artifacts)
    _write_json(OUT_DIR / "export_report.json", export_report)

    metadata = {
        "engine": "federicodeponte/openblog",
        "mode": "real_engine",
        "company_url": company_url,
        "keywords": keywords,
        "language": language,
        "market": market,
        "model_name": model_name,
        "skip_images": skip_images,
        "max_parallel": max_parallel,
        "export_formats": export_formats,
        "duration_seconds": duration_seconds,
        "pipeline_duration_seconds": result.get("duration_seconds"),
        "articles_total": result.get("articles_total"),
        "articles_successful": result.get("articles_successful"),
        "articles_failed": result.get("articles_failed"),
        "export_report": export_report,
    }
    _write_json(OUT_DIR / "run_metadata.json", metadata)

    _zip_directory(ARTICLE_EXPORT_DIR, OUT_DIR / "openblog_articles.zip")
    _zip_directory(IMAGE_EXPORT_DIR, OUT_DIR / "openblog_images.zip")
    _zip_directory(OUT_DIR, OUT_DIR / "openblog_workspace.zip")

    outputs, artifacts = _collect_existing_artifacts({
        "markdown": (markdown_path, "text/markdown"),
        "raw": (OUT_DIR / "raw.json", "application/json"),
        "run_metadata": (OUT_DIR / "run_metadata.json", "application/json"),
        "export_report": (OUT_DIR / "export_report.json", "application/json"),
        "preview_html": (preview_path or OUT_DIR / "preview.html", "text/html"),
        "article_html": (OUT_DIR / "article.html", "text/html"),
        "article_json": (OUT_DIR / "article.json", "application/json"),
        "article_csv": (OUT_DIR / "article.csv", "text/csv"),
        "article_xlsx": (
            OUT_DIR / "article.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "article_pdf": (OUT_DIR / "article.pdf", "application/pdf"),
        "articles_archive": (OUT_DIR / "openblog_articles.zip", "application/zip"),
        "images_archive": (OUT_DIR / "openblog_images.zip", "application/zip"),
        "workspace_archive": (OUT_DIR / "openblog_workspace.zip", "application/zip"),
    })

    missing_formats = [
        fmt
        for fmt, report in export_report["formats"].items()
        if report["requested"] and not report["success"]
    ]
    images_ok = export_report["images"]["success"]
    articles_failed = int(result.get("articles_failed") or 0)
    status = "success"
    error = None
    error_code = None
    if articles_failed or missing_formats or not images_ok:
        status = "error"
        error_code = "openblog_real_engine_incomplete"
        parts = []
        if articles_failed:
            parts.append(f"{articles_failed} article(s) failed")
        if missing_formats:
            parts.append(f"missing requested exports: {', '.join(missing_formats)}")
        if not images_ok:
            parts.append(
                "image generation incomplete: "
                f"{export_report['images']['copied']}/{export_report['images']['expected']} images"
            )
        error = "; ".join(parts)

    outputs.update({
        "duration_seconds": duration_seconds,
        "pipeline_duration_seconds": result.get("duration_seconds"),
        "articles_total": result.get("articles_total"),
        "articles_successful": result.get("articles_successful"),
        "articles_failed": result.get("articles_failed"),
        "image_generation_success": images_ok,
        "images_copied": export_report["images"]["copied"],
        "pdf_export_success": export_report["formats"].get("pdf", {}).get("success"),
        "status_detail": error or "complete",
    })
    _write_result(status=status, outputs=outputs, artifacts=artifacts, error=error, error_code=error_code)


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
        _zip_directory(OUT_DIR, OUT_DIR / "openblog_workspace.zip")
        outputs, artifacts = _collect_existing_artifacts({
            "error_report": (OUT_DIR / "error_report.json", "application/json"),
            "workspace_archive": (OUT_DIR / "openblog_workspace.zip", "application/zip"),
        })
        _write_result(
            status="error",
            outputs=outputs,
            artifacts=artifacts,
            error=str(exc),
            error_code="openblog_real_engine_failed",
        )
