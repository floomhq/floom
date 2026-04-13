from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
import base64
import io

app = FastAPI(
    title="Barcode Generator",
    description="Generate a CODE128, EAN13, or UPC-A barcode as a PNG image.",
    version="0.1.0",
)


class Input(BaseModel):
    code_type: Literal["CODE128", "EAN13", "UPC-A"] = Field(description="Barcode format", example="CODE128")
    value: str = Field(description="Value to encode", example="012345678905")
    show_text: bool = Field(default=True, description="Whether to render the human-readable text below the barcode")


class Output(BaseModel):
    image_base64: str = Field(description="Base64-encoded PNG image")
    format: str = Field(description="Barcode format used")
    byte_size: int = Field(description="Size in bytes")


_TYPE_MAP = {
    "CODE128": "code128",
    "EAN13": "ean13",
    "UPC-A": "upca",
}


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        import barcode
        from barcode.writer import ImageWriter
    except ImportError:
        raise HTTPException(status_code=500, detail="python-barcode is not installed.")

    try:
        barcode_cls = barcode.get_barcode_class(_TYPE_MAP[input.code_type])
        writer = ImageWriter()
        writer_options = {"write_text": input.show_text, "format": "PNG"}

        bc = barcode_cls(input.value, writer=writer)
        buf = io.BytesIO()
        bc.write(buf, options=writer_options)
        out_bytes = buf.getvalue()
        encoded = base64.b64encode(out_bytes).decode("utf-8")
        return Output(image_base64=encoded, format=input.code_type, byte_size=len(out_bytes))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
