import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';

export function NotFoundPage() {
  return (
    <div className="page-root">
      <TopBar />
      <main className="main" style={{ textAlign: 'center' }}>
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
      </main>
    </div>
  );
}
