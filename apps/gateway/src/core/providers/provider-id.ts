import type { ProviderId } from "./types";

export type DbProvider = string;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

const assertProviderId = (provider: string): void => {
  if (!PROVIDER_ID.test(provider)) {
    throw new TypeError(`Invalid provider id: ${provider}`);
  }
};

export const toDbProvider = (provider: ProviderId): DbProvider => {
  assertProviderId(provider);

  return provider.toUpperCase();
};

export const fromDbProvider = (provider: DbProvider): ProviderId => {
  const normalized = provider.toLowerCase();

  assertProviderId(normalized);

  return normalized;
};
