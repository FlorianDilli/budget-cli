import type { ImportFormat } from './config';
import { parseDecimalToCents, type Cents } from './money';
import { formatIso, daysInMonth, type IsoDate } from './dates';

export const MAX_CSV_BYTES = 10_000_000;

/** RFC 4180-style parser with a configurable single-character delimiter. */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else field += c;
      continue;
    }
    if (closedQuote && c !== delimiter && c !== '\n' && c !== '\r') throw new Error('Unexpected character after closing quote');
    if (c === '"') {
      if (field !== '') throw new Error('Unexpected quote in unquoted field');
      inQuotes = true;
    }
    else if (c === delimiter) {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
    } else field += c;
  }
  if (inQuotes) throw new Error('Unclosed quoted field');
  if (field !== '' || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface ParsedCsv {
  headers: string[];
  records: Record<string, string>[];
}

export function readCsv(text: string, delimiter: string): ParsedCsv {
  const rows = parseCsvRows(text, delimiter);
  if (rows.length === 0) return { headers: [], records: [] };
  const [headers, ...body] = rows;
  const records = body.map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = r[i] ?? '';
    });
    return rec;
  });
  return { headers, records };
}

/** Format detection: first format whose columns exist in the headers (Python detect_format). */
export function detectFormat(headers: string[], formats: ImportFormat[]): ImportFormat | null {
  for (const f of formats) {
    if (!headers.includes(f.dateColumn) || !headers.includes(f.amountColumn)) continue;
    if ((f.descriptionColumn && headers.includes(f.descriptionColumn)) || (f.referenceColumn && headers.includes(f.referenceColumn))) {
      return f;
    }
  }
  return null;
}

const DEFAULT_DATE_FORMATS = ['%Y-%m-%d', '%m/%d/%Y', '%d-%m-%Y', '%Y/%m/%d', '%d/%m/%Y', '%b %d, %Y', '%d.%m.%Y'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses a date with a strptime-style format. Supports %Y %y %m %d %b and %%.
 * Returns null if the text does not match or is not a valid calendar date.
 */
export function parseDateWithFormat(raw: string, format: string): IsoDate | null {
  const parts: { kind: 'lit' | 'code'; value: string }[] = [];
  for (let i = 0; i < format.length; i++) {
    if (format[i] === '%' && i + 1 < format.length) {
      const code = format[i + 1];
      if (!'YymdbB%'.includes(code)) return null;
      parts.push({ kind: 'code', value: code });
      i++;
    } else parts.push({ kind: 'lit', value: format[i] });
  }
  let pattern = '^';
  for (const p of parts) {
    if (p.kind === 'lit') pattern += p.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (p.value === 'Y') pattern += '(\\d{4})';
    else if (p.value === 'y') pattern += '(\\d{2})';
    else if (p.value === 'm' || p.value === 'd') pattern += '(\\d{1,2})';
    else if (p.value === 'b' || p.value === 'B') pattern += '([A-Za-z]{3,9})';
    else pattern += '%';
  }
  pattern += '$';
  const m = new RegExp(pattern).exec(raw.trim());
  if (!m) return null;
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let g = 1;
  for (const p of parts) {
    if (p.kind === 'lit' || p.value === '%') continue; // literals and %% capture nothing
    const v = m[g++];
    if (p.value === 'Y') year = Number(v);
    else if (p.value === 'y') year = Number(v) < 69 ? 2000 + Number(v) : 1900 + Number(v);
    else if (p.value === 'm') month = Number(v);
    else if (p.value === 'd') day = Number(v);
    else {
      const idx = MONTHS.indexOf(v.slice(0, 3).toLowerCase());
      if (idx < 0) return null;
      month = idx + 1;
    }
  }
  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return formatIso(year, month, day);
}

export function normalizeDate(raw: string, customFormat?: string): IsoDate | null {
  if (customFormat) {
    const d = parseDateWithFormat(raw, customFormat);
    if (d) return d;
  }
  for (const f of DEFAULT_DATE_FORMATS) {
    const d = parseDateWithFormat(raw, f);
    if (d) return d;
  }
  return null;
}

/** Amount in the format's locale to exact cents. Currency symbols and spaces are removed. */
export function normalizeAmount(raw: string, fmt: ImportFormat): Cents {
  let s = raw;
  for (const ch of ['$', '€', '£', ' ']) s = s.split(ch).join('');
  if (fmt.thousandsSeparator) s = s.split(fmt.thousandsSeparator).join('');
  if (fmt.decimalSeparator !== '.') s = s.split(fmt.decimalSeparator).join('.');
  return parseDecimalToCents(s);
}

export interface NormalizedRow {
  rowNumber: number;
  date: IsoDate;
  description: string;
  cents: Cents;
}

export type ImportPrepared =
  | { ok: true; format: ImportFormat; rows: NormalizedRow[] }
  | { ok: false; error: string; rowErrors?: string[] };

/**
 * Parses a CSV file for import. A file with any invalid row commits nothing
 * (Decision 10), so all rows are validated before a result is returned.
 */
export function prepareImport(text: string, filename: string, formats: ImportFormat[]): ImportPrepared {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    return { ok: false, error: `"${filename}" is larger than 10 MB` };
  }
  let chosen: ImportFormat | null = null;
  let parsed: ParsedCsv | null = null;
  for (const f of formats) {
    let candidate: ParsedCsv;
    try {
      candidate = readCsv(text, f.delimiter);
    } catch {
      continue;
    }
    if (detectFormat(candidate.headers, [f])) {
      chosen = f;
      parsed = candidate;
      break;
    }
  }
  if (!chosen || !parsed) {
    let headers: string[] = [];
    try { headers = readCsv(text, ',').headers; } catch { /* Invalid CSV. */ }
    return {
      ok: false,
      error: `No import format matches "${filename}".${headers.length ? ` Headers: ${headers.join(', ')}` : ''}`,
    };
  }
  const rows: NormalizedRow[] = [];
  const rowErrors: string[] = [];
  parsed.records.forEach((rec, i) => {
    const rowNumber = i + 2; // header is line 1
    const rawDate = (rec[chosen!.dateColumn] ?? '').trim();
    const rawAmount = (rec[chosen!.amountColumn] ?? '').trim();
    const desc = (chosen!.descriptionColumn ? rec[chosen!.descriptionColumn] ?? '' : '').trim();
    const ref = (chosen!.referenceColumn ? rec[chosen!.referenceColumn] ?? '' : '').trim();
    const description = desc || ref;
    if (!rawDate) return rowErrors.push(`Row ${rowNumber}: date is empty`);
    if (!rawAmount) return rowErrors.push(`Row ${rowNumber}: amount is empty`);
    if (!description) return rowErrors.push(`Row ${rowNumber}: no description or reference`);
    const date = normalizeDate(rawDate, chosen!.dateFormat);
    if (!date) return rowErrors.push(`Row ${rowNumber}: date "${rawDate}" is not in a recognized format`);
    try {
      rows.push({ rowNumber, date, description, cents: normalizeAmount(rawAmount, chosen!) });
    } catch {
      rowErrors.push(`Row ${rowNumber}: amount "${rawAmount}" is not a valid amount`);
    }
  });
  if (rowErrors.length) {
    return { ok: false, error: `${rowErrors.length} row(s) could not be imported; nothing was committed`, rowErrors };
  }
  return { ok: true, format: chosen, rows };
}
