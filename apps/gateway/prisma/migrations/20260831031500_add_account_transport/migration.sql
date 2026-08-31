ALTER TABLE "GatewayProviderAccount"
  ADD COLUMN "transportMode" TEXT NOT NULL DEFAULT 'direct',
  ADD COLUMN "transportProfileId" TEXT;

ALTER TABLE "GatewayProviderAccount"
  ADD CONSTRAINT "GatewayProviderAccount_transport_check"
  CHECK (
    ("transportMode" = 'direct' AND "transportProfileId" IS NULL)
    OR
    ("transportMode" = 'agent-sdk' AND "transportProfileId" IS NOT NULL)
  );

CREATE INDEX "GatewayProviderAccount_provider_transportMode_enabled_status_idx"
  ON "GatewayProviderAccount"("provider", "transportMode", "enabled", "status");
