import { calculateVarianceAmount, calculateVarianceRatio, toMoney } from '../utils/calculator';

describe('toMoney', () => {
  it('should format number to 2 decimal places', () => {
    expect(toMoney(420000)).toBe('420000.00');
  });

  it('should format string number', () => {
    expect(toMoney('123.4')).toBe('123.40');
  });

  it('should throw on non-finite value', () => {
    expect(() => toMoney(Infinity)).toThrow('金额必须是有效数字');
    expect(() => toMoney(NaN)).toThrow('金额必须是有效数字');
  });
});

describe('calculateVarianceAmount', () => {
  it('should return positive variance when actual exceeds budget', () => {
    expect(calculateVarianceAmount(100, 120)).toBe('20.00');
  });

  it('should return negative variance when actual is below budget', () => {
    expect(calculateVarianceAmount(100, 80)).toBe('-20.00');
  });

  it('should return zero when actual equals budget', () => {
    expect(calculateVarianceAmount(100, 100)).toBe('0.00');
  });
});

describe('calculateVarianceRatio', () => {
  it('should return 0 when actual equals budget', () => {
    expect(calculateVarianceRatio(100, 100)).toBe(0);
  });

  it('should return correct ratio when actual exceeds budget', () => {
    expect(calculateVarianceRatio(100, 120)).toBeCloseTo(0.2, 10);
  });

  it('should return correct ratio when actual is below budget', () => {
    expect(calculateVarianceRatio(100, 80)).toBeCloseTo(0.2, 10);
  });

  it('should return 0 when both budget and actual are zero', () => {
    expect(calculateVarianceRatio(0, 0)).toBe(0);
  });

  it('should return null when budget is zero and actual is positive', () => {
    expect(calculateVarianceRatio(0, 50000)).toBeNull();
  });

  it('should return null when budget is zero and actual is negative', () => {
    expect(calculateVarianceRatio(0, -100)).toBeNull();
  });

  it('should accept string inputs', () => {
    expect(calculateVarianceRatio('100', '130')).toBeCloseTo(0.3, 10);
  });

  it('should accept mixed string and number inputs', () => {
    expect(calculateVarianceRatio('200', 250)).toBeCloseTo(0.25, 10);
  });
});
