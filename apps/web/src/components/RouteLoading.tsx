import { Logo } from './Logo';

type Props = {
  /** Full viewport (lazy route Suspense). Embedded keeps TopBar layout stable in PageShell. */
  variant?: 'full' | 'embed';
};

/**
 * Branded loading UI for route transitions and auth gates. Keeps bundle small:
 * Logo is already on critical path elsewhere; skeletons are plain CSS.
 */
export function RouteLoading({ variant = 'full' }: Props) {
  const rootClass =
    variant === 'full' ? 'route-loading route-loading--full' : 'route-loading route-loading--embed';

  return (
    <div className={rootClass} aria-busy="true">
      <div className="route-loading__stack">
        <Logo size={44} variant="glow" animate="boot-in" />
        <div className="route-loading__bars" aria-hidden="true">
          <span className="route-loading__bar" />
          <span className="route-loading__bar route-loading__bar--mid" />
          <span className="route-loading__bar route-loading__bar--short" />
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        Loading…
      </span>
    </div>
  );
}
