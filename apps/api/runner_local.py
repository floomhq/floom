import os
import sys
import json
import uuid
import traceback
from typing import Dict, Any, Callable
from datetime import datetime, timezone

WORKERS_DIR = os.environ.get("FLOOM_WORKERS_DIR", "../../workers")
ARTIFACTS_DIR = os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")


def make_context(run_id: str, worker_id: str, secrets: Dict[str, str], log_fn: Callable) -> Dict[str, Any]:
    artifact_dir = os.path.join(ARTIFACTS_DIR, run_id)
    os.makedirs(artifact_dir, exist_ok=True)
    return {
        "log": log_fn,
        "secrets": secrets,
        "run_id": run_id,
        "worker_id": worker_id,
        "artifact_dir": artifact_dir,
    }


def run_worker_local(worker_id: str, run_id: str, inputs: Dict[str, Any], secrets: Dict[str, str], log_fn: Callable) -> Dict[str, Any]:
    worker_dir = os.path.join(WORKERS_DIR, worker_id)
    entrypoint = "run.py"
    config_path = os.path.join(worker_dir, "worker.yml")

    # Try to read entrypoint from config
    try:
        import yaml
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
        entrypoint = config.get("runtime", {}).get("entrypoint", "run.py")
    except Exception:
        pass

    run_file = os.path.join(worker_dir, entrypoint)
    if not os.path.isfile(run_file):
        return {"status": "error", "error": f"Entrypoint not found: {run_file}"}

    # Build context
    context = make_context(run_id, worker_id, secrets, log_fn)

    # SECURITY NOTE: This executes worker code in-process with exec().
    # The local runner is intended for trusted code only.
    # For untrusted code, use the E2B sandbox runner.
    # Execute in isolated way using exec with restricted globals
    try:
        log_fn("Loading worker module")
        with open(run_file, "r") as f:
            source = f.read()

        code = compile(source, run_file, "exec")
        module_globals = {
            "__name__": "__worker__",
            "__file__": run_file,
        }
        exec(code, module_globals)

        if "run" not in module_globals:
            return {"status": "error", "error": "Worker does not expose a run() function"}

        run_fn = module_globals["run"]
        log_fn("Executing worker run()")
        result = run_fn(inputs, context)

        if not isinstance(result, dict):
            return {"status": "error", "error": "Worker run() must return a dict"}

        return result
    except Exception as e:
        tb = traceback.format_exc()
        log_fn(f"Error during execution: {str(e)}")
        return {"status": "error", "error": str(e), "traceback": tb}
