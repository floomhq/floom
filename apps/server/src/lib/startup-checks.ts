interface StartupEnv {
  readonly [name: string]: string | undefined;
}

export interface StartupCheckFailure {
  ok: false;
  code: 'missing_resend_api_key';
  message: string;
}

export interface StartupCheckSuccess {
  ok: true;
}

export type StartupCheckResult = StartupCheckSuccess | StartupCheckFailure;

/**
 * Production is keyed off NODE_ENV across the server. Preview is detected the
 * same way as the SEO noindex gate: PUBLIC_URL containing `preview.`.
 * DEPLOY_ENABLED only controls the publish/waitlist surface and is not a
 * deployment-mode signal.
 */
export function isProductionEnv(env: StartupEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isPreviewEnv(env: StartupEnv = process.env): boolean {
  return (env.PUBLIC_URL || '').includes('preview.');
}

export function requiresResendApiKey(env: StartupEnv = process.env): boolean {
  return isProductionEnv(env) && !isPreviewEnv(env);
}

export function checkStartupEnvironment(
  env: StartupEnv = process.env,
): StartupCheckResult {
  if (requiresResendApiKey(env) && !env.RESEND_API_KEY?.trim()) {
    return {
      ok: false,
      code: 'missing_resend_api_key',
      message:
        '[startup] fatal: NODE_ENV=production with non-preview PUBLIC_URL requires RESEND_API_KEY. ' +
        'ADR-010 forbids silently logging password-reset and signup-verification ' +
        'emails to stdout in production.',
    };
  }

  return { ok: true };
}

export function enforceStartupChecks(): void {
  const result = checkStartupEnvironment();
  if (result.ok) return;

  console.error(result.message);
  process.exit(1);
}
