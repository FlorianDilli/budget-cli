import type { PlanLine } from '../domain/plan';
import { centsToDecimal } from '../domain/money';
import { monthLabel, type YearMonth } from '../domain/dates';
import { Card, Money } from './common';

type Node = { name: string; cents: number; color: string; kind: 'income' | 'expense' | 'deficit' | 'surplus' };
const colors = ['#ef4444', '#f97316', '#ca8a04', '#6366f1', '#a855f7', '#0284c7', '#db2777'];

export function CashFlow({ plan, currency, month }: { plan: PlanLine[]; currency: string; month: YearMonth }) {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const line of plan) {
    if (!line.active || !line.monthlyCents) continue;
    const groups = line.monthlyCents > 0 ? incoming : outgoing;
    const category = line.entry.category || 'General';
    groups.set(category, (groups.get(category) ?? 0) + Math.abs(line.monthlyCents));
  }
  const income = [...incoming.values()].reduce((a, b) => a + b, 0);
  const expense = [...outgoing.values()].reduce((a, b) => a + b, 0);
  const total = Math.max(income, expense);
  const left: Node[] = [...incoming].sort((a, b) => b[1] - a[1]).map(([name, cents]) => ({ name, cents, color: '#16a34a', kind: 'income' }));
  const right: Node[] = [...outgoing].sort((a, b) => b[1] - a[1]).map(([name, cents], i) => ({ name, cents, color: colors[i % colors.length], kind: 'expense' }));
  if (expense > income) left.push({ name: 'Deficit (unfunded)', cents: expense - income, color: '#dc2626', kind: 'deficit' });
  if (income > expense) right.push({ name: 'Surplus (budget)', cents: income - expense, color: '#8fcf36', kind: 'surplus' });

  const hubHeight = 240;
  const gap = 28;
  const columnHeight = (nodes: Node[]) => hubHeight + Math.max(0, nodes.length - 1) * gap;
  const height = Math.max(columnHeight(left), columnHeight(right)) + 80;
  const hubY = (height - hubHeight) / 2;
  const layout = (nodes: Node[]) => {
    let y = (height - columnHeight(nodes)) / 2;
    let hub = hubY;
    return nodes.map((node) => {
      const h = node.cents / total * hubHeight;
      const result = { ...node, y, hub, h };
      y += h + gap;
      hub += h;
      return result;
    });
  };
  const l = total ? layout(left) : [];
  const r = total ? layout(right) : [];
  const ribbon = (x0: number, x1: number, y0: number, y1: number, h: number) => {
    const mid = (x0 + x1) / 2;
    return `M ${x0} ${y0} C ${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1} L ${x1} ${y1 + h} C ${mid} ${y1 + h}, ${mid} ${y0 + h}, ${x0} ${y0 + h} Z`;
  };
  const label = (name: string) => name.length > 22 ? `${name.slice(0, 21)}…` : name;
  const amount = (cents: number) => `${centsToDecimal(cents)} ${currency}`;

  return <Card title={`Cashflow Sankey (${monthLabel(month)})`}>
    <p className="muted small">{expense > income ? 'Income and deficit → total outflow → expenses' : 'Income → total income → expenses and surplus'}. Monthly plan; deficit is not assumed to be funded.</p>
    {!total ? <p className="muted">No planned cash flow for this month.</p> : <>
      <div className="sankey-scroll" tabIndex={0} aria-label="Cashflow diagram, scroll horizontally if needed">
        <svg className="sankey" viewBox={`0 0 840 ${height}`} aria-hidden="true">
          {l.map((n, i) => <path key={`l${i}`} d={ribbon(170, 415, n.y, n.hub, n.h)} fill={n.color} className="sankey-ribbon"><title>{n.name}: {amount(n.cents)}</title></path>)}
          {r.map((n, i) => <path key={`r${i}`} d={ribbon(425, 670, n.hub, n.y, n.h)} fill={n.color} className="sankey-ribbon"><title>{n.name}: {amount(n.cents)}</title></path>)}
          {l.map((n, i) => <g key={`ln${i}`}><rect x="160" y={n.y} width="10" height={n.h} fill={n.color} /><text x="152" y={n.y + n.h / 2 - 4} textAnchor="end">{label(n.name)}</text><text className="sankey-value" x="152" y={n.y + n.h / 2 + 10} textAnchor="end">{amount(n.cents)}</text></g>)}
          <rect x="415" y={hubY} width="10" height={hubHeight} fill={expense > income ? '#dc2626' : '#16a34a'} />
          <text x="420" y={hubY - 12} textAnchor="middle">{expense > income ? 'Total outflow' : 'Total income'}</text>
          <text className="sankey-value" x="420" y={hubY + hubHeight + 18} textAnchor="middle">{amount(total)}</text>
          {r.map((n, i) => <g key={`rn${i}`}><rect x="670" y={n.y} width="10" height={n.h} fill={n.color} /><text x="688" y={n.y + n.h / 2 - 4}>{label(n.name)}</text><text className="sankey-value" x="688" y={n.y + n.h / 2 + 10}>{amount(n.cents)} ({Math.round(n.cents / total * 100)}%)</text></g>)}
        </svg>
      </div>
      <div className="sankey-summary" aria-label="Cashflow breakdown">
        <div><strong>Inflows and deficit</strong><ul>{left.map((n, i) => <li key={i}>{n.name}: <Money cents={n.kind === 'deficit' ? -n.cents : n.cents} currency={currency} /></li>)}</ul></div>
        <div><strong>Outflows and surplus</strong><ul>{right.map((n, i) => <li key={i}>{n.name}: <Money cents={n.kind === 'expense' ? -n.cents : n.cents} currency={currency} /></li>)}</ul></div>
      </div>
    </>}
  </Card>;
}
