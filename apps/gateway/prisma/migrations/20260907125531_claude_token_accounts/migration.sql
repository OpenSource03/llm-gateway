-- AlterTable
ALTER TABLE "GatewayControlAuditLog" RENAME CONSTRAINT "GatewayAdminAuditLog_pkey" TO "GatewayControlAuditLog_pkey";

-- AlterTable
ALTER TABLE "GatewayProviderAccount" ADD COLUMN     "authenticationMethod" TEXT NOT NULL DEFAULT 'oauth',
ADD COLUMN     "inferenceReadyAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GatewayTokenProbe" (
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "modelId" TEXT NOT NULL,
    "statusCode" INTEGER,
    "inputTokens" BIGINT,
    "outputTokens" BIGINT,

    CONSTRAINT "GatewayTokenProbe_pkey" PRIMARY KEY ("accountId","kind")
);

-- AddForeignKey
ALTER TABLE "GatewayTokenProbe" ADD CONSTRAINT "GatewayTokenProbe_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GatewayProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "GatewayProviderAccount_provider_transportMode_enabled_status_id" RENAME TO "GatewayProviderAccount_provider_transportMode_enabled_statu_idx";
