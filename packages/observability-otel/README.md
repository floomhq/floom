# @floomhq/observability-otel

OpenTelemetry implementation of the Floom protocol `ObservabilityAdapter`.

```ts
import { createOtelObservabilityAdapter } from '@floomhq/observability-otel';

const observability = createOtelObservabilityAdapter({
  serviceName: 'floom-server',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
```

When no OTLP endpoint is configured, the adapter keeps the contract's no-throw
behavior and emits local metric lines for contract visibility.
