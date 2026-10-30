import { useState, type FormEvent } from 'react';
import { useSession, MIN_PASSWORD_LENGTH } from '../state/session';
import { CryptoError } from '../crypto/envelope';

function errorText(e: unknown): string {
  if (e instanceof CryptoError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function SetupScreen() {
  const { setup, importBackup } = useSession();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<File | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupError, setBackupError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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

  const submitImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!backup) return;
    setBackupError(null);
    setImporting(true);
    try {
      await importBackup(await backup.text(), backupPassword);
    } catch (err) {
      setBackupError(errorText(err));
    } finally {
      setImporting(false);
      setBackupPassword('');
    }
  };

  return (
    <main className="gate gate-setup">
      <div className="gate-brand">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={112} height={112} className="gate-logo" />
        <h1>moonli Budget</h1>
      </div>
      <div className="setup-options">
        <section className="card setup-option">
          <h2>Set up a new budget</h2>
          <p className="muted small">Your data stays encrypted in this browser. There is no recovery if you forget your password.</p>
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
        </section>
        <section className="card setup-option">
          <h2>Restore a .budget file</h2>
          <p className="muted small">Import an encrypted backup. Its password will protect the copy saved in this browser.</p>
          <form onSubmit={submitImport} className="stack">
            <label>Backup file
              <input type="file" accept=".budget,application/json" onChange={(e) => setBackup(e.target.files?.[0] ?? null)} />
            </label>
            <label>Backup password
              <input type="password" autoComplete="current-password" value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} required />
            </label>
            {backupError && <p className="error" role="alert">{backupError}</p>}
            <button type="submit" disabled={!backup || importing}>{importing ? 'Restoring…' : 'Restore budget'}</button>
          </form>
        </section>
      </div>
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
