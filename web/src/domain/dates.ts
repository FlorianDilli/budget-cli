// Dates are kept as ISO strings "YYYY-MM-DD" (lexically comparable) and months
// as "YYYY-MM". Every function that depends on "today" takes an injected `now`.

export type IsoDate = string;
export type YearMonth = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** Accepts an ISO string or a TOML native date (Date at UTC midnight). */
export function parseIsoDate(value: unknown): IsoDate | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return formatIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'string' && isIsoDate(value.trim())) return value.trim();
  return null;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function formatIso(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function monthOf(date: IsoDate): YearMonth {
  return date.slice(0, 7);
}

export function monthFirst(ym: YearMonth): IsoDate {
  return `${ym}-01`;
}

export function monthLast(ym: YearMonth): IsoDate {
  const [y, m] = ym.split('-').map(Number);
  return formatIso(y, m, daysInMonth(y, m));
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** Inclusive list of months from a to b. Empty if a > b. */
export function monthRange(a: YearMonth, b: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let ym = a; ym <= b; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

export function todayIso(now: Date): IsoDate {
  return formatIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function currentMonth(now: Date): YearMonth {
  return monthOf(todayIso(now));
}

export function monthLabel(ym: YearMonth): string {
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[m - 1]} ${y}`;
}
