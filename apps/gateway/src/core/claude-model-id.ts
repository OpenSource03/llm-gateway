const ROUTED_ALIAS_PREFIX = "claude-llmgw-";
const LEGACY_ROUTED_ALIAS_PREFIX = "claude-arcademy-";
const ROUTED_ALIAS_SEPARATOR = "--";
const ONE_MILLION_SUFFIX = "[1m]";
const MAX_PUBLIC_MODEL_ID_BYTES = 1_024;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_MODEL_ID = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;

const encodeModelId = (modelId: string): string =>
  modelId.replaceAll("~", "~t").replaceAll("/", "~s");

const decodeModelId = (encoded: string): string => {
  let decoded = "";

  for (let index = 0; index < encoded.length; index += 1) {
    const current = encoded[index];

    if (current === "~" && index + 1 < encoded.length) {
      const escape = encoded[index + 1];

      if (escape === "s" || escape === "t") {
        decoded += escape === "s" ? "/" : "~";
        index += 1;
        continue;
      }
    }
    decoded += current;
  }

  return decoded;
};

const withContextMarker = (id: string, contextWindow: number | null): string =>
  contextWindow !== null && contextWindow >= 1_000_000
    ? `${id}${ONE_MILLION_SUFFIX}`
    : id;

/** Public Claude Code selector for one canonical gateway model. */
export function claudeCodeModelId(input: {
  contextWindow: number | null;
  provider: string;
  publicModelId: string;
  upstreamModelId: string;
}): string {
  const provider = input.provider.toLowerCase();
  const providerPrefix = `${provider}/`;
  const canonicalModelId = input.publicModelId.startsWith(providerPrefix)
    ? input.publicModelId.slice(providerPrefix.length)
    : input.publicModelId;
  const base =
    input.provider === "ANTHROPIC" &&
    input.upstreamModelId.startsWith("claude-")
      ? input.upstreamModelId
      : `${ROUTED_ALIAS_PREFIX}${provider}${ROUTED_ALIAS_SEPARATOR}${encodeModelId(canonicalModelId)}`;

  return withContextMarker(base, input.contextWindow);
}

/** Decode only aliases minted by {@link claudeCodeModelId}. */
export function canonicalGatewayModelIdFromClaudeCode(
  requestedId: string,
): string | null {
  const withoutMarker = requestedId.replace(/\[1m\]$/i, "");

  const routedPrefix = withoutMarker.startsWith(ROUTED_ALIAS_PREFIX)
    ? ROUTED_ALIAS_PREFIX
    : withoutMarker.startsWith(LEGACY_ROUTED_ALIAS_PREFIX)
      ? LEGACY_ROUTED_ALIAS_PREFIX
      : null;

  if (!routedPrefix) {
    return /^claude-[a-z0-9][a-z0-9._-]*$/i.test(withoutMarker)
      ? `anthropic/${withoutMarker}`
      : null;
  }
  const encoded = withoutMarker.slice(routedPrefix.length);
  const separator = encoded.indexOf(ROUTED_ALIAS_SEPARATOR);

  if (separator <= 0) return null;
  const provider = encoded.slice(0, separator);
  const encodedModelId = encoded.slice(
    separator + ROUTED_ALIAS_SEPARATOR.length,
  );
  const modelId = decodeModelId(encodedModelId);

  if (
    !PROVIDER_ID.test(provider) ||
    !modelId ||
    !SAFE_MODEL_ID.test(modelId) ||
    Buffer.byteLength(`${provider}/${modelId}`, "utf8") >
      MAX_PUBLIC_MODEL_ID_BYTES ||
    encodeModelId(modelId) !== encodedModelId
  ) {
    return null;
  }

  return `${provider}/${modelId}`;
}
