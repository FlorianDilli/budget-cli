import { useState, type FormEvent } from 'react';
import { useSession, MIN_PASSWORD_LENGTH } from '../state/session';
import { CryptoError } from '../crypto/envelope';

function errorText(e: unknown): string {
  if (e instanceof CryptoError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function SetupScreen() {
  const { setup } = useSession();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== confirm) return setError('The passwords do not match');
    setBusy(true);
    try {
      await setup(pw);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <h1>Set up moonli Budget</h1>
      <p className="warn">
        Your data is encrypted with this password and stays in this browser. There is no recovery: a forgotten password makes the data unreadable.
      </p>
      <form onSubmit={submit} className="stack">
        <label>Password (at least {MIN_PASSWORD_LENGTH} characters)
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </label>
        <label>Confirm password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Encrypting…' : 'Create encrypted store'}</button>
      </form>
    </main>
  );
}

export function UnlockScreen() {
  const { unlock, error: storeError } = useSession();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await unlock(pw);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setPw('');
    }
  };

  return (
    <main className="gate">
      <div className="gate-brand">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={112} height={112} className="gate-logo" />
        <h1>moonli Budget</h1>
      </div>
      <form onSubmit={submit} className="stack">
        <label>Password
          <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required />
        </label>
        {(error || storeError) && <p className="error" role="alert">{error ?? storeError}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
    </main>
  );
}
