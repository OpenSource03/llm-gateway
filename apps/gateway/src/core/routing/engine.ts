import type {
  CandidateEvaluation,
  NormalizedQuotaWindow,
  RoutingMemberCandidate,
  RoutingSelection,
  RoutingSelectionInput,
} from "./types";

const DEFAULT_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_SHORT_RESET_GRACE_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const validRatio = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? clamp01(value) : null;

const quotaThreshold = (member: RoutingMemberCandidate): number =>
  Math.min(
    validRatio(member.maxUsedRatio) ?? 1,
    1 - (validRatio(member.reserveRatio) ?? 0),
  );

const windowUsedRatio = (window: NormalizedQuotaWindow): number | null => {
  const direct = validRatio(window.usedRatio);

  if (direct !== null) return direct;
  if (
    typeof window.remaining === "number" &&
    Number.isFinite(window.remaining) &&
    typeof window.limit === "number" &&
    Number.isFinite(window.limit) &&
    window.limit > 0
  ) {
    return clamp01(1 - window.remaining / window.limit);
  }

  return null;
};

const retryAtForWindow = (window: NormalizedQuotaWindow): Date | null =>
  window.resetAt instanceof Date && Number.isFinite(window.resetAt.getTime())
    ? window.resetAt
    : null;

/** Small deterministic hash: selection must be stable across App Service replicas. */
const stableHash = (value: string): number => {
  let hash = 0x811c9dc5;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
};

const latest = (dates: Array<Date | null>): Date | null => {
  const valid = dates.filter((d): d is Date => d instanceof Date);

  if (valid.length === 0) return null;

  return new Date(Math.max(...valid.map((d) => d.getTime())));
};

const evaluate = (
  member: RoutingMemberCandidate,
  input: RoutingSelectionInput,
  options: { existingSticky: boolean },
): CandidateEvaluation => {
  const reasons: CandidateEvaluation["reasons"] = [];
  const retryDates: Array<Date | null> = [];
  const nowMs = input.now.getTime();

  if (!member.enabled || member.health === "disabled") reasons.push("disabled");
  if (!member.supportsModel) reasons.push("model_unavailable");
  if (member.health === "reauth_required") reasons.push("authentication");

  if (
    member.maxConcurrency !== null &&
    member.activeConcurrency >= member.maxConcurrency
  ) {
    reasons.push("concurrency");
    retryDates.push(new Date(nowMs + 1_000));
  }
  if (
    member.dailyRequestCap !== null &&
    member.requestsLast24h >= member.dailyRequestCap
  ) {
    reasons.push("daily_request_cap");
  }
  if (
    member.dailyInputTokenCap !== null &&
    member.inputTokensLast24h + (input.estimatedInputTokens ?? 0) >
      member.dailyInputTokenCap
  ) {
    reasons.push("daily_input_cap");
  }
  if (
    member.dailyOutputTokenCap !== null &&
    member.outputTokensLast24h + (input.estimatedOutputTokens ?? 0) >
      member.dailyOutputTokenCap
  ) {
    reasons.push("daily_output_cap");
  }
  // Compare the pre-dispatch share and allow equality. That is a deliberate
  // one-request deficit-scheduling tolerance: an exact 50/50 pool can accept
  // its next discrete request, then the over-share member becomes ineligible
  // until its peers catch up.
  if (
    member.maxTrafficShareBps !== null &&
    member.trafficShareBps > member.maxTrafficShareBps
  ) {
    reasons.push("traffic_share");
  }

  if (member.cooldownUntil && member.cooldownUntil.getTime() > nowMs) {
    reasons.push("cooldown");
    retryDates.push(member.cooldownUntil);
  }

  const quotaMaxAgeMs = input.quotaMaxAgeMs ?? DEFAULT_QUOTA_MAX_AGE_MS;
  const quotaAge = member.quotaObservedAt
    ? nowMs - member.quotaObservedAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (!options.existingSticky) {
    if (!member.quotaObservedAt || member.quotaWindows.length === 0) {
      reasons.push("quota_unknown");
    } else if (quotaAge > quotaMaxAgeMs) {
      reasons.push("quota_stale");
    }
  }

  const threshold = quotaThreshold(member);
  const usedRatios: number[] = [];
  const sustainable: number[] = [];

  for (const window of member.quotaWindows) {
    const usedRatio = windowUsedRatio(window);

    if (usedRatio !== null) usedRatios.push(usedRatio);
    const exhausted =
      window.allowed === false ||
      window.limitReached === true ||
      (usedRatio !== null && usedRatio >= threshold);

    if (exhausted) {
      reasons.push("quota_exhausted");
      retryDates.push(retryAtForWindow(window));
      continue;
    }

    if (usedRatio !== null) {
      let headroom = Math.max(0, threshold - usedRatio);

      if (
        typeof window.limit === "number" &&
        window.limit > 0 &&
        typeof input.estimatedInputTokens === "number"
      ) {
        headroom = Math.max(
          0,
          headroom - input.estimatedInputTokens / window.limit,
        );
      }
      const hoursToReset = window.resetAt
        ? Math.max((window.resetAt.getTime() - nowMs) / HOUR_MS, 1 / 60)
        : 1;

      sustainable.push(headroom / hoursToReset);
    }
  }

  return {
    accountId: member.accountId,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    retryAt: latest(retryDates),
    bindingUsedRatio: usedRatios.length > 0 ? Math.max(...usedRatios) : 1,
    sustainableHeadroom: sustainable.length > 0 ? Math.min(...sustainable) : 0,
  };
};

const weightedPick = (
  members: RoutingMemberCandidate[],
  requestKey: string,
): RoutingMemberCandidate => {
  const total = members.reduce(
    (sum, member) => sum + Math.max(1, member.weight),
    0,
  );
  let point = stableHash(requestKey) % total;

  for (const member of members) {
    point -= Math.max(1, member.weight);
    if (point < 0) return member;
  }

  return members[members.length - 1]!;
};

const choose = (
  input: RoutingSelectionInput,
  eligibleMembers: RoutingMemberCandidate[],
  evaluations: Map<string, CandidateEvaluation>,
): RoutingMemberCandidate => {
  const deterministic = [...eligibleMembers].sort((a, b) =>
    a.accountId.localeCompare(b.accountId),
  );

  if (input.policy === "weighted_share") {
    return weightedPick(deterministic, `${input.modelId}:${input.requestKey}`);
  }

  if (input.policy === "priority_failover") {
    const bestPriority = Math.min(...deterministic.map((m) => m.priority));
    const tier = deterministic.filter((m) => m.priority === bestPriority);

    return weightedPick(tier, `${input.modelId}:${input.requestKey}`);
  }

  if (input.policy === "least_utilized") {
    return deterministic.sort((a, b) => {
      const ae = evaluations.get(a.accountId)!;
      const be = evaluations.get(b.accountId)!;
      const utilization = ae.bindingUsedRatio - be.bindingUsedRatio;

      if (utilization !== 0) return utilization;
      if (a.weight !== b.weight) return b.weight - a.weight;

      return a.accountId.localeCompare(b.accountId);
    })[0]!;
  }

  return deterministic.sort((a, b) => {
    const ae = evaluations.get(a.accountId)!;
    const be = evaluations.get(b.accountId)!;
    const scoreA = ae.sustainableHeadroom * Math.max(1, a.weight);
    const scoreB = be.sustainableHeadroom * Math.max(1, b.weight);

    if (scoreA !== scoreB) return scoreB - scoreA;

    return a.accountId.localeCompare(b.accountId);
  })[0]!;
};

/**
 * Select an account without performing I/O. A caller must acquire distributed
 * account/client concurrency leases after selection and rerun selection if a
 * competing replica filled the selected slot.
 */
export const selectRoutingAccount = (
  input: RoutingSelectionInput,
): RoutingSelection => {
  const evaluations = new Map<string, CandidateEvaluation>();

  for (const member of input.members) {
    evaluations.set(
      member.accountId,
      evaluate(member, input, {
        existingSticky: member.accountId === input.stickyAccountId,
      }),
    );
  }

  const sticky = input.stickyAccountId
    ? input.members.find((member) => member.accountId === input.stickyAccountId)
    : undefined;

  if (sticky) {
    const stickyEvaluation = evaluations.get(sticky.accountId)!;
    const hardMigrationReasons = new Set([
      "disabled",
      "model_unavailable",
      "authentication",
      "daily_request_cap",
      "daily_input_cap",
      "daily_output_cap",
      "traffic_share",
    ]);
    const mustMigrate = stickyEvaluation.reasons.some((reason) =>
      hardMigrationReasons.has(reason),
    );

    if (!mustMigrate && stickyEvaluation.reasons.length === 0) {
      return {
        kind: "selected",
        accountId: sticky.accountId,
        sticky: true,
        evaluations: [...evaluations.values()],
      };
    }

    if (!mustMigrate && stickyEvaluation.retryAt) {
      const graceMs = input.shortResetGraceMs ?? DEFAULT_SHORT_RESET_GRACE_MS;

      if (stickyEvaluation.retryAt.getTime() - input.now.getTime() <= graceMs) {
        return {
          kind: "hold",
          accountId: sticky.accountId,
          retryAt: stickyEvaluation.retryAt,
          evaluations: [...evaluations.values()],
        };
      }
    }
  }

  const eligible = input.members.filter(
    (member) => evaluations.get(member.accountId)?.eligible,
  );

  if (eligible.length > 0) {
    const selected = choose(input, eligible, evaluations);

    return {
      kind: "selected",
      accountId: selected.accountId,
      sticky: false,
      evaluations: [...evaluations.values()],
    };
  }

  const allReasons = [...evaluations.values()].flatMap((e) => e.reasons);
  const quotaOnly = allReasons.some((reason) =>
    ["quota_exhausted", "quota_stale", "quota_unknown", "cooldown"].includes(
      reason,
    ),
  );
  const capacityOnly = allReasons.some((reason) =>
    [
      "concurrency",
      "daily_request_cap",
      "daily_input_cap",
      "daily_output_cap",
      "traffic_share",
    ].includes(reason),
  );
  const retryTimes = [...evaluations.values()]
    .map((e) => e.retryAt)
    .filter((date): date is Date => date instanceof Date);
  let reason: "accounts" | "capacity" | "quota" = "accounts";

  if (quotaOnly) reason = "quota";
  else if (capacityOnly) reason = "capacity";

  return {
    kind: "unavailable",
    reason,
    retryAt:
      retryTimes.length > 0
        ? new Date(Math.min(...retryTimes.map((date) => date.getTime())))
        : null,
    evaluations: [...evaluations.values()],
  };
};
