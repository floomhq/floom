interface LogoProps {
  size?: number;
  className?: string;
  withWordmark?: boolean;
  /**
   * Visual treatment for the mark.
   *
   *   plain  — flat green "f" in a rounded square (default, unchanged
   *            from prior versions to keep existing surfaces intact).
   *   glow   — the chevron mark from /floom-mark-glow.svg with a baked
   *            SVG halo. Use for brand moments (onboarding hero, 404
   *            backdrop echo, splash states).
   *   icon   — full iOS-style app icon: dark rounded-square background
   *            with the halo'd green chevron. Source for apple-touch
   *            -icon; also usable in-app for "install" prompts or brand
   *            previews.
   */
  variant?: 'plain' | 'glow' | 'icon';
  /**
   * Optional one-shot or ambient CSS animation. Pure CSS keyframes live
   * in wireframe.css and are all gated behind prefers-reduced-motion.
   *
   *   none       — default. No animation ever.
   *   boot-in    — one-shot fade + faint scale on mount (login, empty
   *                states, 404 echo).
   *   pulse-once — one-shot success flash. Re-runs when the consumer
   *                changes the React `key` on this Logo.
   *   breathe    — slow, infinite, subtle loop. ONLY on the landing
   *                hero — using this anywhere else reads as tacky.
   */
  animate?: 'none' | 'boot-in' | 'pulse-once' | 'breathe';
}

const ANIMATE_CLASS: Record<NonNullable<LogoProps['animate']>, string> = {
  none: '',
  'boot-in': 'logo-animate-boot-in',
  'pulse-once': 'logo-animate-pulse-once',
  breathe: 'logo-animate-breathe',
};

/**
 * Floom mark. Shared across in-app TopBar and landing-style surfaces so
 * the brand renders identically everywhere. Three variants:
 *
 *   - plain (default): text "f" in a green rounded square. Crisp at any
 *     size, no filter cost, safe inside tight chrome.
 *   - glow: chevron mark with a soft green halo. Use sparingly for
 *     brand moments. Static halo unless `animate` opts in.
 *   - icon: full app-icon with dark rounded-square background + halo.
 *     Use where a single logo needs to stand alone on a neutral page
 *     (404 echo, hero splash).
 *
 * The gradient and shadow for `plain` match the existing landing page
 * wordmark exactly; the glow filter lives in the SVGs so there is one
 * source of truth for the halo recipe.
 */
export function Logo({
  size = 28,
  className = '',
  withWordmark = false,
  variant = 'plain',
  animate = 'none',
}: LogoProps) {
  const wordmark = withWordmark ? (
    <span className="font-semibold">floom</span>
  ) : null;

  const animClass = ANIMATE_CLASS[animate];
  const rootClass = `inline-flex items-center gap-2 ${animClass} ${className}`.trim();

  if (variant === 'glow') {
    return (
      <span className={rootClass}>
        <img
          src="/floom-mark-glow.svg"
          alt="Floom"
          width={size}
          height={size}
          style={{ width: size, height: size, display: 'inline-block' }}
          draggable={false}
        />
        {wordmark}
      </span>
    );
  }

  if (variant === 'icon') {
    return (
      <span className={rootClass}>
        <img
          src="/floom-icon.svg"
          alt="Floom"
          width={size}
          height={size}
          style={{
            width: size,
            height: size,
            display: 'inline-block',
            borderRadius: Math.round(size * 0.22),
          }}
          draggable={false}
        />
        {wordmark}
      </span>
    );
  }

  // plain (default) — unchanged layout to preserve existing surfaces.
  const fontSize = Math.round(size * 0.5);
  const radius = Math.max(6, Math.round(size * 0.29));
  return (
    <span className={rootClass}>
      <span
        aria-label="Floom"
        role="img"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: 'linear-gradient(135deg, #059669, #10b981)',
          color: '#fff',
          fontWeight: 700,
          fontSize,
          fontFamily: 'Inter, system-ui, sans-serif',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow:
            '0 1px 2px rgba(5, 150, 105, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
          lineHeight: 1,
        }}
      >
        f
      </span>
      {wordmark}
    </span>
  );
}

// Keep backward-compat exports used in other files.
export function FloomMark({ size = 32, className }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />;
}

export function FloomWordmark({ size = 32, className }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} withWordmark />;
}
