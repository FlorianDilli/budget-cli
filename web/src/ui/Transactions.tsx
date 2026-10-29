import { useMemo, useState, type ChangeEvent } from 'react';
import { useSession, type ImportPreview } from '../state/session';
import { analyzeMonth, type TxAnalysis } from '../domain/analysis';
import { currentMonth, type YearMonth } from '../domain/dates';
import { Card, Money, MonthSelect, currencyOf, dataMonths } from './common';
import { centsToDecimal } from '../domain/money';
import { readCsv } from '../domain/csv';
import type { ImportFormat } from '../domain/config';

const FLAG_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  AMOUNT_MISMATCH: 'amount mismatch',
  WRONG_MONTH: 'wrong month',
};

export function Transactions() {
  const { snapshot, settings, financials, previewImport, commitImport } = useSession();
  const now = useMemo(() => new Date(), []);
  const months = useMemo(() => (snapshot ? dataMonths(snapshot, financials, now) : []), [snapshot, financials, now]);
  const [ym, setYm] = useState<YearMonth>(() => currentMonth(now));
  const [selected, setSelected] = useState<string | null>(null);
  if (!snapshot) return null;
  const cur = currencyOf(settings);
  const a = analyzeMonth(financials, snapshot.transactions, ym);
  const selectedTx: TxAnalysis | undefined = a.txs.find((t) => t.tx.hash === selected);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Transactions</h1>
        <MonthSelect months={months} value={ym} onChange={(m) => { setYm(m); setSelected(null); }} label="Month" />
      </header>

      <ImportPanel
        formats={settings.formats}
        onPreview={previewImport}
        onCommit={commitImport}
      />

      <Card title={`Transactions in ${ym} (${a.txs.length})`} wide>
        {a.txs.length === 0 ? <p className="muted">No transactions this month.</p> : (
          <table className="tx-table">
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Flags</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {a.txs.map((t) => (
                <tr key={t.tx.hash} className={selected === t.tx.hash ? 'selected' : ''} onClick={() => setSelected(t.tx.hash)}>
                  <td>{t.tx.date}</td>
                  <td>{t.tx.description}</td>
                  <td>{t.category}</td>
                  <td>{t.flags.map((f) => <span key={f} className={`flag ${f.toLowerCase()}`}>{FLAG_LABEL[f]}</span>)}</td>
                  <td className="num"><Money cents={t.tx.cents} currency={cur} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selectedTx && (
        <Card title="Detail" wide>
          <dl className="detail">
            <dt>Date</dt><dd>{selectedTx.tx.date}</dd>
            <dt>Description</dt><dd>{selectedTx.tx.description}</dd>
            <dt>Account</dt><dd>{selectedTx.tx.account}</dd>
            <dt>Category</dt><dd>{selectedTx.category}</dd>
            <dt>Recurring match</dt><dd>{selectedTx.matchedEntry !== null ? financials.recurring[selectedTx.matchedEntry]?.label : 'none'}</dd>
            <dt>Effect on spending</dt><dd><Money cents={selectedTx.spendCents} currency={cur} /></dd>
            <dt>Duplicate key</dt><dd className="mono small">{selectedTx.tx.hash.slice(0, 16)}…</dd>
          </dl>
        </Card>
      )}
    </div>
  );
}

function ImportPanel({
  formats,
  onPreview,
  onCommit,
}: {
  formats: ImportFormat[];
  onPreview: (text: string, filename: string, format?: ImportFormat) => Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string; rowErrors?: string[] }>;
  onCommit: (p: ImportPreview) => Promise<number>;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{ text: string; filename: string } | null>(null);
  const [mapping, setMapping] = useState<ImportFormat | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);

  const chooseFormat = (format: ImportFormat, text: string) => {
    setMapping(format);
    try { setHeaders(readCsv(text, format.delimiter).headers); }
    catch { setHeaders([]); }
    setPreview(null);
  };

  const runPreview = async (text: string, filename: string, format?: ImportFormat) => {
    setError(null);
    setRowErrors([]);
    setPreview(null);
    setBusy(true);
    try {
      const res = await onPreview(text, filename, format);
      if (!res.ok) { setError(res.error); setRowErrors(res.rowErrors ?? []); }
      else { setPreview(res.preview); chooseFormat(res.preview.format, text); setPreview(res.preview); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setRowErrors([]);
    setDone(null);
    setPreview(null);
    setSource(null);
    setMapping(null);
    if (!formats.length) {
      setError('Define an importer format in Settings → settings.toml first.');
      return;
    }
    if (file.size > 10_000_000) return setError('File is larger than 10 MB');
    try {
      const text = await file.text();
      setSource({ text, filename: file.name });
      chooseFormat(formats[0], text);
      await runPreview(text, file.name);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const n = await onCommit(preview);
      setDone(`${preview.filename}: ${n} new, ${preview.duplicates} duplicate(s) skipped`);
      setPreview(null);
      setSource(null);
      setMapping(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Import CSV" wide>
      <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} aria-label="Choose CSV file" />
      {source && mapping && <fieldset className="mapping-controls" disabled={busy}>
        <p className="muted small">Column mapping for {source.filename}. Changes apply to this import only.</p>
        <label>Format <select value={mapping.name} onChange={(e) => { const format = formats.find((f) => f.name === e.target.value); if (format) chooseFormat(format, source.text); }}>{formats.map((f, i) => <option key={`${f.name}-${i}`} value={f.name}>{f.name}</option>)}</select></label>
        {(['dateColumn', 'amountColumn', 'descriptionColumn', 'referenceColumn'] as const).map((field) => <label key={field}>{field === 'dateColumn' ? 'Date' : field === 'amountColumn' ? 'Amount' : field === 'descriptionColumn' ? 'Description' : 'Reference'} <select value={mapping[field] ?? ''} onChange={(e) => { setMapping({ ...mapping, [field]: e.target.value || undefined }); setPreview(null); }}><option value="">Select column</option>{headers.map((h, i) => <option key={`${h}-${i}`} value={h}>{h}</option>)}</select></label>)}
        <button type="button" disabled={busy} onClick={() => void runPreview(source.text, source.filename, mapping)}>Preview mapping</button>
      </fieldset>}
      {error && <p className="error" role="alert">{error}</p>}
      {rowErrors.length > 0 && <ul className="errors">{rowErrors.slice(0, 20).map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {done && <p className="ok">{done}</p>}
      {preview && (
        <div className="preview">
          <p>Format <strong>{preview.format.name}</strong>: {preview.rows.length} rows, <strong>{preview.fresh.length}</strong> new, {preview.duplicates} duplicate(s) will be skipped.</p>
          <div className="import-preview-table"><table><thead><tr><th>Row</th><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead><tbody>{preview.rows.slice(0, 10).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.date}</td><td>{row.description}</td><td className="num">{centsToDecimal(row.cents)}</td></tr>)}</tbody></table>{preview.rows.length > 10 && <p className="muted small">Showing first 10 of {preview.rows.length} rows.</p>}</div>
          <button className="primary" onClick={confirm} disabled={busy || preview.fresh.length === 0}>
            {preview.fresh.length === 0 ? 'Nothing new to import' : `Import ${preview.fresh.length} transactions`}
          </button>
          <button onClick={() => setPreview(null)}>Cancel</button>
        </div>
      )}
    </Card>
  );
}
