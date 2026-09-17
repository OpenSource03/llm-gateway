-- DropIndex
DROP INDEX "GatewayRequestLog_startedAt_idx";

-- AlterTable
ALTER TABLE "GatewayClientKey" ADD COLUMN     "testing" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GatewayRequestLog" ADD COLUMN     "testing" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "GatewayRequestLog_testing_startedAt_idx" ON "GatewayRequestLog"("testing", "startedAt");
