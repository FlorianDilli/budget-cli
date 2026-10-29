import { describe, expect, it } from 'vitest';
import { parseSettings, parseFinancials } from '../src/domain/config';
import { SAMPLE_FINANCIALS, SAMPLE_SETTINGS } from '../src/domain/sample';
import { findTableLines, parseToml } from '../src/domain/toml';

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
    const r = parseSettings('[user]\ncurrency_symbol = = 1\n');
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
  it('normalizes month boundary dates in financial fields', () => {
    const r = parseFinancials(`[[recurring_transactions]]
amount = 10
start_date = "2024-02-start"
end_date = "2024-02-END"
amount_history = [{ from = "2024-02-end", amount = 20 }]
[cash]
entries = [{ date = "2025-02-end", amount = 5 }]
`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recurring[0].start).toBe('2024-02-01');
      expect(r.value.recurring[0].end).toBe('2024-02-29');
      expect(r.value.recurring[0].history[0].from).toBe('2024-02-29');
      expect(r.value.cash[0].date).toBe('2025-02-28');
    }
  });
  it.each(['2024-00-start', '2024-13-end', '2024-2-start', '2024-02-middle'])('rejects invalid financial date %s', (date) => {
    expect(parseFinancials(`[[recurring_transactions]]\namount=1\nstart_date="${date}"`).ok).toBe(false);
  });
  it('accepts unquoted month boundary dates via the reference-compatible fallback', () => {
    const r = parseFinancials('[[recurring_transactions]]\namount=1\nstart_date=2024-02-start');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recurring[0].start).toBe('2024-02-01');
  });
  it('reports the actual quoted recurring header after misleading string content', () => {
    const text = `note = """
[[recurring_transactions]]
"""
[["recurring_transactions"]]
description = "Bad"
`;
    const r = parseFinancials(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.find((issue) => issue.message.includes('needs amount'))?.line).toBe(4);
  });
});

describe('TOML recognition', () => {
  it('passes empty and invalid whitespace through the parser', () => {
    expect(parseToml('').ok).toBe(true);
    expect(parseToml(' \t\r\n').ok).toBe(true);
    expect(parseToml('\u00a0').ok).toBe(false);
    expect(parseToml('\u000b').ok).toBe(false);
  });
  it('recognizes decoded dotted headers without matching multiline values', () => {
    const text = `note = '''
[[importer.formats]]
'''
values = [
  [1, 2],
]
[["importer" . 'formats']] # real
name = "x"
[[importer.formats]]
name = "y"
`;
    expect(parseToml(text).ok).toBe(true);
    expect(findTableLines(text, 'importer.formats')).toEqual([7, 9]);
    expect(findTableLines('["importer.formats"]', 'importer.formats')).toEqual([]);
  });
  it('handles escaped quotes, comments, and multiline closing quote runs', () => {
    const text = `a = "escaped \\\" # not a comment"
b = """text
[[recurring_transactions]]
end"""" # one quote in the value
[[recurring_transactions]]
amount = 1
`;
    expect(parseToml(text).ok).toBe(true);
    expect(findTableLines(text, 'recurring_transactions')).toEqual([5]);
  });
  it('locates quoted format headers in validation errors', () => {
    const r = parseSettings('title = "x"\n[["importer" . "formats"]]\nname = "Bad"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].line).toBe(2);
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
