// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseFinancials } from '../src/domain/config';
import { planForMonth } from '../src/domain/plan';
import { CashFlow } from '../src/ui/CashFlow';

function render(text: string, month = '2026-01') {
  const parsed = parseFinancials(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const html = renderToStaticMarkup(createElement(CashFlow, { plan: planForMonth(parsed.value, month), currency: '$', month }));
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('cashflow Sankey', () => {
  it('groups signed monthly plan amounts by category and balances surplus', () => {
    const doc = render(`
[[recurring_transactions]]
amount = 1000
category = "Work"
[[recurring_transactions]]
amount = 200
category = "Work"
[[recurring_transactions]]
amount = -120
recurrence_months = 3
category = "Home"
[[recurring_transactions]]
amount = -60
category = "Home"
[[recurring_transactions]]
amount = -50
`);
    const summary = doc.querySelector('.sankey-summary')!.textContent!;
    expect(summary).toContain('Work: 1200.00 $');
    expect(summary).toContain('Home: -100.00 $');
    expect(summary).toContain('General: -50.00 $');
    expect(summary).toContain('Surplus (budget): 1050.00 $');
    expect(doc.querySelectorAll('.sankey-ribbon')).toHaveLength(4);
    expect(doc.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows unfunded deficit, including when there is no income', () => {
    const doc = render('[[recurring_transactions]]\namount = -25\ncategory = "Food"');
    expect(doc.querySelector('.sankey-summary')?.textContent).toContain('Deficit (unfunded): -25.00 $');
    expect(doc.querySelector('.sankey-summary')?.textContent).toContain('Food: -25.00 $');
    expect(doc.querySelector('svg')?.textContent).toContain('Total outflow');
    expect(doc.querySelector('svg')?.outerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('renders an empty state for zero and inactive entries', () => {
    const doc = render('[[recurring_transactions]]\namount = 0\n[[recurring_transactions]]\namount = 10\nstart_date = 2026-02-01');
    expect(doc.body.textContent).toContain('No planned cash flow for this month.');
    expect(doc.querySelector('svg')).toBeNull();
  });

  it('handles income only and balanced plans without artificial nodes', () => {
    const income = render('[[recurring_transactions]]\namount = 10');
    expect(income.querySelector('.sankey-summary')?.textContent).toContain('Surplus (budget): 10.00 $');
    const balanced = render('[[recurring_transactions]]\namount = 10\n[[recurring_transactions]]\namount = -10');
    expect(balanced.querySelector('.sankey-summary')?.textContent).not.toMatch(/Surplus|Deficit/);
  });
});
