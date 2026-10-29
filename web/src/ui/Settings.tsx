import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession, type SaveResult } from '../state/session';
import { TomlEditor, type TomlEditorHandle } from './TomlEditor';
import { parseSettings, parseFinancials, type ValidationIssue, type Parsed } from '../domain/config';
import { SAMPLE_FINANCIALS, SAMPLE_SETTINGS } from '../domain/sample';
import { planBudgetCents, planForMonth, type PlanLine } from '../domain/plan';
import { addMonths, currentMonth, monthLabel, monthLast, type YearMonth } from '../domain/dates';
import { centsToDecimal, type Cents } from '../domain/money';
import { envelopeCreatedAt } from '../crypto/envelope';
import type { Snapshot } from '../domain/snapshot';
import { Card, Money, MonthSelect, currencyOf, dataMonths } from './common';
import { MIN_PASSWORD_LENGTH } from '../state/session';

const TABS = ['editor', 'budget', 'data'] as const;
type Tab = (typeof TABS)[number];

export function Settings() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'editor';
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
        <nav className="subtabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'editor' ? 'Editor' : t === 'budget' ? 'Visual Budget' : 'Data'}
            </button>
          ))}
        </nav>
      </header>
      <div hidden={tab !== 'editor'}><EditorTab /></div>
      {tab === 'budget' && <BudgetTab />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ------------------------------------------------------------------ Editor

function EditorTab() {
  const { snapshot, isSample } = useSession();
  const [view, setView] = useState<'split' | 'settings' | 'financials'>('split');
  if (!snapshot) return null;
  return (
    <>
      {isSample && <p className="warn">Sample content is shown as a draft. It is not saved until you press Save.</p>}
      <div className="editor-view toolbar" role="group" aria-label="Editor layout">
        {(['split', 'settings', 'financials'] as const).map((mode) => <button type="button" key={mode} className={view === mode ? 'active' : ''} aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === 'split' ? 'Split view' : `${mode}.toml`}</button>)}
      </div>
      <div className={`editor-grid ${view !== 'split' ? 'single' : ''}`}>
        <div hidden={view === 'financials'}>
        <EditorPane
          kind="settings"
          fileName="settings.toml"
          savedText={snapshot.settingsToml}
          sample={SAMPLE_SETTINGS}
          isSample={isSample}
          parse={parseSettings}
        />
        </div>
        <div hidden={view === 'settings'}>
        <EditorPane
          kind="financials"
          fileName="financials.toml"
          savedText={snapshot.financialsToml}
          sample={SAMPLE_FINANCIALS}
          isSample={isSample}
          parse={parseFinancials}
        />
        </div>
      </div>
    </>
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
  kind: 'settings' | 'financials';
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
    const fn = kind === 'settings' ? session.saveSettings : session.saveFinancials;
    const res: SaveResult = await fn(draft);
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
    const text = isSample ? draft : savedText;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
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

      <div className="toolbar">
        {SYMBOLS.map((s) => (
          <button key={s} type="button" className="sym" onClick={() => ref.current?.insert(s === 'Tab' ? '\t' : s)}>{s}</button>
        ))}
      </div>
      <div className="toolbar">
        <button type="button" onClick={() => ref.current?.undo()}>Undo</button>
        <button type="button" onClick={() => ref.current?.redo()}>Redo</button>
        <button type="button" onClick={() => ref.current?.search()}>Search</button>
        <label className="check"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap</label>
        <button type="button" onClick={() => fileInput.current?.click()}>Open</button>
        <input ref={fileInput} type="file" accept=".toml,text/plain" hidden onChange={onPick} aria-label={`Open ${fileName}`} />
        <button type="button" onClick={download}>Download</button>
        <button type="button" onClick={() => navigator.clipboard?.writeText(draft)}>Copy</button>
        <button type="button" onClick={() => setDraft('')}>Clear</button>
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
        {notice && <span className="muted">{notice}</span>}
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ Visual Budget

function BudgetTab() {
  const { snapshot, settings, financials } = useSession();
  const now = useMemo(() => new Date(), []);
  const [ym, setYm] = useState<YearMonth>(() => currentMonth(now));
  const [sort, setSort] = useState<'amount' | 'category' | 'name'>('amount');
  const [currency, setCurrency] = useState('');
  if (!snapshot) return null;
  const cur = currency || currencyOf(settings);
  const plan = planForMonth(financials, ym);
  const previous = planForMonth(financials, addMonths(ym, -1));
  const income = plan.filter((p) => p.active && p.monthlyCents > 0);
  const expense = plan.filter((p) => p.active && p.monthlyCents < 0);
  const incomeSum: Cents = income.reduce((s, p) => s + p.monthlyCents, 0);
  const expenseSum: Cents = expense.reduce((s, p) => s + p.monthlyCents, 0);
  const net = planBudgetCents(plan);
  const cash = financials.cash.filter((c) => c.date <= monthLast(ym)).sort((a, b) => b.date.localeCompare(a.date))[0];
  const changes = plan.map((line, i) => ({ line, before: previous[i]?.monthlyCents ?? 0 })).filter(({ line, before }) => line.monthlyCents !== before);
  const sorted = (lines: PlanLine[]) => [...lines].sort((a, b) => sort === 'amount' ? Math.abs(b.monthlyCents) - Math.abs(a.monthlyCents) : sort === 'category' ? (a.entry.category || 'General').localeCompare(b.entry.category || 'General') : lineName(a).localeCompare(lineName(b)));

  return (
    <div className="budget">
      <div className="budget-toolbar">
        <div className="year-control"><button type="button" aria-label="Previous year" onClick={() => setYm(addMonths(ym, -12))}>←</button><strong>{ym.slice(0, 4)}</strong><button type="button" aria-label="Next year" onClick={() => setYm(addMonths(ym, 12))}>→</button></div>
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="amount">Amount</option><option value="category">Category</option><option value="name">Name</option></select></label>
        <label>Currency label <select value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="">Settings ({currencyOf(settings)})</option><option value="€">€ EUR</option><option value="$">$ USD</option><option value="£">£ GBP</option><option value="CHF">CHF</option></select></label>
      </div>
      <p className="budget-caption">Select a month to inspect <span>Plan only · currency labels do not convert amounts</span></p>
      <div className="month-strip" aria-label="Budget months">
        {Array.from({ length: 12 }, (_, i) => `${ym.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`).map((month) => <button type="button" key={month} className={month === ym ? 'active' : ''} aria-pressed={month === ym} onClick={() => setYm(month)}><span>{monthLabel(month).split(' ')[0]}</span><strong>{centsToDecimal(planBudgetCents(planForMonth(financials, month)))}</strong></button>)}
      </div>
      <div className="kpis">
        <Kpi label="Plan income / month" value={<Money cents={incomeSum} currency={cur} />} />
        <Kpi label="Plan expenses / month" value={<Money cents={expenseSum} currency={cur} />} />
        <Kpi label="Net budget" value={<Money cents={net} currency={cur} />} />
      </div>
      <CashFlow income={incomeSum} expense={expenseSum} currency={cur} />
      <Card title={`Changes since ${monthLabel(addMonths(ym, -1))}`}>
        {changes.length ? <div className="change-list">{changes.map(({ line, before }) => <div key={line.entry.index}><span>{lineName(line)}</span><span><span className="muted">{centsToDecimal(before)} → </span><Money cents={line.monthlyCents} currency={cur} /></span></div>)}</div> : <p className="muted">No changes to the monthly plan.</p>}
      </Card>
      <div className="cash-banner"><span>Cash snapshot {cash ? `· ${cash.date}` : ''}</span><strong>{cash ? <Money cents={cash.cents} currency={cur} /> : 'Not recorded'}</strong></div>
      <div className="grid-2">
        <PlanList title="Income" lines={sorted(income)} currency={cur} />
        <PlanList title="Expenses" lines={sorted(expense)} currency={cur} />
      </div>
      <p className="muted small">Entries count when active on any day of the month. Prices use the latest amount effective by month end; less frequent payments are averaged over their recurrence.</p>
    </div>
  );
}

function lineName(line: PlanLine) { return line.entry.intuitiveName || line.entry.description || line.entry.label; }

function PlanList({ title, lines, currency }: { title: string; lines: PlanLine[]; currency: string }) {
  return <Card title={title}>{lines.length === 0 ? <p className="muted">No planned {title.toLowerCase()} this month.</p> : <div className="plan-list">{lines.map((line) => <div className="plan-item" key={line.entry.index}><div><strong>{lineName(line)}</strong><span>{line.entry.category || 'General'} · {line.entry.recurrence === 1 ? 'Monthly' : line.isDue ? 'Due this month' : `Every ${line.entry.recurrence} months`}</span></div><strong><Money cents={line.monthlyCents} currency={currency} /><small> /mo</small></strong></div>)}</div>}</Card>;
}

function CashFlow({ income, expense, currency }: { income: Cents; expense: Cents; currency: string }) {
  const out = Math.abs(expense);
  const flow = Math.max(income, out);
  const incomeHeight = flow ? income / flow * 110 : 0;
  const expenseHeight = flow ? out / flow * 110 : 0;
  return <Card title="Monthly cash flow"><p className="muted small">Planned income flows to expenses and surplus. A deficit is shown when expenses exceed income.</p>{flow === 0 ? <p className="muted">No planned cash flow for this month.</p> : <div className="flow"><div><span>Income</span><strong><Money cents={income} currency={currency} /></strong></div><svg viewBox="0 0 400 140" role="img" aria-label={`Income ${centsToDecimal(income)}, expenses ${centsToDecimal(out)}, net ${centsToDecimal(income - out)} ${currency}`}><path className="flow-income" d={`M 0 15 L 0 ${15 + incomeHeight} C 130 ${15 + incomeHeight} 130 ${15 + incomeHeight} 200 ${15 + incomeHeight} L 200 15 Z`} /><path className="flow-expense" d={`M 200 15 L 200 ${15 + expenseHeight} C 270 ${15 + expenseHeight} 270 ${15 + expenseHeight} 400 ${15 + expenseHeight} L 400 15 Z`} /><rect x="195" y="15" width="10" height="110" rx="5" className="flow-node" /></svg><div><span>Expenses</span><strong><Money cents={expense} currency={currency} /></strong><span>{income >= out ? 'Surplus' : 'Deficit'} <Money cents={income - out} currency={currency} /></span></div></div>}</Card>;
}

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
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
