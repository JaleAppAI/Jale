import { getAdminAuthConfig } from '@/lib/auth';
import { AdminLoginForm } from '@/components/AdminLoginForm';

export default function LoginPage() {
  const config = getAdminAuthConfig();
  const userPoolId = config.userPoolId || 'Not configured';
  const clientId = config.clientId || 'Not configured';

  return (
    <main className="grid two">
      <section className="card stack-gap">
        <div className="meta">
          <span className="badge open">Admin sign-in</span>
          <span className="pill warning">MFA required</span>
        </div>
        <h1>Sign in to Jale Admin</h1>
        <p className="muted">
          Admin access is intentionally separate from worker and employer auth and uses the
          dedicated Cognito user pool with MFA.
        </p>
        <AdminLoginForm config={config} />
      </section>

      <aside className="card stack-gap">
        <h2>Auth config</h2>
        <div className="stack">
          <span className="muted">Hosted domain</span>
          <strong>{config.hostedDomain}</strong>
        </div>
        <div className="stack">
          <span className="muted">User pool</span>
          <code>{userPoolId}</code>
        </div>
        <div className="stack">
          <span className="muted">Client ID</span>
          <code>{clientId}</code>
        </div>
        <div className="stack">
          <span className="muted">Region</span>
          <code>{config.region}</code>
        </div>
        <p className="muted">
          These values come from the dedicated admin stack environment and are checked server-side.
        </p>
      </aside>
    </main>
  );
}
