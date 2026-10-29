import type { ReactNode } from 'react';
import type { Financials, Settings } from '../domain/config';
import type { Snapshot } from '../domain/snapshot';
import { centsToDecimal, type Cents } from '../domain/money';
import { currentMonth, monthLabel, monthRange, type YearMonth } from '../domain/dates';

export function Money({ cents, currency, className }: { cents: Cents; currency: string; className?: string }) {
  const cls = [className, cents < 0 ? 'neg' : cents > 0 ? 'pos' : ''].filter(Boolean).join(' ');
  return <span className={cls}>{`${centsToDecimal(cents)} ${currency}`}</span>;
}

export function Card({ title, children, wide }: { title?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'card wide' : 'card'}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

/** Months covered by the data, from the earliest known month to the latest, always including the current month. */
export function dataMonths(snapshot: Snapshot, financials: Financials, now: Date): YearMonth[] {
  const cur = currentMonth(now);
  const dates: string[] = [];
  for (const t of snapshot.transactions) dates.push(t.date);
  for (const e of financials.recurring) {
    if (e.start) dates.push(e.start);
    if (e.end) dates.push(e.end);
    for (const h of e.history) dates.push(h.from);
  }
  for (const c of financials.cash) dates.push(c.date);
  let first = cur;
  let last = cur;
  for (const d of dates) {
    const ym = d.slice(0, 7);
    if (ym < first) first = ym;
    if (ym > last) last = ym;
  }
  return monthRange(first, last);
}

export function MonthSelect({ months, value, onChange, label }: { months: YearMonth[]; value: YearMonth; onChange: (ym: YearMonth) => void; label: string }) {
  return (
    <label className="month-select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {months.map((m) => (
          <option key={m} value={m}>{monthLabel(m)}</option>
        ))}
      </select>
    </label>
  );
}

export function currencyOf(settings: Settings): string {
  return settings.currencySymbol || 'EUR';
}
