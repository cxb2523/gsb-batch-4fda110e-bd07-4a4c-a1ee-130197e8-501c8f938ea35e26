export function toDisplayProgress(isLoading: boolean, ratio: number): number {
  if (!isLoading) return 0;
  if (Number.isNaN(ratio)) return 0.05;
  return Math.min(1, Math.max(0.05, ratio));
}