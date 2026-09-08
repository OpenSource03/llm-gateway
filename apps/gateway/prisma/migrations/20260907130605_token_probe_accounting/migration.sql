-- AlterTable
ALTER TABLE "GatewayTokenProbe" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inputTokensTotal" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "outputTokensTotal" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "unknownUsageCount" INTEGER NOT NULL DEFAULT 0;
