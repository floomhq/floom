"""E2B test worker — verifies sandbox execution + dependency install.

This worker runs in an E2B cloud sandbox. It reads inputs from inputs.json
and writes result.json (E2B worker protocol — no context object).
"""
import json
import os


def main():
    # Read inputs (may be empty for this test)
    try:
        with open("inputs.json") as f:
            inputs = json.load(f)
    except Exception:
        inputs = {}

    # Test numpy — proves dependency install works
    import numpy as np
    arr = np.array([1, 2, 3, 4, 5])

    result = {
        "status": "success",
        "outputs": {
            "result": {
                "numpy_array": arr.tolist(),
                "mean": float(np.mean(arr)),
                "sum": int(np.sum(arr)),
                "sandbox": "e2b",
                "run_id": os.environ.get("FLOOM_RUN_ID", "unknown"),
            }
        },
    }

    with open("result.json", "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
