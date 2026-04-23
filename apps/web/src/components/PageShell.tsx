// W4-minimal: shared page shell used by every new page on the store side.
//
// This is now a thin wrapper over <BaseLayout> (2026-04-20 nav
// unification). Public props are unchanged so every caller keeps
// working. BaseLayout owns the TopBar, auth gating, and route-loading
// behavior; PageShell just hands it the store-side defaults (main
// max-width, footer, no sidebar).
//
// OSS mode (is_local=true) is treated as "logged in as local" for pages
// that don't strictly require cloud — the synthetic user can still browse
// /me, /build, /creator and see their device-scoped runs.

import type { ReactNode } from 'react';
import { BaseLayout } from './BaseLayout';
import { Footer } from './Footer';

interface Props {
  children: ReactNode;
  requireAuth?: 'cloud' | 'any' | null;
  title?: string;
  /** Meta description for this route. Forwarded to BaseLayout which
   *  updates <meta name="description"> + og:description + twitter:description
   *  on mount / route change. */
  description?: string;
  contentStyle?: React.CSSProperties;
  allowSignedOutShell?: boolean;
  /** Forwarded to BaseLayout. Pages that are auth-gated and don't
   *  belong in search results (/me/*, password reset) set this to true. */
  noIndex?: boolean;
}

export function PageShell({
  children,
  requireAuth = null,
  title,
  description,
  contentStyle,
  allowSignedOutShell = false,
  noIndex = false,
}: Props) {
  return (
    <BaseLayout
      title={title}
      description={description}
      requireAuth={requireAuth}
      allowSignedOutShell={allowSignedOutShell}
      noIndex={noIndex}
      footer={<Footer />}
      mainStyle={{
        padding: '32px 24px 120px',
        maxWidth: 1080,
        margin: '0 auto',
        minHeight: 'calc(100vh - 56px - 80px)',
        ...contentStyle,
      }}
    >
      {children}
    </BaseLayout>
  );
}
