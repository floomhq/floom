# Gmail Meeting Approval

Scan the 10 most recent Gmail inbox messages, detect meeting requests, and for each one call `request_approval()` to pause and ask the operator. Only create a Google Calendar event if the operator approves. Write a JSON summary and finish.

## Available tools

- `composio__gmail__execute(tool="GMAIL_FETCH_EMAILS", arguments={...})` — list inbox messages
- `composio__gmail__execute(tool="GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", arguments={"message_id": "..."})` — fetch full message
- `composio__googlecalendar__execute(tool="GOOGLECALENDAR_CREATE_EVENT", arguments={...})` — create calendar event
- `request_approval(title, description, metadata)` — pause the run and ask the operator to approve or reject

## Steps

1. Call `composio__gmail__execute` with `tool="GMAIL_FETCH_EMAILS"` and `arguments={"max_results": 10, "query": "in:inbox"}`.

2. For each message returned, call `composio__gmail__execute` with `tool="GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"` and `arguments={"message_id": "<id>"}`.

3. Decide if the email is a meeting request. It qualifies if it proposes a specific date/time AND uses scheduling language ("meet", "call", "schedule", "available", "Zoom", "Google Meet", "Teams", "does X work", etc.). Skip newsletters, receipts, and emails with no proposed time.

4. For each meeting request, extract:
   - `from` — sender name/email
   - `subject` — email subject
   - `proposed_time` — the proposed date/time (ISO string if clear, otherwise natural language)
   - `duration_minutes` — numeric if stated, otherwise null
   - `location` — physical location or conferencing link, or empty string

5. For each meeting request, call `request_approval` **before** creating any calendar event:
   ```
   request_approval(
     title="Meeting request from <sender>",
     description="Subject: <subject>\nProposed time: <time>\nDuration: <duration_minutes> min\nLocation: <location>",
     metadata={"from": "...", "subject": "...", "proposed_time": "...", "duration_minutes": ..., "location": "..."}
   )
   ```
   - If `approved: true` — first check `result.edited_output.text`: if present, re-parse it to extract any corrected `summary`, `proposed_time`, `duration_minutes`, or `location` and override your originally extracted values with those corrections before creating the event. Then create the Google Calendar event using `composio__googlecalendar__execute` with `tool="GOOGLECALENDAR_CREATE_EVENT"` and these exact argument keys:
     ```
     arguments={
       "summary": "<subject or concise meeting title>",
       "start_datetime": "<YYYY-MM-DDTHH:MM:SS naive, no Z or offset>",
       "end_datetime": "<YYYY-MM-DDTHH:MM:SS naive, no Z or offset>",
       "timezone": "<IANA timezone e.g. America/New_York>",
       "attendees": ["<sender email if available>"]
     }
     ```
     The event ID is at `result.data.response_data.id` in the response (use empty string if missing). Mark `approval_status: "approved"`.
   - If `approved: false` — skip. Mark `approval_status: "rejected"`.

6. Create the `out/` directory if needed. Write `out/result.json`:
```json
{
  "emails_scanned": 0,
  "meeting_requests_found": 0,
  "approvals_raised": [],
  "events_created": []
}
```

7. Call `finish_with_outputs({"result": "out/result.json"})`.

## Rules
- Call `request_approval` once per detected meeting request, in order.
- Only create a calendar event after receiving `approved: true`.
- If no meeting requests are found, write the JSON with `meeting_requests_found: 0` and empty arrays.
- If a single email fails to parse, skip it and continue.
- Do NOT use `approvals: required: true` in the manifest.
- Output file must be valid JSON only.
