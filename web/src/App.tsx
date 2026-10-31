import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './state/session';
import { SetupScreen, UnlockScreen } from './ui/Gate';
import { Overview } from './ui/Overview';
import { Transactions } from './ui/Transactions';
import { Insights } from './ui/Insights';
import { Settings } from './ui/Settings';
import { BudgetPage } from './ui/BudgetPage';

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
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/insights', label: 'Insights', icon: 'insights' },
  { to: '/budget', label: 'Budget', icon: 'budget' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

function Shell() {
  const { lock, error, setError } = useSession();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={28} height={28} />
          <span>Plan Your Budget</span>
        </div>
        <button onClick={lock} className="lock">Lock</button>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <NavIcon name={n.icon} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="content">
        {error && (
          <p className="error" role="alert">
            {error} <button onClick={() => setError(null)}>Dismiss</button>
          </p>
        )}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function NavIcon({ name }: { name: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'overview' && <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>}
      {name === 'transactions' && <><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r=".8" /><circle cx="4" cy="12" r=".8" /><circle cx="4" cy="18" r=".8" /></>}
      {name === 'insights' && <><path d="M3.5 19.5h17" /><path d="m5 15 4-4 3 2 6-7" /><path d="M15 6h3v3" /></>}
      {name === 'budget' && <><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M8 3.5v17M4 9h16M12 13h4M12 17h4" /></>}
      {name === 'settings' && <><circle cx="12" cy="12" r="3" /><path d="M19.4 15.2a1.7 1.7 0 0 0 1.2-1.6v-3.2a1.7 1.7 0 0 0-1.2-1.6l-.8-.3a7 7 0 0 0-.7-1.2l.3-.8a1.7 1.7 0 0 0-.7-2l-2.8-1.6a1.7 1.7 0 0 0-2 .3l-.6.6a7 7 0 0 0-1.4 0l-.6-.6a1.7 1.7 0 0 0-2-.3L5.3 4.5a1.7 1.7 0 0 0-.7 2l.3.8a7 7 0 0 0-.7 1.2l-.8.3a1.7 1.7 0 0 0-1.2 1.6v3.2a1.7 1.7 0 0 0 1.2 1.6l.8.3a7 7 0 0 0 .7 1.2l-.3.8a1.7 1.7 0 0 0 .7 2l2.8 1.6a1.7 1.7 0 0 0 2-.3l.6-.6a7 7 0 0 0 1.4 0l.6.6a1.7 1.7 0 0 0 2 .3l2.8-1.6a1.7 1.7 0 0 0 .7-2l-.3-.8a7 7 0 0 0 .7-1.2z" /></>}
    </svg>
  );
}
