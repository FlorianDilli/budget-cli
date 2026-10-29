import { useState } from 'react';
import { monthLast } from '../domain/dates';
import { planForMonth, type PlanLine } from '../domain/plan';
import { useSession } from '../state/session';
import type { Financials } from '../domain/config';
import './budget-inspector.css';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const colors = ['#ef4444', '#f97316', '#eab308', '#6366f1', '#a855f7', '#0ea5e9', '#ec4899'];
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
        {([['New', added], ['Changed', changed], ['Removed', removed]] as const).map(([label, lines]) => lines.length > 0 && <div className="bi-diff-group" key={label}><h4>{label} ({lines.length})</h4>{lines.map((line) => <div className="bi-change" key={line.entry.index}><span>{nameOf(line)}</span><span>{label === 'Changed' && <del>{signed(previousByIndex.get(line.entry.index)!.monthlyCents)} </del>}{signed(line.monthlyCents)}</span></div>)}</div>)}
        {!added.length && !changed.length && !removed.length && <p className="bi-empty">No changes from the previous month.</p>}
      </details>
      {cash && <div className="bi-card bi-cash"><strong>Cash Snapshot ({cash.date})</strong><strong>{money(cash.cents)}{cash.cents < 0 ? ' (negative)' : ''}</strong></div>}
      <div className="bi-transactions"><section className="bi-card bi-list"><header className="bi-list-head bi-income-head"><strong>↙ Income</strong><strong className="bi-positive">{signed(incomeTotal)}</strong></header>{list(income)}</section><section className="bi-card bi-list"><header className="bi-list-head bi-expense-head"><strong>↗ Expenses</strong><strong className="bi-negative">-{money(expenseTotal)}</strong></header>{list(expenses)}</section></div>
    </div>
  </section>;
}

function Cashflow({ income, expenses, currency, month }: { income: PlanLine[]; expenses: PlanLine[]; currency: (cents: number) => string; month: string }) {
  const group = (lines: PlanLine[]) => {
    const totals = new Map<string, number>();
    for (const line of lines) totals.set(categoryOf(line), (totals.get(categoryOf(line)) || 0) + Math.abs(line.monthlyCents));
    return [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  };
  const left = group(income), right = group(expenses);
  const incoming = sum(income), outgoing = -sum(expenses), total = Math.max(incoming, outgoing);
  if (outgoing > incoming) left.push(['Deficit (unfunded)', outgoing - incoming]);
  if (incoming > outgoing) right.push(['Surplus', incoming - outgoing]);
  const height = Math.max(260, Math.max(left.length, right.length) * 38 + 60);
  const hubHeight = 160, hubY = (height - hubHeight) / 2;
  const layout = (nodes: [string, number][]) => {
    let y = (height - hubHeight - Math.max(0, nodes.length - 1) * 20) / 2, hub = hubY;
    return nodes.map(([name, value], i) => { const h = value / total * hubHeight; const node = { name, value, y, hub, h, color: name.startsWith('Deficit') ? '#dc2626' : name === 'Surplus' ? '#8fcf36' : colors[i % colors.length] }; y += h + 20; hub += h; return node; });
  };
  const l = total ? layout(left) : [], r = total ? layout(right) : [];
  const path = (x1: number, x2: number, y1: number, y2: number, h: number) => `M${x1} ${y1} C420 ${y1} 420 ${y2} ${x2} ${y2} L${x2} ${y2 + h} C420 ${y2 + h} 420 ${y1 + h} ${x1} ${y1 + h} Z`;
  return <section className="bi-card bi-flow"><div className="bi-card-head"><span>Cashflow Sankey ({month})</span><span>Monthly plan</span></div>{!total ? <p className="bi-empty">No planned cash flow for this month.</p> : <><div className="bi-flow-scroll"><svg viewBox={`0 0 840 ${height}`} role="img" aria-label="Monthly planned cashflow by category">
    {l.map((n) => <g key={n.name}><path d={path(170, 415, n.y, n.hub, n.h)} fill={n.name.startsWith('Deficit') ? n.color : '#16a34a'} opacity=".55"><title>{n.name}: {currency(n.value)}</title></path><text x="160" y={n.y + n.h / 2} textAnchor="end">{n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name}</text><text className="bi-flow-value" x="160" y={n.y + n.h / 2 + 14} textAnchor="end">{currency(n.value)}</text><rect x="170" y={n.y} width="8" height={n.h} fill={n.name.startsWith('Deficit') ? n.color : '#16a34a'} /></g>)}
    {r.map((n) => <g key={n.name}><path d={path(425, 670, n.hub, n.y, n.h)} fill={n.color} opacity=".55"><title>{n.name}: {currency(n.value)}</title></path><rect x="662" y={n.y} width="8" height={n.h} fill={n.color} /><text x="680" y={n.y + n.h / 2}>{n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name}</text><text className="bi-flow-value" x="680" y={n.y + n.h / 2 + 14}>{currency(n.value)}</text></g>)}
    <rect x="415" y={hubY} width="10" height={hubHeight} fill={outgoing > incoming ? '#dc2626' : '#16a34a'} /><text x="420" y={hubY - 12} textAnchor="middle">{outgoing > incoming ? 'Total outflow' : 'Total income'}</text><text className="bi-flow-value" x="420" y={hubY + hubHeight + 18} textAnchor="middle">{currency(total)}</text>
  </svg></div><p className="bi-flow-note">Monthly plan; deficit is not assumed to be funded.</p></>}</section>;
}
