import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './state/session';
import { SetupScreen, UnlockScreen } from './ui/Gate';
import { Overview } from './ui/Overview';
import { Transactions } from './ui/Transactions';
import { Insights } from './ui/Insights';
import { Settings } from './ui/Settings';

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}

function Gate() {
  const { status } = useSession();
  if (status === 'loading') return <main className="gate"><p className="muted">Loading…</p></main>;
  if (status === 'setup') return <SetupScreen />;
  if (status === 'locked') return <UnlockScreen />;
  return <Shell />;
}

const NAV = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/insights', label: 'Insights', icon: '↗' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

function Shell() {
  const { lock, error, setError, isSample } = useSession();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={28} height={28} />
          <span>moonli Budget</span>
        </div>
        <button onClick={lock} className="lock">Lock</button>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <span aria-hidden="true">{n.icon}</span>
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="content">
        {isSample && <p className="warn">Sample data: open Settings → Editor and press Save to keep it.</p>}
        {error && (
          <p className="error" role="alert">
            {error} <button onClick={() => setError(null)}>Dismiss</button>
          </p>
        )}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
