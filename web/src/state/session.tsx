import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sealEnvelope, openEnvelope, CryptoError } from '../crypto/envelope';
import { readVault, writeVault, deleteVault } from '../storage/vault';
import { emptySnapshot, parseSnapshot, SnapshotError, type Snapshot, type Tx } from '../domain/snapshot';
import { parseSettings, parseFinancials, DEFAULT_SETTINGS, EMPTY_FINANCIALS, type Settings, type Financials, type ValidationIssue } from '../domain/config';
import { prepareImport, type ImportPrepared, type NormalizedRow } from '../domain/csv';
import { classifyRows } from '../domain/duplicates';
import { monthOf } from '../domain/dates';
import type { ImportFormat } from '../domain/config';
import { SAMPLE_FINANCIALS, SAMPLE_SETTINGS } from '../domain/sample';

export type Status = 'loading' | 'setup' | 'locked' | 'unlocked';

export const AUTO_LOCK_MS = 10 * 60 * 1000;

export interface ImportPreview {
  filename: string;
  format: ImportFormat;
  rows: NormalizedRow[];
  fresh: Tx[];
  duplicates: number;
}

export type ImportResult = { ok: true; preview: ImportPreview } | { ok: false; error: string; rowErrors?: string[] };

export type SaveResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

interface SessionValue {
  status: Status;
  snapshot: Snapshot | null;
  settings: Settings;
  financials: Financials;
  /** True while the data is still the first-run sample (not saved by the user). */
  isSample: boolean;
  drafts: Record<'settings' | 'financials', string | null>;
  setDraft: (kind: 'settings' | 'financials', text: string) => void;
  error: string | null;
  setError: (e: string | null) => void;
  setup: (password: string) => Promise<void>;
  importBackup: (text: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  saveSettings: (text: string) => Promise<SaveResult>;
  saveFinancials: (text: string) => Promise<SaveResult>;
  previewImport: (text: string, filename: string, format?: ImportFormat) => Promise<ImportResult>;
  commitImport: (preview: ImportPreview) => Promise<number>;
  deleteMonth: (ym: string) => Promise<number>;
  resetAll: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  exportBackup: () => Promise<{ text: string; filename: string }>;
  readBackup: (text: string, password: string) => Promise<Snapshot>;
  restoreBackup: (snapshot: Snapshot) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function nowIso(): string {
  return new Date().toISOString();
}

function validSnapshotToml(s: Snapshot): ValidationIssue[] {
  const a = parseSettings(s.settingsToml);
  const b = parseFinancials(s.financialsToml);
  const issues: ValidationIssue[] = [];
  if (!a.ok) issues.push(...a.issues.map((i) => ({ ...i, message: `settings.toml: ${i.message}` })));
  if (!b.ok) issues.push(...b.issues.map((i) => ({ ...i, message: `financials.toml: ${i.message}` })));
  return issues;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<'settings' | 'financials', string | null>>({ settings: null, financials: null });
  const passwordRef = useRef<string | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const generation = useRef(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const lockTimer = useRef<number | null>(null);

  const lock = useCallback(() => {
    generation.current++;
    passwordRef.current = null;
    snapshotRef.current = null;
    setSnapshot(null);
    setDrafts({ settings: null, financials: null });
    setStatus((s) => (s === 'unlocked' ? 'locked' : s));
  }, []);

  // Auto-lock after inactivity (Open Question 7).
  useEffect(() => {
    if (status !== 'unlocked') return;
    const arm = () => {
      if (lockTimer.current !== null) window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(lock, AUTO_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'input', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, arm));
    arm();
    return () => {
      events.forEach((e) => window.removeEventListener(e, arm));
      if (lockTimer.current !== null) window.clearTimeout(lockTimer.current);
    };
  }, [status, lock]);

  useEffect(() => {
    readVault()
      .then((v) => setStatus(v === null ? 'setup' : 'locked'))
      .catch((e: unknown) => {
        setError(`Storage unavailable: ${e instanceof Error ? e.message : String(e)}`);
        setStatus('locked');
      });
  }, []);

  const persist = useCallback(async (makeNext: (current: Snapshot | null) => Snapshot, password: string, expectedPassword?: string) => {
    const epoch = generation.current;
    const operation = writes.current.then(async () => {
      if (generation.current !== epoch) throw new Error('The app is locked');
      if (snapshotRef.current && passwordRef.current !== (expectedPassword ?? password)) throw new Error('Password changed; retry the operation');
      const next = makeNext(snapshotRef.current);
      const env = await sealEnvelope(JSON.stringify(next), password, next.savedAt);
      if (generation.current !== epoch) throw new Error('The app is locked');
      await writeVault(env);
      if (generation.current !== epoch) throw new Error('The app is locked');
      if (expectedPassword !== undefined) passwordRef.current = password;
      snapshotRef.current = next;
      setSnapshot(next);
    });
    writes.current = operation.catch(() => {});
    await operation;
  }, []);

  const requirePassword = (): string => {
    if (!passwordRef.current || !snapshot) throw new Error('The app is locked');
    return passwordRef.current;
  };

  const current = (): Snapshot => {
    if (!snapshot) throw new Error('The app is locked');
    return snapshot;
  };

  const setup = useCallback(async (password: string) => {
    const snap = emptySnapshot(nowIso());
    await persist(() => snap, password);
    passwordRef.current = password;
    setDrafts({ settings: SAMPLE_SETTINGS, financials: SAMPLE_FINANCIALS });
    setStatus('unlocked');
  }, [persist]);

  const unlock = useCallback(async (password: string) => {
    const epoch = generation.current;
    await writes.current;
    const env = await readVault();
    if (env === null) throw new Error('No data stored yet');
    const json = await openEnvelope(env, password);
    let snap: Snapshot;
    try {
      snap = parseSnapshot(json);
    } catch (e) {
      throw new CryptoError('corrupt', e instanceof SnapshotError ? e.message : 'Data is damaged');
    }
    if (epoch !== generation.current) throw new Error('The app is locked');
    const issues = validSnapshotToml(snap);
    if (issues.length) throw new CryptoError('corrupt', issues[0].message);
    passwordRef.current = password;
    snapshotRef.current = snap;
    setSnapshot(snap);
    setDrafts(snap.settingsToml === '' && snap.financialsToml === '' ? { settings: SAMPLE_SETTINGS, financials: SAMPLE_FINANCIALS } : { settings: null, financials: null });
    setStatus('unlocked');
    setError(null);
  }, []);

  const saveSettings = useCallback(async (text: string): Promise<SaveResult> => {
    const parsed = parseSettings(text);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    await persist((s) => ({ ...s!, savedAt: nowIso(), settingsToml: text }), requirePassword());
    return { ok: true };
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveFinancials = useCallback(async (text: string): Promise<SaveResult> => {
    const parsed = parseFinancials(text);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    await persist((s) => ({ ...s!, savedAt: nowIso(), financialsToml: text }), requirePassword());
    return { ok: true };
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const settingsParsed = useMemo(() => parseSettings(snapshot?.settingsToml ?? ''), [snapshot]);
  const financialsParsed = useMemo(() => parseFinancials(snapshot?.financialsToml ?? ''), [snapshot]);
  const settings: Settings = settingsParsed.ok ? settingsParsed.value : DEFAULT_SETTINGS;
  const financials: Financials = financialsParsed.ok ? financialsParsed.value : EMPTY_FINANCIALS;
  const isSample = snapshot !== null && snapshot.settingsToml === '' && snapshot.financialsToml === '';

  const previewImport = useCallback(async (text: string, filename: string, format?: ImportFormat): Promise<ImportResult> => {
    const prep: ImportPrepared = prepareImport(text, filename, format ? [format] : settings.formats);
    if (!prep.ok) return { ok: false, error: prep.error, rowErrors: prep.rowErrors };
    const s = current();
    const existing = new Set(s.transactions.map((t) => t.hash));
    const classified = await classifyRows(prep.rows, prep.format.name, existing);
    return {
      ok: true,
      preview: { filename, format: prep.format, rows: prep.rows, fresh: classified.fresh, duplicates: classified.duplicates },
    };
  }, [snapshot, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitImport = useCallback(async (preview: ImportPreview): Promise<number> => {
    if (preview.fresh.length === 0) return 0;
    let count = 0;
    await persist((s) => {
      const known = new Set(s!.transactions.map((t) => t.hash));
      const fresh = preview.fresh.filter((t) => !known.has(t.hash));
      count = fresh.length;
      return { ...s!, savedAt: nowIso(), transactions: [...s!.transactions, ...fresh] };
    }, requirePassword());
    return count;
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteMonth = useCallback(async (ym: string): Promise<number> => {
    let removed = 0;
    await persist((s) => {
      const remaining = s!.transactions.filter((t) => monthOf(t.date) !== ym);
      removed = s!.transactions.length - remaining.length;
      return { ...s!, savedAt: nowIso(), transactions: remaining };
    }, requirePassword());
    return removed;
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetAll = useCallback(async () => {
    generation.current++;
    passwordRef.current = null;
    snapshotRef.current = null;
    setSnapshot(null);
    setDrafts({ settings: null, financials: null });
    setStatus('locked');
    await writes.current;
    await deleteVault();
    setStatus('setup');
  }, []);

  const changePassword = useCallback(async (currentPw: string, next: string) => {
    if (currentPw !== passwordRef.current) throw new Error('Current password is incorrect');
    await persist((s) => ({ ...s!, savedAt: nowIso() }), next, currentPw);
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportBackup = useCallback(async () => {
    const createdAt = nowIso();
    const text = await sealEnvelope(JSON.stringify(current()), requirePassword(), createdAt);
    const stamp = createdAt.replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
    return { text, filename: `moonli-${stamp}.budget` };
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const readBackup = useCallback(async (text: string, password: string): Promise<Snapshot> => {
    const json = await openEnvelope(text, password);
    const snap = parseSnapshot(json);
    const issues = validSnapshotToml(snap);
    if (issues.length) throw new SnapshotError(`Backup contains invalid TOML: ${issues[0].message}`);
    return snap;
  }, []);

  const importBackup = useCallback(async (text: string, password: string) => {
    const snap = await readBackup(text, password);
    await persist(() => ({ ...snap, savedAt: nowIso() }), password);
    passwordRef.current = password;
    setDrafts({ settings: null, financials: null });
    setStatus('unlocked');
    setError(null);
  }, [persist, readBackup]);

  const restoreBackup = useCallback(async (snap: Snapshot) => {
    const issues = validSnapshotToml(snap);
    if (issues.length) throw new Error(issues[0].message);
    await persist(() => ({ ...snap, savedAt: nowIso() }), requirePassword());
    setDrafts({ settings: null, financials: null });
  }, [snapshot, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  const valueGeneration = generation.current;
  const value: SessionValue = {
    status,
    snapshot,
    settings,
    financials,
    isSample,
    drafts,
    setDraft: (kind, text) => {
      if (snapshotRef.current && generation.current === valueGeneration) setDrafts((current) => ({ ...current, [kind]: text }));
    },
    error,
    setError,
    setup,
    importBackup,
    unlock,
    lock,
    saveSettings,
    saveFinancials,
    previewImport,
    commitImport,
    deleteMonth,
    resetAll,
    changePassword,
    exportBackup,
    readBackup,
    restoreBackup,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
