import { describe, expect, it } from 'vitest';
import { parseFinancials } from '../src/domain/config';
import { analyzeMonth, categorize, topSpending } from '../src/domain/analysis';
import type { Tx } from '../src/domain/snapshot';

const FIN = `
[category_rules]
"Groceries" = ["supermarket", "lidl"]
"Dining" = ["super"]

[[recurring_transactions]]
description = "Netflix"
amount = -9.99
recurrence_months = 1

[[recurring_transactions]]
description = "Insurance"
amount = -240
recurrence_months = 12
payment_month = [1, 7]

[[recurring_transactions]]
description = "Salary"
amount = 2000
`;

function fin() {
  const r = parseFinancials(FIN);
  if (!r.ok) throw new Error('bad fixture');
  return r.value;
}

const tx = (hash: string, date: string, description: string, cents: number): Tx => ({ hash, date, description, cents, account: 'A' });

describe('categorize', () => {
  it('uses the first matching keyword, case-insensitively, else Uncategorized', () => {
    const rules = fin().categoryRules;
    expect(categorize('LIDL Store', rules)).toBe('Groceries');
    expect(categorize('Supermarket Super', rules)).toBe('Groceries'); // matches both rules; first rule wins
    expect(categorize('Super Shop', rules)).toBe('Dining');
    expect(categorize('Cinema', rules)).toBe('Uncategorized');
  });
});

describe('analyzeMonth', () => {
  it('verifies a matching monthly payment and reports a mismatch', () => {
    const txs = [
      tx('h1', '2025-03-03', 'NETFLIX.COM', -999),
      tx('h2', '2025-03-05', 'PAYPAL *NETFLIX', -1099),
    ];
    const a = analyzeMonth(fin(), txs, '2025-03');
    expect(a.txs[0].flags).toEqual(['VERIFIED']);
    // Smart fallback (core.py:600-610): Netflix already has a perfect match this month,
    // so the second payment is not force-matched and counts as spend.
    expect(a.txs[1].flags).toEqual([]);
    expect(a.txs[1].spendCents).toBe(-1099);

    const solo = analyzeMonth(fin(), [tx('h6', '2025-04-05', 'PAYPAL *NETFLIX', -1099)], '2025-04');
    expect(solo.txs[0].flags).toEqual(['AMOUNT_MISMATCH']);
    expect(solo.txs[0].spendCents).toBe(-100);
    expect(solo.alerts.some((m) => m.includes('Amount mismatch'))).toBe(true);
  });

  it('counts a yearly payment in its month as a deviation only, and treats wrong-month payments as spend', () => {
    const good = analyzeMonth(fin(), [tx('h1', '2025-07-02', 'INSURANCE CO', -24000)], '2025-07');
    expect(good.txs[0].flags).toEqual(['VERIFIED']);
    expect(good.spendCents).toBe(0);
    expect(good.budgetCents).toBe(197001);

    const wrong = analyzeMonth(fin(), [tx('h2', '2025-03-02', 'INSURANCE CO', -24000)], '2025-03');
    expect(wrong.txs[0].flags).toEqual(['WRONG_MONTH']);
    expect(wrong.spendCents).toBe(-24000);
    expect(wrong.alerts.some((m) => m.includes('wrong month'))).toBe(true);
  });

  it('alerts when an expected payment is missing and counts unmatched rows as spend', () => {
    const a = analyzeMonth(fin(), [tx('h3', '2025-01-10', 'Cinema', -1500)], '2025-01');
    expect(a.alerts).toContain('Expected recurring payment for "Insurance" not found');
    expect(a.spendCents).toBe(-1500);
    expect(a.txs[0].category).toBe('Uncategorized');
  });

  it('computes left = plan budget + spending (Decision 18)', () => {
    const a = analyzeMonth(fin(), [tx('h4', '2025-02-10', 'Lidl', -4000)], '2025-02');
    // Plan: Netflix -9.99, Salary +2000.00, Insurance -20.00 (yearly / 12 is only active in-plan without a price range issue).
    expect(a.budgetCents).toBe(-999 + 200000 + -2000);
    expect(a.leftCents).toBe(a.budgetCents + -4000);
  });

  it('never auto-matches entries without a description', () => {
    const r = parseFinancials('[[recurring_transactions]]\namount = -5\n');
    if (!r.ok) throw new Error('bad');
    const a = analyzeMonth(r.value, [tx('h5', '2025-01-02', 'anything', -500)], '2025-01');
    expect(a.txs[0].matchedEntry).toBeNull();
    expect(a.spendCents).toBe(-500);
    expect(a.budgetCents).toBe(-500); // still counted in the plan
  });

  it('uses transaction-date pricing while the plan uses month-end pricing', () => {
    const r = parseFinancials('[[recurring_transactions]]\ndescription="Service"\namount=-10\nstart_date="2025-01-01"\namount_history=[{from=2025-03-20, amount=-15}]');
    if (!r.ok) throw new Error('bad fixture');
    const result = analyzeMonth(r.value, [tx('h', '2025-03-10', 'Service', -1000)], '2025-03');
    expect(result.budgetCents).toBe(-1500);
    expect(result.txs[0].flags).toEqual(['VERIFIED']);
    expect(result.leftCents).toBe(-1500);
  });

  it('ranks raw categorized totals alongside individual uncategorized transactions', () => {
    const a = analyzeMonth(fin(), [
      tx('1', '2025-03-01', 'Lidl', -3000),
      tx('2', '2025-03-02', 'Supermarket', -2000),
      tx('3', '2025-03-03', 'Netflix', -999),
      tx('4', '2025-03-04', 'Refund', 6000),
    ], '2025-03');
    expect(topSpending(a.txs, 3)).toEqual([
      { name: 'Refund', cents: 6000, type: 'Transaction', recurring: false },
      { name: 'Groceries', cents: -5000, type: 'Category' },
      { name: 'Netflix', cents: -999, type: 'Transaction', recurring: true },
    ]);
  });
});
