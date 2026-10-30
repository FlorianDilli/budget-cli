import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { SectionTabs, useSectionParam, type SectionItem } from './SectionTabs';
import { useSession, type SaveResult } from '../state/session';
import { TomlEditor, type TomlEditorHandle } from './TomlEditor';
import { parseSettings, type ValidationIssue, type Parsed } from '../domain/config';
import { SAMPLE_SETTINGS } from '../domain/sample';
import { currentMonth, type YearMonth } from '../domain/dates';
import { envelopeCreatedAt } from '../crypto/envelope';
import type { Snapshot } from '../domain/snapshot';
import { Card, MonthSelect, currencyOf, dataMonths } from './common';
import { MIN_PASSWORD_LENGTH } from '../state/session';

const TABS = ['editor', 'data'] as const;
type Tab = (typeof TABS)[number];
const TAB_ITEMS = [
  { id: 'editor', label: 'Editor' },
  { id: 'data', label: 'Data' },
] as const satisfies readonly SectionItem<Tab>[];

export function Settings() {
  const [tab, setTab] = useSectionParam<Tab>('tab', TABS, 'editor');
  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>Settings</h1>
        <SectionTabs items={TAB_ITEMS} value={tab} onChange={setTab} label="Settings sections" />
      </header>
      <div hidden={tab !== 'editor'}><EditorTab /></div>
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ------------------------------------------------------------------ Editor

function EditorTab() {
  const { snapshot, isSample } = useSession();
  if (!snapshot) return null;
  return (
    <div className="editor-studio">
      {isSample && <p className="warn">Sample content is shown as a draft. It is not saved until you press Save.</p>}
      <div className="editor-grid single">
        <EditorPane
          kind="settings"
          fileName="settings.toml"
          savedText={snapshot.settingsToml}
          sample={SAMPLE_SETTINGS}
          isSample={isSample}
          parse={parseSettings}
        />
      </div>
    </div>
  );
}

const SYMBOLS = ['[', ']', '[[', ']]', '{', '}', '"', "'", '=', '#', ',', 'Tab'];

function EditorPane<T>({
  kind,
  fileName,
  savedText,
  sample,
  isSample,
  parse,
}: {
  kind: 'settings';
  fileName: string;
  savedText: string;
  sample: string;
  isSample: boolean;
  parse: (text: string) => Parsed<T>;
}) {
  const session = useSession();
  const draft = session.drafts[kind] ?? (isSample ? sample : savedText);
  const setDraft = (text: string) => session.setDraft(kind, text);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [wrap, setWrap] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<TomlEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const live = useMemo(() => parse(draft), [draft, parse]);
  const liveIssues: ValidationIssue[] = live.ok ? [] : live.issues;
  const shownIssues = issues.length ? issues : liveIssues;
  const dirty = draft !== (isSample ? '' : savedText);
  const saved = isSample ? false : savedText === draft;

  const save = async () => {
    setNotice(null);
    const res: SaveResult = await session.saveSettings(draft);
    if (!res.ok) {
      setIssues(res.issues);
      setNotice('Not saved. The last valid version stays active.');
    } else {
      setIssues([]);
      setNotice('Saved and applied.');
    }
  };

  const discard = () => {
    setDraft(isSample ? sample : savedText);
    setIssues([]);
    setNotice(null);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const readInto = async (file: File) => {
    const text = await file.text();
    setDraft(text);
    setIssues([]);
    setNotice(`Loaded ${file.name} into the editor (not saved)`);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void readInto(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void readInto(f);
  };

  const firstIssue = shownIssues[0];

  return (
    <section className="pane" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="pane-head">
        <h2>{fileName}</h2>
        <span className={`state ${dirty ? 'dirty' : saved ? 'clean' : ''}`}>
          {isSample ? 'Sample (unsaved)' : dirty ? 'Unsaved draft' : 'Saved'}
        </span>
      </header>

      <div className="toolbar editor-actions" role="group" aria-label={`${fileName} actions`}>
        <button type="button" onClick={() => ref.current?.undo()}>Undo</button>
        <button type="button" onClick={() => ref.current?.redo()}>Redo</button>
        <button type="button" onClick={() => ref.current?.search()}>Search</button>
        <label className="check"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap</label>
        <button type="button" onClick={() => fileInput.current?.click()}>Open</button>
        <input ref={fileInput} type="file" accept=".toml,text/plain" hidden onChange={onPick} aria-label={`Open ${fileName}`} />
        <button type="button" className="download-button" onClick={download} title="Download the displayed draft as a plaintext TOML file">Download</button>
      </div>
      <div className="toolbar editor-symbols" role="group" aria-label={`${fileName} quick actions`}>
        <button type="button" onClick={() => { setDraft(''); setIssues([]); }}>Clear</button>
        <button type="button" onClick={() => navigator.clipboard?.writeText(draft)}>Copy</button>
        {SYMBOLS.map((s) => (
          <button key={s} type="button" className="sym" aria-label={s === 'Tab' ? 'Insert tab' : `Insert ${s}`} onClick={() => ref.current?.insert(s === 'Tab' ? '\t' : s)}>{s}</button>
        ))}
      </div>

      {firstIssue && (
        <div className="error-banner" role="alert">
          <span>{firstIssue.line ? `Line ${firstIssue.line}: ` : ''}{firstIssue.message}</span>
          {firstIssue.line > 0 && <button type="button" onClick={() => ref.current?.jumpToLine(firstIssue.line)}>Jump to line</button>}
        </div>
      )}
      {shownIssues.length > 1 && (
        <ul className="errors">
          {shownIssues.slice(1, 10).map((i, idx) => <li key={idx}>{i.line ? `Line ${i.line}: ` : ''}{i.message}</li>)}
        </ul>
      )}

      <TomlEditor ref={ref} value={draft} onChange={(text) => { setDraft(text); setIssues([]); }} wrap={wrap} ariaLabel={`${fileName} editor`} />

      <footer className="pane-foot">
        <button type="button" className="primary" onClick={save} disabled={!dirty || !live.ok}>Save</button>
        <button type="button" onClick={discard} disabled={!dirty}>Discard changes</button>
        <span className="editor-stats">{draft.split('\n').length} {draft.split('\n').length === 1 ? 'line' : 'lines'} · {live.ok ? 'Valid' : 'Needs attention'}</span>
        {notice && <span className="muted" role="status">{notice}</span>}
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ Data

function DataTab() {
  const session = useSession();
  const { snapshot, settings, financials } = session;
  const now = useMemo(() => new Date(), []);
  const months = useMemo(() => (snapshot ? dataMonths(snapshot, financials, now) : []), [snapshot, financials, now]);
  if (!snapshot) return null;
  return (
    <div className="grid-2">
      <ExportCard />
      <RestoreCard localSavedAt={snapshot.savedAt} />
      <DeleteMonthCard months={months} />
      <PasswordCard />
      <ResetCard />
      <Card title="Lock">
        <p className="muted">The app locks automatically after 10 minutes without interaction. Currency: {currencyOf(settings)}.</p>
        <button onClick={session.lock}>Lock now</button>
      </Card>
    </div>
  );
}

function ExportCard() {
  const { exportBackup, setError } = useSession();
  const run = async () => {
    try {
      const { text, filename } = await exportBackup();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card title="Export backup">
      <p className="muted">Encrypted .budget file with the same contents as local data. Original CSVs are not included.</p>
      <button className="primary" onClick={run}>Download .budget</button>
    </Card>
  );
}

function RestoreCard({ localSavedAt }: { localSavedAt: string }) {
  const { readBackup, restoreBackup } = useSession();
  const [text, setText] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [backup, setBackup] = useState<Snapshot | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setText(await f.text());
    setBackup(null);
    setError(null);
    setDone(null);
  };

  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!text) return;
    setError(null);
    try {
      const snap = await readBackup(text, pw);
      setBackup(snap);
      setCreatedAt(envelopeCreatedAt(text));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPw('');
    }
  };

  const restore = async () => {
    if (!backup) return;
    if (!window.confirm('Replace all local data with this backup? This cannot be undone.')) return;
    try {
      await restoreBackup(backup);
      setDone('Backup restored.');
      setBackup(null);
      setText(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const olderWarning = backup !== null && !!backup.savedAt && !!localSavedAt && backup.savedAt < localSavedAt;

  return (
    <Card title="Restore backup">
      <p className="muted">Replaces local data after confirmation. The file is verified before any local data changes.</p>
      <input type="file" accept=".budget,application/json" onChange={onFile} aria-label="Choose .budget file" />
      {text && !backup && (
        <form onSubmit={open} className="stack">
          <label>Password used for this backup
            <input type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </label>
          <button type="submit">Open backup</button>
        </form>
      )}
      {backup && (
        <div className="stack">
          <p>Backup created: <strong>{createdAt ?? 'unknown'}</strong><br />Backup data saved: <strong>{backup.savedAt || 'unknown'}</strong><br />Local data saved: <strong>{localSavedAt || 'never'}</strong></p>
          {olderWarning && <p className="warn">This backup is older than the local data. Restoring will discard newer changes.</p>}
          <button className="danger" onClick={restore}>Replace local data with backup</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok">{done}</p>}
    </Card>
  );
}

function DeleteMonthCard({ months }: { months: YearMonth[] }) {
  const { deleteMonth } = useSession();
  const [ym, setYm] = useState<YearMonth>(months[months.length - 1] ?? currentMonth(new Date()));
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    if (!window.confirm(`Delete all imported transactions in ${ym}? Recurring entries are kept.`)) return;
    const n = await deleteMonth(ym);
    setMsg(`Deleted ${n} transaction(s) for ${ym}.`);
  };
  return (
    <Card title="Delete a month">
      <p className="muted">Removes imported transactions for one month. Settings and financials are unchanged.</p>
      <MonthSelect months={months} value={ym} onChange={setYm} label="Month" />
      <button className="danger" onClick={run}>Delete transactions</button>
      {msg && <p className="ok">{msg}</p>}
    </Card>
  );
}

function PasswordCard() {
  const { changePassword } = useSession();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: 'New passwords do not match' });
    try {
      await changePassword(cur, next);
      setMsg({ ok: true, text: 'Password changed.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
    setCur(''); setNext(''); setConfirm('');
  };
  return (
    <Card title="Change password">
      <form onSubmit={submit} className="stack">
        <input type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        <input type="password" placeholder={`New password (min ${MIN_PASSWORD_LENGTH})`} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <input type="password" placeholder="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <button type="submit">Change password</button>
      </form>
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </Card>
  );
}

function ResetCard() {
  const { resetAll } = useSession();
  const [word, setWord] = useState('');
  return (
    <Card title="Reset everything">
      <p className="warn">Deletes all encrypted local data in this browser. Download a backup first.</p>
      <input value={word} onChange={(e) => setWord(e.target.value)} placeholder='Type "RESET" to confirm' aria-label="Reset confirmation" />
      <button className="danger" disabled={word !== 'RESET'} onClick={() => void resetAll()}>Reset all data</button>
    </Card>
  );
}
