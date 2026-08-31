import type {
  ControlScope,
  CreateControlKeyInput,
  CreatedGatewayControlKey,
  GatewayControlKey,
} from "@opensource03/llm-gateway-contracts";
import { controlScopes } from "@opensource03/llm-gateway-contracts";

import ipaddr from "ipaddr.js";

import { llmGatewayPrisma } from "../core/db";
import { GatewayError } from "../core/errors";
import {
  createControlSecret,
  isControlSecret,
} from "../core/security/control-secrets";
import { constantTimeHexEqual, sha256Hex } from "../core/security/secrets";

const DAY_MS = 24 * 60 * 60 * 1_000;
const LAST_USED_THROTTLE_MS = 60_000;
const CONTROL_SCOPES = new Set<string>(controlScopes);

type ControlKeyRecord = {
  id: string;
  name: string;
  ownerLabel: string;
  keyPrefix: string;
  scopes: string[];
  allowedCidrs: string[];
  canDelegateActors: boolean;
  enabled: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

const statusOf = (key: ControlKeyRecord): GatewayControlKey["status"] =>
  key.revokedAt
    ? "revoked"
    : key.expiresAt && key.expiresAt <= new Date()
      ? "expired"
      : key.enabled
        ? "active"
        : "disabled";

const toRow = (key: ControlKeyRecord): GatewayControlKey => ({
  id: key.id,
  name: key.name,
  ownerLabel: key.ownerLabel,
  keyPrefix: key.keyPrefix,
  scopes: key.scopes as ControlScope[],
  allowedCidrs: key.allowedCidrs,
  canDelegateActors: key.canDelegateActors,
  status: statusOf(key),
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  expiresAt: key.expiresAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
});

const normalizeCidr = (value: string): string => {
  const [address, prefixText] = value.split("/");
  const parsed = ipaddr.parse(address!);
  const maximumPrefix = parsed.kind() === "ipv4" ? 32 : 128;
  const prefix = prefixText === undefined ? maximumPrefix : Number(prefixText);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    throw new GatewayError(
      `Invalid control-key CIDR: ${value}`,
      400,
      "INVALID_CIDR",
    );
  }

  return `${parsed.toNormalizedString()}/${prefix}`;
};

const addressAllowed = (address: string, cidrs: readonly string[]): boolean => {
  if (cidrs.length === 0) return true;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;

  try {
    parsed = ipaddr.process(
      address.startsWith("ip:") ? address.slice(3) : address,
    );
  } catch {
    return false;
  }

  return cidrs.some((cidr) => {
    const [network, prefix] = ipaddr.parseCIDR(cidr);
    const normalizedNetwork = ipaddr.process(network.toString());

    return (
      parsed.kind() === normalizedNetwork.kind() &&
      parsed.match(normalizedNetwork, prefix)
    );
  });
};

export interface AuthenticatedControlKey {
  id: string;
  name: string;
  ownerLabel: string;
  scopes: ReadonlySet<string>;
  canDelegateActors: boolean;
}

export const listControlKeys = async (): Promise<GatewayControlKey[]> =>
  (
    await llmGatewayPrisma.gatewayControlKey.findMany({
      orderBy: { createdAt: "desc" },
    })
  ).map(toRow);

export const createControlKey = async (
  createdByActorId: string | null,
  input: CreateControlKeyInput,
): Promise<CreatedGatewayControlKey> => {
  const generated = createControlSecret();
  const allowedCidrs = [...new Set(input.allowed_cidrs.map(normalizeCidr))];
  const scopes = [...new Set(input.scopes)];

  if (scopes.some((scope) => !CONTROL_SCOPES.has(scope))) {
    throw new GatewayError(
      "Unknown control scope",
      400,
      "INVALID_CONTROL_SCOPE",
    );
  }
  const created = await llmGatewayPrisma.gatewayControlKey.create({
    data: {
      name: input.name,
      ownerLabel: input.owner_label,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      scopes,
      allowedCidrs,
      canDelegateActors: input.can_delegate_actors,
      expiresAt: input.expires_in_days
        ? new Date(Date.now() + input.expires_in_days * DAY_MS)
        : null,
      createdByActorId,
    },
  });

  return { ...toRow(created), key: generated.secret };
};

const isTransactionConflict = (error: unknown): boolean => {
  let current = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;

    if (
      record.code === "P2034" ||
      record.kind === "TransactionWriteConflict" ||
      record.originalCode === "40001"
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
};

export const revokeControlKey = async (
  id: string,
): Promise<GatewayControlKey> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const revoked = await llmGatewayPrisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('llm-gateway-control-key-revocation'))`;
          const existing = await transaction.gatewayControlKey.findUnique({
            where: { id },
          });

          if (!existing) {
            throw new GatewayError("Control key not found", 404, "NOT_FOUND");
          }
          if (existing.revokedAt) return existing;
          const activeCount = await transaction.gatewayControlKey.count({
            where: {
              enabled: true,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          });

          if (activeCount <= 1) {
            throw new GatewayError(
              "Create another active control key before revoking the last one",
              409,
              "LAST_CONTROL_KEY",
            );
          }

          return transaction.gatewayControlKey.update({
            where: { id },
            data: { enabled: false, revokedAt: new Date() },
          });
        },
        { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
      );

      return toRow(revoked);
    } catch (error) {
      if (attempt === 3 || !isTransactionConflict(error)) throw error;
    }
  }

  throw new Error("Unreachable control-key revocation state");
};

export const authenticateControlKey = async (
  presented: string,
  clientAddress: string,
): Promise<AuthenticatedControlKey> => {
  if (!isControlSecret(presented)) {
    throw new GatewayError("Invalid control key", 401, "INVALID_CONTROL_KEY");
  }
  const hash = sha256Hex(presented);
  const key = await llmGatewayPrisma.gatewayControlKey.findUnique({
    where: { keyHash: hash },
  });

  if (!key || !constantTimeHexEqual(key.keyHash, hash)) {
    throw new GatewayError("Invalid control key", 401, "INVALID_CONTROL_KEY");
  }
  if (!key.enabled || key.revokedAt) {
    throw new GatewayError("Control key revoked", 401, "CONTROL_KEY_REVOKED");
  }
  if (key.expiresAt && key.expiresAt <= new Date()) {
    throw new GatewayError("Control key expired", 401, "CONTROL_KEY_EXPIRED");
  }
  if (!addressAllowed(clientAddress, key.allowedCidrs)) {
    throw new GatewayError(
      "Control key is not allowed from this address",
      403,
      "CONTROL_KEY_ADDRESS_DENIED",
    );
  }
  if (
    !key.lastUsedAt ||
    Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS
  ) {
    void llmGatewayPrisma.gatewayControlKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    id: key.id,
    name: key.name,
    ownerLabel: key.ownerLabel,
    scopes: new Set(key.scopes),
    canDelegateActors: key.canDelegateActors,
  };
};
