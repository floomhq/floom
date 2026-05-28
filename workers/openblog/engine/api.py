"""
OpenBlog Neo - FastAPI Application

RESTful API wrapper for the blog generation pipeline.

Usage:
    uvicorn api:app --reload --port 8000

API Docs:
    - Swagger UI: http://localhost:8000/docs
    - ReDoc: http://localhost:8000/redoc
    - OpenAPI JSON: http://localhost:8000/openapi.json
"""

import asyncio
import re
import threading
import uuid
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, HttpUrl, field_validator

# Import pipeline
from run_pipeline import run_pipeline, process_single_article

# =============================================================================
# Pydantic Models for API
# =============================================================================

class JobStatus(str, Enum):
    """Job status enumeration."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


# Valid export formats (whitelist for security)
VALID_EXPORT_FORMATS = {"html", "markdown", "json", "csv", "xlsx", "pdf"}


class PipelineRequest(BaseModel):
    """Request model for starting a pipeline job."""
    keywords: List[str] = Field(
        ...,
        min_length=1,
        max_length=20,
        description="List of keywords to generate articles for (1-20)",
        json_schema_extra={"example": ["AI in healthcare", "Machine learning basics"]}
    )
    company_url: HttpUrl = Field(
        ...,
        description="Company website URL for context",
        json_schema_extra={"example": "https://example.com"}
    )
    language: str = Field(
        default="en",
        max_length=10,
        pattern=r"^[a-z]{2}(-[A-Z]{2})?$",
        description="Target language code (ISO 639-1)",
        json_schema_extra={"example": "en"}
    )
    market: str = Field(
        default="US",
        max_length=10,
        pattern=r"^[A-Z]{2,3}$",
        description="Target market code",
        json_schema_extra={"example": "US"}
    )
    skip_images: bool = Field(
        default=False,
        description="Skip image generation to speed up processing"
    )
    max_parallel: Optional[int] = Field(
        default=None,
        ge=1,
        le=10,
        description="Max concurrent articles (1-10, None = unlimited)"
    )
    export_formats: List[str] = Field(
        default=["html", "json"],
        description="Export formats: html, markdown, json, csv, xlsx, pdf"
    )

    @field_validator("keywords")
    @classmethod
    def validate_keywords(cls, v: List[str]) -> List[str]:
        """Validate keywords are non-empty strings."""
        validated = [kw.strip() for kw in v if kw and kw.strip()]
        if not validated:
            raise ValueError("At least one non-empty keyword is required")
        if len(validated) > 20:
            raise ValueError("Maximum 20 keywords allowed")
        return validated

    @field_validator("export_formats")
    @classmethod
    def validate_export_formats(cls, v: List[str]) -> List[str]:
        """Validate export formats against whitelist."""
        invalid = set(v) - VALID_EXPORT_FORMATS
        if invalid:
            raise ValueError(f"Invalid export formats: {invalid}. Valid: {VALID_EXPORT_FORMATS}")
        return v


class JobResponse(BaseModel):
    """Response model for job creation."""
    job_id: str = Field(..., description="Unique job identifier")
    status: JobStatus = Field(..., description="Current job status")
    message: str = Field(..., description="Status message")
    created_at: str = Field(..., description="Job creation timestamp")


class JobStatusResponse(BaseModel):
    """Response model for job status check."""
    job_id: str
    status: JobStatus
    progress: Optional[Dict] = Field(None, description="Progress details")
    result: Optional[Dict] = Field(None, description="Pipeline result (when completed)")
    error: Optional[str] = Field(None, description="Error message (when failed)")
    created_at: str
    updated_at: str


class ArticlePreviewResponse(BaseModel):
    """Response model for article preview."""
    job_id: str
    keyword: str
    headline: Optional[str] = None
    meta_description: Optional[str] = None
    word_count: Optional[int] = None
    status: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str = "healthy"
    version: str = "1.0.0"
    timestamp: str


# =============================================================================
# In-Memory Job Store (replace with Redis/DB in production)
# =============================================================================

class JobStore:
    """Thread-safe in-memory job store."""

    def __init__(self):
        self._jobs: Dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, job_id: str, request: PipelineRequest) -> dict:
        job = {
            "job_id": job_id,
            "status": JobStatus.PENDING,
            "request": request.model_dump(),
            "progress": {"articles_completed": 0, "articles_total": len(request.keywords)},
            "result": None,
            "error": None,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[dict]:
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id: str, **kwargs) -> Optional[dict]:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(kwargs)
                self._jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()
                return self._jobs[job_id]
        return None

    def list_all(self, limit: int = 50) -> List[dict]:
        with self._lock:
            jobs = sorted(
                self._jobs.values(),
                key=lambda x: x["created_at"],
                reverse=True
            )
            return jobs[:limit]

    def delete(self, job_id: str) -> bool:
        with self._lock:
            if job_id in self._jobs:
                del self._jobs[job_id]
                return True
        return False


# Global job store
job_store = JobStore()


# =============================================================================
# FastAPI Application
# =============================================================================

app = FastAPI(
    title="OpenBlog Neo API",
    description="""
## AI-Powered Blog Generation Pipeline

OpenBlog Neo generates high-quality, SEO-optimized blog articles using Google's Gemini AI.

### Pipeline Stages

1. **Stage 1: Set Context** - Analyze company website, extract context
2. **Stage 2: Blog Generation** - Generate article content + images
3. **Stage 3: Quality Check** - Apply quality fixes
4. **Stage 4: URL Verification** - Validate and fix dead links
5. **Stage 5: Internal Links** - Add internal linking

### Features

- 🚀 Parallel article processing
- 🖼️ AI-generated images (optional)
- 📊 Multiple export formats (HTML, Markdown, JSON, CSV, XLSX, PDF)
- 🔗 Automatic internal linking
- ✅ URL verification and replacement
    """,
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    contact={
        "name": "OpenBlog Neo",
        "url": "https://github.com/federicodeponte/openblog",
    },
    license_info={
        "name": "MIT",
    },
)


# =============================================================================
# Background Task Runner
# =============================================================================

async def run_pipeline_job(job_id: str, request: PipelineRequest):
    """Background task to run the pipeline."""
    try:
        job_store.update(job_id, status=JobStatus.RUNNING)

        # Create output directory
        output_dir = Path(f"output/api_jobs/{job_id}")
        output_dir.mkdir(parents=True, exist_ok=True)

        # Run pipeline
        result = await run_pipeline(
            keywords=request.keywords,
            company_url=str(request.company_url),
            language=request.language,
            market=request.market,
            skip_images=request.skip_images,
            max_parallel=request.max_parallel,
            output_dir=output_dir,
            export_formats=request.export_formats,
        )

        job_store.update(
            job_id,
            status=JobStatus.COMPLETED,
            result=result,
            progress={
                "articles_completed": result["articles_successful"],
                "articles_total": result["articles_total"],
                "articles_failed": result["articles_failed"],
            }
        )

    except Exception as e:
        job_store.update(
            job_id,
            status=JobStatus.FAILED,
            error=str(e)
        )


# =============================================================================
# API Endpoints
# =============================================================================

@app.get(
    "/",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Health check",
)
async def health_check():
    """Check API health status."""
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        timestamp=datetime.utcnow().isoformat(),
    )


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Health check (alias)",
)
async def health():
    """Health check endpoint (alias for root)."""
    return await health_check()


@app.post(
    "/api/v1/jobs",
    response_model=JobResponse,
    status_code=202,
    tags=["Jobs"],
    summary="Start a new pipeline job",
)
async def create_job(
    request: PipelineRequest,
    background_tasks: BackgroundTasks,
):
    """
    Start a new blog generation pipeline job.

    The job runs asynchronously in the background. Use the returned `job_id`
    to check status via `GET /api/v1/jobs/{job_id}`.

    **Example request:**
    ```json
    {
        "keywords": ["AI in healthcare", "Machine learning basics"],
        "company_url": "https://example.com",
        "language": "en",
        "market": "US",
        "skip_images": false,
        "export_formats": ["html", "json"]
    }
    ```
    """
    job_id = str(uuid.uuid4())
    job = job_store.create(job_id, request)

    # Start background task
    background_tasks.add_task(run_pipeline_job, job_id, request)

    return JobResponse(
        job_id=job_id,
        status=JobStatus.PENDING,
        message=f"Job created. Processing {len(request.keywords)} article(s).",
        created_at=job["created_at"],
    )


@app.get(
    "/api/v1/jobs",
    response_model=List[JobStatusResponse],
    tags=["Jobs"],
    summary="List all jobs",
)
async def list_jobs(
    limit: int = Query(default=50, ge=1, le=100, description="Max jobs to return"),
):
    """List all pipeline jobs, sorted by creation time (newest first)."""
    jobs = job_store.list_all(limit=limit)
    return [
        JobStatusResponse(
            job_id=job["job_id"],
            status=job["status"],
            progress=job.get("progress"),
            result=None,  # Don't include full result in list view
            error=job.get("error"),
            created_at=job["created_at"],
            updated_at=job["updated_at"],
        )
        for job in jobs
    ]


@app.get(
    "/api/v1/jobs/{job_id}",
    response_model=JobStatusResponse,
    tags=["Jobs"],
    summary="Get job status",
)
async def get_job(job_id: str):
    """
    Get the status and result of a pipeline job.

    Returns full result when job is completed.
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    return JobStatusResponse(
        job_id=job["job_id"],
        status=job["status"],
        progress=job.get("progress"),
        result=job.get("result"),
        error=job.get("error"),
        created_at=job["created_at"],
        updated_at=job["updated_at"],
    )


@app.delete(
    "/api/v1/jobs/{job_id}",
    status_code=204,
    tags=["Jobs"],
    summary="Delete a job",
)
async def delete_job(job_id: str):
    """Delete a job and its results."""
    if not job_store.delete(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return None


@app.get(
    "/api/v1/jobs/{job_id}/articles",
    response_model=List[ArticlePreviewResponse],
    tags=["Articles"],
    summary="List articles for a job",
)
async def list_job_articles(job_id: str):
    """Get a preview of all articles generated by a job."""
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    if job["status"] != JobStatus.COMPLETED:
        return [
            ArticlePreviewResponse(
                job_id=job_id,
                keyword=kw,
                status="pending" if job["status"] == JobStatus.PENDING else "processing",
            )
            for kw in job["request"]["keywords"]
        ]

    result = job.get("result", {})
    articles = []

    for article_result in result.get("results", []):
        article = article_result.get("article", {})
        articles.append(ArticlePreviewResponse(
            job_id=job_id,
            keyword=article_result.get("keyword", ""),
            headline=article.get("Headline") if article else None,
            meta_description=article.get("Meta_Description") if article else None,
            word_count=article.get("Word_Count") if article else None,
            status="completed" if article else "failed",
        ))

    return articles


def _sanitize_path_component(value: str) -> str:
    """Sanitize a path component to prevent path traversal attacks."""
    # URL decode first
    decoded = unquote(value)
    # Remove any path traversal attempts
    sanitized = re.sub(r'[./\\]', '', decoded)
    # Limit length
    return sanitized[:200]


@app.get(
    "/api/v1/jobs/{job_id}/articles/{keyword}/html",
    tags=["Articles"],
    summary="Get article HTML",
)
async def get_article_html(job_id: str, keyword: str):
    """Get the rendered HTML for a specific article."""
    # Validate job_id is a valid UUID to prevent injection
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid job_id format")

    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    if job["status"] != JobStatus.COMPLETED:
        raise HTTPException(status_code=400, detail="Job not completed")

    # Sanitize keyword to prevent path traversal
    safe_keyword = unquote(keyword)

    result = job.get("result", {})
    for article_result in result.get("results", []):
        if article_result.get("keyword") == safe_keyword:
            exported = article_result.get("exported_files", {})
            html_path = exported.get("html")
            if html_path:
                file_path = Path(html_path).resolve()
                # Ensure file is within allowed output directory
                allowed_base = Path("output").resolve()
                if not str(file_path).startswith(str(allowed_base)):
                    raise HTTPException(status_code=403, detail="Access denied")
                if file_path.exists():
                    return FileResponse(
                        str(file_path),
                        media_type="text/html",
                        filename=f"{_sanitize_path_component(article_result.get('slug', keyword))}.html"
                    )
            raise HTTPException(status_code=404, detail="HTML file not found")

    raise HTTPException(status_code=404, detail=f"Article '{safe_keyword}' not found")


@app.post(
    "/api/v1/generate",
    tags=["Sync"],
    summary="Generate article (synchronous)",
    response_class=JSONResponse,
)
async def generate_sync(request: PipelineRequest):
    """
    Generate articles synchronously (blocking).

    **Warning:** This endpoint blocks until all articles are generated.
    For large batches, use the async job endpoint instead.

    Returns the full pipeline result directly.
    """
    if len(request.keywords) > 3:
        raise HTTPException(
            status_code=400,
            detail="Synchronous generation limited to 3 keywords. Use /api/v1/jobs for larger batches."
        )

    output_dir = Path(f"output/api_sync/{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}")
    output_dir.mkdir(parents=True, exist_ok=True)

    result = await run_pipeline(
        keywords=request.keywords,
        company_url=str(request.company_url),
        language=request.language,
        market=request.market,
        skip_images=request.skip_images,
        max_parallel=request.max_parallel,
        output_dir=output_dir,
        export_formats=request.export_formats,
    )

    return result


# =============================================================================
# Run with: uvicorn api:app --reload
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
