// Exact money: amounts are integer cents. No floating-point arithmetic is used
// for sums; the only rounding is the monthly division of a plan amount by
// recurrence_months (rounded half away from zero to the cent).

export type Cents = number;

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

/** Parses "-1234.5" or "12,00"-free decimal strings into integer cents. Throws on invalid input. */
export function parseDecimalToCents(input: string): Cents {
  const s = input.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error(`Invalid amount "${input}"`);
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount out of range "${input}"`);
  return sign === '-' ? -cents : cents;
}

/** Converts a TOML/JSON number to cents. Rejects values with more than two decimals. */
export function numberToCents(n: number): Cents {
  if (!Number.isFinite(n)) throw new Error('Amount must be a finite number');
  const s = String(n);
  if (/e/i.test(s)) throw new Error(`Amount "${s}" is not a plain decimal`);
  return parseDecimalToCents(s);
}

export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Divides cents by an integer divisor, rounding half away from zero. */
export function divideCents(cents: Cents, divisor: number): Cents {
  if (divisor === 1) return cents;
  return roundHalfAwayFromZero(cents / divisor);
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Fixed two-decimal representation, e.g. -1234 -> "-12.34". */
export function centsToDecimal(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export function formatMoney(cents: Cents, currency = 'EUR'): string {
  return `${centsToDecimal(cents)} ${currency}`;
}
