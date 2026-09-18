-- AlterTable
ALTER TABLE "GatewayRequestLog" ADD COLUMN     "cacheReadInputTokens" BIGINT,
ADD COLUMN     "cacheWriteInputTokens" BIGINT;
