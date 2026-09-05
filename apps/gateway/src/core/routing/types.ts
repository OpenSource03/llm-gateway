export type GatewayProvider = string;

export type RoutingPolicy =
  "quota_balanced" | "weighted_share" | "least_utilized" | "priority_failover";

export type AccountHealth =
  "healthy" | "degraded" | "reauth_required" | "disabled";

export interface NormalizedQuotaWindow {
  /** Stable provider meter/window key, for example `chat:5h`. */
  id: string;
  /** Fraction consumed in the inclusive range 0..1. */
  usedRatio: number | null;
  /** Absolute units when the provider reports them. */
  remaining?: number | null;
  limit?: number | null;
  resetAt?: Date | null;
  allowed?: boolean | null;
  limitReached?: boolean | null;
}

export interface RoutingMemberCandidate {
  accountId: string;
  provider: GatewayProvider;
  enabled: boolean;
  supportsModel: boolean;
  health: AccountHealth;
  weight: number;
  priority: number;
  maxConcurrency: number | null;
  activeConcurrency: number;
  dailyRequestCap: number | null;
  dailyInputTokenCap: number | null;
  dailyOutputTokenCap: number | null;
  requestsLast24h: number;
  inputTokensLast24h: number;
  outputTokensLast24h: number;
  /** Optional hard share ceiling, in basis points (10_000 = 100%). */
  maxTrafficShareBps: number | null;
  trafficShareBps: number;
  /** Maximum fraction that may be consumed; defaults to 1. */
  maxUsedRatio: number | null;
  /** Fraction to leave untouched; defaults to 0. */
  reserveRatio: number | null;
  quotaObservedAt: Date | null;
  quotaWindows: NormalizedQuotaWindow[];
  cooldownUntil: Date | null;
}

export interface RoutingSelectionInput {
  policy: RoutingPolicy;
  members: RoutingMemberCandidate[];
  now: Date;
  modelId: string;
  requestKey: string;
  stickyAccountId?: string | null;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  quotaMaxAgeMs?: number;
  shortResetGraceMs?: number;
}

export type IneligibilityReason =
  | "disabled"
  | "model_unavailable"
  | "authentication"
  | "concurrency"
  | "daily_request_cap"
  | "daily_input_cap"
  | "daily_output_cap"
  | "traffic_share"
  | "quota_unknown"
  | "quota_stale"
  | "quota_exhausted"
  | "cooldown";

export interface CandidateEvaluation {
  accountId: string;
  eligible: boolean;
  reasons: IneligibilityReason[];
  retryAt: Date | null;
  bindingUsedRatio: number;
  sustainableHeadroom: number;
}

export type RoutingSelection =
  | {
      kind: "selected";
      accountId: string;
      sticky: boolean;
      evaluations: CandidateEvaluation[];
    }
  | {
      /** Preserve the sticky account and ask the client to retry after a short reset. */
      kind: "hold";
      accountId: string;
      retryAt: Date;
      evaluations: CandidateEvaluation[];
    }
  | {
      kind: "unavailable";
      reason: "quota_exhausted" | "quota" | "capacity" | "accounts";
      retryAt: Date | null;
      evaluations: CandidateEvaluation[];
    };
