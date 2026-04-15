interface LogoProps {
  size?: number;
  className?: string;
  withWordmark?: boolean;
}

/**
 * Floom mark: rounded-square "f" in the brand accent. Shared with
 * landing.floom.dev so both surfaces render the same wordmark. The
 * gradient matches landing's `--accent` -> `#10b981`, and the drop
 * shadow matches landing's `wordmark-f` class exactly. Hex values are
 * inlined so the mark renders even in environments where the CSS var
 * hasn't loaded yet.
 */
export function Logo({ size = 28, className = '', withWordmark = false }: LogoProps) {
  const fontSize = Math.round(size * 0.5);
  const radius = Math.max(6, Math.round(size * 0.29));
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
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
      {withWordmark && <span className="font-semibold">floom</span>}
    </span>
  );
}

// Keep backward-compat exports used in other files
export function FloomMark({ size = 32, className }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />;
}

export function FloomWordmark({ size = 32, className }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} withWordmark />;
}
