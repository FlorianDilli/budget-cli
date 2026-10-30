import { useMemo, useState, type ReactNode } from 'react';
import { useSession } from '../state/session';
import { analyzeMonth, topSpending } from '../domain/analysis';
import { asOfForMonth, totalMoney } from '../domain/totals';
import { currentMonth, type YearMonth } from '../domain/dates';
import { Card, Money, MonthSelect, PreviewNotice, currencyOf, dataMonths } from './common';

export function Overview() {
  const { snapshot, settings, financials, isSample } = useSession();
  const now = useMemo(() => new Date(), []);
  const months = useMemo(() => (snapshot ? dataMonths(snapshot, financials, now) : []), [snapshot, financials, now]);
  const [ym, setYm] = useState<YearMonth>(() => currentMonth(now));
  if (!snapshot) return null;
  const cur = currencyOf(settings);

  const a = analyzeMonth(financials, snapshot.transactions, ym);
  const total = totalMoney(settings, financials, snapshot.transactions, asOfForMonth(ym, settings, now));
  const top = topSpending(a.txs);
  const empty = snapshot.transactions.length === 0 && financials.recurring.length === 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Overview</h1>
        <MonthSelect months={months} value={ym} onChange={setYm} label="Month" />
      </header>
      <PreviewNotice isSample={isSample} />

      {empty && <p className="hint">No data yet. Add recurring entries in Settings and import a CSV in Transactions.</p>}

      <div className="kpis">
        <Kpi label="Available to spend" value={<Money cents={a.leftCents} currency={cur} />} />
        <Kpi label="Plan budget" value={<Money cents={a.budgetCents} currency={cur} />} />
        <Kpi label="Spending" value={<Money cents={a.spendCents} currency={cur} />} />
        <Kpi label="Total money" value={<Money cents={total.totalCents} currency={cur} />} sub={`as of ${total.asOf}`} />
      </div>

      <div className="grid-2">
        <Card title="Alerts">
          {a.alerts.length === 0 ? <p className="muted">No alerts for {ym}.</p> : (
            <ul className="alerts">{a.alerts.map((m, i) => <li key={i}>{m}</li>)}</ul>
          )}
        </Card>
        <Card title="Top 10 spending">
          {top.length === 0 ? <p className="muted">No transactions this month.</p> : <table><thead><tr><th>Name</th><th>Type</th><th className="num">Amount</th></tr></thead><tbody>{top.map((item, i) => <tr key={`${item.type}-${item.name}-${i}`}><td>{item.name}</td><td>{item.type}{item.recurring ? ' · recurring' : ''}</td><td className="num"><Money cents={item.cents} currency={cur} /></td></tr>)}</tbody></table>}
          <p className="muted small">Actual transaction amounts, grouped by category where applicable.</p>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
