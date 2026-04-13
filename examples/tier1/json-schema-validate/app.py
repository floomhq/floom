from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Any, List

app = FastAPI(
    title="JSON Schema Validator",
    description="Validate a JSON document against a JSON Schema.",
    version="0.1.0",
)


class ValidationError(BaseModel):
    path: str = Field(description="JSON path where the error occurred")
    message: str = Field(description="Error description")


class Input(BaseModel):
    document: Any = Field(description="The JSON document to validate", example={"name": "Alice", "age": 30})
    schema: Any = Field(description="The JSON Schema to validate against", example={"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}}, "required": ["name"]})


class Output(BaseModel):
    valid: bool = Field(description="Whether the document is valid")
    errors: List[ValidationError] = Field(description="List of validation errors (empty if valid)")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        import jsonschema
    except ImportError:
        raise HTTPException(status_code=500, detail="jsonschema is not installed.")

    try:
        validator = jsonschema.Draft7Validator(input.schema)
        errors = []
        for error in sorted(validator.iter_errors(input.document), key=str):
            path = "." + ".".join(str(p) for p in error.absolute_path) if error.absolute_path else "(root)"
            errors.append(ValidationError(path=path, message=error.message))
        return Output(valid=len(errors) == 0, errors=errors)
    except jsonschema.SchemaError as e:
        raise HTTPException(status_code=400, detail=f"Invalid schema: {e.message}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
