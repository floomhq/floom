from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import base64
import io

app = FastAPI(
    title="QR Generator",
    description="Generate a QR code PNG from any text or URL.",
    version="0.1.0",
)


class Input(BaseModel):
    text: str = Field(description="Text or URL to encode", example="https://floom.dev")
    size: int = Field(default=10, ge=1, le=40, description="QR code version size (1–40)")
    border: int = Field(default=4, ge=0, le=20, description="Border width in boxes")
    color: str = Field(default="#000000", description="Foreground color (hex)", example="#000000")
    background: str = Field(default="#ffffff", description="Background color (hex)", example="#ffffff")


class Output(BaseModel):
    image_base64: str = Field(description="Base64-encoded PNG image")
    byte_size: int = Field(description="Size in bytes")


def _hex_to_rgb(hex_color: str):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        import qrcode
        from PIL import Image
    except ImportError:
        raise HTTPException(status_code=500, detail="qrcode or Pillow not installed.")

    try:
        fg = _hex_to_rgb(input.color)
        bg = _hex_to_rgb(input.background)

        qr = qrcode.QRCode(
            version=input.size,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=input.border,
        )
        qr.add_data(input.text)
        qr.make(fit=True)

        img = qr.make_image(fill_color=fg, back_color=bg).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out_bytes = buf.getvalue()
        encoded = base64.b64encode(out_bytes).decode("utf-8")
        return Output(image_base64=encoded, byte_size=len(out_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
