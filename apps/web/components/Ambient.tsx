// Aurora + grain background layers. Drop into the root of any page.
// Decorative only (aria-hidden).

export function Ambient() {
  return (
    <>
      <div className="spacebg" aria-hidden="true"><span className="c c1" /><span className="c c2" /><span className="c c3" /></div>
      <svg className="ambient-filter-defs" width="0" height="0" aria-hidden="true">
        <filter id="liquid-refract">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves={2} seed={4} result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={14} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div className="ambient" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
    </>
  );
}
