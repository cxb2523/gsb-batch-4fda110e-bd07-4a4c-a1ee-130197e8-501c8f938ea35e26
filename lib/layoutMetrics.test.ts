import { describe, expect, it } from 'vitest';
import { computeRobustBounds } from './layoutMetrics';

describe('computeRobustBounds', () => {
  it('excludes far outliers from the framing box', () => {
    const bounds = computeRobustBounds([
      ...Array.from({ length: 20 }, (_, index) => ({ x: index, y: index })),
      { x: 10000, y: -10000 },
    ]);

    expect(bounds.x[1]).toBeLessThan(1000);
    expect(bounds.y[0]).toBeGreaterThan(-1000);
  });

  it('returns a padded safe box for tiny or empty inputs', () => {
    expect(computeRobustBounds([])).toEqual({ x: [-0.5, 0.5], y: [-0.5, 0.5] });
    const bounds = computeRobustBounds([{ x: 2, y: 3 }]);
    expect(bounds.x[0]).toBeLessThan(2);
    expect(bounds.x[1]).toBeGreaterThan(2);
    expect(bounds.y[0]).toBeLessThan(3);
    expect(bounds.y[1]).toBeGreaterThan(3);
  });
});