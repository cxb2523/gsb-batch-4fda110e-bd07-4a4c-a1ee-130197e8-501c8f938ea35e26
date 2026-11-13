import { describe, expect, it } from 'vitest';
import { getCrawlRequestBudget, shouldQueuePage } from './crawler';

describe('crawler helpers', () => {
  it('clamps the request budget to a sane maximum and stays above the minimum', () => {
    expect(getCrawlRequestBudget(50, 3)).toBe(500);
    expect(getCrawlRequestBudget(500, 3)).toBe(500);
  });

  it('rejects duplicate queue entries while allowing new pages', () => {
    expect(shouldQueuePage('Neural network', new Set(['Neural network']))).toBe(false);
    expect(shouldQueuePage('Quantum mechanics', new Set(['Complexity science']))).toBe(true);
  });
});
