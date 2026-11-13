export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBounds {
  x: [number, number];
  y: [number, number];
}

export interface RobustBoundsOptions {
  lowPct?: number;
  highPct?: number;
  padRatio?: number;
}

function percentile(values: number[], fraction: number): number {
  const rawIndex = (values.length - 1) * fraction;
  const index = fraction < 0.5 ? Math.ceil(rawIndex) : Math.floor(rawIndex);
  return values[Math.min(values.length - 1, index)];
}

export function computeRobustBounds(
  points: LayoutPoint[],
  { lowPct = 0.03, highPct = 0.97, padRatio = 0.15 }: RobustBoundsOptions = {},
): LayoutBounds {
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const source = finitePoints.length > 0 ? finitePoints : [{ x: 0, y: 0 }];
  const xs = source.map((point) => point.x).sort((left, right) => left - right);
  const ys = source.map((point) => point.y).sort((left, right) => left - right);
  const low = Math.max(0, Math.min(1, lowPct));
  const high = Math.max(low, Math.min(1, highPct));
  const rawX = [percentile(xs, low), percentile(xs, high)] as [number, number];
  const rawY = [percentile(ys, low), percentile(ys, high)] as [number, number];
  const pad = (range: number) => Math.max(Math.abs(range) * Math.max(0, padRatio), 0.5);
  const xPad = pad(rawX[1] - rawX[0]);
  const yPad = pad(rawY[1] - rawY[0]);

  return {
    x: [rawX[0] - xPad, rawX[1] + xPad],
    y: [rawY[0] - yPad, rawY[1] + yPad],
  };
}