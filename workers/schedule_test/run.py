"""Schedule test worker — records a timestamp on each scheduled run."""
from datetime import datetime, timezone


def run(inputs, context):
    ts = datetime.now(timezone.utc).isoformat()
    context.log(f"Scheduled run at {ts}")
    return {
        "status": "success",
        "outputs": {
            "message": f"Scheduled at {ts}",
        },
    }
