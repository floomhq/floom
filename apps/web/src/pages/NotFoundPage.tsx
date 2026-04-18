import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Logo } from '../components/Logo';
import { PublicFooter } from '../components/public/PublicFooter';

export function NotFoundPage() {
  return (
    <div className="page-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopBar />
      <main
        className="main"
        style={{
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
          flex: 1,
        }}
      >
        {/* Brand echo: large glowing mark sits behind the 404, reading as
            a watermark rather than a competing visual. Opacity is low so
            the headline stays the star. Hidden from screen readers so
            the 404 wording is what gets announced. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -64%)',
            width: 360,
            height: 360,
            pointerEvents: 'none',
            opacity: 0.18,
            zIndex: 0,
          }}
        >
          <Logo size={360} variant="glow" />
        </div>

        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1 className="headline" style={{ fontSize: 48 }}>
            404 <span className="headline-dim">· not found</span>
          </h1>
          <p className="subhead" style={{ margin: '0 auto 32px' }}>
            This path isn't wired to anything. Head back home or browse public apps.
          </p>
          <div className="pills" style={{ justifyContent: 'center' }}>
            <Link to="/" className="pill" style={{ textDecoration: 'none' }}>
              Back to home
            </Link>
            <Link to="/apps" className="pill" style={{ textDecoration: 'none' }}>
              Browse apps
            </Link>
          </div>
        </div>
      </main>
      {/* Landing visual audit 2026-04-18: 404 previously had no footer,
          leaving a tall screen with just the glow mark echo and two
          pills. Reuse PublicFooter so 404 exposes the same trust links
          (Docs / GitHub / Privacy / Terms / Cookies) as the landing. */}
      <PublicFooter />
    </div>
  );
}
