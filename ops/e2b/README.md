# E2B Runtime Templates

WorkerOS can create sandboxes from configured E2B templates:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_ID=workeros-python-base
WORKEROS_E2B_NODE_TEMPLATE_ID=workeros-node-base
WORKEROS_E2B_PYTHON_DEPS_BAKED=1
WORKEROS_E2B_NODE_DEPS_BAKED=1
```

The runtime still supports per-run installs. Only set a `*_DEPS_BAKED` flag when
the selected template contains the dependencies required by that worker class.

Current template defaults:

- Python base: `2` CPU, `2048` MB memory.
- Node base: `2` CPU, `2048` MB memory.

E2B fixes CPU and memory on the template; `Sandbox.create()` does not accept
per-create resource arguments. Workers can request a larger template with
`resources.memory_mb` / `resources.cpu_count` or `exec.resources.*`. Register
the matching template ID or alias with one of these env vars:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048=tpl-python-2gb
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_4096=tpl-python-4gb
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048_CPU_4=tpl-python-2gb-4cpu
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_2048=tpl-node-2gb
```

If no matching resource-bucket template env var exists, the run logs a warning
and falls back to `WORKEROS_E2B_{PYTHON,NODE}_TEMPLATE_ID` or
`WORKEROS_E2B_DEFAULT_TEMPLATE_ID`.

Templates in this directory:

- `python-base`: shared Python 3.11 image with common WorkerOS dependencies.
- `node-base`: shared Node LTS image with common helper packages.

Builds require an E2B account and `E2B_API_KEY`; the returned template id/alias is
account-scoped.
