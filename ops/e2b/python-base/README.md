# WorkerOS Python E2B Base Template

This builds the shared Python base template used to avoid per-run installation of
common WorkerOS dependencies.

Build:

```bash
pip install e2b
E2B_API_KEY=e2b_... python ops/e2b/python-base/template.py
```

Configure the API after the build returns your account-scoped template id or
alias:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_ID=workeros-python-base
WORKEROS_E2B_PYTHON_DEPS_BAKED=1
```

Keep `WORKEROS_E2B_PYTHON_DEPS_BAKED=0` for workers whose `requirements.txt`
contains packages not baked into this template; otherwise the runtime will skip
`pip install -r requirements.txt`.

The runtime also has a safety guard: with `WORKEROS_E2B_PYTHON_DEPS_BAKED=1`, it
only skips `pip install` when every requirement name is in the baked package
allowlist. Override that allowlist with `WORKEROS_E2B_PYTHON_BAKED_PACKAGES` if
you build a custom base image.
