import { useEffect, useState } from 'react';

const DEFAULT_MAX_WIDTH = 560;

export function useMeCompactLayout(maxWidth = DEFAULT_MAX_WIDTH): boolean {
  const [compact, setCompact] = useState(() => readMatch(maxWidth));

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => {
      setCompact(media.matches);
    };

    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, [maxWidth]);

  return compact;
}

function readMatch(maxWidth: number): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
}
