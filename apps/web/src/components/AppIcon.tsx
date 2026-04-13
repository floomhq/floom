import { iconForSlug } from './IconSprite';

interface Props {
  slug: string;
  size?: number;
  color?: string;
}

export function AppIcon({ slug, size = 24, color = 'var(--ink)' }: Props) {
  const id = iconForSlug(slug);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ color, flexShrink: 0 }}
      aria-hidden="true"
    >
      <use href={`#${id}`} />
    </svg>
  );
}
