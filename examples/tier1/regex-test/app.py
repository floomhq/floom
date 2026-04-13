from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
import re
import signal
import sys

app = FastAPI(
    title="Regex Tester",
    description="Test a regular expression against input text and return all matches with groups.",
    version="0.1.0",
)

MAX_INPUT_LEN = 100_000
TIMEOUT_SECONDS = 5


class Match(BaseModel):
    full_match: str = Field(description="The full matched string")
    start: int = Field(description="Start index in input")
    end: int = Field(description="End index in input")
    groups: List[Optional[str]] = Field(description="Captured groups (None for unmatched optional groups)")


class Input(BaseModel):
    pattern: str = Field(description="Regular expression pattern", example=r"\b\w+@\w+\.\w+\b")
    input: str = Field(description="Text to search", example="Contact us at hello@floom.dev or support@floom.dev")
    flags: str = Field(default="", description="Flags: i=IGNORECASE, m=MULTILINE, s=DOTALL, x=VERBOSE", example="i")


class Output(BaseModel):
    matches: List[Match] = Field(description="All matches found")
    match_count: int = Field(description="Total number of matches")


def _parse_flags(flags_str: str) -> int:
    flag_map = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL, "x": re.VERBOSE}
    result = 0
    for ch in flags_str.lower():
        if ch in flag_map:
            result |= flag_map[ch]
        elif ch.strip():
            raise ValueError(f"Unknown flag: '{ch}'. Valid flags: i, m, s, x")
    return result


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    if len(input.input) > MAX_INPUT_LEN:
        raise HTTPException(status_code=400, detail=f"Input text too long (max {MAX_INPUT_LEN} chars).")

    try:
        flags = _parse_flags(input.flags)
        compiled = re.compile(input.pattern, flags)
    except re.error as e:
        raise HTTPException(status_code=400, detail=f"Invalid regex pattern: {e}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Timeout guard using SIGALRM (Unix only)
    def _timeout_handler(signum, frame):
        raise TimeoutError("Regex execution timed out (possible ReDoS).")

    matches = []
    try:
        if sys.platform != "win32":
            signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(TIMEOUT_SECONDS)
        for m in compiled.finditer(input.input):
            matches.append(Match(
                full_match=m.group(0),
                start=m.start(),
                end=m.end(),
                groups=list(m.groups()),
            ))
    except TimeoutError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if sys.platform != "win32":
            signal.alarm(0)

    return Output(matches=matches, match_count=len(matches))


@app.get("/health")
def health():
    return {"status": "ok"}
