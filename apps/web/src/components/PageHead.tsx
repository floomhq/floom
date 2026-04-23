// PageHead — per-route <head> updater for an SPA.
//
// Our index.html ships sensible defaults for the landing page (title,
// description, canonical, OG, Twitter). On client-side navigation those
// defaults are *wrong*: the landing description renders on /about, the
// canonical points at "/" on every deep link, and share-card title
// reads "Ship AI apps fast" even when you share /pricing.
//
// This component runs a useEffect on mount / route change and updates
// the handful of tags that actually matter for SEO + social:
//   <title>, <link rel=canonical>, og:title, og:description, og:url,
//   twitter:title, twitter:description. og:image and twitter:card stay
//   whatever index.html sets (global default is fine for now).
//
// Use it inside any page component. The element renders nothing.
//
// Related issues: #172, #316, #317, #324.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SITE = 'https://floom.dev';

function setMeta(selector: string, attr: 'content' | 'href', value: string) {
  let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
  if (!el) return;
  el.setAttribute(attr, value);
}

export interface PageHeadProps {
  /** Full document title. Usually "<page name> · Floom". */
  title: string;
  /** ~140–160 char meta description. */
  description: string;
  /**
   * Explicit pathname, if the caller wants to override what useLocation()
   * returns. Useful for redirect pages or dynamic routes where the React
   * Router path already decoded (e.g. `/p/uuid`).
   */
  pathname?: string;
}

export function PageHead({ title, description, pathname }: PageHeadProps) {
  const loc = useLocation();
  useEffect(() => {
    const path = pathname ?? loc.pathname ?? '/';
    // Strip trailing slash (except root) so /about/ and /about share the
    // same canonical — mirrors how Google's canonicalisation works.
    const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    const url = `${SITE}${clean}`;

    document.title = title;
    setMeta('link[rel="canonical"]', 'href', url);
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:url"]', 'content', url);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', description);
  }, [loc.pathname, pathname, title, description]);

  return null;
}
