"""The agent system prompt must carry the real current date.

Regression for 2026-07-08: date-sensitive workers (daily digests with a
"last 24 hours" rule) ran on the model's training-data sense of time and
dated their output a year in the past; prompt-level "figure out the date
from web results" instructions did not fix it.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_system_prompt_starts_with_current_date(tmp_path):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger
    from runner_sandbox.agent_driver import AgentDriver

    (tmp_path / "SKILL.md").write_text("# Do the thing\n", encoding="utf-8")
    config = WorkerConfig(
        id="date-probe",
        name="Date Probe",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="agent", entrypoint="SKILL.md", mode="agent"),
        outputs=[],
    )

    prompt = AgentDriver()._load_system_prompt(tmp_path, config)

    now = datetime.now(timezone.utc)
    assert prompt.startswith("Current date and time:")
    assert str(now.year) in prompt.split("\n\n")[0]
    assert now.strftime("%B") in prompt.split("\n\n")[0]
    # The worker's own SKILL.md still follows.
    assert "# Do the thing" in prompt
