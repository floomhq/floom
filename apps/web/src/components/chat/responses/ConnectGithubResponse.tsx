interface Props {
  isSignedIn?: boolean;
  onSignIn?: () => void;
}

export function ConnectGithubResponse({ isSignedIn = false, onSignIn }: Props) {
  if (isSignedIn) {
    return (
      <div className="assistant-turn">
        <div className="app-expanded-card">
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
            Your GitHub is connected. You can deploy private repos from any URL.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="assistant-turn">
      <div className="app-expanded-card">
        <p style={{ margin: '0 0 16px', fontSize: 15, lineHeight: 1.6 }}>
          Sign in with GitHub to deploy private repos, see your saved apps, and persist your chat
          history.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 16px',
            background: '#24292f',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
            <use href="#icon-github" />
          </svg>
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
