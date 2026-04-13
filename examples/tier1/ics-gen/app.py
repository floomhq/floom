from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List

app = FastAPI(
    title="ICS Calendar Generator",
    description="Generate an .ics calendar file from event details.",
    version="0.1.0",
)


class Input(BaseModel):
    title: str = Field(description="Event title", example="Team Standup")
    start: str = Field(description="Start datetime in ISO 8601 format", example="2025-06-01T10:00:00")
    end: Optional[str] = Field(default=None, description="End datetime in ISO 8601 format", example="2025-06-01T10:30:00")
    description: Optional[str] = Field(default=None, description="Event description")
    location: Optional[str] = Field(default=None, description="Event location")
    attendees: Optional[List[str]] = Field(default=None, description="List of attendee email addresses")
    organizer: Optional[str] = Field(default=None, description="Organizer email address")


class Output(BaseModel):
    ics_content: str = Field(description="Raw .ics file content")
    byte_size: int = Field(description="Size in bytes")


@app.post("/run", response_model=Output)
def run(input: Input) -> Output:
    try:
        from ics import Calendar, Event
        from datetime import datetime, timedelta
    except ImportError:
        raise HTTPException(status_code=500, detail="ics library not installed.")

    try:
        cal = Calendar()
        event = Event()
        event.name = input.title

        start_dt = datetime.fromisoformat(input.start)
        event.begin = start_dt

        if input.end:
            event.end = datetime.fromisoformat(input.end)
        else:
            event.end = start_dt + timedelta(hours=1)

        if input.description:
            event.description = input.description
        if input.location:
            event.location = input.location
        if input.organizer:
            event.organizer = input.organizer
        if input.attendees:
            for attendee in input.attendees:
                event.add_attendee(attendee)

        cal.events.add(event)
        ics_str = str(cal)
        return Output(ics_content=ics_str, byte_size=len(ics_str.encode("utf-8")))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
