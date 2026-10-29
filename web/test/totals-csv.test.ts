import { describe, expect, it } from 'vitest';
import { parseSettings, parseFinancials } from '../src/domain/config';
import { totalMoney, asOfForMonth } from '../src/domain/totals';
import { prepareImport, parseDateWithFormat, normalizeAmount, readCsv } from '../src/domain/csv';
import { classifyRows, transactionHash } from '../src/domain/duplicates';
import { parseSettings as ps } from '../src/domain/config';
import type { Tx } from '../src/domain/snapshot';

const SETTINGS = `
[[importer.formats]]
name = "N26"
date_column = "Value Date"
description_column = "Partner Name"
reference_column = "Payment Reference"
amount_column = "Amount (EUR)"
delimiter = ","
date_format = "%Y.%m.%d"
balance_snapshot = 1000.00
balance_snapshot_date = "2025-01-31"

[[importer.formats]]
name = "GLS"
date_column = "Buchungstag"
description_column = "Name"
amount_column = "Betrag"
delimiter = ";"
date_format = "%d.%m.%Y"
decimal_separator = ","
thousands_separator = "."
`;

describe('total money', () => {
  it('adds transactions strictly after the snapshot date and cash on or before asOf', () => {
    const s = parseSettings(SETTINGS);
    const f = parseFinancials('[cash]\nentries = [{date = "2025-02-01", amount = 50.00}, {date = "2025-03-01", amount = 80.00}]\n');
    if (!s.ok || !f.ok) throw new Error('bad');
    const txs: Tx[] = [
      { hash: 'a', date: '2025-01-31', description: 'before', cents: -500, account: 'N26' },
      { hash: 'b', date: '2025-02-10', description: 'after', cents: -2000, account: 'N26' },
      { hash: 'c', date: '2025-04-10', description: 'later', cents: -9000, account: 'N26' },
    ];
    const t = totalMoney(s.value, f.value, txs, '2025-02-28');
    expect(t.accounts[0].cents).toBe(100000 - 2000);
    expect(t.cashCents).toBe(5000);
    expect(t.totalCents).toBe(98000 + 5000);
  });

  it('uses the configured total_money_as_of_day, never in the future for the current month', () => {
    const s = ps('[user]\ntotal_money_as_of_day = 28\n');
    if (!s.ok) throw new Error('bad');
    expect(asOfForMonth('2025-02', s.value, new Date(2026, 0, 1))).toBe('2025-02-28');
    expect(asOfForMonth('2026-10', s.value, new Date(2026, 9, 10))).toBe('2026-10-10');
    expect(asOfForMonth('2026-11', s.value, new Date(2026, 9, 10))).toBe('2026-11-28');
  });

  it('reconstructs historical balances by unwinding through the snapshot date', () => {
    const s = parseSettings(SETTINGS);
    const f = parseFinancials('[cash]\nentries = [{date = "2025-01-01", amount = 5}]');
    if (!s.ok || !f.ok) throw new Error('bad fixture');
    const txs: Tx[] = [
      { hash: 'a', date: '2025-01-10', description: 'as of', cents: -100, account: 'N26' },
      { hash: 'b', date: '2025-01-20', description: 'between', cents: -2000, account: 'N26' },
      { hash: 'c', date: '2025-01-31', description: 'snapshot', cents: 500, account: 'N26' },
      { hash: 'd', date: '2025-01-25', description: 'other', cents: -10000, account: 'GLS' },
    ];
    expect(totalMoney(s.value, f.value, txs, '2025-01-10').totalCents).toBe(102000);
    expect(totalMoney(s.value, f.value, txs, '2025-01-31').totalCents).toBe(100500);
  });
});

describe('CSV import', () => {
  const s = parseSettings(SETTINGS);
  if (!s.ok) throw new Error('bad');
  const formats = s.value.formats;

  it('detects N26 headers and normalizes rows with quoted fields', () => {
    const csv = '\ufeffValue Date,Partner Name,Payment Reference,Amount (EUR)\n2025.02.01,"Lidl, Berlin","Groceries",-12.5\n2025.02.02,,"Rent",-800\n';
    const r = prepareImport(csv, 'n26.csv', formats);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.format.name).toBe('N26');
      expect(r.rows[0]).toMatchObject({ date: '2025-02-01', description: 'Lidl, Berlin', cents: -1250 });
      expect(r.rows[1].description).toBe('Rent');
    }
  });

  it('handles German decimal and thousands separators', () => {
    const csv = 'Buchungstag;Name;Betrag\n01.03.2025;Shop;"-1.234,50"\n';
    const r = prepareImport(csv, 'gls.csv', formats);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].cents).toBe(-123450);
  });

  it('commits nothing when any row is invalid', () => {
    const csv = 'Value Date,Partner Name,Amount (EUR)\n2025.02.01,A,-1\n2025.13.01,B,-2\n';
    const r = prepareImport(csv, 'bad.csv', formats);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rowErrors?.[0]).toContain('Row 3');
  });

  it('rejects malformed quoted CSV rather than importing partial rows', () => {
    expect(prepareImport('Value Date,Partner Name,Amount (EUR)\n2025.02.01,"Coffee,-3', 'bad.csv', formats).ok).toBe(false);
    expect(prepareImport('Value Date,Partner Name,Amount (EUR)\n2025.02.01,"Coffee"junk,-3', 'bad.csv', formats).ok).toBe(false);
  });

  it('rejects amounts with more than two decimals', () => {
    expect(() => normalizeAmount('1.234', formats[0])).toThrow();
  });

  it('parses dates with strptime-style formats', () => {
    expect(parseDateWithFormat('31.12.2023', '%d.%m.%Y')).toBe('2023-12-31');
    expect(parseDateWithFormat('Jan 05, 2024', '%b %d, %Y')).toBe('2024-01-05');
    expect(parseDateWithFormat('02/30/2024', '%m/%d/%Y')).toBeNull();
  });

  it('keeps identical lines in one file and skips re-imports (duplicate rule)', async () => {
    const csv = 'Value Date,Partner Name,Amount (EUR)\n2025.02.01,Coffee,-3\n2025.02.01,Coffee,-3\n';
    const r = prepareImport(csv, 'x.csv', formats);
    if (!r.ok) throw new Error('bad');
    const first = await classifyRows(r.rows, 'N26', new Set());
    expect(first.fresh).toHaveLength(2);
    const existing = new Set(first.fresh.map((t) => t.hash));
    const second = await classifyRows(r.rows, 'N26', existing);
    expect(second.fresh).toHaveLength(0);
    expect(second.duplicates).toBe(2);
  });

  it('matches the CLI duplicate hash (crypto.py generate_transaction_hash)', async () => {
    expect(await transactionHash('2025-01-02', 'Test Payment', 1250, 0))
      .toBe('0ede5c2d6d63c96ddf85adbb9825d25f54921dbbb2cc60527337f58d9fa4894a');
    expect(await transactionHash('2025-01-02', 'Rent', 120000, 1))
      .toBe('21b770e4a7cacbf752aa15713a373fcb7f253442709c73885020c5f93b011d63');
  });

  it('readCsv keeps header names exactly', () => {
    expect(readCsv('a,b\n1,2\n', ',').headers).toEqual(['a', 'b']);
  });
});
