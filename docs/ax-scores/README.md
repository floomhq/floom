# ax-eval scores

This directory collects nightly agent experience (AX) scorecards for Floom. Each
Markdown file here is one round of [ax-eval](https://github.com/team2027/ax-eval):
10 Claude Code agents are spawned with a minimal prompt ("Publish this OpenAPI
spec as a shareable app: … using Floom"), asked to figure out Floom from scratch
with no docs, and scored on how smoothly they complete the task.

The goal isn't to grade Floom on a curve. It's an **agent UX regression signal**.
If the median final score drops after a release, something we changed made Floom
harder for agents to use. Look at the affected round's scorecard and the
workflow artifact transcripts to see which step tripped them up.

## The four dimensions

Every agent run is scored on four deterministic, 0-100 axes (no AI grading —
these come straight from the session log):

| dim | formula | what it measures |
|---|---|---|
| friction | `100 − interruptions × 14` | oauth, manual creds, parent follow-ups |
| speed | `100 − ((duration_sec − 30) / 570) × 100` | wall-clock time |
| efficiency | `100 − ((tool_calls − 1) / 39) × 100` | tool calls per task |
| errorRecovery | `100 − (errors / 15) × 100` | failed tool calls |

**Final score** is a weighted sum, also 0-100:

```
final = 0.30·friction + 0.25·speed + 0.20·efficiency + 0.25·errorRecovery
```

Full rubric, philosophy, and the extraction script (`extract_metrics.py`) live
in the ax-eval repo: <https://github.com/team2027/ax-eval>.

## The badge

The AX badge in the main README shows the most recent round's **median final
score** across 10 agents. Colors:

| color | median final | read as |
|---|---|---|
| red | `< 60` | agents are struggling. Investigate. |
| orange | `60 – 79` | room to improve discoverability, docs, or error messages. |
| brightgreen | `80+` | agents complete the task cleanly. |

Medians over N=10 have noise. Treat single-round swings of less than 10 points
as noise; look for trend across 3+ rounds before concluding anything.

## Comparing rounds

To diff two rounds side-by-side (local checkout of the ax-eval repo required):

```
ax-eval compare floom <round-a> <round-b>
```

Each round directory has a `result.json` with the full schema from
[`ax-eval/schemas/result.schema.json`](https://github.com/team2027/ax-eval/blob/main/schemas/result.schema.json).
Round names here follow `ci-{run_number}` for CI runs.

## How to trigger a new round manually

```bash
gh workflow run ax-eval-nightly.yml --repo floomhq/floom
```

Or: GitHub Actions → "ax-eval nightly" → Run workflow.

The scorecard Markdown lands in this directory; the full per-agent JSONL
transcripts and `result.json` are kept as a workflow artifact
(`ax-eval-ci-{run_number}`) for 30 days.

## Cost note

Each round spawns 10 Opus agents with a 40-turn cap and a per-agent budget
ceiling of ~$4. Typical cost per run: **$40–80** (2026-04 pricing). This is why
the schedule trigger is manual-only for the first two weeks — we want to prove
signal value before auto-running nightly.
