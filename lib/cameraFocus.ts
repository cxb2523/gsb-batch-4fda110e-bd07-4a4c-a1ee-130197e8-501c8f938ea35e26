interface DisplayCoordinates {
  x?: number;
  y?: number;
}

export function getFocusCameraTarget(display: DisplayCoordinates | null | undefined): { x: number; y: number } | null {
  const x = display?.x;
  const y = display?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x as number, y: y as number };
}