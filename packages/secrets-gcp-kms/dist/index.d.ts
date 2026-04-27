import type { SecretsAdapter, StorageAdapter } from '@floom/adapter-types';
export interface GcpKmsSecretsAdapterOptions {
    keyName: string;
    projectId?: string;
    storage: StorageAdapter;
    kmsClient?: DekWrapper;
}
export interface DekWrapper {
    encryptDek(dek: Buffer): Promise<Buffer>;
    decryptDek(encryptedDek: Buffer): Promise<Buffer>;
}
export declare function createMockGcpKmsDekWrapper(): DekWrapper;
export declare function createGcpKmsSecretsAdapter(opts: GcpKmsSecretsAdapterOptions): SecretsAdapter;
interface FactoryOptions {
    keyName?: string;
    projectId?: string;
    storage?: StorageAdapter;
}
declare const _default: {
    kind: "secrets";
    name: string;
    protocolVersion: string;
    create(opts: FactoryOptions): SecretsAdapter;
};
export default _default;
