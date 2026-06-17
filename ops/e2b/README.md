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

Templates in this directory:

- `python-base`: shared Python 3.11 image with common WorkerOS dependencies.
- `node-base`: shared Node LTS image with common helper packages.

Builds require an E2B account and `E2B_API_KEY`; the returned template id/alias is
account-scoped.
