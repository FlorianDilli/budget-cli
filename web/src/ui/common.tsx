import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Financials, Settings } from '../domain/config';
import type { Snapshot } from '../domain/snapshot';
import { centsToDecimal, type Cents } from '../domain/money';
import { currentMonth, monthLabel, monthRange, type YearMonth } from '../domain/dates';

export function Money({ cents, currency, className }: { cents: Cents; currency: string; className?: string }) {
  const cls = [className, cents < 0 ? 'neg' : cents > 0 ? 'pos' : ''].filter(Boolean).join(' ');
  return <span className={cls}>{`${centsToDecimal(cents)} ${currency}`}</span>;
}

export function Card({ title, children, wide, info }: { title?: string; children: ReactNode; wide?: boolean; info?: string }) {
  return (
    <section className={wide ? 'card wide' : 'card'}>
      {title && <header className="card-title"><h2>{title}</h2>{info && <InfoButton label={title} text={info} />}</header>}
      {children}
    </section>
  );
}

export function PreviewNotice({ isSample }: { isSample: boolean }) {
  return isSample ? <p className="sample-notice">Preview data is being shown. Save your budget or settings to keep your changes.</p> : null;
}

export function InfoButton({ label, text }: { label: string; text: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const popup = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (!open || !summary.current || !popup.current) return;
    const place = () => {
      const anchor = summary.current?.getBoundingClientRect();
      const panel = popup.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - panel.width / 2, window.innerWidth - panel.width - 12));
      let top = anchor.bottom + 6;
      if (top + panel.height > window.innerHeight - 12) top = Math.max(12, anchor.top - panel.height - 6);
      popup.current?.style.setProperty('--tip-left', `${left}px`);
      popup.current?.style.setProperty('--tip-top', `${top}px`);
    };
    const closeOnScroll = () => {
      if (details.current) details.current.open = false;
      setOpen(false);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open]);

  return (
    <details ref={details} className="info-tip" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary ref={summary} aria-label={`More about ${label}`} title={`More about ${label}`}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" /><path d="M8 7v4M8 4.8h.01" /></svg>
      </summary>
      <p ref={popup}>{text}</p>
    </details>
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
