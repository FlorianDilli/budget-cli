import { describe, expect, it } from 'vitest';
import { parseFinancials, type RecurringEntry } from '../src/domain/config';
import { planLineForMonth, priceAt } from '../src/domain/plan';

function entry(toml: string): RecurringEntry {
  const r = parseFinancials(toml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.recurring[0];
}

// Decision 19 fixtures: expected values are written from the decision, not from Python output.
describe('Decision 19 month-level activity', () => {
  it('counts an entry in the month where it starts, not the month before', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Gym"\namount=-30\nstart_date="2025-03-15"\n');
    expect(planLineForMonth(e, '2025-02').active).toBe(false);
    expect(planLineForMonth(e, '2025-03').active).toBe(true);
  });
  it('counts an entry in the month where it ends, and not after', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Gym"\namount=-30\nend_date="2025-05-10"\n');
    expect(planLineForMonth(e, '2025-05').active).toBe(true);
    expect(planLineForMonth(e, '2025-06').active).toBe(false);
  });
  it('uses the plan price at the last day of the month', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Netflix"\namount=-12.99\namount_history=[{from=2025-03-20, amount=-9.99}]\n');
    // Start is the first history date (Mar 20), so Feb is inactive even though a base amount exists.
    expect(planLineForMonth(e, '2025-02').active).toBe(false);
    expect(planLineForMonth(e, '2025-03').priceCents).toBe(-999);
    expect(planLineForMonth(e, '2025-04').priceCents).toBe(-999);
  });
  it('history-only entry is inactive before its first from date', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Old"\namount_history=[{from=2025-03-01, amount=-5}]\n');
    expect(priceAt(e, '2025-02-28')).toBeNull();
    expect(planLineForMonth(e, '2025-02').active).toBe(false);
    expect(planLineForMonth(e, '2025-03').active).toBe(true);
  });
  it('spreads a yearly amount over twelve months', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Insurance"\namount=-240\nrecurrence_months=12\npayment_month=3\n');
    const l = planLineForMonth(e, '2025-03');
    expect(l.monthlyCents).toBe(-2000);
    expect(l.isDue).toBe(true);
    expect(planLineForMonth(e, '2025-04').isDue).toBe(false);
  });
  it('defaults recurrence to 1 and does not count when no price exists', () => {
    const e = entry('[[recurring_transactions]]\ndescription="Plain"\namount=-10\n');
    expect(e.recurrence).toBe(1);
    expect(planLineForMonth(e, '2025-01').monthlyCents).toBe(-1000);
  });
});
