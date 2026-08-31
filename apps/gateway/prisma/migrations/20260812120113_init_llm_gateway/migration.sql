-- CreateEnum
CREATE TYPE "GatewayProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'XAI');

-- CreateEnum
CREATE TYPE "GatewayAccountStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "GatewayOAuthFlow" AS ENUM ('AUTHORIZATION_CODE', 'DEVICE_CODE');

-- CreateEnum
CREATE TYPE "GatewayOAuthAttemptStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'FAILED', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "GatewayRoutingPolicy" AS ENUM ('QUOTA_BALANCED', 'WEIGHTED_SHARE', 'LEAST_UTILIZED', 'PRIORITY_FAILOVER');

-- CreateEnum
CREATE TYPE "GatewayQuotaSource" AS ENUM ('POLL', 'RESPONSE_HEADER');

-- CreateEnum
CREATE TYPE "GatewayUsageScope" AS ENUM ('ACCOUNT', 'CLIENT_KEY', 'ROUTING_POOL');

-- CreateEnum
CREATE TYPE "GatewayLeaseKind" AS ENUM ('TOKEN_REFRESH', 'MODEL_DISCOVERY', 'QUOTA_REFRESH', 'ACCOUNT_CONCURRENCY', 'CLIENT_CONCURRENCY', 'HOUSEKEEPING');

-- CreateTable
CREATE TABLE "GatewayProviderAccount" (
    "id" TEXT NOT NULL,
    "provider" "GatewayProvider" NOT NULL,
    "identityKey" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "externalWorkspaceId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "workspaceName" TEXT,
    "planType" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "GatewayAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "healthReason" TEXT,
    "maxConcurrency" INTEGER,
    "dailyRequestCap" INTEGER,
    "dailyInputTokenCap" BIGINT,
    "dailyOutputTokenCap" BIGINT,
    "cooldownUntil" TIMESTAMP(3),
    "lastAuthenticatedAt" TIMESTAMP(3),
    "lastSuccessfulRequestAt" TIMESTAMP(3),
    "lastQuotaRefreshAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayProviderCredential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "keyVaultKeyId" TEXT NOT NULL,
    "encryptionAlgorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM+RSA-OAEP-256',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayOAuthAttempt" (
    "id" TEXT NOT NULL,
    "provider" "GatewayProvider" NOT NULL,
    "flow" "GatewayOAuthFlow" NOT NULL,
    "status" "GatewayOAuthAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "stateHash" TEXT,
    "pollSecretHash" TEXT,
    "verificationUri" TEXT,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "keyVaultKeyId" TEXT NOT NULL,
    "encryptionAlgorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM+RSA-OAEP-256',
    "createdByAdminId" TEXT NOT NULL,
    "pollingIntervalSeconds" INTEGER,
    "nextPollAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayOAuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayModel" (
    "id" TEXT NOT NULL,
    "provider" "GatewayProvider" NOT NULL,
    "upstreamModelId" TEXT NOT NULL,
    "publicModelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "contextWindow" INTEGER,
    "maxOutputTokens" INTEGER,
    "capabilities" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "catalogSource" TEXT NOT NULL,
    "catalogVersion" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAfter" TIMESTAMP(3),
    "routingPoolId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayModelAlias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayModelAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayAccountModel" (
    "accountId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "unavailableReason" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayAccountModel_pkey" PRIMARY KEY ("accountId","modelId")
);

-- CreateTable
CREATE TABLE "GatewayRoutingPool" (
    "id" TEXT NOT NULL,
    "provider" "GatewayProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "policy" "GatewayRoutingPolicy" NOT NULL DEFAULT 'QUOTA_BALANCED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stickySessions" BOOLEAN NOT NULL DEFAULT true,
    "sessionTtlSeconds" INTEGER NOT NULL DEFAULT 604800,
    "shortResetGraceSeconds" INTEGER NOT NULL DEFAULT 900,
    "quotaMaxAgeSeconds" INTEGER NOT NULL DEFAULT 900,
    "quotaPollIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayRoutingPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayRoutingPoolMember" (
    "id" TEXT NOT NULL,
    "routingPoolId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "maxConcurrency" INTEGER,
    "dailyRequestCap" INTEGER,
    "dailyInputTokenCap" BIGINT,
    "dailyOutputTokenCap" BIGINT,
    "maxTrafficShareBps" INTEGER,
    "quotaRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayRoutingPoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayClientKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerLabel" TEXT NOT NULL,
    "ownerEmail" TEXT,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowAllModels" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrency" INTEGER,
    "dailyRequestCap" INTEGER,
    "dailyInputTokenCap" BIGINT,
    "dailyOutputTokenCap" BIGINT,
    "createdByAdminId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayClientKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayClientKeyModel" (
    "clientKeyId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayClientKeyModel_pkey" PRIMARY KEY ("clientKeyId","modelId")
);

-- CreateTable
CREATE TABLE "GatewaySessionRoute" (
    "id" TEXT NOT NULL,
    "clientKeyId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "routingPoolId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewaySessionRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayQuotaSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "modelId" TEXT,
    "meterKey" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "used" DOUBLE PRECISION,
    "remaining" DOUBLE PRECISION,
    "limit" DOUBLE PRECISION,
    "utilizationBps" INTEGER,
    "resetAt" TIMESTAMP(3),
    "source" "GatewayQuotaSource" NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayQuotaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayRequestLog" (
    "id" TEXT NOT NULL,
    "clientKeyId" TEXT NOT NULL,
    "accountId" TEXT,
    "provider" "GatewayProvider",
    "publicModelId" TEXT NOT NULL,
    "upstreamModelId" TEXT,
    "routingPolicy" "GatewayRoutingPolicy",
    "sessionHash" TEXT,
    "statusCode" INTEGER,
    "outcome" TEXT NOT NULL,
    "errorClass" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "inputTokens" BIGINT,
    "outputTokens" BIGINT,
    "cachedInputTokens" BIGINT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GatewayRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayUsageBucket" (
    "id" BIGSERIAL NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "scopeType" "GatewayUsageScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '*',
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cachedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayUsageBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayLease" (
    "leaseKey" TEXT NOT NULL,
    "kind" "GatewayLeaseKind" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayLease_pkey" PRIMARY KEY ("leaseKey")
);

-- CreateTable
CREATE TABLE "GatewayAdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "status" INTEGER NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayAdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GatewayProviderAccount_provider_enabled_status_idx" ON "GatewayProviderAccount"("provider", "enabled", "status");

-- CreateIndex
CREATE INDEX "GatewayProviderAccount_cooldownUntil_idx" ON "GatewayProviderAccount"("cooldownUntil");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayProviderAccount_provider_identityKey_key" ON "GatewayProviderAccount"("provider", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayProviderCredential_accountId_key" ON "GatewayProviderCredential"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayOAuthAttempt_stateHash_key" ON "GatewayOAuthAttempt"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayOAuthAttempt_pollSecretHash_key" ON "GatewayOAuthAttempt"("pollSecretHash");

-- CreateIndex
CREATE INDEX "GatewayOAuthAttempt_createdByAdminId_status_idx" ON "GatewayOAuthAttempt"("createdByAdminId", "status");

-- CreateIndex
CREATE INDEX "GatewayOAuthAttempt_status_expiresAt_idx" ON "GatewayOAuthAttempt"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayModel_publicModelId_key" ON "GatewayModel"("publicModelId");

-- CreateIndex
CREATE INDEX "GatewayModel_provider_enabled_idx" ON "GatewayModel"("provider", "enabled");

-- CreateIndex
CREATE INDEX "GatewayModel_routingPoolId_idx" ON "GatewayModel"("routingPoolId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayModel_provider_upstreamModelId_key" ON "GatewayModel"("provider", "upstreamModelId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayModelAlias_alias_key" ON "GatewayModelAlias"("alias");

-- CreateIndex
CREATE INDEX "GatewayModelAlias_modelId_idx" ON "GatewayModelAlias"("modelId");

-- CreateIndex
CREATE INDEX "GatewayAccountModel_modelId_available_idx" ON "GatewayAccountModel"("modelId", "available");

-- CreateIndex
CREATE INDEX "GatewayRoutingPool_provider_enabled_idx" ON "GatewayRoutingPool"("provider", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayRoutingPool_provider_name_key" ON "GatewayRoutingPool"("provider", "name");

-- CreateIndex
CREATE INDEX "GatewayRoutingPoolMember_accountId_enabled_idx" ON "GatewayRoutingPoolMember"("accountId", "enabled");

-- CreateIndex
CREATE INDEX "GatewayRoutingPoolMember_routingPoolId_enabled_priority_idx" ON "GatewayRoutingPoolMember"("routingPoolId", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayRoutingPoolMember_routingPoolId_accountId_key" ON "GatewayRoutingPoolMember"("routingPoolId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayClientKey_keyHash_key" ON "GatewayClientKey"("keyHash");

-- CreateIndex
CREATE INDEX "GatewayClientKey_enabled_revokedAt_expiresAt_idx" ON "GatewayClientKey"("enabled", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "GatewayClientKey_createdByAdminId_idx" ON "GatewayClientKey"("createdByAdminId");

-- CreateIndex
CREATE INDEX "GatewayClientKeyModel_modelId_idx" ON "GatewayClientKeyModel"("modelId");

-- CreateIndex
CREATE INDEX "GatewaySessionRoute_accountId_expiresAt_idx" ON "GatewaySessionRoute"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "GatewaySessionRoute_expiresAt_idx" ON "GatewaySessionRoute"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GatewaySessionRoute_clientKeyId_sessionHash_modelId_key" ON "GatewaySessionRoute"("clientKeyId", "sessionHash", "modelId");

-- CreateIndex
CREATE INDEX "GatewayQuotaSnapshot_accountId_meterKey_windowKey_observedA_idx" ON "GatewayQuotaSnapshot"("accountId", "meterKey", "windowKey", "observedAt");

-- CreateIndex
CREATE INDEX "GatewayQuotaSnapshot_resetAt_idx" ON "GatewayQuotaSnapshot"("resetAt");

-- CreateIndex
CREATE INDEX "GatewayQuotaSnapshot_observedAt_idx" ON "GatewayQuotaSnapshot"("observedAt");

-- CreateIndex
CREATE INDEX "GatewayRequestLog_startedAt_idx" ON "GatewayRequestLog"("startedAt");

-- CreateIndex
CREATE INDEX "GatewayRequestLog_clientKeyId_startedAt_idx" ON "GatewayRequestLog"("clientKeyId", "startedAt");

-- CreateIndex
CREATE INDEX "GatewayRequestLog_accountId_startedAt_idx" ON "GatewayRequestLog"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "GatewayRequestLog_publicModelId_startedAt_idx" ON "GatewayRequestLog"("publicModelId", "startedAt");

-- CreateIndex
CREATE INDEX "GatewayRequestLog_outcome_startedAt_idx" ON "GatewayRequestLog"("outcome", "startedAt");

-- CreateIndex
CREATE INDEX "GatewayUsageBucket_scopeType_scopeId_bucketStart_idx" ON "GatewayUsageBucket"("scopeType", "scopeId", "bucketStart");

-- CreateIndex
CREATE INDEX "GatewayUsageBucket_bucketStart_idx" ON "GatewayUsageBucket"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayUsageBucket_bucketStart_scopeType_scopeId_modelId_key" ON "GatewayUsageBucket"("bucketStart", "scopeType", "scopeId", "modelId");

-- CreateIndex
CREATE INDEX "GatewayLease_expiresAt_idx" ON "GatewayLease"("expiresAt");

-- CreateIndex
CREATE INDEX "GatewayLease_ownerId_idx" ON "GatewayLease"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayLease_kind_resourceId_slot_key" ON "GatewayLease"("kind", "resourceId", "slot");

-- CreateIndex
CREATE INDEX "GatewayAdminAuditLog_createdAt_idx" ON "GatewayAdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "GatewayAdminAuditLog_entityType_entityId_idx" ON "GatewayAdminAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "GatewayAdminAuditLog_adminUserId_idx" ON "GatewayAdminAuditLog"("adminUserId");

-- AddForeignKey
ALTER TABLE "GatewayProviderCredential" ADD CONSTRAINT "GatewayProviderCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayModel" ADD CONSTRAINT "GatewayModel_routingPoolId_fkey" FOREIGN KEY ("routingPoolId") REFERENCES "GatewayRoutingPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayModelAlias" ADD CONSTRAINT "GatewayModelAlias_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "GatewayModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayAccountModel" ADD CONSTRAINT "GatewayAccountModel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayAccountModel" ADD CONSTRAINT "GatewayAccountModel_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "GatewayModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayRoutingPoolMember" ADD CONSTRAINT "GatewayRoutingPoolMember_routingPoolId_fkey" FOREIGN KEY ("routingPoolId") REFERENCES "GatewayRoutingPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayRoutingPoolMember" ADD CONSTRAINT "GatewayRoutingPoolMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayClientKeyModel" ADD CONSTRAINT "GatewayClientKeyModel_clientKeyId_fkey" FOREIGN KEY ("clientKeyId") REFERENCES "GatewayClientKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayClientKeyModel" ADD CONSTRAINT "GatewayClientKeyModel_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "GatewayModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewaySessionRoute" ADD CONSTRAINT "GatewaySessionRoute_clientKeyId_fkey" FOREIGN KEY ("clientKeyId") REFERENCES "GatewayClientKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewaySessionRoute" ADD CONSTRAINT "GatewaySessionRoute_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "GatewayModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewaySessionRoute" ADD CONSTRAINT "GatewaySessionRoute_routingPoolId_fkey" FOREIGN KEY ("routingPoolId") REFERENCES "GatewayRoutingPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewaySessionRoute" ADD CONSTRAINT "GatewaySessionRoute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayQuotaSnapshot" ADD CONSTRAINT "GatewayQuotaSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayQuotaSnapshot" ADD CONSTRAINT "GatewayQuotaSnapshot_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "GatewayModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
