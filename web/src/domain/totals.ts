import type { Financials, Settings } from './config';
import { monthLast, todayIso, type IsoDate, type YearMonth } from './dates';
import { sumCents, type Cents } from './money';
import type { Tx } from './snapshot';

export interface AccountTotal {
  name: string;
  snapshotDate: IsoDate;
  cents: Cents;
}

export interface TotalMoney {
  asOf: IsoDate;
  accounts: AccountTotal[];
  cashCents: Cents | null;
  totalCents: Cents;
}

/**
 * Date at which "Total money" is measured for a month (core.py total money rules):
 * the configured total_money_as_of_day, clipped to the month, and never in the
 * future for the current month. Without a configured day: today for the current
 * month, the last day of past months.
 */
export function asOfForMonth(ym: YearMonth, settings: Settings, now: Date): IsoDate {
  const today = todayIso(now);
  const todayYm = today.slice(0, 7);
  const last = monthLast(ym);
  if (ym === todayYm) {
    if (settings.totalMoneyAsOfDay > 0) {
      const day = Math.min(settings.totalMoneyAsOfDay, Number(last.slice(8)));
      const configured = `${ym}-${String(day).padStart(2, '0')}`;
      return configured < today ? configured : today;
    }
    return today;
  }
  if (settings.totalMoneyAsOfDay > 0) {
    const day = Math.min(settings.totalMoneyAsOfDay, Number(last.slice(8)));
    return `${ym}-${String(day).padStart(2, '0')}`;
  }
  return last;
}

/**
 * The snapshot is the closing balance of its date. Reconstruct earlier balances
 * by subtracting transactions through the snapshot date, or later ones by adding
 * transactions after it. Cash = latest entry on or before `asOf`.
 */
export function totalMoney(settings: Settings, financials: Financials, txs: Tx[], asOf: IsoDate): TotalMoney {
  const accounts: AccountTotal[] = [];
  for (const f of settings.formats) {
    if (f.balanceSnapshot === undefined || f.balanceSnapshotDate === undefined) continue;
    const snapDate = f.balanceSnapshotDate;
    const backwards = asOf < snapDate;
    const deltas = txs
      .filter((t) => t.account === f.name && (backwards
        ? t.date > asOf && t.date <= snapDate
        : t.date > snapDate && t.date <= asOf))
      .map((t) => t.cents);
    accounts.push({ name: f.name, snapshotDate: snapDate, cents: f.balanceSnapshot + (backwards ? -sumCents(deltas) : sumCents(deltas)) });
  }
  let cashCents: Cents | null = null;
  for (const c of financials.cash) {
    if (c.date <= asOf) cashCents = c.cents;
  }
  const totalCents = sumCents([...accounts.map((a) => a.cents), cashCents ?? 0]);
  return { asOf, accounts, cashCents, totalCents };
}
