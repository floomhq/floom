from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Literal
import base64
import io

app = FastAPI(
    title="HTML to PDF",
    description="Convert an HTML string or URL to a PDF document.",
    version="0.1.0",
)


class Input(BaseModel):
    html: Optional[str] = Field(default=None, description="Raw HTML string to convert", example="<h1>Hello</h1><p>World</p>")
    url: Optional[str] = Field(default=None, description="URL to fetch and convert", example="https://example.com")
    page_size: Literal["A4", "Letter", "Legal"] = Field(default="A4", description="Output page size")
    margin_mm: int = Field(default=20, ge=0, le=100, description="Page margin in millimetres")


class Output(BaseModel):
    pdf_base64: str = Field(description="Base64-encoded PDF bytes")
    byte_size: int = Field(description="Size of the PDF in bytes")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    if not input.html and not input.url:
        raise HTTPException(status_code=400, detail="Provide either 'html' or 'url'.")

    try:
        from weasyprint import HTML, CSS
    except ImportError:
        raise HTTPException(status_code=500, detail="weasyprint is not installed.")

    try:
        margin = f"{input.margin_mm}mm"
        page_css = CSS(string=f"@page {{ size: {input.page_size}; margin: {margin}; }}")

        if input.html:
            doc = HTML(string=input.html)
        else:
            import httpx
            resp = httpx.get(input.url, timeout=15, follow_redirects=True)
            resp.raise_for_status()
            doc = HTML(string=resp.text, base_url=input.url)

        pdf_bytes = doc.write_pdf(stylesheets=[page_css])
        encoded = base64.b64encode(pdf_bytes).decode("utf-8")
        return Output(pdf_base64=encoded, byte_size=len(pdf_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
