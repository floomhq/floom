import type { AuthAdapter, StorageAdapter } from '@floom/adapter-types';
export interface MagicLinkAuthAdapterOptions {
    resendApiKey: string;
    fromEmail: string;
    jwtSecret: string;
    jwtIssuer?: string;
    storage: StorageAdapter;
    baseUrl?: string;
    sessionTtlSeconds?: number;
    magicLinkTtlSeconds?: number;
    sendEmail?: boolean;
    exposeTokenForTests?: boolean;
    resendClient?: MagicLinkEmailClient;
}
interface MagicLinkEmailClient {
    emails: {
        send(input: {
            from: string;
            to: string;
            subject: string;
            html: string;
        }): Promise<unknown> | unknown;
    };
}
export declare function createMagicLinkAuthAdapter(opts: MagicLinkAuthAdapterOptions): AuthAdapter;
declare const _default: {
    kind: "auth";
    name: string;
    protocolVersion: string;
    create: typeof createMagicLinkAuthAdapter;
};
export default _default;
