"""Webhook test worker — echoes the incoming payload."""
import json


def run(inputs, context):
    context.log(f"Received webhook payload: {json.dumps(inputs)[:200]}")
    return {
        "status": "success",
        "outputs": {
            "echo": inputs,
        },
    }
