# ics-gen

Generate an .ics calendar file from event details.

Uses the [ics](https://github.com/C4ptainCrunch/ics.py) library.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Team Standup",
    "start": "2025-06-01T10:00:00",
    "end": "2025-06-01T10:30:00",
    "description": "Daily sync",
    "location": "Zoom",
    "attendees": ["alice@example.com", "bob@example.com"]
  }' \
  | jq -r '.ics_content' > event.ics
```

## Notes

- `start` and `end` are ISO 8601 datetime strings
- If `end` is omitted, the event defaults to 1 hour duration
