import json
from pathlib import Path
from typing import Dict, Any


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    # Placeholder worker — edit run.py to do the real work.
    return {"status": "success", "outputs": {}, "artifacts": []}


if __name__ == "__main__":
    # E2B pure-script entry: write result.json so the run does not fail
    # with missing_result. Edit this to produce real outputs.
    Path("result.json").write_text(
        json.dumps({"status": "success", "outputs": {}, "artifacts": []}),
        encoding='utf-8',
    )
