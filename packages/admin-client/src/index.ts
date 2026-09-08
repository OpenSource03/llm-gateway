import type { CreateOAuthTokenInput } from "@opensource03/llm-gateway-contracts";
import type {
  ApiEnvelope,
  ApiPage,
  CreateClientKeyInput,
  CreateControlKeyInput,
  CreateRoutingMemberInput,
  CreateRoutingPoolInput,
  CreatedGatewayClientKey,
  CreatedGatewayControlKey,
  GatewayAuditRow,
  GatewayAccountAccessVerification,
  GatewayClientKey,
  GatewayControlKey,
  GatewayExternalTransportProfile,
  GatewayModel,
  GatewayOAuthAttempt,
  GatewayProviderAccount,
  GatewayRequestRow,
  GatewayUsageReport,
  GatewayRoutingPool,
  GatewayStatus,
  LinkExternalProfileInput,
  UpdateAccountInput,
  UpdateModelInput,
  UpdateRoutingMemberInput,
  UpdateRoutingPoolInput,
} from "@opensource03/llm-gateway-contracts";

export interface GatewayActor {
  id: string;
  email?: string;
  name?: string;
}

export interface GatewayAdminClientOptions {
  baseUrl: string;
  apiKey: string | (() => string | Promise<string>);
  actor?: GatewayActor | (() => GatewayActor | Promise<GatewayActor>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class GatewayAdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GatewayAdminApiError";
  }
}

const pathPart = (value: string): string => encodeURIComponent(value);
const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const normalizedControlBaseUrl = (value: string): string => {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Gateway control base URL must be a credential-free HTTP(S) URL",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");

  return url.toString().replace(/\/$/, "");
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length") ?? 0);

  if (declared > MAX_CONTROL_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GatewayAdminApiError(
      "Gateway control response is too large",
      502,
      "CONTROL_RESPONSE_TOO_LARGE",
    );
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel("control response limit exceeded");
        throw new GatewayAdminApiError(
          "Gateway control response is too large",
          502,
          "CONTROL_RESPONSE_TOO_LARGE",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return null;

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
};

export class GatewayAdminClient {
  readonly #baseUrl: string;
  readonly #apiKey: GatewayAdminClientOptions["apiKey"];
  readonly #actor?: GatewayAdminClientOptions["actor"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: GatewayAdminClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new TypeError("Gateway control timeout must be 1-300000ms");
    }
    this.#baseUrl = normalizedControlBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#actor = options.actor;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const apiKey =
      typeof this.#apiKey === "function" ? await this.#apiKey() : this.#apiKey;
    const actor =
      typeof this.#actor === "function" ? await this.#actor() : this.#actor;
    const headers = new Headers(init.headers);

    if (!apiKey || apiKey.trim() !== apiKey || /\s/.test(apiKey)) {
      throw new TypeError("Gateway control key is missing or malformed");
    }

    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    if (actor) {
      headers.set("x-llm-gateway-actor-id", actor.id);
      if (actor.email) headers.set("x-llm-gateway-actor-email", actor.email);
      if (actor.name) headers.set("x-llm-gateway-actor-name", actor.name);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(this.#timeoutMs),
      ]),
    });
    const payload = (await readBoundedJson(response)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;

    if (!response.ok) {
      throw new GatewayAdminApiError(
        payload?.error?.message ?? payload?.message ?? "Gateway request failed",
        response.status,
        payload?.error?.code,
      );
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new GatewayAdminApiError(
        "Gateway returned an invalid control response",
        502,
        "INVALID_CONTROL_RESPONSE",
      );
    }

    return payload as T;
  }

  status = async (): Promise<GatewayStatus> =>
    (await this.#request<ApiEnvelope<GatewayStatus>>("/status")).data;

  listAccounts = async (): Promise<GatewayProviderAccount[]> =>
    (await this.#request<ApiEnvelope<GatewayProviderAccount[]>>("/accounts"))
      .data;

  listExternalProfiles = async (
    provider: string,
    transport = "agent-sdk",
  ): Promise<GatewayExternalTransportProfile[]> => {
    const query = new URLSearchParams({ provider, transport });

    return (
      await this.#request<ApiEnvelope<GatewayExternalTransportProfile[]>>(
        `/accounts/external-profiles?${query}`,
      )
    ).data;
  };

  linkExternalProfile = async (
    input: LinkExternalProfileInput,
  ): Promise<GatewayProviderAccount> =>
    (
      await this.#request<ApiEnvelope<GatewayProviderAccount>>(
        "/accounts/external-profiles",
        { method: "POST", body: JSON.stringify(input) },
      )
    ).data;

  createOAuthToken = async (
    input: CreateOAuthTokenInput,
  ): Promise<GatewayProviderAccount> =>
    (
      await this.#request<ApiEnvelope<GatewayProviderAccount>>(
        "/accounts/oauth-tokens",
        { method: "POST", body: JSON.stringify(input) },
      )
    ).data;

  startOAuth = async (
    provider: string,
    accountId?: string,
  ): Promise<GatewayOAuthAttempt> =>
    (
      await this.#request<ApiEnvelope<GatewayOAuthAttempt>>("/oauth-attempts", {
        method: "POST",
        body: JSON.stringify({ provider, account_id: accountId }),
      })
    ).data;

  getOAuthAttempt = async (id: string): Promise<GatewayOAuthAttempt> =>
    (
      await this.#request<ApiEnvelope<GatewayOAuthAttempt>>(
        `/oauth-attempts/${pathPart(id)}`,
      )
    ).data;

  pollOAuthAttempt = async (id: string): Promise<GatewayOAuthAttempt> =>
    (
      await this.#request<ApiEnvelope<GatewayOAuthAttempt>>(
        `/oauth-attempts/${pathPart(id)}/poll`,
        { method: "POST" },
      )
    ).data;

  completeOAuth = async (
    id: string,
    authorizationCode: string,
  ): Promise<GatewayOAuthAttempt> =>
    (
      await this.#request<ApiEnvelope<GatewayOAuthAttempt>>(
        `/oauth-attempts/${pathPart(id)}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ authorization_code: authorizationCode }),
        },
      )
    ).data;

  updateAccount = async (
    id: string,
    input: UpdateAccountInput,
  ): Promise<GatewayProviderAccount> =>
    (
      await this.#request<ApiEnvelope<GatewayProviderAccount>>(
        `/accounts/${pathPart(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      )
    ).data;

  refreshAccount = async (id: string): Promise<GatewayProviderAccount> =>
    (
      await this.#request<ApiEnvelope<GatewayProviderAccount>>(
        `/accounts/${pathPart(id)}/refresh`,
        { method: "POST" },
      )
    ).data;

  verifyAccountAccess = async (
    id: string,
  ): Promise<GatewayAccountAccessVerification> =>
    (
      await this.#request<ApiEnvelope<GatewayAccountAccessVerification>>(
        `/accounts/${pathPart(id)}/verify-access`,
        { method: "POST" },
      )
    ).data;

  deleteAccount = async (id: string): Promise<GatewayProviderAccount> =>
    (
      await this.#request<ApiEnvelope<GatewayProviderAccount>>(
        `/accounts/${pathPart(id)}`,
        { method: "DELETE" },
      )
    ).data;

  listModels = async (): Promise<GatewayModel[]> =>
    (await this.#request<ApiEnvelope<GatewayModel[]>>("/models")).data;

  refreshModels = async (): Promise<GatewayModel[]> =>
    (
      await this.#request<ApiEnvelope<GatewayModel[]>>("/models/refresh", {
        method: "POST",
      })
    ).data;

  updateModel = async (
    id: string,
    input: UpdateModelInput,
  ): Promise<GatewayModel> =>
    (
      await this.#request<ApiEnvelope<GatewayModel>>(
        `/models/${pathPart(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      )
    ).data;

  listRoutingPools = async (): Promise<GatewayRoutingPool[]> =>
    (await this.#request<ApiEnvelope<GatewayRoutingPool[]>>("/routing-pools"))
      .data;

  createRoutingPool = async (
    input: CreateRoutingPoolInput,
  ): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>("/routing-pools", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).data;

  updateRoutingPool = async (
    id: string,
    input: UpdateRoutingPoolInput,
  ): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>(
        `/routing-pools/${pathPart(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      )
    ).data;

  deleteRoutingPool = async (id: string): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>(
        `/routing-pools/${pathPart(id)}`,
        { method: "DELETE" },
      )
    ).data;

  createRoutingMember = async (
    poolId: string,
    input: CreateRoutingMemberInput,
  ): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>(
        `/routing-pools/${pathPart(poolId)}/members`,
        { method: "POST", body: JSON.stringify(input) },
      )
    ).data;

  updateRoutingMember = async (
    poolId: string,
    memberId: string,
    input: UpdateRoutingMemberInput,
  ): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>(
        `/routing-pools/${pathPart(poolId)}/members/${pathPart(memberId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      )
    ).data;

  deleteRoutingMember = async (
    poolId: string,
    memberId: string,
  ): Promise<GatewayRoutingPool> =>
    (
      await this.#request<ApiEnvelope<GatewayRoutingPool>>(
        `/routing-pools/${pathPart(poolId)}/members/${pathPart(memberId)}`,
        { method: "DELETE" },
      )
    ).data;

  listClientKeys = async (): Promise<GatewayClientKey[]> =>
    (await this.#request<ApiEnvelope<GatewayClientKey[]>>("/client-keys")).data;

  createClientKey = async (
    input: CreateClientKeyInput,
  ): Promise<CreatedGatewayClientKey> =>
    (
      await this.#request<ApiEnvelope<CreatedGatewayClientKey>>(
        "/client-keys",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      )
    ).data;

  revokeClientKey = async (id: string): Promise<GatewayClientKey> =>
    (
      await this.#request<ApiEnvelope<GatewayClientKey>>(
        `/client-keys/${pathPart(id)}`,
        { method: "DELETE" },
      )
    ).data;

  listControlKeys = async (): Promise<GatewayControlKey[]> =>
    (await this.#request<ApiEnvelope<GatewayControlKey[]>>("/control-keys"))
      .data;

  createControlKey = async (
    input: CreateControlKeyInput,
  ): Promise<CreatedGatewayControlKey> =>
    (
      await this.#request<ApiEnvelope<CreatedGatewayControlKey>>(
        "/control-keys",
        { method: "POST", body: JSON.stringify(input) },
      )
    ).data;

  revokeControlKey = async (id: string): Promise<GatewayControlKey> =>
    (
      await this.#request<ApiEnvelope<GatewayControlKey>>(
        `/control-keys/${pathPart(id)}`,
        { method: "DELETE" },
      )
    ).data;

  getUsage = async (
    filters: {
      from?: string;
      to?: string;
      interval?: "hour" | "day";
      provider?: string;
      accountId?: string;
      model?: string;
      clientKeyId?: string;
    } = {},
  ): Promise<GatewayUsageReport> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value)
        query.set(
          key === "accountId"
            ? "account_id"
            : key === "clientKeyId"
              ? "client_key_id"
              : key,
          value,
        );
    }
    return (
      await this.#request<ApiEnvelope<GatewayUsageReport>>(
        `/requests/usage?${query}`,
      )
    ).data;
  };

  listRequests = async (query = ""): Promise<ApiPage<GatewayRequestRow>> =>
    this.#request<ApiPage<GatewayRequestRow>>(`/requests${query}`);

  listAudit = async (query = ""): Promise<ApiPage<GatewayAuditRow>> =>
    this.#request<ApiPage<GatewayAuditRow>>(`/audit${query}`);
}
