from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List
import csv
import io

app = FastAPI(
    title="CSV to JSON",
    description="Convert CSV text to a JSON array of objects, with automatic type inference.",
    version="0.1.0",
)


class Input(BaseModel):
    csv_content: str = Field(description="Raw CSV text", example="name,age,active\nAlice,30,true\nBob,25,false")
    delimiter: str = Field(default=",", max_length=1, description="Column delimiter character")
    has_header: bool = Field(default=True, description="Whether the first row is a header")


class Output(BaseModel):
    rows: List[Dict[str, Any]] = Field(description="Parsed rows as JSON objects")
    row_count: int = Field(description="Number of data rows")
    columns: List[str] = Field(description="Column names")


def _coerce(value: str) -> Any:
    if value.lower() in ("true", "yes"):
        return True
    if value.lower() in ("false", "no"):
        return False
    if value == "" or value.lower() in ("null", "none", "na", "n/a"):
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        reader = csv.reader(io.StringIO(input.csv_content), delimiter=input.delimiter)
        all_rows = list(reader)

        if not all_rows:
            return Output(rows=[], row_count=0, columns=[])

        if input.has_header:
            columns = all_rows[0]
            data_rows = all_rows[1:]
        else:
            columns = [f"col{i}" for i in range(len(all_rows[0]))]
            data_rows = all_rows

        rows = [
            {col: _coerce(val) for col, val in zip(columns, row)}
            for row in data_rows
            if any(v.strip() for v in row)
        ]
        return Output(rows=rows, row_count=len(rows), columns=columns)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
