export interface QuotaGenerationRow {
  observedAt: Date;
  source: string;
}

/**
 * A provider poll is a complete snapshot, so response-header observations
 * older than the newest poll are superseded: a window the provider stopped
 * reporting (or renamed) must not linger. Newer headers still apply.
 */
export const withoutSupersededHeaderQuota = <T extends QuotaGenerationRow>(
  snapshots: T[],
): T[] => {
  const latestPollAt = snapshots.reduce<number | null>(
    (latest, snapshot) =>
      snapshot.source === "POLL"
        ? Math.max(
            latest ?? Number.NEGATIVE_INFINITY,
            snapshot.observedAt.getTime(),
          )
        : latest,
    null,
  );

  return latestPollAt === null
    ? snapshots
    : snapshots.filter(
        (snapshot) =>
          snapshot.source !== "RESPONSE_HEADER" ||
          snapshot.observedAt.getTime() >= latestPollAt,
      );
};
