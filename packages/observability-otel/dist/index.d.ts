import type { ObservabilityAdapter } from '@floom/adapter-types';
export interface OtelObservabilityOptions {
    serviceName: string;
    otlpEndpoint?: string;
    batchTimeoutMs?: number;
}
export declare function createOtelObservabilityAdapter(opts: OtelObservabilityOptions): ObservabilityAdapter;
export declare const otelObservabilityAdapter: ObservabilityAdapter;
declare const _default: {
    kind: "observability";
    name: string;
    protocolVersion: string;
    create: typeof createOtelObservabilityAdapter;
    adapter: ObservabilityAdapter;
};
export default _default;
