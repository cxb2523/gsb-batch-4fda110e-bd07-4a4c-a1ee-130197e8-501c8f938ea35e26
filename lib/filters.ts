export const DENYLIST: RegExp[] = [
  /^Copyright( renewal.*)?$/i,
  /^Wayback Machine$/i,
  /^Wikidata$/i,
];

export interface JunkTitleOptions {
  rejectYearOnly?: boolean;
}

export function isJunkTitle(title: string, options: JunkTitleOptions = {}): boolean {
  const normalized = title.replace(/_/g, ' ').trim();
  if (!normalized) return true;
  if (/\s\(identifier\)$/i.test(normalized)) return true;
  if (DENYLIST.some((pattern) => pattern.test(normalized))) return true;
  return options.rejectYearOnly === true && /^\d{4}$/.test(normalized);
}