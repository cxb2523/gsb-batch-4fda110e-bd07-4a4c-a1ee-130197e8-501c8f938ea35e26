import { describe, expect, it } from 'vitest';
import { toDisplayProgress } from './progress';

describe('toDisplayProgress', () => {
  it('returns zero while idle', () => {
    expect(toDisplayProgress(false, 0.42)).toBe(0);
  });

  it('keeps loading progress visible and clamps its bounds', () => {
    expect(toDisplayProgress(true, 0)).toBe(0.05);
    expect(toDisplayProgress(true, 0.42)).toBe(0.42);
    expect(toDisplayProgress(true, 5)).toBe(1);
    expect(toDisplayProgress(true, Number.NaN)).toBe(0.05);
  });
});