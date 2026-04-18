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
          paddingTop: 72,
          paddingBottom: 72,
        }}
      >
        {/* Brand echo: small glowing mark sits behind the headline.
            Round 2 polish: previously the mark was centered on the main
            axis (top: 50%, translate -64%), which pulled it over the
            pills row. Shrink it to 240px and anchor it at the top so
            its bounding box clears the CTA row at 1440x900. Geometry
            gate: pills top must exceed the mark's bottom. */}
        <div
          aria-hidden="true"
          data-testid="not-found-glow"
          style={{
            position: 'absolute',
            top: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 240,
            height: 240,
            pointerEvents: 'none',
            opacity: 0.14,
            zIndex: 0,
          }}
        >
          <Logo size={240} variant="glow" />
        </div>

        <div
          style={{
            position: 'relative',
            zIndex: 1,
            maxWidth: 560,
            margin: '0 auto',
            padding: '300px 24px 40px',
          }}
        >
          <h1 className="headline" style={{ fontSize: 48, margin: '0 0 14px' }}>
            404 <span className="headline-dim">· not found</span>
          </h1>
          <p className="subhead" style={{ margin: '0 auto 32px' }}>
            This path isn't wired to anything. Head back home or browse public apps.
          </p>
          <div
            className="pills"
            data-testid="not-found-pills"
            style={{ justifyContent: 'center', position: 'relative', zIndex: 2 }}
          >
            <Link to="/" className="pill" data-testid="not-found-pill-home" style={{ textDecoration: 'none' }}>
              Back to home
            </Link>
            <Link to="/apps" className="pill" data-testid="not-found-pill-apps" style={{ textDecoration: 'none' }}>
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
