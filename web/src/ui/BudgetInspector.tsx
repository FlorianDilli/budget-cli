import { useId, useState } from 'react';
import { monthLast } from '../domain/dates';
import { planForMonth, type PlanLine } from '../domain/plan';
import { useSession } from '../state/session';
import type { Financials } from '../domain/config';
import './budget-inspector.css';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const colors = ['#ef4444', '#f97316', '#eab308', '#6366f1', '#a855f7', '#0ea5e9', '#ec4899'];
const darkColors = ['#f87171', '#fb923c', '#facc15', '#818cf8', '#c084fc', '#38bdf8', '#f472b6'];
const ymOf = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
const sum = (lines: PlanLine[]) => lines.reduce((total, line) => total + line.monthlyCents, 0);
const nameOf = (line: PlanLine) => line.entry.intuitiveName || line.entry.description || 'Untitled Transaction';
const categoryOf = (line: PlanLine) => line.entry.category || 'General';

export interface BudgetInspectorProps {
  financials: Financials;
  onSourceLineClick?: (line: number) => void;
}

export function BudgetInspector({ financials, onSourceLineClick }: BudgetInspectorProps) {
  const { settings } = useSession();
  const [today] = useState(() => new Date());
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [sort, setSort] = useState<'amount' | 'category'>('amount');
  const [currency, setCurrency] = useState(() => settings.currencySymbol || 'EUR');
  const years = new Set([today.getFullYear(), year]);
  for (const entry of financials.recurring) {
    for (const date of [entry.start, entry.end, ...entry.history.map((h) => h.from)]) if (date) years.add(Number(date.slice(0, 4)));
  }
  for (const cash of financials.cash) years.add(Number(cash.date.slice(0, 4)));
  const money = (cents: number) => `${currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' '}${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (cents: number) => `${cents < 0 ? '-' : '+'}${money(cents)}`;
  const plans = months.map((_, i) => planForMonth(financials, ymOf(year, i + 1)).filter((line) => line.active));
  const active = plans[month - 1];
  const income = active.filter((line) => line.monthlyCents >= 0);
  const expenses = active.filter((line) => line.monthlyCents < 0);
  const incomeTotal = sum(income);
  const expenseTotal = sum(expenses);
  const net = incomeTotal + expenseTotal;
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const previous = planForMonth(financials, ymOf(previousYear, previousMonth)).filter((line) => line.active);
  const previousByIndex = new Map(previous.map((line) => [line.entry.index, line]));
  const activeByIndex = new Map(active.map((line) => [line.entry.index, line]));
  const added = active.filter((line) => !previousByIndex.has(line.entry.index));
  const removed = previous.filter((line) => !activeByIndex.has(line.entry.index));
  const changed = active.filter((line) => previousByIndex.has(line.entry.index) && previousByIndex.get(line.entry.index)!.monthlyCents !== line.monthlyCents);
  const cash = financials.cash.filter((entry) => entry.date <= monthLast(ymOf(year, month))).reduce<typeof financials.cash[number] | null>((latest, entry) => !latest || entry.date >= latest.date ? entry : latest, null);
  const categoryTotals = new Map<string, number>();
  for (const line of expenses) categoryTotals.set(categoryOf(line), (categoryTotals.get(categoryOf(line)) || 0) - line.monthlyCents);
  const categoryColors = new Map([...categoryTotals].sort((a, b) => b[1] - a[1]).map(([category], i) => [category, colors[i % colors.length]]));

  const row = (line: PlanLine) => {
    const entry = line.entry;
    const color = line.monthlyCents < 0 ? categoryColors.get(categoryOf(line)) || colors[0] : '#15803d';
    const note = entry.recurrence === 1 ? 'Monthly' : line.isDue ? `Due (${money(line.priceCents || 0)})` : entry.paymentMonths.length ? `Paid in ${entry.paymentMonths.map((m) => months[m - 1]).join(', ')} (${money(line.priceCents || 0)})` : `Every ${entry.recurrence} months`;
    return <button type="button" className="bi-row" key={entry.index} onClick={() => onSourceLineClick?.(entry.line)} disabled={!onSourceLineClick || entry.line < 1} title={entry.description}>
      <span className="bi-row-left"><span className="bi-row-title">{nameOf(line)}</span><span className="bi-meta"><span className="bi-badge" style={{ color, borderColor: color }}>{categoryOf(line)}</span><span className={line.isDue && entry.recurrence > 1 ? 'bi-due' : ''}>{note}</span></span></span>
      <span className={`bi-amount ${line.monthlyCents < 0 ? 'bi-negative' : 'bi-positive'}`}>{signed(line.monthlyCents)}<small>/mo</small>{onSourceLineClick && <span className="bi-line">L{entry.line}</span>}</span>
    </button>;
  };
  const list = (lines: PlanLine[]) => {
    if (!lines.length) return <div className="bi-empty">No planned entries for {months[month - 1]}.</div>;
    const sorted = [...lines].sort((a, b) => Math.abs(b.monthlyCents) - Math.abs(a.monthlyCents));
    if (sort === 'amount') return sorted.map(row);
    const groups = new Map<string, PlanLine[]>();
    for (const line of sorted) groups.set(categoryOf(line), [...(groups.get(categoryOf(line)) || []), line]);
    return [...groups].sort((a, b) => Math.abs(sum(b[1])) - Math.abs(sum(a[1]))).map(([category, items]) => <div className="bi-group" key={category}><div className="bi-group-head"><span>{category} ({items.length})</span><span>{signed(sum(items))}/mo</span></div>{items.map(row)}</div>);
  };

  return <section className="budget-inspector" aria-label="Budget inspector">
    <div className="bi-toolbar">
      <select aria-label="Year" value={year} onChange={(event) => setYear(Number(event.target.value))}>{[...years].sort((a, b) => a - b).map((y) => <option key={y}>{y}</option>)}</select>
      <select aria-label="Sort transactions" value={sort} onChange={(event) => setSort(event.target.value as 'amount' | 'category')}><option value="amount">↕ Amount</option><option value="category">↕ Category</option></select>
      <select aria-label="Display currency label (no conversion)" title="Changes the label only; amounts are not converted" value={currency} onChange={(event) => setCurrency(event.target.value)}>{![ 'USD', 'EUR', 'GBP', 'CHF'].includes(currency) && <option value={currency}>{currency}</option>}<option value="USD">$ USD</option><option value="EUR">€ EUR</option><option value="GBP">£ GBP</option><option value="CHF">CHF</option></select>
    </div>
    <div className="bi-body">
      <div className="bi-card bi-months"><div className="bi-card-head"><span>{year} Monthly Overview</span><span>Select month to inspect</span></div><div className="bi-month-grid">{months.map((label, i) => <button type="button" key={label} aria-pressed={month === i + 1} className={`bi-month ${month === i + 1 ? 'active' : ''} ${year === today.getFullYear() && i === today.getMonth() ? 'current' : ''}`} onClick={() => setMonth(i + 1)}><span>{label}</span><small className={sum(plans[i]) < 0 ? 'bi-negative' : 'bi-positive'}>{signed(sum(plans[i]))}</small></button>)}</div></div>
      <div className="bi-kpis">
        <div className="bi-card bi-kpi"><span>↗ Income</span><strong className="bi-positive">{signed(incomeTotal)}</strong><small>Cash due: {money(income.filter((l) => l.isDue).reduce((n, l) => n + (l.priceCents || 0), 0))}</small></div>
        <div className="bi-card bi-kpi"><span>↘ Expenses</span><strong className="bi-negative">-{money(expenseTotal)}</strong><small>Cash due: {money(expenses.filter((l) => l.isDue).reduce((n, l) => n + (l.priceCents || 0), 0))}</small></div>
        <div className={`bi-card bi-kpi bi-net ${net < 0 ? 'negative' : ''}`}><span>Net Budget</span><strong className={net < 0 ? 'bi-negative' : 'bi-positive'}>{signed(net)}</strong><small>{net < 0 ? 'Deficit' : 'Surplus'}</small></div>
        <div className="bi-card bi-kpi"><span>Savings Rate</span><strong>{incomeTotal > 0 ? `${(net / incomeTotal * 100).toFixed(1)}%` : '—'}</strong><small>{incomeTotal > 0 ? 'of income' : 'No income'}</small></div>
      </div>
      <Cashflow income={income} expenses={expenses} currency={money} month={`${fullMonths[month - 1]} ${year}`} />
      <details className="bi-diff"><summary><span>Changes vs. {fullMonths[previousMonth - 1]} {previousYear}</span><strong className={net - sum(previous) < 0 ? 'bi-negative' : 'bi-positive'}>{signed(net - sum(previous))}</strong><span className="bi-toggle"><span className="bi-expand">Expand</span><span className="bi-collapse">Collapse</span> ⌄</span></summary>
        {([['New', added, 'bi-diff-new'], ['Changed', changed, 'bi-diff-changed'], ['Removed', removed, 'bi-diff-removed']] as const).map(([label, lines, cls]) => lines.length > 0 && <div className="bi-diff-group" key={label}><h4 className={cls}>{label.toUpperCase()} ({lines.length})</h4>{lines.map((line) => { const prev = previousByIndex.get(line.entry.index); const expense = line.monthlyCents < 0; const amountCls = label === 'Removed' ? 'bi-amount-removed' : expense ? 'bi-negative' : 'bi-positive'; return <div className="bi-change" key={line.entry.index}><span className="bi-change-name">{nameOf(line)}</span><span className="bi-change-values">{label === 'Changed' && prev && <del>{signed(prev.monthlyCents)}</del>}<span className={amountCls}>{signed(line.monthlyCents)}</span>{label === 'Changed' && prev && <span className="bi-change-delta">({signed(line.monthlyCents - prev.monthlyCents)})</span>}</span></div>; })}</div>)}
        {!added.length && !changed.length && !removed.length && <p className="bi-empty">No changes from the previous month.</p>}
      </details>
      {cash && <div className="bi-card bi-cash"><strong>Cash Snapshot ({cash.date})</strong><strong>{money(cash.cents)}{cash.cents < 0 ? ' (negative)' : ''}</strong></div>}
      <div className="bi-transactions"><section className="bi-card bi-list"><header className="bi-list-head bi-income-head"><strong>↙ Income</strong><strong className="bi-positive">{signed(incomeTotal)}</strong></header>{list(income)}</section><section className="bi-card bi-list"><header className="bi-list-head bi-expense-head"><strong>↗ Expenses</strong><strong className="bi-negative">-{money(expenseTotal)}</strong></header>{list(expenses)}</section></div>
    </div>
  </section>;
}

const prefersDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

function Cashflow({ income, expenses, currency, month }: { income: PlanLine[]; expenses: PlanLine[]; currency: (cents: number) => string; month: string }) {
  const uid = useId().replace(/:/g, '');
  const dark = prefersDark();
  const incomeColor = dark ? '#4ade80' : '#16a34a';
  const deficitColor = dark ? '#f87171' : '#dc2626';
  const surplusColor = '#b9fe67';
  const palette = dark ? darkColors : colors;
  const group = (lines: PlanLine[]) => {
    const totals = new Map<string, number>();
    for (const line of lines) totals.set(categoryOf(line), (totals.get(categoryOf(line)) || 0) + Math.abs(line.monthlyCents));
    return [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  };
  const incoming = sum(income), outgoing = -sum(expenses), total = Math.max(incoming, outgoing);
  const isDeficit = outgoing > incoming;
  if (!total) return <section className="bi-card bi-flow"><div className="bi-card-head"><span>Cashflow Sankey ({month})</span><span>Monthly plan</span></div><p className="bi-empty">No planned cash flow for this month.</p></section>;

  type Node = { name: string; value: number; color: string; h: number; x: number; y: number; deficit: boolean };
  const left: Node[] = group(income).map(([name, value]) => ({ name, value, color: incomeColor, h: 0, x: 0, y: 0, deficit: false }));
  if (left.length === 0 && incoming > 0) left.push({ name: 'Unspecified Income', value: incoming, color: incomeColor, h: 0, x: 0, y: 0, deficit: false });
  if (isDeficit) left.push({ name: 'Deficit (Savings Used)', value: outgoing - incoming, color: deficitColor, h: 0, x: 0, y: 0, deficit: true });
  left.sort((a, b) => b.value - a.value);
  const right: Node[] = group(expenses).map(([name, value], i) => ({ name, value, color: palette[i % palette.length], h: 0, x: 0, y: 0, deficit: false }));
  if (!isDeficit && incoming > outgoing) right.push({ name: 'Surplus (Budget)', value: incoming - outgoing, color: surplusColor, h: 0, x: 0, y: 0, deficit: false });

  const flowH = Math.max(260, Math.min(380, right.length * 38));
  const perUnit = flowH / total;
  const nodeW = 10, padY = 32, gap = 20, minSpacing = 32, minH = 6, leftX = 140, midX = 400, rightX = 640;
  for (const n of [...left, ...right]) n.h = Math.max(minH, n.value * perUnit);
  const midH = flowH;
  const colHeight = (nodes: Node[]) => nodes.reduce((t, n, i) => t + (i === nodes.length - 1 ? n.h : Math.max(n.h + gap, minSpacing)), 0);
  const maxCol = Math.max(colHeight(left), colHeight(right), midH);
  const height = maxCol + padY * 2;
  const place = (nodes: Node[], x: number) => {
    let y = padY + (maxCol - colHeight(nodes)) / 2;
    nodes.forEach((n, i) => { n.x = x; n.y = y; if (i < nodes.length - 1) y += Math.max(n.h + gap, minSpacing); });
  };
  place(left, leftX);
  place(right, rightX);
  const midY = padY + (maxCol - midH) / 2;
  const hubColor = isDeficit ? deficitColor : incomeColor;
  const label = (name: string) => (name.length > 22 ? `${name.slice(0, 21)}…` : name);
  const pct = (value: number) => Math.round((value / total) * 100);

  // Ribbons: left -> hub and hub -> right, each with a horizontal gradient at 45% opacity.
  let inY = midY, outY = midY;
  const leftRibbons = left.map((n, i) => {
    const slice = (n.value / total) * midH;
    const x0 = n.x + nodeW, x1 = midX, xm = (x0 + x1) / 2;
    const y0 = inY, y1 = inY + slice;
    inY += slice;
    const d = `M ${x0} ${n.y} C ${xm} ${n.y}, ${xm} ${y0}, ${x1} ${y0} L ${x1} ${y1} C ${xm} ${y1}, ${xm} ${n.y + n.h}, ${x0} ${n.y + n.h} Z`;
    return { key: `l${i}`, d, from: n.color, to: hubColor, name: n.name, value: n.value, sign: n.deficit ? '-' : '+' };
  });
  const rightRibbons = right.map((n, i) => {
    const slice = (n.value / total) * midH;
    const x0 = midX + nodeW, x1 = n.x, xm = (x0 + x1) / 2;
    const y0 = outY, y1 = outY + slice;
    outY += slice;
    const d = `M ${x0} ${y0} C ${xm} ${y0}, ${xm} ${n.y}, ${x1} ${n.y} L ${x1} ${n.y + n.h} C ${xm} ${n.y + n.h}, ${xm} ${y1}, ${x0} ${y1} Z`;
    return { key: `r${i}`, d, from: hubColor, to: n.color, name: n.name, value: n.value, sign: '' };
  });

  return <section className="bi-card bi-flow">
    <div className="bi-card-head"><span>Cashflow Sankey ({month})</span><span>{isDeficit ? 'Income & deficit → outflow' : 'Income → total income'}</span></div>
    <div className="bi-flow-scroll">
      <svg viewBox={`0 0 840 ${height}`} role="img" aria-label="Monthly planned cashflow by category">
        <defs>
          {[...leftRibbons, ...rightRibbons].map((r) => <linearGradient key={r.key} id={`${uid}-${r.key}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={r.from} stopOpacity=".45" /><stop offset="100%" stopColor={r.to} stopOpacity=".45" />
          </linearGradient>)}
        </defs>
        {leftRibbons.map((r) => <path key={r.key} d={r.d} fill={`url(#${uid}-${r.key})`}><title>{r.name} → {isDeficit ? 'Total Outflow' : 'Total Income'}: {r.sign}{currency(r.value)}</title></path>)}
        {rightRibbons.map((r) => <path key={r.key} d={r.d} fill={`url(#${uid}-${r.key})`}><title>{isDeficit ? 'Total Outflow' : 'Total Income'} → {r.name}: {currency(r.value)}</title></path>)}
        {left.map((n, i) => <g key={`ln${i}`}>
          <rect x={n.x} y={n.y} width={nodeW} height={n.h} rx="3" fill={n.color} />
          <text x={n.x - 8} y={n.y + n.h / 2 - 6} textAnchor="end" dominantBaseline="central" className="bi-flow-name">{label(n.name)}</text>
          <text x={n.x - 8} y={n.y + n.h / 2 + 8} textAnchor="end" dominantBaseline="central" className="bi-flow-value" style={{ fill: n.deficit ? deficitColor : undefined }}>{n.deficit ? '-' : '+'}{currency(n.value)}</text>
        </g>)}
        <rect x={midX} y={midY} width={nodeW} height={midH} rx="3" fill={hubColor} />
        <text x={midX + nodeW / 2} y={midY - 12} textAnchor="middle" className="bi-flow-name">{isDeficit ? 'Total Outflow' : 'Total Income'}</text>
        <text x={midX + nodeW / 2} y={midY + midH + 16} textAnchor="middle" className="bi-flow-value">{currency(total)}</text>
        {right.map((n, i) => <g key={`rn${i}`}>
          <rect x={n.x} y={n.y} width={nodeW} height={n.h} rx="3" fill={n.color} />
          <text x={n.x + nodeW + 8} y={n.y + n.h / 2 - 6} dominantBaseline="central" className="bi-flow-name">{label(n.name)}</text>
          <text x={n.x + nodeW + 8} y={n.y + n.h / 2 + 8} dominantBaseline="central" className="bi-flow-value">{currency(n.value)} ({pct(n.value)}%)</text>
        </g>)}
      </svg>
    </div>
    <p className="bi-flow-note">Monthly plan; deficit is not assumed to be funded.</p>
  </section>;
}