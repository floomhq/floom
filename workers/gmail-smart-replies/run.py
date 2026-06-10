"""Skill/agent-mode worker. Execution is driven by SKILL.md via the platform
agent runtime; this stub exists to satisfy the worker bundle contract."""

from typing import Dict, Any


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    return {"status": "success", "outputs": {}, "artifacts": []}
