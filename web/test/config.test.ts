import { describe, expect, it } from 'vitest';
import { parseSettings, parseFinancials } from '../src/domain/config';
import { SAMPLE_FINANCIALS, SAMPLE_SETTINGS } from '../src/domain/sample';

describe('settings.toml', () => {
  it('parses the synthetic sample', () => {
    const r = parseSettings(SAMPLE_SETTINGS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.formats[0].balanceSnapshot).toBe(100000);
      expect(r.value.formats[0].balanceSnapshotDate).toBe('2025-01-01');
    }
  });
  it('names the format and points at its line on error', () => {
    const text = '[[importer.formats]]\nname = "N26"\ndate_column = "D"\namount_column = "A"\n';
    const r = parseSettings(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0].line).toBe(1);
      expect(r.issues[0].message).toContain('Format "N26"');
      expect(r.issues[0].message).toContain('description_column');
    }
  });
  it('reports TOML syntax errors with line numbers', () => {
    const r = parseSettings('[user]\ncurrency_symbol = =\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].line).toBe(2);
  });
});

describe('financials.toml', () => {
  it('parses the synthetic sample', () => {
    const r = parseFinancials(SAMPLE_FINANCIALS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recurring).toHaveLength(4);
      expect(r.value.recurring[2].history[0].cents).toBe(-999);
      expect(r.value.recurring[3].paymentMonths).toEqual([3]);
      expect(r.value.recurring[3].recurrence).toBe(12);
      expect(r.value.recurring[1].recurrence).toBe(1);
    }
  });
  it('applies defaults and accepts native TOML dates', () => {
    const r = parseFinancials('[[recurring_transactions]]\ndescription = "X"\namount = -5\nstart_date = 2025-03-01\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recurring[0].recurrence).toBe(1);
      expect(r.value.recurring[0].start).toBe('2025-03-01');
      expect(r.value.recurring[0].paymentMonths).toEqual([]);
    }
  });
  it('names the entry in every entry error', () => {
    const r = parseFinancials('[[recurring_transactions]]\ndescription = "Netflix"\namount = -5\nrecurrence_months = 0\n[[recurring_transactions]]\ndescription = "Bad"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.message.includes('Recurring entry 1 "Netflix"') && i.message.includes('recurrence_months'))).toBe(true);
      expect(r.issues.some((i) => i.message.includes('Recurring entry 2 "Bad"') && i.message.includes('needs amount'))).toBe(true);
      expect(r.issues.find((i) => i.message.includes('"Bad"'))?.line).toBe(5);
    }
  });
  it('rejects end before start', () => {
    const r = parseFinancials('[[recurring_transactions]]\ndescription="A"\namount=1\nstart_date="2025-05-01"\nend_date="2025-04-01"\n');
    expect(r.ok).toBe(false);
  });
});

describe('configuration shape validation', () => {
  it.each([
    'user = 1',
    '[user]\nround_amounts = "yes"',
    'importer = 1',
    '[importer]\nformats = 1',
    '[importer]\nformats = [1]',
  ])('rejects invalid settings: %s', (text) => {
    expect(parseSettings(text).ok).toBe(false);
  });

  it.each([
    'category_rules = 1',
    'recurring_transactions = 1',
    'recurring_transactions = [1]',
    '[[recurring_transactions]]\namount = 1\namount_history = [1]',
    '[[recurring_transactions]]\namount = 1\ncategory = 42',
    'cash = 1',
    '[cash]\nentries = 1',
    '[cash]\nentries = [1]',
  ])('rejects invalid financials: %s', (text) => {
    expect(parseFinancials(text).ok).toBe(false);
  });
});
