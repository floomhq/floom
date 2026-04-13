from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Literal
import base64
import io

app = FastAPI(
    title="Image Resize",
    description="Resize an image to target dimensions with configurable fit mode.",
    version="0.1.0",
)


class Input(BaseModel):
    image_base64: str = Field(description="Base64-encoded input image")
    width: Optional[int] = Field(default=None, gt=0, le=10000, description="Target width in pixels")
    height: Optional[int] = Field(default=None, gt=0, le=10000, description="Target height in pixels")
    fit: Literal["cover", "contain", "scale"] = Field(default="contain", description="Resize mode: contain keeps aspect ratio with padding, cover crops to fill, scale stretches")
    format: Literal["PNG", "JPEG", "WebP"] = Field(default="PNG", description="Output image format")


class Output(BaseModel):
    image_base64: str = Field(description="Base64-encoded output image")
    width: int = Field(description="Actual output width")
    height: int = Field(description="Actual output height")
    byte_size: int = Field(description="Size in bytes")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    if not input.width and not input.height:
        raise HTTPException(status_code=400, detail="Provide at least one of 'width' or 'height'.")

    try:
        from PIL import Image
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow is not installed.")

    try:
        raw = base64.b64decode(input.image_base64)
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        orig_w, orig_h = img.size

        target_w = input.width or orig_w
        target_h = input.height or orig_h

        if input.fit == "scale":
            img = img.resize((target_w, target_h), Image.LANCZOS)
        elif input.fit == "contain":
            img.thumbnail((target_w, target_h), Image.LANCZOS)
        elif input.fit == "cover":
            ratio = max(target_w / orig_w, target_h / orig_h)
            new_w = int(orig_w * ratio)
            new_h = int(orig_h * ratio)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            left = (new_w - target_w) // 2
            top = (new_h - target_h) // 2
            img = img.crop((left, top, left + target_w, top + target_h))

        fmt = input.format
        save_kwargs = {}
        if fmt == "JPEG":
            img = img.convert("RGB")
            save_kwargs = {"quality": 90}

        buf = io.BytesIO()
        img.save(buf, format=fmt, **save_kwargs)
        out_bytes = buf.getvalue()
        encoded = base64.b64encode(out_bytes).decode("utf-8")
        return Output(image_base64=encoded, width=img.width, height=img.height, byte_size=len(out_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
