// Friendly copy for auth errors.
//
// The signup / sign-in page talks to Better Auth at /auth/*. Better Auth
// returns errors as `{ message, code }` where `code` is a stable machine
// identifier (e.g. `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`) and `message` is
// a raw English sentence not fit for UI. We map codes (and, as a fallback,
// HTTP status) to short human-friendly copy and an optional recovery action
// the UI can wire to a button.
//
// If you add new server-side auth codes (custom endpoints or Better Auth
// upgrades), extend the CODE_MAP below. The fallback path guarantees we
// never spill raw JSON to the UI.

export type AuthErrorAction =
  | { kind: 'switch-to-signin' }
  | { kind: 'switch-to-signup' }
  | { kind: 'resend-verification' };

export interface AuthErrorCopy {
  /** Short sentence to show above the form. */
  message: string;
  /** Optional inline button the UI can render next to the message. */
  action?: { label: string; intent: AuthErrorAction };
}

// Codes covered below are the ones Better Auth 1.6.x can emit from the
// /auth/sign-in/email, /auth/sign-up/email, /auth/change-password,
// /auth/delete-user, and /auth/forget-password endpoints we use. When a new
// code shows up in the wild, add it here rather than letting it fall
// through to the generic fallback.
const CODE_MAP: Record<string, AuthErrorCopy> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    message: 'This email already has a Floom account.',
    action: { label: 'Sign in instead', intent: { kind: 'switch-to-signin' } },
  },
  USER_ALREADY_EXISTS: {
    message: 'This email already has a Floom account.',
    action: { label: 'Sign in instead', intent: { kind: 'switch-to-signin' } },
  },
  EMAIL_ALREADY_IN_USE: {
    message: 'This email already has a Floom account.',
    action: { label: 'Sign in instead', intent: { kind: 'switch-to-signin' } },
  },
  INVALID_CREDENTIALS: {
    message: 'Email or password is incorrect.',
  },
  INVALID_EMAIL_OR_PASSWORD: {
    message: 'Email or password is incorrect.',
  },
  INVALID_EMAIL: {
    message: 'That email address does not look right.',
  },
  INVALID_PASSWORD: {
    message: 'Email or password is incorrect.',
  },
  USER_NOT_FOUND: {
    message: 'No Floom account with that email.',
    action: {
      label: 'Create account instead',
      intent: { kind: 'switch-to-signup' },
    },
  },
  EMAIL_NOT_VERIFIED: {
    message: 'Check your email — we sent a verification link.',
    action: {
      label: 'Resend link',
      intent: { kind: 'resend-verification' },
    },
  },
  PASSWORD_TOO_SHORT: {
    message: 'Password must be at least 8 characters.',
  },
  PASSWORD_TOO_LONG: {
    message: 'Password is too long.',
  },
  FAILED_TO_CREATE_USER: {
    message: 'We could not create the account. Try again in a moment.',
  },
  FAILED_TO_CREATE_SESSION: {
    message: 'We could not sign you in. Try again in a moment.',
  },
  ACCOUNT_NOT_FOUND: {
    message: 'No Floom account with that email.',
    action: {
      label: 'Create account instead',
      intent: { kind: 'switch-to-signup' },
    },
  },
  RATE_LIMIT_EXCEEDED: {
    message: 'Too many attempts. Wait a minute and try again.',
  },
  TOO_MANY_REQUESTS: {
    message: 'Too many attempts. Wait a minute and try again.',
  },
  SESSION_EXPIRED: {
    message: 'Your session expired. Sign in again.',
    action: {
      label: 'Sign in',
      intent: { kind: 'switch-to-signin' },
    },
  },
  SOCIAL_ACCOUNT_ALREADY_LINKED: {
    message: 'This email is already linked to another sign-in method.',
    action: {
      label: 'Try signing in instead',
      intent: { kind: 'switch-to-signin' },
    },
  },
};

interface AuthErrorLike {
  status?: number;
  code?: string | null;
  message?: string;
}

/**
 * Resolve a Floom/Better Auth error into human-friendly copy. Never returns
 * raw JSON. Works for any caller that throws an `ApiError`-shaped object.
 *
 * The optional `mode` arg disambiguates status-code fallbacks between
 * sign-in (401 = wrong password) and sign-up (400/422 = invalid input).
 */
export function friendlyAuthError(
  err: AuthErrorLike | null | undefined,
  mode: 'signin' | 'signup' = 'signin',
): AuthErrorCopy {
  if (!err) return { message: 'Something went wrong. Try again.' };

  if (err.code) {
    const hit = CODE_MAP[err.code];
    if (hit) return hit;
  }

  // Status-code fallback: Floom's own /auth error paths (e.g. 404 when cloud
  // mode is off) and any Better Auth codes we haven't enumerated yet.
  const status = err.status ?? 0;
  if (status === 404) {
    return {
      message:
        'Cloud sign-in is not enabled on this server. You can still use Floom as the local user.',
    };
  }
  if (status === 401) {
    return { message: 'Email or password is incorrect.' };
  }
  if (status === 429) {
    return { message: 'Too many attempts. Wait a minute and try again.' };
  }
  if (status === 400 || status === 422) {
    // If the server did return text via `err.message` but it doesn't look
    // like machine JSON, pass it through — it's usually a useful validation
    // hint (e.g. "password must contain at least 8 characters"). We guard
    // against raw `{...}` leaking by checking the first char.
    const msg = (err.message || '').trim();
    if (msg && !msg.startsWith('{') && !msg.startsWith('[')) {
      return { message: msg };
    }
    return {
      message:
        mode === 'signup'
          ? 'Check your email and password, then try again.'
          : 'Email or password is incorrect.',
    };
  }
  if (status >= 500) {
    return {
      message: 'Our server hiccuped. Try again in a moment.',
    };
  }

  return { message: 'Something went wrong. Try again.' };
}
