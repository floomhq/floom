from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List
import base64
import io

app = FastAPI(
    title="Favicon Generator",
    description="Generate a multi-size favicon.ico from a source PNG image.",
    version="0.1.0",
)


class Input(BaseModel):
    image_base64: str = Field(description="Base64-encoded source PNG image")
    sizes: List[int] = Field(default=[16, 32, 48, 64], description="Icon sizes to include in the .ico file")


class Output(BaseModel):
    favicon_ico_base64: str = Field(description="Base64-encoded .ico file")
    byte_size: int = Field(description="Size of the .ico file in bytes")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    if not input.sizes:
        raise HTTPException(status_code=400, detail="Provide at least one size.")
    if any(s < 1 or s > 256 for s in input.sizes):
        raise HTTPException(status_code=400, detail="Sizes must be between 1 and 256.")

    try:
        from PIL import Image
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow is not installed.")

    try:
        raw = base64.b64decode(input.image_base64)
        src = Image.open(io.BytesIO(raw)).convert("RGBA")

        frames = []
        for size in sorted(set(input.sizes)):
            frame = src.copy()
            frame.thumbnail((size, size), Image.LANCZOS)
            frames.append(frame)

        buf = io.BytesIO()
        frames[0].save(
            buf,
            format="ICO",
            sizes=[(f.width, f.height) for f in frames],
            append_images=frames[1:],
        )
        ico_bytes = buf.getvalue()
        encoded = base64.b64encode(ico_bytes).decode("utf-8")
        return Output(favicon_ico_base64=encoded, byte_size=len(ico_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
