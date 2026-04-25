import { getAuth, isCloudMode } from '../lib/better-auth.js';
import type { AuthAdapter } from './types.js';
import type { SessionContext } from '../types.js';


export class BetterAuthAdapter implements AuthAdapter {
  async getSession(request: Request): Promise<SessionContext | null> {
    if (!isCloudMode()) return null;
    const auth = getAuth();
    if (!auth) return null;

    try {
      const result = await auth.api.getSession({ headers: request.headers }) as any;
      if (!result || !result.user || result.user.emailVerified === false) {
        return null;
      }
      // We simply return the auth information. The session.ts
      // middleware will still handle the Floom-specific tenant mirroring 
      // (workspaces, device_id). We use a partial SessionContext here and 
      // let session.ts fill the rest.
      return {
        user_id: result.user.id,
        workspace_id: '', // filled by session.ts
        device_id: '', // filled by session.ts
        is_authenticated: true,
        auth_user_id: result.user.id,
        auth_session_id: result.session?.id,
        email: result.user.email,
        _raw_user: result.user, // pass raw user for mirror
      } as any;
    } catch {
      return null;
    }
  }

  async signIn(): Promise<any> { throw new Error('NotImplemented'); }
  async signUp(): Promise<any> { throw new Error('NotImplemented'); }
  async signOut(): Promise<any> { throw new Error('NotImplemented'); }
  async onUserDelete(): Promise<any> { throw new Error('NotImplemented'); }
}

export const authAdapter = new BetterAuthAdapter();
