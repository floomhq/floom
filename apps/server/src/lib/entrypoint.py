#!/usr/bin/env python3
"""
Floom app entrypoint.

Called by the floom-docker runner. Imports the user's app module, calls the
requested action function with inputs as kwargs, and prints a single JSON
line to stdout describing the result.

Protocol:
  stdin  : nothing
  argv[1]: JSON string {"action": "...", "inputs": {...}}
  stdout : single JSON line -- either
             {"ok": true,  "outputs": ...}
           or
             {"ok": false, "error": "...", "error_type": "...", "logs": "..."}

The user's module must be importable as `app` (i.e. `/app/app.py` exists, or
there is an `/app/app/__init__.py` package). Each action name in the manifest
must map to a top-level callable of the same name.
"""
import inspect
import json
import os
import sys
import traceback


def emit(payload: dict) -> None:
    # Keep this on a single line so the server can parse the last line.
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def filter_kwargs_for_callee(func, kwargs: dict) -> dict:
    """Drop kwargs the callee doesn't declare, unless it accepts **kwargs.

    The runner injects server-controlled keys into inputs (e.g. `_knowledge`
    from smart context infusion). Older apps have fixed signatures like
    `def analyze(url, context)` and reject unknown kwargs with TypeError.
    Any key the callee doesn't explicitly declare and can't absorb via
    **kwargs is dropped silently. Underscore-prefixed keys that would be
    dropped are logged so operators can tell when opt-in context is being
    skipped.
    """
    try:
        sig = inspect.signature(func)
    except (TypeError, ValueError):
        # Built-ins and C-extensions may not expose a signature. Pass
        # everything through and let Python raise if it doesn't fit.
        return kwargs

    accepts_var_kw = any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
    )
    if accepts_var_kw:
        return kwargs

    declared = {
        name
        for name, p in sig.parameters.items()
        if p.kind
        in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    }

    filtered = {k: v for k, v in kwargs.items() if k in declared}
    dropped = [k for k in kwargs if k not in declared]
    # Surface dropped runner-injected kwargs (underscore-prefixed) in logs
    # so it's obvious when an app opted out of a feature by signature.
    dropped_runner = [k for k in dropped if k.startswith("_")]
    if dropped_runner:
        print(
            f"[entrypoint] dropping runner kwargs not in signature: "
            f"{', '.join(sorted(dropped_runner))}",
            flush=True,
        )
    return filtered


def main() -> int:
    if len(sys.argv) < 2:
        emit({
            "ok": False,
            "error": "Missing config argument",
            "error_type": "runtime_error",
        })
        return 1

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        emit({
            "ok": False,
            "error": f"Invalid config JSON: {exc}",
            "error_type": "runtime_error",
        })
        return 1

    action = config.get("action") or "run"
    inputs = config.get("inputs") or {}

    # Import the user's module.
    print("Importing app module...", flush=True)
    try:
        import app  # noqa: F401  -- user module
    except SyntaxError as exc:
        emit({
            "ok": False,
            "error": f"Syntax error in app: {exc}",
            "error_type": "syntax_error",
            "logs": traceback.format_exc(),
        })
        return 1
    except ImportError as exc:
        emit({
            "ok": False,
            "error": f"Could not import app module: {exc}",
            "error_type": "runtime_error",
            "logs": traceback.format_exc(),
        })
        return 1
    except Exception as exc:  # noqa: BLE001
        emit({
            "ok": False,
            "error": f"App module raised on import: {exc}",
            "error_type": "runtime_error",
            "logs": traceback.format_exc(),
        })
        return 1

    func = getattr(app, action, None)
    if func is None or not callable(func):
        available = [n for n in dir(app) if not n.startswith("_") and callable(getattr(app, n))]
        emit({
            "ok": False,
            "error": f"Action '{action}' not found. Available: {', '.join(available) or '(none)'}",
            "error_type": "invalid_action",
        })
        return 1

    # Run the action. Filter inputs to only the kwargs the callee accepts so
    # runner-injected keys like `_knowledge` don't blow up apps with fixed
    # signatures. Apps that opt in by declaring the kwarg (or **kwargs) still
    # receive it.
    safe_inputs = filter_kwargs_for_callee(func, inputs)
    print(f"Running action '{action}'...", flush=True)
    try:
        result = func(**safe_inputs)
    except KeyError as exc:
        # Crude but effective: a KeyError touching os.environ is almost
        # always a missing secret. Check the traceback frames.
        tb = traceback.format_exc()
        missing = str(exc).strip("'\"")
        if "os.environ" in tb or "environ[" in tb:
            emit({
                "ok": False,
                "error": f"Missing secret: {missing}",
                "error_type": "missing_secret",
                "logs": tb,
            })
        else:
            emit({
                "ok": False,
                "error": f"KeyError: {exc}",
                "error_type": "runtime_error",
                "logs": tb,
            })
        return 1
    except SyntaxError as exc:
        emit({
            "ok": False,
            "error": str(exc),
            "error_type": "syntax_error",
            "logs": traceback.format_exc(),
        })
        return 1
    except MemoryError as exc:
        emit({
            "ok": False,
            "error": f"Out of memory: {exc}",
            "error_type": "oom",
            "logs": traceback.format_exc(),
        })
        return 1
    except Exception as exc:  # noqa: BLE001
        emit({
            "ok": False,
            "error": str(exc) or type(exc).__name__,
            "error_type": "runtime_error",
            "logs": traceback.format_exc(),
        })
        return 1

    # If the user app imported the floom SDK shim, merge any artifacts it
    # collected via save_artifact / save_dataframe into the result dict. The
    # action's explicit return takes priority over collected artifacts.
    try:
        import floom  # type: ignore

        collected = floom._get_collected_outputs()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        collected = {}

    # Success. Wrap non-dict results in {"result": value} so the server always
    # gets a dict shape back.
    if not isinstance(result, dict):
        if result is None and collected:
            result = {}
        else:
            result = {"result": result}

    if collected:
        for k, v in collected.items():
            if k not in result:
                result[k] = v

    try:
        emit({"ok": True, "outputs": result})
    except (TypeError, ValueError) as exc:
        emit({
            "ok": False,
            "error": f"Action result is not JSON-serializable: {exc}",
            "error_type": "runtime_error",
        })
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
