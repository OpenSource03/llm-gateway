const streamExplanations: Record<string, string> = {
  ClientStreamCancelled:
    "The client connection closed before completion. This may be a cancellation or disconnect; it does not establish a provider failure.",
  UpstreamStreamError: "The provider sent an explicit failure event.",
  UpstreamStreamTruncated:
    "The provider stream ended without a completion event.",
  UpstreamTransportError:
    "Reading the provider stream failed before completion.",
  GatewayStreamDeadline:
    "The gateway request deadline expired before completion.",
  GatewayLeaseLostError:
    "The gateway lost its concurrency lease before completion.",
  GatewayStreamAborted:
    "The stream was aborted before completion; the source was not identified.",
};

export const explainRequestHistory = (
  outcome: string,
  errorClass: string | null,
) => ({
  tokenUsageBasis:
    outcome === "stream_error"
      ? ("conservative_reservation" as const)
      : ("accounted" as const),
  outcomeExplanation:
    outcome === "stream_error"
      ? errorClass && Object.hasOwn(streamExplanations, errorClass)
        ? streamExplanations[errorClass]!
        : "The gateway recorded an interrupted stream without a specific cause. Older records can include a client closing after completion; these cannot be distinguished retrospectively."
      : null,
  tokenUsageExplanation:
    outcome === "stream_error"
      ? "Actual provider usage is unknown. These counts are conservative reservations retained for gateway limits, not measured consumption or a provider bill."
      : "Accounted tokens include cached input. Provider usage replaces conservative reservations when available; older records do not distinguish missing-usage estimates.",
});
