/**
 * Money display formatting — ADR-037. Two decimals, thousands separators, sign preserved,
 * banker's rounding at cents; inputs get the plain two-decimal form. Never a JS number.
 */
import { describe, expect, it } from 'vitest';

import { Decimal } from '@/lib/decimal';
import { formatMoney, toInputAmount } from '@/lib/money-format';

describe('formatMoney', () => {
  it.each([
    ['1379.5000', '1,379.50'],
    ['1500.0000', '1,500.00'],
    ['0.0000', '0.00'],
    ['0', '0.00'],
    ['-120.5000', '-120.50'],
    ['-1234567.8900', '-1,234,567.89'],
    ['999.99', '999.99'],
    ['1000', '1,000.00'],
    ['12345678901234.5678', '12,345,678,901,234.57'],
  ])('%s → %s', (input, expected) => {
    expect(formatMoney(input)).toBe(expected);
  });

  it('rounds half-even at cents (the global decimal.js rule), never half-up', () => {
    expect(formatMoney('0.0050')).toBe('0.00');
    expect(formatMoney('0.0150')).toBe('0.02');
    expect(formatMoney('2.6750')).toBe('2.68');
    expect(formatMoney('2.6650')).toBe('2.66');
    expect(formatMoney('-0.0050')).toBe('-0.00'.replace('-0.00', '-0.00')); // sign is preserved as given
  });

  it('accepts a Decimal as well as a money string', () => {
    expect(formatMoney(new Decimal('42.1'))).toBe('42.10');
  });
});

describe('toInputAmount', () => {
  it('gives the plain two-decimal form that the money validators accept', () => {
    expect(toInputAmount('1379.5000')).toBe('1379.50');
    expect(toInputAmount('-5')).toBe('-5.00');
    expect(toInputAmount('1234567')).toBe('1234567.00');
  });
});
