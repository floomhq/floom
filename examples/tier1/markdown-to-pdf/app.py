from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Literal
import base64

app = FastAPI(
    title="Markdown to PDF",
    description="Convert Markdown to a styled PDF document.",
    version="0.1.0",
)

DEFAULT_CSS = """
body { font-family: Georgia, serif; font-size: 14px; line-height: 1.6; color: #222; }
h1, h2, h3 { font-family: Helvetica, Arial, sans-serif; color: #111; }
h1 { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow: auto; }
blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1em; color: #666; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background: #f5f5f5; font-weight: bold; }
"""


class Input(BaseModel):
    markdown: str = Field(description="Markdown content to convert", example="# Hello\n\nThis is **bold** text.")
    css: Optional[str] = Field(default=None, description="Custom CSS to apply (replaces default styles)")
    page_size: Literal["A4", "Letter"] = Field(default="A4", description="Output page size")


class Output(BaseModel):
    pdf_base64: str = Field(description="Base64-encoded PDF bytes")
    byte_size: int = Field(description="Size in bytes")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        import markdown as md_lib
        from weasyprint import HTML, CSS
    except ImportError:
        raise HTTPException(status_code=500, detail="markdown or weasyprint not installed.")

    try:
        html_body = md_lib.markdown(
            input.markdown,
            extensions=["tables", "fenced_code", "codehilite", "toc"],
        )
        css_content = input.css if input.css is not None else DEFAULT_CSS
        full_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>{css_content}</style>
</head><body>{html_body}</body></html>"""

        page_css = CSS(string=f"@page {{ size: {input.page_size}; margin: 20mm; }}")
        pdf_bytes = HTML(string=full_html).write_pdf(stylesheets=[page_css])
        encoded = base64.b64encode(pdf_bytes).decode("utf-8")
        return Output(pdf_base64=encoded, byte_size=len(pdf_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
