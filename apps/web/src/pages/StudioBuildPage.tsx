// /studio/build — thin wrapper around BuildPage rendered inside
// StudioLayout. Keeps the paste-first / detect / publish flow intact
// (PR #5) while reusing the same code path. Back breadcrumb points
// to /studio, post-publish links send the creator to /studio/:slug.

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
      backHref="/studio"
      postPublishHref={(slug) => `/studio/${slug}`}
    />
  );
}
