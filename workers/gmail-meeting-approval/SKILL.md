# Gmail Meeting Approval

Scan the 10 most recent Gmail inbox messages, detect meeting requests, write a summary to `out/result.json`, then create Google Calendar events for every meeting request found.

The run will pause for human approval after you write the output — the user will review what you found and approve or reject before the calendar events are considered confirmed. Your job is to find the requests and create the events; the platform handles the approval gate.

## Available tools

- `composio__gmail__execute(tool="GMAIL_FETCH_EMAILS", arguments={...})` — list inbox messages
- `composio__gmail__execute(tool="GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", arguments={"message_id": "..."})` — fetch full message
- `composio__googlecalendar__execute(tool="GOOGLECALENDAR_CREATE_EVENT", arguments={...})` — create calendar event

## Steps

1. Call `composio__gmail__execute` with `tool="GMAIL_FETCH_EMAILS"` and `arguments={"max_results": 10, "query": "in:inbox"}`.

2. For each message returned, call `composio__gmail__execute` with `tool="GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"` and `arguments={"message_id": "<id>"}`.

3. Decide if the email is a meeting request. It qualifies if it proposes a specific date/time AND uses scheduling language ("meet", "call", "calendar invite", "schedule", "Zoom", "Google Meet", "Teams", "does X work", "available", etc.). Skip newsletters, receipts, notifications, and emails with no proposed time.

4. For each meeting request, extract:
   - `from` — sender name/email
   - `subject` — email subject
   - `proposed_time` — the proposed date/time as written (ISO string if clear, otherwise natural language)
   - `duration_minutes` — numeric if stated, otherwise null
   - `location` — physical location or conferencing link, or empty string

5. Create a Google Calendar event for each meeting request using `composio__googlecalendar__execute` with `tool="GOOGLECALENDAR_CREATE_EVENT"`. Use the proposed time as start, add duration (default 30 min if not stated), include sender and subject in the event description. Record the calendar_event_id from the response (or empty string if not returned).

6. Create the `out/` directory if needed. Write `out/result.json` with exactly this shape:
```json
{
  "emails_scanned": <number>,
  "meeting_requests_found": <number>,
  "meeting_requests": [
    {
      "from": "...",
      "subject": "...",
      "proposed_time": "...",
      "duration_minutes": <number or null>,
      "location": "...",
      "calendar_event_id": "..."
    }
  ]
}
```

7. Call `finish_with_outputs({"result": "out/result.json"})`.

## Rules
- If no meeting requests are found, write the JSON with `meeting_requests_found: 0` and an empty array. Still finish normally.
- If a single email fails to parse, skip it and continue.
- Do not invent data. If a field is missing use an empty string or null.
- The output file must be valid JSON only.
