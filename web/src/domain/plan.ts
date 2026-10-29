import type { Financials, RecurringEntry } from './config';
import { divideCents, sumCents, type Cents } from './money';
import { monthFirst, monthLast, type IsoDate, type YearMonth } from './dates';

/**
 * Plan price on a date: the most recent amount_history entry whose `from` is on
 * or before the date; otherwise the base `amount`; otherwise null (not active).
 */
export function priceAt(entry: RecurringEntry, date: IsoDate): Cents | null {
  let price: Cents | null = null;
  for (const h of entry.history) {
    if (h.from <= date) price = h.cents;
  }
  if (price !== null) return price;
  return entry.baseCents;
}

/** Start used for activity: start_date, else the earliest history date, else unbounded. */
export function startOfEntry(entry: RecurringEntry): IsoDate | undefined {
  if (entry.start) return entry.start;
  if (entry.history.length) return entry.history[0].from;
  return undefined;
}

export interface PlanLine {
  entry: RecurringEntry;
  active: boolean;
  priceCents: Cents | null;
  monthlyCents: Cents;
  isDue: boolean;
}

/**
 * Decision 19 (month-level activity): an entry counts in month M if it is active
 * on any day of M. Plan price is taken at the last day of M.
 */
export function planLineForMonth(entry: RecurringEntry, ym: YearMonth): PlanLine {
  const first = monthFirst(ym);
  const last = monthLast(ym);
  const price = priceAt(entry, last);
  const start = startOfEntry(entry);
  const active =
    price !== null && !(start !== undefined && start > last) && !(entry.end !== undefined && entry.end < first);
  const month = Number(ym.slice(5, 7));
  return {
    entry,
    active,
    priceCents: active ? price : null,
    monthlyCents: active && price !== null ? divideCents(price, entry.recurrence) : 0,
    isDue: active && (entry.recurrence === 1 || entry.paymentMonths.includes(month)),
  };
}

export function planForMonth(financials: Financials, ym: YearMonth): PlanLine[] {
  return financials.recurring.map((e) => planLineForMonth(e, ym));
}

/** Signed monthly plan budget: income positive, expenses negative. */
export function planBudgetCents(lines: PlanLine[]): Cents {
  return sumCents(lines.filter((l) => l.active).map((l) => l.monthlyCents));
}
