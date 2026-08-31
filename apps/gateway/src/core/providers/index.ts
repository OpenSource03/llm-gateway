import type { ProviderId, SubscriptionProviderAdapter } from "./types";

import { anthropicProviderAdapter } from "./anthropic";
import { openAICodexProviderAdapter } from "./openai-codex";
import { toDbProvider } from "./provider-id";
import { xaiProviderAdapter } from "./xai";

const PROVIDER_ADAPTERS = new Map<string, SubscriptionProviderAdapter>();

for (const adapter of [
  anthropicProviderAdapter,
  openAICodexProviderAdapter,
  xaiProviderAdapter,
]) {
  toDbProvider(adapter.id);
  if (PROVIDER_ADAPTERS.has(adapter.id)) {
    throw new TypeError(`Duplicate provider adapter: ${adapter.id}`);
  }
  PROVIDER_ADAPTERS.set(adapter.id, adapter);
}

export const listProviderAdapters = (): SubscriptionProviderAdapter[] => [
  ...PROVIDER_ADAPTERS.values(),
];

export function getProviderAdapter(
  provider: ProviderId,
): SubscriptionProviderAdapter {
  const adapter = PROVIDER_ADAPTERS.get(provider);

  if (!adapter) throw new TypeError(`Unsupported provider: ${provider}`);

  return adapter;
}

export * from "./anthropic";
export * from "./claude-code-cch";
export * from "./claude-code-wire";
export * from "./openai-codex";
export * from "./pkce";
export * from "./provider-id";
export * from "./shared";
export * from "./types";
export * from "./xai";
