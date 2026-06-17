# Managed LLM gateway (#1448)

LLM calls run **inside** the E2B sandbox (worker code calls litellm/openai), so
the engine can't intercept them in-process. The fix is a gateway the workers
route through: it pools provider quota, applies shared backoff on 429, and
round-robins across regions, so concurrent judge-heavy runs stop stacking and
429ing the shared provider quota.

This is the issue's **option 2**. The **option 1** scheduling backpressure
(`llm_intensive` manifest flag + `WORKEROS_MAX_CONCURRENT_LLM_RUNS`) already
ships in the engine and is complementary - keep both.

## How it wires up

```
worker (in E2B)  --OPENAI_BASE_URL-->  LiteLLM Proxy  --pooled/backoff/RR-->  Vertex / OpenAI / Bedrock
                                            |
                                          Redis (shared quota + cooldown state)
```

The engine injects the routing env into each sandbox **only when
`WORKEROS_LLM_GATEWAY_URL` is set** (`runner_sandbox/e2b_driver.py::_llm_gateway_env`,
merged into the worker command env after the worker's own secrets so it takes
precedence). The gateway host is also added to the sandbox egress allowlist.

## Engine env vars (set on the API service)

| Var | Meaning |
|-----|---------|
| `WORKEROS_LLM_GATEWAY_URL` | Gateway OpenAI-compatible base, e.g. `https://llm-gw.floom.dev/v1`. **Unset = off** (workers call providers directly with their own keys = today's behaviour; this is the kill-switch). |
| `WORKEROS_LLM_GATEWAY_KEY` | The shared virtual key (the proxy's `LITELLM_MASTER_KEY` or a minted virtual key). Injected as the worker's `OPENAI_API_KEY`. |

## Run it

Local / single host:
```bash
cd ops/llm-gateway
export LITELLM_MASTER_KEY=sk-... OPENAI_API_KEY=... VERTEX_PROJECT=...
export VERTEX_SA_JSON=/abs/path/vertex-sa.json   # if using Gemini/Vertex
docker compose up -d
# then on the API service:
export WORKEROS_LLM_GATEWAY_URL=http://localhost:4000/v1
export WORKEROS_LLM_GATEWAY_KEY=$LITELLM_MASTER_KEY
```

Cloud (Railway): deploy `ghcr.io/berriai/litellm:main-stable` as a service with
`litellm_config.yaml` mounted (or baked) and the same env vars; add a managed
Redis; then set `WORKEROS_LLM_GATEWAY_URL` / `WORKEROS_LLM_GATEWAY_KEY` on the
`managed-deployment-api` service. No engine submodule change is needed beyond the
code already in `e2b_driver.py`.

## Tuning the pool
Edit `litellm_config.yaml`: add/remove regional deployments per `model_name` for
wider round-robin, set per-deployment `rpm`/`tpm` to your real provider quota,
and adjust `allowed_fails`/`cooldown_time` for how aggressively a 429ing region
is cooled out. `routing_strategy: usage-based-routing-v2` spreads by live
headroom (best for the judge-burst pattern).

## Worker authoring note
Workers should call models by the `model_name` aliases defined in the config
(`gemini-3-flash`, `gpt-4o`, `claude-sonnet`) via the OpenAI-compatible
interface (openai SDK or `litellm` with the injected base URL). Direct
provider-SDK calls (e.g. raw `google.generativeai`) bypass the gateway - prefer
litellm/openai so the gateway can do its job.

## Verification (needs real provider creds + load - do in staging)
1. `docker compose up -d`, then `curl $URL/health` (expect ok) and a `/v1/chat/completions` smoke with the master key.
2. Set the two engine env vars, run an `llm_intensive` worker, confirm in the
   LiteLLM logs that calls arrive at the proxy and spread across regions.
3. Stack 2+ judge-heavy runs and confirm 429s drop vs. the direct-provider
   baseline (the original #1448 measurement: 24 concurrent direct = ~16 429s).
