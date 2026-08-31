-- Provider identifiers become strings so new adapters do not require a
-- PostgreSQL enum migration. Explicit casts preserve every existing row.
-- AlterTable
ALTER TABLE "GatewayAdminAuditLog" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "controlCredentialId" TEXT,
ALTER COLUMN "adminEmail" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GatewayModel"
ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

-- AlterTable
ALTER TABLE "GatewayOAuthAttempt" ADD COLUMN     "envelopeVersion" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

-- AlterTable
ALTER TABLE "GatewayProviderAccount"
ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

-- AlterTable
ALTER TABLE "GatewayProviderCredential" ADD COLUMN     "envelopeVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "GatewayRequestLog"
ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

-- AlterTable
ALTER TABLE "GatewayRoutingPool"
ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

-- AlterTable
ALTER TABLE "GatewaySessionRoute" DROP COLUMN "lastProviderRequestId";

-- DropEnum
DROP TYPE "GatewayProvider";

-- CreateTable
CREATE TABLE "GatewayControlKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerLabel" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "allowedCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canDelegateActors" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdByActorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayControlKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayControlKey_keyHash_key" ON "GatewayControlKey"("keyHash");

-- CreateIndex
CREATE INDEX "GatewayControlKey_enabled_revokedAt_expiresAt_idx" ON "GatewayControlKey"("enabled", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "GatewayAdminAuditLog_controlCredentialId_idx" ON "GatewayAdminAuditLog"("controlCredentialId");
