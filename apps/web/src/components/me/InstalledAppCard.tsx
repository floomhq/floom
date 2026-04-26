// /me/apps card. v23 PR-J editorial pattern: each card has a banner
// thumb (mono "run-result" preview), a body with name + meta + desc +
// sparkline + tag chips, and a foot row with a last-run mono pill +
// accent CTA.
//
// Two variants:
//   - hero (`variant="hero"`) — first card in the staggered grid,
//     spans 2 columns on desktop, has a 240px banner, shows the
//     "installed" pill in the header, and renders a primary green CTA
//     ("Run again →"). Mobile collapses to a regular row.
//   - compact (`variant="compact"`) — every other card, 1-col,
//     140px banner, no install pill, accent text-link CTA ("Open →").
//
// CSS lives in wireframe.css under `.me-apps-page` scope.
//
// NO category tints (Federico-locked 2026-04-26). The wireframe's
// `banner-research / banner-writing / banner-content / banner-travel /
// banner-dev` thumb tints are dropped — every banner uses one neutral
// surface. The category badge stays as a small mono cap inside the
// thumb so the category signal isn't lost.

import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { BannerCard, type BannerLine } from '../public/BannerCard';
import { Sparkline } from '../studio/Sparkline';
import { formatTime } from '../../lib/time';
import { buildRerunHref } from './runPreview';

export interface InstalledAppCardProps {
  slug: string;
  name: string;
  /** App description shown as the 1-line lede under the name. */
  description: string;
  /** Mono category badge in the top-left of the thumb (e.g. "Research"). */
  categoryLabel: string;
  /** Banner mini-preview (mono title + 1-3 lines, optional accent/dim). */
  bannerTitle: string;
  bannerLines: BannerLine[];
  /** Per-week run count meta line. */
  runCountThisWeek: number;
  /** ISO timestamp of last run — formatted as "2m ago". */
  lastUsedAt: string | null;
  /** Optional tags to render below the sparkline. */
  tags?: string[];
  /** Last run id + action — used to deep-link Re-run via buildRerunHref. */
  lastRunId?: string | null;
  lastRunAction?: string | null;
  /** Hero card spans 2 cols + 240px banner + green CTA. */
  variant: 'hero' | 'compact';
}

export function InstalledAppCard({
  slug,
  name,
  description,
  categoryLabel,
  bannerTitle,
  bannerLines,
  runCountThisWeek,
  lastUsedAt,
  tags,
  lastRunId,
  lastRunAction,
  variant,
}: InstalledAppCardProps) {
  const isHero = variant === 'hero';
  const rel = lastUsedAt ? formatTime(lastUsedAt) : null;
  const cardHref = `/p/${slug}`;
  const ctaHref = isHero ? buildRerunHref(slug, lastRunId, lastRunAction) : cardHref;
  const runMeta = `${runCountThisWeek} ${
    isHero ? 'of your runs this week' : `run${runCountThisWeek === 1 ? '' : 's'} this week`
  }`;

  return (
    <article
      className={`ma-card${isHero ? ' ma-card-hero' : ''}`}
      data-testid={`me-apps-card-${slug}`}
      data-hero={isHero ? 'true' : undefined}
    >
      <Link to={cardHref} className="ma-card-link" aria-label={`Open ${name}`}>
        <div className="thumb app-banner">
          <span className="thumb-cap">{categoryLabel}</span>
          <BannerCard
            title={bannerTitle}
            lines={bannerLines}
            size={isHero ? 'lg' : 'sm'}
          />
        </div>
        <div className="body">
          <div className="head">
            <span aria-hidden className="app-ic">
              <AppIcon slug={slug} size={isHero ? 22 : 18} />
            </span>
            <div className="meta">
              <div className="nm">{name}</div>
              <div className="stats">
                <span className="run-count-inline">{runMeta}</span>
              </div>
            </div>
            {isHero ? (
              <span
                className="pill pill-accent installed-pill"
                data-testid={`me-apps-installed-pill-${slug}`}
              >
                <span className="dot dot-live" aria-hidden />
                installed
              </span>
            ) : null}
          </div>
          <p className="desc">{description}</p>
          <div className="ma-spark" aria-hidden>
            <Sparkline slug={slug} />
          </div>
          {tags && tags.length > 0 ? (
            <div className="tag-chips">
              {tags.map((t) => (
                <span key={t} className="tag-chip">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Link>
      <div className="foot">
        <span className="mono-tag last-run">
          {rel ? `Last run ${rel}` : 'Not run yet'}
        </span>
        {isHero ? (
          <Link
            to={ctaHref}
            className="btn btn-accent btn-sm"
            data-testid={`me-apps-cta-${slug}`}
          >
            Run again →
          </Link>
        ) : (
          <Link
            to={ctaHref}
            className="open-link"
            data-testid={`me-apps-cta-${slug}`}
          >
            Open →
          </Link>
        )}
      </div>
    </article>
  );
}
