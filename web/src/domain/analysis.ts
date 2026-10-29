import type { CategoryRule, Financials, RecurringEntry } from './config';
import { planForMonth, planBudgetCents, priceAt, type PlanLine } from './plan';
import { monthFirst, monthLast, monthOf, type YearMonth } from './dates';
import { sumCents, type Cents } from './money';
import type { Tx } from './snapshot';

export type Flag = 'VERIFIED' | 'AMOUNT_MISMATCH' | 'WRONG_MONTH';

export interface TxAnalysis {
  tx: Tx;
  category: string;
  /** Some recurring entry's description occurs in this transaction's description. */
  recurring: boolean;
  matchedEntry: number | null;
  flags: Flag[];
  /** Contribution of this transaction to the month's spending (signed). */
  spendCents: Cents;
}

export interface MonthAnalysis {
  ym: YearMonth;
  plan: PlanLine[];
  budgetCents: Cents;
  spendCents: Cents;
  leftCents: Cents;
  txs: TxAnalysis[];
  alerts: string[];
  categories: { category: string; cents: Cents }[];
}

/** First matching keyword in category_rules (case-insensitive substring), else "Uncategorized". */
export function categorize(description: string, rules: CategoryRule[]): string {
  const d = description.toLowerCase();
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (kw.length && d.includes(kw.toLowerCase())) return rule.category;
    }
  }
  return 'Uncategorized';
}

/** CLI top spending: categorized transactions are grouped, others remain individual. */
export function topSpending(txs: TxAnalysis[], limit = 10): { name: string; cents: Cents; type: 'Transaction' | 'Category'; recurring?: boolean }[] {
  const categories = new Map<string, Cents>();
  const result: { name: string; cents: Cents; type: 'Transaction' | 'Category'; recurring?: boolean }[] = [];
  for (const item of txs) {
    if (item.category === 'Uncategorized') {
      result.push({ name: item.tx.description, cents: item.tx.cents, type: 'Transaction', recurring: item.recurring });
    } else {
      categories.set(item.category, (categories.get(item.category) ?? 0) + item.tx.cents);
    }
  }
  for (const [name, cents] of categories) result.push({ name, cents, type: 'Category' });
  return result.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, limit);
}

/**
 * Port of BudgetEngine._calculate_expenses_and_alerts (core.py:524-675).
 * Entries without a description are never matched automatically (Decision 13).
 * Missing-payment alerts are only raised for entries active in the month.
 */
export function analyzeMonth(financials: Financials, txs: Tx[], ym: YearMonth): MonthAnalysis {
  const plan = planForMonth(financials, ym);
  const budgetCents = planBudgetCents(plan);
  const activeByIndex = new Map(plan.map((l) => [l.entry.index, l.active]));
  const configs = financials.recurring.filter((e) => e.description.length > 0);
  const first = monthFirst(ym);
  const last = monthLast(ym);
  const month = Number(ym.slice(5, 7));
  const monthTxs = txs.filter((t) => t.date >= first && t.date <= last).sort(byDateThenDesc);

  const contains = (tx: Tx, e: RecurringEntry) => tx.description.toLowerCase().includes(e.description.toLowerCase());
  const activeConfigs = (tx: Tx) => configs.filter((e) => activeByIndex.get(e.index) && contains(tx, e));

  // Smart fallback: entries that have a perfect (amount-equal) match somewhere this month.
  const perfect = new Set<number>();
  for (const tx of monthTxs) {
    for (const e of activeConfigs(tx)) {
      if (priceAt(e, tx.date) === tx.cents) perfect.add(e.index);
    }
  }

  const alerts: string[] = [];
  const matched = new Set<number>();
  const rules = financials.categoryRules;
  let spendCents = 0;

  const analyses: TxAnalysis[] = monthTxs.map((tx) => {
    const isRecurring = configs.some((e) => contains(tx, e));
    const category = categorize(tx.description, rules);
    const out: TxAnalysis = { tx, category, recurring: isRecurring, matchedEntry: null, flags: [], spendCents: 0 };
    const potential = activeConfigs(tx);

    if (!isRecurring || potential.length === 0) {
      out.spendCents = tx.cents;
      return out;
    }

    const priceFor = (e: RecurringEntry) => priceAt(e, tx.date);
    let chosen: RecurringEntry | undefined =
      potential.find((e) => priceFor(e) === tx.cents && (e.paymentMonths.length === 0 || e.paymentMonths.includes(month))) ??
      potential.find((e) => priceFor(e) === tx.cents) ??
      potential.find((e) => !perfect.has(e.index));

    if (!chosen) {
      out.spendCents = tx.cents;
      return out;
    }

    out.matchedEntry = chosen.index;
    matched.add(chosen.index);
    const defined = priceFor(chosen);

    if (chosen.recurrence === 1) {
      if (defined === null) {
        out.spendCents = tx.cents;
        return out;
      }
      const diff = tx.cents - defined;
      out.spendCents = diff;
      if (diff !== 0) {
        out.flags.push('AMOUNT_MISMATCH');
        alerts.push(`Amount mismatch for "${tx.description}": expected ${fmt(defined)}, got ${fmt(tx.cents)}`);
      } else out.flags.push('VERIFIED');
      return out;
    }

    const paymentMonths = chosen.paymentMonths;
    if (paymentMonths.length === 0) {
      // No payment month defined: the budget already reserves the monthly share.
      out.spendCents = 0;
      return out;
    }
    if (paymentMonths.includes(month)) {
      if (defined === null) {
        out.spendCents = tx.cents;
        return out;
      }
      const diff = tx.cents - defined;
      out.spendCents = diff;
      if (diff !== 0) {
        out.flags.push('AMOUNT_MISMATCH');
        alerts.push(`Amount mismatch for "${tx.description}": expected ${fmt(defined)}, got ${fmt(tx.cents)}`);
      } else out.flags.push('VERIFIED');
    } else {
      out.spendCents = tx.cents;
      out.flags.push('WRONG_MONTH');
      alerts.push(`Recurring payment "${tx.description}" detected in wrong month (expected ${paymentMonths.join(', ')})`);
    }
    return out;
  });

  for (const a of analyses) spendCents += a.spendCents;

  for (const e of configs) {
    if (e.recurrence > 1 && e.paymentMonths.includes(month) && activeByIndex.get(e.index) && !matched.has(e.index)) {
      alerts.push(`Expected recurring payment for "${e.description}" not found`);
    }
  }

  const byCategory = new Map<string, Cents>();
  for (const a of analyses) {
    if (a.spendCents !== 0) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + a.spendCents);
  }
  const categories = [...byCategory.entries()]
    .map(([category, cents]) => ({ category, cents }))
    .sort((x, y) => x.cents - y.cents);

  return {
    ym,
    plan,
    budgetCents,
    spendCents,
    leftCents: sumCents([budgetCents, spendCents]),
    txs: analyses,
    alerts,
    categories,
  };
}

/** Transactions dated in a month, sorted by date (newest first). */
export function txsInMonth(txs: Tx[], ym: YearMonth): Tx[] {
  return txs.filter((t) => monthOf(t.date) === ym);
}

function byDateThenDesc(a: Tx, b: Tx): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.description < b.description ? -1 : a.description > b.description ? 1 : 0;
}

function fmt(cents: Cents | null): string {
  return cents === null ? 'n/a' : (cents / 100).toFixed(2);
}
