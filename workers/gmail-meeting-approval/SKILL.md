# Gmail Meeting Approval

Scan the 10 most recent Gmail inbox messages, detect meeting requests, and for each one call `request_approval()` to pause the run and ask the operator. Only create a Google Calendar event if the operator approves. Write a JSON summary and finish.

## Available tools

- `composio__gmail__execute(tool="GMAIL_FETCH_EMAILS", arguments={...})` — list inbox messages
- `composio__gmail__execute(tool="GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", arguments={"message_id": "..."})` — fetch full message
- `composio__googlecalendar__execute(tool="GOOGLECALENDAR_CREATE_EVENT", arguments={...})` — create calendar event
- `request_approval(title, description, metadata)` — pause the run and ask the operator to approve or reject an action

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

5. For each meeting request, call `request_approval` **before** creating any calendar event:
   ```
   request_approval(
     title="Create calendar event: <subject>",
     description="From: <sender>\nProposed time: <time>\nDuration: <duration_minutes> min\nLocation: <location>",
     metadata={"from": "...", "subject": "...", "proposed_time": "...", "duration_minutes": ..., "location": "..."}
   )
   ```
   - If the result has `approved: true` — create the Google Calendar event using `composio__googlecalendar__execute` with `tool="GOOGLECALENDAR_CREATE_EVENT"`. Use these argument keys (NOT the Google Calendar API format):
     ```
     composio__googlecalendar__execute(
       tool="GOOGLECALENDAR_CREATE_EVENT",
       arguments={
         "summary": "<event title>",
         "start_datetime": "<YYYY-MM-DDTHH:MM:SS naive, no Z or offset>",
         "end_datetime": "<YYYY-MM-DDTHH:MM:SS naive, no Z or offset>",
         "timezone": "<IANA timezone e.g. America/New_York>",
         "attendees": ["<sender email if available>"]
       }
     )
     ```
     The event ID is at `result.data.response_data.id` in the response (use empty string if missing). Mark `approval_status: "approved"` in the summary.
   - If the result has `approved: false` — skip creating the event. Mark `approval_status: "rejected"` in the summary.

6. Create the `out/` directory if needed. Write `out/result.json` with exactly this shape:
```json
{
  "emails_scanned": <number>,
  "meeting_requests_found": <number>,
  "approvals_raised": [
    {
      "subject": "...",
      "from": "...",
      "proposed_time": "...",
      "approval_status": "approved" | "rejected"
    }
  ],
  "events_created": [
    {
      "summary": "...",
      "start": "...",
      "calendar_event_id": "..."
    }
  ]
}
```

7. Call `finish_with_outputs({"result": "out/result.json"})`.

## Rules
- Call `request_approval` once per detected meeting request, in order. Do NOT call it in a loop around the entire run.
- Only create a calendar event after receiving `approved: true` from `request_approval`.
- If no meeting requests are found, write the JSON with `meeting_requests_found: 0` and empty arrays. Still finish normally.
- If a single email fails to parse, skip it and continue.
- Do not invent data. If a field is missing use an empty string or null.
- The output file must be valid JSON only.

## Important: approval tool vs manifest-level approvals

This worker uses the `request_approval()` tool to pause mid-run for per-item decisions. The worker manifest does NOT declare `approvals: required: true` — that is a different, whole-run gate that would conflict with this per-item tool and cause an infinite loop.
