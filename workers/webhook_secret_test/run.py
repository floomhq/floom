"""Webhook test worker with HMAC secret."""
import json

def run(inputs, context):
    context.log(f"Verified webhook payload: {json.dumps(inputs)[:200]}")
    return {
        "status": "success",
        "outputs": {
            "echo": inputs,
        },
    }
