import { useMemo } from 'react';
import { useSession } from '../state/session';
import { analyzeMonth } from '../domain/analysis';
import { asOfForMonth, totalMoney } from '../domain/totals';
import { currentMonth, monthLabel, monthOf } from '../domain/dates';
import { sumCents, centsToDecimal, type Cents } from '../domain/money';
import { Card, Money, currencyOf, dataMonths } from './common';

interface Row {
  ym: string;
  budget: Cents;
  spend: Cents;
  left: Cents;
  total: Cents;
  hasData: boolean;
}

export function Insights() {
  const { snapshot, settings, financials } = useSession();
  const now = useMemo(() => new Date(), []);
  if (!snapshot) return null;
  const cur = currencyOf(settings);
  const cutoff = currentMonth(now);

  const rows: Row[] = useMemo(() => {
    const months = dataMonths(snapshot, financials, now).filter((m) => m <= cutoff);
    return months.map((ym) => {
      const a = analyzeMonth(financials, snapshot.transactions, ym);
      const t = totalMoney(settings, financials, snapshot.transactions, asOfForMonth(ym, settings, now));
      const hasData = a.txs.length > 0 || a.plan.some((p) => p.active);
      return { ym, budget: a.budgetCents, spend: a.spendCents, left: a.leftCents, total: t.totalCents, hasData };
    });
  }, [snapshot, settings, financials, now, cutoff]);

  const withData = rows.filter((r) => r.hasData);
  const avg = (key: 'budget' | 'spend' | 'left') => {
    if (!withData.length) return 0;
    return Math.round(sumCents(withData.map((r) => r[key])) / withData.length);
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Insights</h1></header>

      <Card title="Total money over time" wide>
        <TotalChart rows={rows.filter((r) => r.total !== 0 || r.hasData)} currency={cur} />
        <p className="muted small">Measured on the day set by total_money_as_of_day (settings.toml); each point is the month's measurement date.</p>
      </Card>

      <Card title="Months at a glance" wide>
        {rows.length === 0 ? <p className="muted">No months to show yet.</p> : (
          <table className="tx-table">
            <thead>
              <tr><th>Month</th><th className="num">Plan budget</th><th className="num">Spending</th><th className="num">Left</th><th className="num">Total money</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ym} className={r.hasData ? '' : 'muted'}>
                  <td>{monthLabel(r.ym)}</td>
                  <td className="num"><Money cents={r.budget} currency={cur} /></td>
                  <td className="num"><Money cents={r.spend} currency={cur} /></td>
                  <td className="num"><Money cents={r.left} currency={cur} /></td>
                  <td className="num"><Money cents={r.total} currency={cur} /></td>
                </tr>
              ))}
            </tbody>
            {withData.length > 0 && (
              <tfoot>
                <tr>
                  <td>Average</td>
                  <td className="num">{centsToDecimal(avg('budget'))} {cur}</td>
                  <td className="num">{centsToDecimal(avg('spend'))} {cur}</td>
                  <td className="num">{centsToDecimal(avg('left'))} {cur}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </Card>
    </div>
  );
}

function TotalChart({ rows, currency }: { rows: Row[]; currency: string }) {
  if (rows.length < 2) return <p className="muted">Need at least two months to draw the chart.</p>;
  const W = 640;
  const H = 220;
  const pad = 36;
  const vals = rows.map((r) => r.total);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (W - pad * 2)) / (rows.length - 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const points = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Total money from ${monthOf(rows[0].ym)} to ${monthOf(rows[rows.length - 1].ym)}`}>
      <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="axis" />
      <polyline points={points} className="series" fill="none" />
      {rows.map((r, i) => (
        <g key={r.ym}>
          <circle cx={x(i)} cy={y(r.total)} r={3} />
          {(i === 0 || i === rows.length - 1 || i % 3 === 0) && (
            <text x={x(i)} y={H - 10} textAnchor="middle">{r.ym}</text>
          )}
        </g>
      ))}
      <text x={4} y={y(max) + 4} className="axis-label">{centsToDecimal(max)}</text>
      <text x={4} y={y(min) + 4} className="axis-label">{centsToDecimal(min)} {currency}</text>
    </svg>
  );
}
