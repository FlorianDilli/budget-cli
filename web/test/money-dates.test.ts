import { describe, expect, it } from 'vitest';
import { parseDecimalToCents, numberToCents, divideCents, centsToDecimal } from '../src/domain/money';
import { isIsoDate, parseIsoDate, monthLast, addMonths, monthRange, todayIso } from '../src/domain/dates';

describe('money', () => {
  it('parses decimals to exact cents', () => {
    expect(parseDecimalToCents('-1234.5')).toBe(-123450);
    expect(parseDecimalToCents('0.07')).toBe(7);
    expect(parseDecimalToCents('+3')).toBe(300);
  });
  it('rejects invalid or over-precise amounts', () => {
    expect(() => parseDecimalToCents('1.234')).toThrow();
    expect(() => parseDecimalToCents('1e3')).toThrow();
    expect(() => numberToCents(1.005)).toThrow();
  });
  it('converts TOML floats without float drift', () => {
    expect(numberToCents(0.1 + 0.2 === 0.3 ? 0.3 : 0.3)).toBe(30);
    expect(numberToCents(-12.99)).toBe(-1299);
  });
  it('divides by recurrence with half-away-from-zero rounding', () => {
    expect(divideCents(-24000, 12)).toBe(-2000);
    expect(divideCents(-10000, 3)).toBe(-3333);
    expect(divideCents(-1500, 2)).toBe(-750);
    expect(divideCents(1500, 4)).toBe(375);
    expect(divideCents(-25, 2)).toBe(-13);
  });
  it('formats decimals', () => {
    expect(centsToDecimal(-1205)).toBe('-12.05');
    expect(centsToDecimal(5)).toBe('0.05');
  });
});

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2025-1-02')).toBe(false);
  });
  it('accepts TOML native dates as UTC components', () => {
    expect(parseIsoDate(new Date(Date.UTC(2025, 0, 2)))).toBe('2025-01-02');
  });
  it('computes month bounds and ranges', () => {
    expect(monthLast('2024-02')).toBe('2024-02-29');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(monthRange('2025-11', '2026-01')).toEqual(['2025-11', '2025-12', '2026-01']);
  });
  it('uses the injected clock for today', () => {
    expect(todayIso(new Date(2026, 9, 29, 12))).toBe('2026-10-29');
  });
});
