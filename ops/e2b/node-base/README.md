# WorkerOS Node E2B Base Template

Build:

```bash
pip install e2b
E2B_API_KEY=e2b_... python ops/e2b/node-base/template.py
```

Default resources are `2` CPU and `1024` MB memory. Override them when building
a larger template:

```bash
WORKEROS_E2B_NODE_TEMPLATE_ALIAS=workeros-node-2gb \
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_MB=2048 \
E2B_API_KEY=e2b_... python ops/e2b/node-base/template.py
```

Configure the API after the build returns your account-scoped template id or
alias:

```bash
WORKEROS_E2B_NODE_TEMPLATE_ID=workeros-node-base
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_2048=workeros-node-2gb
WORKEROS_E2B_NODE_DEPS_BAKED=1
```

Keep `WORKEROS_E2B_NODE_DEPS_BAKED=0` for workers whose `package.json` contains
packages not baked into this template; otherwise the runtime will skip
`npm install`.
