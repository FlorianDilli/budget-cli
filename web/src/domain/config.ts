import { parseToml, findTableLines } from './toml';
import { numberToCents, type Cents } from './money';
import { parseIsoDate, type IsoDate } from './dates';

export interface ValidationIssue {
  line: number;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

// ---------------------------------------------------------------- settings.toml

export interface ImportFormat {
  name: string;
  dateColumn: string;
  amountColumn: string;
  descriptionColumn?: string;
  referenceColumn?: string;
  delimiter: string;
  dateFormat?: string;
  decimalSeparator: string;
  thousandsSeparator: string;
  balanceSnapshot?: Cents;
  balanceSnapshotDate?: IsoDate;
}

export interface Settings {
  currencySymbol: string;
  roundAmounts: boolean;
  totalMoneyAsOfDay: number;
  formats: ImportFormat[];
}

export const DEFAULT_SETTINGS: Settings = {
  currencySymbol: 'EUR',
  roundAmounts: false,
  totalMoneyAsOfDay: 0,
  formats: [],
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function table(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

export function parseSettings(text: string): Parsed<Settings> {
  const parsed = parseToml(text);
  if (!parsed.ok) return { ok: false, issues: [{ line: parsed.line, message: parsed.message }] };
  const root = parsed.value;
  const issues: ValidationIssue[] = [];
  if (root.user !== undefined && !table(root.user)) issues.push({ line: lineOf(text, 'user'), message: '[user] must be a table' });
  const user = table(root.user) ? root.user : {};
  const settings: Settings = { ...DEFAULT_SETTINGS, formats: [] };

  if (user.currency_symbol !== undefined) {
    if (typeof user.currency_symbol !== 'string') issues.push({ line: lineOf(text, 'user'), message: '[user] currency_symbol must be a string' });
    else settings.currencySymbol = user.currency_symbol;
  }
  if (user.round_amounts !== undefined) {
    if (typeof user.round_amounts !== 'boolean') issues.push({ line: lineOf(text, 'user'), message: '[user] round_amounts must be a boolean' });
    else settings.roundAmounts = user.round_amounts;
  }
  if (user.total_money_as_of_day !== undefined) {
    const d = user.total_money_as_of_day;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 31) {
      issues.push({ line: lineOf(text, 'user'), message: '[user] total_money_as_of_day must be an integer 0-31' });
    } else settings.totalMoneyAsOfDay = d;
  }

  if (root.importer !== undefined && !table(root.importer)) issues.push({ line: lineOf(text, 'importer'), message: '[importer] must be a table' });
  const importer = table(root.importer) ? root.importer : {};
  if (importer.formats !== undefined && !Array.isArray(importer.formats)) issues.push({ line: lineOf(text, 'importer.formats'), message: 'importer.formats must be an array of tables' });
  const formats = Array.isArray(importer.formats) ? importer.formats : [];
  const lines = findTableLines(text, 'importer.formats');
  formats.forEach((raw, i) => {
    const line = lines[i] ?? 1;
    if (!table(raw)) {
      issues.push({ line, message: `Format #${i + 1}: must be a table` });
      return;
    }
    const label = `Format "${str(raw.name) ?? `#${i + 1}`}"`;
    const fail = (message: string) => issues.push({ line, message: `${label}: ${message}` });
    const name = str(raw.name);
    const dateColumn = str(raw.date_column);
    const amountColumn = str(raw.amount_column);
    const descriptionColumn = str(raw.description_column);
    const referenceColumn = str(raw.reference_column);
    if (!name) fail('name is required');
    if (!dateColumn) fail('date_column is required');
    if (!amountColumn) fail('amount_column is required');
    if (!descriptionColumn && !referenceColumn) fail('description_column or reference_column is required');
    const delimiter = raw.delimiter === undefined ? ',' : str(raw.delimiter);
    if (delimiter === undefined || delimiter.length !== 1) fail('delimiter must be a single character');
    const decimal = raw.decimal_separator === undefined ? '.' : str(raw.decimal_separator);
    if (decimal !== '.' && decimal !== ',') fail('decimal_separator must be "." or ","');
    const thousands = raw.thousands_separator === undefined ? '' : str(raw.thousands_separator);
    if (thousands === undefined) fail('thousands_separator must be a string');
    if (thousands && thousands === decimal) fail('thousands_separator must differ from decimal_separator');
    if (raw.date_format !== undefined && typeof raw.date_format !== 'string') fail('date_format must be a string');
    const hasBal = raw.balance_snapshot !== undefined;
    const hasBalDate = raw.balance_snapshot_date !== undefined;
    let balance: Cents | undefined;
    let balanceDate: IsoDate | undefined;
    if (hasBal !== hasBalDate) fail('balance_snapshot and balance_snapshot_date must be given together');
    if (hasBal && hasBalDate) {
      try {
        if (typeof raw.balance_snapshot !== 'number') throw new Error('not a number');
        balance = numberToCents(raw.balance_snapshot);
      } catch {
        fail('balance_snapshot must be a number with at most two decimals');
      }
      const d = parseIsoDate(raw.balance_snapshot_date);
      if (!d) fail('balance_snapshot_date must be YYYY-MM-DD');
      else balanceDate = d;
    }
    settings.formats.push({
      name: name ?? `Format ${i + 1}`,
      dateColumn: dateColumn ?? '',
      amountColumn: amountColumn ?? '',
      descriptionColumn,
      referenceColumn,
      delimiter: delimiter ?? ',',
      dateFormat: str(raw.date_format),
      decimalSeparator: decimal ?? '.',
      thousandsSeparator: thousands ?? '',
      balanceSnapshot: balance,
      balanceSnapshotDate: balanceDate,
    });
  });

  return issues.length ? { ok: false, issues } : { ok: true, value: settings };
}

// ---------------------------------------------------------------- financials.toml

export interface RecurringEntry {
  index: number;
  line: number;
  label: string;
  description: string;
  baseCents: Cents | null;
  history: { from: IsoDate; cents: Cents }[];
  recurrence: number;
  paymentMonths: number[];
  start?: IsoDate;
  end?: IsoDate;
  intuitiveName?: string;
  category?: string;
}

export interface CategoryRule {
  category: string;
  keywords: string[];
}

export interface CashEntry {
  date: IsoDate;
  cents: Cents;
}

export interface Financials {
  categoryRules: CategoryRule[];
  recurring: RecurringEntry[];
  cash: CashEntry[];
}

export const EMPTY_FINANCIALS: Financials = { categoryRules: [], recurring: [], cash: [] };

export function parseFinancials(text: string): Parsed<Financials> {
  const parsed = parseToml(text);
  if (!parsed.ok) return { ok: false, issues: [{ line: parsed.line, message: parsed.message }] };
  const root = parsed.value;
  const issues: ValidationIssue[] = [];
  const out: Financials = { categoryRules: [], recurring: [], cash: [] };

  if (root.category_rules !== undefined && !table(root.category_rules)) issues.push({ line: lineOf(text, 'category_rules'), message: 'category_rules must be a table' });
  const rules = table(root.category_rules) ? root.category_rules : {};
  const rulesLine = lineOf(text, 'category_rules');
  for (const [category, keywords] of Object.entries(rules)) {
    if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === 'string')) {
      issues.push({ line: rulesLine, message: `Category "${category}": keywords must be a list of strings` });
      continue;
    }
    out.categoryRules.push({ category, keywords: keywords as string[] });
  }

  if (root.recurring_transactions !== undefined && !Array.isArray(root.recurring_transactions)) issues.push({ line: lineOf(text, 'recurring_transactions'), message: 'recurring_transactions must be an array of tables' });
  const recurring = Array.isArray(root.recurring_transactions) ? root.recurring_transactions : [];
  const headerLines = findTableLines(text, 'recurring_transactions');
  recurring.forEach((raw, i) => {
    const line = headerLines[i] ?? 1;
    if (!table(raw)) {
      issues.push({ line, message: `Recurring entry ${i + 1}: must be a table` });
      return;
    }
    const description = str(raw.description) ?? '';
    const label = `Recurring entry ${i + 1}${description ? ` "${description}"` : ''}`;
    const fail = (message: string) => issues.push({ line, message: `${label}: ${message}` });

    if (raw.description !== undefined && typeof raw.description !== 'string') fail('description must be a string');
    if (raw.intuitive_name !== undefined && typeof raw.intuitive_name !== 'string') fail('intuitive_name must be a string');
    if (raw.category !== undefined && typeof raw.category !== 'string') fail('category must be a string');

    let baseCents: Cents | null = null;
    if (raw.amount !== undefined) {
      if (typeof raw.amount !== 'number') fail('amount must be a number');
      else {
        try {
          baseCents = numberToCents(raw.amount);
        } catch {
          fail('amount must have at most two decimals');
        }
      }
    }

    const history: { from: IsoDate; cents: Cents }[] = [];
    if (raw.amount_history !== undefined) {
      if (!Array.isArray(raw.amount_history)) fail('amount_history must be an array of { from, amount }');
      else {
        raw.amount_history.forEach((h, hi) => {
          if (!table(h)) return fail(`amount_history[${hi + 1}] must be a table`);
          const from = parseIsoDate(h.from);
          if (!from) return fail(`amount_history[${hi + 1}].from must be YYYY-MM-DD`);
          if (typeof h.amount !== 'number') return fail(`amount_history[${hi + 1}].amount must be a number`);
          try {
            history.push({ from, cents: numberToCents(h.amount) });
          } catch {
            fail(`amount_history[${hi + 1}].amount must have at most two decimals`);
          }
        });
        history.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
      }
    }

    if (baseCents === null && history.length === 0) fail('needs amount or amount_history');

    let recurrence = 1;
    if (raw.recurrence_months !== undefined) {
      if (typeof raw.recurrence_months !== 'number' || !Number.isInteger(raw.recurrence_months) || raw.recurrence_months < 1) {
        fail('recurrence_months must be an integer >= 1');
      } else recurrence = raw.recurrence_months;
    }

    let paymentMonths: number[] = [];
    const pm = raw.payment_month;
    const pmList = Array.isArray(pm) ? pm : pm === undefined ? [] : [pm];
    if (!pmList.every((m) => typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 12)) {
      fail('payment_month must be an integer 1-12 or a list of them');
    } else paymentMonths = pmList as number[];

    let start: IsoDate | undefined;
    let end: IsoDate | undefined;
    if (raw.start_date !== undefined) {
      const d = parseIsoDate(raw.start_date);
      if (!d) fail('start_date must be YYYY-MM-DD');
      else start = d;
    }
    if (raw.end_date !== undefined) {
      const d = parseIsoDate(raw.end_date);
      if (!d) fail('end_date must be YYYY-MM-DD');
      else end = d;
    }
    if (start && end && end < start) fail('end_date is before start_date');

    out.recurring.push({
      index: i,
      line,
      label,
      description,
      baseCents,
      history,
      recurrence,
      paymentMonths,
      start,
      end,
      intuitiveName: str(raw.intuitive_name),
      category: str(raw.category),
    });
  });

  if (root.cash !== undefined && !table(root.cash)) issues.push({ line: lineOf(text, 'cash'), message: 'cash must be a table' });
  const cash = table(root.cash) ? root.cash : {};
  if (cash.entries !== undefined && !Array.isArray(cash.entries)) issues.push({ line: lineOf(text, 'cash'), message: 'cash.entries must be an array of tables' });
  const cashEntries = Array.isArray(cash.entries) ? cash.entries : [];
  const cashLine = lineOf(text, 'cash');
  cashEntries.forEach((e, i) => {
    if (!table(e)) return issues.push({ line: cashLine, message: `Cash entry ${i + 1}: must be a table` });
    const date = parseIsoDate(e.date);
    if (!date) return issues.push({ line: cashLine, message: `Cash entry ${i + 1}: date must be YYYY-MM-DD` });
    if (typeof e.amount !== 'number') return issues.push({ line: cashLine, message: `Cash entry ${i + 1} (${date}): amount must be a number` });
    try {
      out.cash.push({ date, cents: numberToCents(e.amount) });
    } catch {
      issues.push({ line: cashLine, message: `Cash entry ${i + 1} (${date}): amount must have at most two decimals` });
    }
  });
  out.cash.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

/** Line of the first `[section]` header (1 if absent). */
function lineOf(text: string, section: string): number {
  const found = findTableLines(text, section);
  if (found.length) return found[0];
  const lines = text.split('\n');
  const re = new RegExp(`^\\s*${section.replace(/\./g, '\\.')}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  return idx >= 0 ? idx + 1 : 1;
}
