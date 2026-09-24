/**
 * What a file's diff looked like when the reader marked it viewed. `version` fingerprints the
 * loaded patch; `stat` (`additions:deletions`) stands in while a lazily loaded patch is still a
 * placeholder. Either is null when it was unknown at the time.
 */
export interface DiffViewedMark {
  readonly version: number | null;
  readonly stat: string | null;
}

export function diffViewedStat(stat: { additions: number; deletions: number } | undefined) {
  return stat ? `${stat.additions}:${stat.deletions}` : null;
}

/**
 * A mark holds only while the file's diff is unchanged, so new work on a viewed file brings it
 * back for review. The patch fingerprint wins when both sides have one.
 */
export function isDiffFileViewed(
  mark: DiffViewedMark | undefined,
  current: DiffViewedMark,
): boolean {
  if (!mark) return false;
  if (mark.version !== null && current.version !== null) return mark.version === current.version;
  return mark.stat !== null && mark.stat === current.stat;
}
