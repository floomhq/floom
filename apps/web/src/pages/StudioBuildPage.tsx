// /studio/build — thin wrapper around BuildPage rendered inside
// StudioLayout. Keeps the paste-first / detect / publish flow intact
// (PR #5) while reusing the same code path. Post-publish links send
// the creator to /studio/:slug. The in-page back breadcrumb was killed
// in the 2026-04-20 nav unification; the TopBar pill is now the only
// mode-switch affordance.

import type { ReactNode } from 'react';
import { BuildPage } from './BuildPage';
import { StudioLayout } from '../components/studio/StudioLayout';

function StudioLayoutAdapter({ children, title }: { children: ReactNode; title?: string }) {
  return <StudioLayout title={title}>{children}</StudioLayout>;
}

export function StudioBuildPage() {
  return (
    <BuildPage
      layout={StudioLayoutAdapter}
      postPublishHref={(slug) => `/studio/${slug}`}
    />
  );
}
