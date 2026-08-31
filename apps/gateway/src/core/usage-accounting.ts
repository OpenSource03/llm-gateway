const nonNegativeTokenCount = (value: number | undefined): bigint =>
  BigInt(Math.max(0, Math.trunc(value ?? 0)));

/**
 * Anthropic reports ordinary input, cache reads, and cache creation as
 * separate counters. Daily input limits apply to all three: cached prompt
 * traffic still consumes a shared subscription and must not reopen the
 * conservative reservation after a clean response.
 *
 * When ordinary input usage is missing, keep the original reservation. It is
 * a tokenizer-independent upper bound for the complete prompt, including any
 * cached portion, so adding a partial cache observation would double count it.
 */
export const reconciledBillableInputTokens = (input: {
  reservedInputTokens: bigint;
  inputTokens?: number;
  cachedInputTokens?: number;
}): bigint =>
  input.inputTokens === undefined
    ? input.reservedInputTokens
    : nonNegativeTokenCount(input.inputTokens) +
      nonNegativeTokenCount(input.cachedInputTokens);

/** Combine provider cache-read and cache-creation telemetry safely. */
export const combinedCachedInputTokens = (
  cacheReadInputTokens: number | undefined,
  cacheCreationInputTokens: number | undefined,
): number | undefined => {
  if (
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }

  return Number(
    nonNegativeTokenCount(cacheReadInputTokens) +
      nonNegativeTokenCount(cacheCreationInputTokens),
  );
};

/**
 * Responses reports cached input as a subset of `input_tokens`. Convert that
 * inclusive total to the ordinary-input counter used by gateway accounting.
 */
export const uncachedResponsesInputTokens = (
  totalInputTokens: number | undefined,
  cachedInputTokens: number | undefined,
): number | undefined => {
  if (totalInputTokens === undefined) return undefined;
  const total = nonNegativeTokenCount(totalInputTokens);
  const cached = nonNegativeTokenCount(cachedInputTokens);

  return Number(total > cached ? total - cached : 0n);
};
