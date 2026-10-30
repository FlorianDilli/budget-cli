import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { SectionTabs, useSectionParam, type SectionItem } from './SectionTabs';
import { useSession, type SaveResult } from '../state/session';
import { DEFAULT_SETTINGS, parseSettings, serializeSettings, type ImportFormat, type Settings } from '../domain/config';
import { SAMPLE_SETTINGS } from '../domain/sample';
import { centsToDecimal, numberToCents } from '../domain/money';
import { currentMonth, todayIso, type IsoDate, type YearMonth } from '../domain/dates';
import { envelopeCreatedAt } from '../crypto/envelope';
import type { Snapshot } from '../domain/snapshot';
import { Card, InfoButton, MonthSelect, PreviewNotice, dataMonths } from './common';

const TABS = ['general', 'data'] as const;
type Tab = (typeof TABS)[number];
const TAB_ITEMS = [
  { id: 'general', label: 'General' },
  { id: 'data', label: 'Data' },
] as const satisfies readonly SectionItem<Tab>[];

export function Settings() {
  const { isSample } = useSession();
  const [tab, setTab] = useSectionParam<Tab>('tab', TABS, 'general');
  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>Settings</h1>
        <SectionTabs items={TAB_ITEMS} value={tab} onChange={setTab} label="Settings sections" />
      </header>
      {tab === 'data' && <PreviewNotice isSample={isSample} />}
      {tab === 'general' && <SettingsForm />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ------------------------------------------------------------------ General

function readSettings(text: string): Settings {
  const parsed = parseSettings(text);
  return parsed.ok ? parsed.value : DEFAULT_SETTINGS;
}

/** Messages that block saving: the form's own rules plus whatever the stored-format parser rejects. */
function formIssues(form: Settings): string[] {
  const messages: string[] = [];
  if (!form.currencySymbol.trim()) messages.push('Currency symbol is required.');
  const parsed = parseSettings(serializeSettings(form));
  if (!parsed.ok) messages.push(...parsed.issues.map((issue) => issue.message));
  return messages;
}

const DELIMITERS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
];
const THOUSANDS = [
  { value: '', label: 'None' },
  { value: ',', label: 'Comma (,)' },
  { value: '.', label: 'Period (.)' },
  { value: ' ', label: 'Space' },
  { value: "'", label: "Apostrophe (')" },
];

function SettingsForm() {
  const session = useSession();
  const { snapshot, isSample, drafts, setDraft, saveSettings } = session;
  const savedText = snapshot?.settingsToml ?? '';
  const originalText = isSample ? SAMPLE_SETTINGS : savedText;
  const baseText = drafts.settings ?? originalText;
  const [form, setForm] = useState<Settings>(() => readSettings(baseText));
  const [notice, setNotice] = useState<string | null>(null);
  // The text this form last wrote to the session draft. Anything else means an outside change (discard, reload).
  const pushed = useRef(baseText);

  useEffect(() => {
    if (baseText !== pushed.current) {
      pushed.current = baseText;
      setForm(readSettings(baseText));
    }
  }, [baseText]);

  const stored = parseSettings(savedText);
  const issues = formIssues(form);
  const valid = issues.length === 0;
  const text = serializeSettings(form);
  const dirty = isSample || text !== serializeSettings(readSettings(savedText));

  const update = (next: Settings) => {
    setForm(next);
    setNotice(null);
    const nextText = serializeSettings(next);
    if (parseSettings(nextText).ok && next.currencySymbol.trim()) {
      pushed.current = nextText;
      setDraft('settings', nextText);
    }
  };

  const save = async () => {
    if (!valid) return;
    setNotice(null);
    const result: SaveResult = await saveSettings(text);
    setNotice(result.ok ? 'Saved and applied.' : 'Not saved. Fix the errors first.');
  };

  const discard = () => {
    pushed.current = originalText;
    setDraft('settings', originalText);
    setForm(readSettings(originalText));
    setNotice(null);
  };

  const patchFormat = (index: number, patch: Partial<ImportFormat>) =>
    update({ ...form, formats: form.formats.map((f, i) => (i === index ? { ...f, ...patch } : f)) });

  const addFormat = () =>
    update({
      ...form,
      formats: [...form.formats, { name: `Format ${form.formats.length + 1}`, dateColumn: '', amountColumn: '', descriptionColumn: '', delimiter: ',', decimalSeparator: '.', thousandsSeparator: '' }],
    });

  const removeFormat = (index: number) => update({ ...form, formats: form.formats.filter((_, i) => i !== index) });

  return (
    <div className="settings-form">
      {isSample && <p className="sample-notice">Preview settings are shown. Save to keep your changes.</p>}
      {!stored.ok && !isSample && <p className="warn">The saved settings could not be read ({stored.issues[0]?.message}). Showing defaults until you save.</p>}
      {issues.length > 0 && (
        <div className="error-banner" role="alert">
          <ul>{issues.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      )}

      <Card title="General">
        <div className="settings-grid">
          <label><span className="setting-label">Currency symbol<InfoButton label="Currency symbol" text="The symbol or code shown beside money amounts, such as €, EUR, or $." /></span>
            <input value={form.currencySymbol} maxLength={8} aria-invalid={!form.currencySymbol.trim()} onChange={(e) => update({ ...form, currencySymbol: e.target.value })} />
          </label>
          <label><span className="setting-label">Count totals up to day<InfoButton label="Count totals up to day" text="Choose the day of each month through which transactions are included in totals. Use 0 to include the whole month." /></span>
            <input type="number" min={0} max={31} step={1} value={form.totalMoneyAsOfDay} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 31) update({ ...form, totalMoneyAsOfDay: n }); }} />
            <span className="muted small">0 counts the whole month.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.roundAmounts} onChange={(e) => update({ ...form, roundAmounts: e.target.checked })} />
            <span className="setting-label">Round amounts to whole units<InfoButton label="Round amounts" text="When enabled, displayed totals are rounded to whole currency units instead of showing cents." /></span>
          </label>
        </div>
      </Card>

      <Card title="Import formats" info="Each format describes the columns and number/date conventions used by a bank CSV export. Add one format for each bank export layout you import.">
        <p className="muted small">Describe how bank CSV exports are read. Each format is matched when you import a file.</p>
        {form.formats.length === 0 && <p className="muted">No formats yet.</p>}
        {form.formats.map((format, index) => {
          const delimiters = DELIMITERS.some((d) => d.value === format.delimiter) ? DELIMITERS : [...DELIMITERS, { value: format.delimiter, label: `Custom (${format.delimiter})` }];
          return (
            <section className="format-card" key={index} aria-label={`Format ${index + 1}`}>
              <div className="settings-grid">
                <label><span className="setting-label">Name<InfoButton label="Format name" text="A short name to identify this bank export format when importing a CSV." /></span>
                  <input value={format.name} aria-invalid={!format.name.trim()} onChange={(e) => patchFormat(index, { name: e.target.value })} />
                </label>
                <label><span className="setting-label">Date column<InfoButton label="Date column" text="Enter the CSV header containing each transaction date." /></span>
                  <input value={format.dateColumn} aria-invalid={!format.dateColumn.trim()} onChange={(e) => patchFormat(index, { dateColumn: e.target.value })} />
                </label>
                <label><span className="setting-label">Amount column<InfoButton label="Amount column" text="Enter the CSV header containing the transaction amount. Use one amount column for income and expenses." /></span>
                  <input value={format.amountColumn} aria-invalid={!format.amountColumn.trim()} onChange={(e) => patchFormat(index, { amountColumn: e.target.value })} />
                </label>
                <label><span className="setting-label">Description column<InfoButton label="Description column" text="Optional CSV header containing the transaction description or payee." /></span>
                  <input value={format.descriptionColumn ?? ''} onChange={(e) => patchFormat(index, { descriptionColumn: e.target.value || undefined })} />
                </label>
                <label><span className="setting-label">Reference column<InfoButton label="Reference column" text="Optional CSV header containing a bank reference or transaction identifier." /></span>
                  <input value={format.referenceColumn ?? ''} onChange={(e) => patchFormat(index, { referenceColumn: e.target.value || undefined })} />
                </label>
                <label><span className="setting-label">Date format<InfoButton label="Date format" text="Optional date pattern for this bank export, for example %Y-%m-%d. Leave blank to use automatic parsing." /></span>
                  <input value={format.dateFormat ?? ''} placeholder="%Y-%m-%d" onChange={(e) => patchFormat(index, { dateFormat: e.target.value || undefined })} />
                </label>
                <label><span className="setting-label">Delimiter<InfoButton label="Delimiter" text="Select the character that separates fields in each CSV row. Choose Custom when the bank uses another delimiter." /></span>
                  <select value={format.delimiter} onChange={(e) => patchFormat(index, { delimiter: e.target.value })}>
                    {delimiters.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </label>
                <label><span className="setting-label">Decimal separator<InfoButton label="Decimal separator" text="Choose the character used between whole currency units and cents in the amount column." /></span>
                  <select value={format.decimalSeparator} onChange={(e) => patchFormat(index, { decimalSeparator: e.target.value })}>
                    <option value=".">Period (.)</option>
                    <option value=",">Comma (,)</option>
                  </select>
                </label>
                <label><span className="setting-label">Thousands separator<InfoButton label="Thousands separator" text="Choose the character used to group thousands in the amount column, or None if amounts are not grouped." /></span>
                  <select value={format.thousandsSeparator} onChange={(e) => patchFormat(index, { thousandsSeparator: e.target.value })}>
                    {THOUSANDS.filter((t) => t.value !== format.decimalSeparator).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
              </div>

              <div className="settings-grid">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={format.balanceSnapshot !== undefined}
                    onChange={(e) => patchFormat(index, e.target.checked
                      ? { balanceSnapshot: 0, balanceSnapshotDate: todayIso(new Date()) }
                      : { balanceSnapshot: undefined, balanceSnapshotDate: undefined })}
                  />
                  <span className="setting-label">Set an opening balance from this export<InfoButton label="Opening balance" text="Use this CSV's balance snapshot to establish the account balance at the selected date." /></span>
                </label>
                {format.balanceSnapshot !== undefined && format.balanceSnapshotDate && (
                  <>
                    <label><span className="setting-label">Balance<InfoButton label="Opening balance amount" text="Enter the account balance represented by the imported statement." /></span>
                      <input
                        type="number"
                        step="0.01"
                        value={centsToDecimal(format.balanceSnapshot)}
                        onChange={(e) => {
                          try {
                            if (e.target.value !== '') patchFormat(index, { balanceSnapshot: numberToCents(Number(e.target.value)) });
                          } catch {
                            /* keep the last valid amount while typing */
                          }
                        }}
                      />
                    </label>
                    <label><span className="setting-label">Balance date<InfoButton label="Opening balance date" text="Set the date the opening balance applies to." /></span>
                      <input type="date" value={format.balanceSnapshotDate} onChange={(e) => { if (e.target.value) patchFormat(index, { balanceSnapshotDate: e.target.value as IsoDate }); }} />
                    </label>
                  </>
                )}
              </div>

              <div className="format-actions">
                <button type="button" onClick={() => removeFormat(index)}>Remove format</button>
              </div>
            </section>
          );
        })}
        <div><button type="button" onClick={addFormat}>Add format</button></div>
      </Card>

      <footer className="settings-actions">
        <button type="button" className="primary" onClick={save} disabled={!dirty || !valid}>Save</button>
        <button type="button" onClick={discard} disabled={!dirty}>Discard changes</button>
        {notice && <span className="muted" role="status">{notice}</span>}
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ Data

function DataTab() {
  const session = useSession();
  const { snapshot, financials } = session;
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
      <Card title="Lock" info="Lock immediately to hide your budget. The app also locks automatically after 10 minutes without interaction.">
        <p className="muted">The app locks automatically after 10 minutes without interaction.</p>
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
    <Card title="Export backup" info="Downloads an encrypted .budget backup that can be restored in this browser or another browser. It uses your current password.">
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
    <Card title="Restore backup" info="Choose an encrypted .budget backup and enter its password to inspect it. Your local data is only replaced after you confirm the restore.">
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
    <Card title="Delete a month" info="Permanently removes imported transactions for the selected month. Recurring entries and settings are not changed.">
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
    <Card title="Change password" info="Enter your current password, then choose and confirm any non-empty new password. Your encrypted data is re-encrypted with it.">
      <form onSubmit={submit} className="stack">
        <input type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        <input type="password" placeholder="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
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
    <Card title="Reset everything" info="Permanently deletes all encrypted local data in this browser. Download a backup first if you want to keep your budget.">
      <p className="warn">Deletes all encrypted local data in this browser. Download a backup first.</p>
      <input value={word} onChange={(e) => setWord(e.target.value)} placeholder='Type "RESET" to confirm' aria-label="Reset confirmation" />
      <button className="danger" disabled={word !== 'RESET'} onClick={() => void resetAll()}>Reset all data</button>
    </Card>
  );
}
