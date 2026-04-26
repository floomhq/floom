# Outbound Network Policy

Floom hosted Docker apps use ADR-016 outbound deny by default. A container can
only reach domains declared in its manifest:

```yaml
network:
  allowed_domains:
    - api.openai.com
    - generativelanguage.googleapis.com
    - "*.example-api.com"
```

`allowed_domains: []` means the app has no outbound network. This is the
default for new manifests that declare the `network` block.

## Validation

Publish-time validation enforces:

- At most 20 domains.
- Exact domains such as `api.openai.com`.
- Wildcards only in the `*.subdomain.com` form.
- No full wildcard `*`.
- No URLs, ports, userinfo, or IP literals.
- No private or local resolved targets at runtime.

Public-store review uses the same field to inspect whether the app's declared
integrations match its product behavior.

## Runtime Enforcement

For an empty allowlist, Floom starts the app container with Docker
`NetworkMode: none`.

For a non-empty allowlist, Floom creates a per-run internal Docker bridge and
starts a per-run HTTP CONNECT proxy on that bridge gateway. The container gets
`HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` pointing to that proxy. Direct
egress is blocked by the internal Docker network; proxy requests are allowed
only when the requested host matches `network.allowed_domains` and resolves to
public IP addresses.

Denied attempts are logged as:

```text
[network-policy] denied outbound run=<run_id> host=<host> reason=<reason>
```

## Backward Compatibility

Manifests persisted before ADR-016 may not contain `network`. At runtime those
legacy apps receive a curated compatibility allowlist for the common AI APIs:

- `api.openai.com`
- `generativelanguage.googleapis.com`
- `api.anthropic.com`

New publishes must declare `network.allowed_domains` explicitly.
