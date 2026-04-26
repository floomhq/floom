import type { StorageAdapter } from '@floom/adapter-types';
export interface PostgresAdapterOptions {
    connectionString: string;
    setupSchema?: boolean;
    callTimeoutMs?: number;
}
export declare function createPostgresAdapter(opts: PostgresAdapterOptions): StorageAdapter;
export declare const postgresStorageAdapter: StorageAdapter;
declare const _default: {
    kind: "storage";
    name: string;
    protocolVersion: string;
    adapter: StorageAdapter;
};
export default _default;
