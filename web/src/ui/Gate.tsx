import { useRef, useState, type FormEvent } from 'react';
import { useSession } from '../state/session';
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
  const fileInput = useRef<HTMLInputElement>(null);

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
        <h1>Budget Tracker</h1>
      </div>
      <div className="setup-options">
        <section className="card setup-option">
          <h2>Set up a new budget</h2>
          <p className="muted small">Your data stays encrypted in this browser. There is no recovery if you forget your password.</p>
          <form onSubmit={submit} className="stack">
            <label>Password
              <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
            </label>
            <label>Confirm password
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Encrypting…' : 'Create encrypted store'}</button>
          </form>
        </section>
        <section className="card setup-option setup-import-option">
          <h2>Import a .budget file</h2>
          <p className="muted small">Bring an encrypted budget into this browser. The file password unlocks it, then protects the local copy.</p>
          <form onSubmit={submitImport} className="stack">
            <div className="file-picker">
              <span className="file-picker-label">Budget file</span>
              <input ref={fileInput} className="file-picker-input" type="file" accept=".budget,application/json" tabIndex={-1} aria-hidden="true" onChange={(e) => setBackup(e.target.files?.[0] ?? null)} />
              <button type="button" className="file-picker-button" onClick={() => fileInput.current?.click()}>Choose a .budget file</button>
              <div className="file-picker-selection" aria-live="polite">
                <span className="file-picker-name">{backup?.name ?? 'No file selected'}</span>
                {backup && <button type="button" className="file-picker-clear" onClick={() => { setBackup(null); if (fileInput.current) fileInput.current.value = ''; }}>Remove</button>}
              </div>
            </div>
            <label>File password
              <input type="password" autoComplete="current-password" value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} required />
            </label>
            {backupError && <p className="error" role="alert">{backupError}</p>}
            <button type="submit" className="primary import-submit" disabled={!backup || importing}>{importing ? 'Importing…' : 'Import budget'}</button>
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
        <h1>Budget Tracker</h1>
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
