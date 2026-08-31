-- Rename the remaining embedded-installation storage names without rewriting
-- credential ciphertext, wrapped keys, audit rows, or attribution.

ALTER TABLE "GatewayClientKey"
RENAME COLUMN "createdByAdminId" TO "createdByActorId";

ALTER TABLE "GatewayOAuthAttempt"
RENAME COLUMN "createdByAdminId" TO "createdByActorId";
ALTER TABLE "GatewayOAuthAttempt"
RENAME COLUMN "keyVaultKeyId" TO "keyWrapperId";

ALTER TABLE "GatewayProviderAccount"
RENAME COLUMN "createdByAdminId" TO "createdByActorId";

ALTER TABLE "GatewayProviderCredential"
RENAME COLUMN "keyVaultKeyId" TO "keyWrapperId";

ALTER TABLE "GatewayAdminAuditLog"
RENAME COLUMN "adminUserId" TO "actorId";
ALTER TABLE "GatewayAdminAuditLog"
RENAME COLUMN "adminEmail" TO "actorEmail";
ALTER TABLE "GatewayAdminAuditLog"
RENAME TO "GatewayControlAuditLog";

ALTER INDEX "GatewayClientKey_createdByAdminId_idx"
RENAME TO "GatewayClientKey_createdByActorId_idx";
ALTER INDEX "GatewayOAuthAttempt_createdByAdminId_status_idx"
RENAME TO "GatewayOAuthAttempt_createdByActorId_status_idx";
ALTER INDEX "GatewayAdminAuditLog_createdAt_idx"
RENAME TO "GatewayControlAuditLog_createdAt_idx";
ALTER INDEX "GatewayAdminAuditLog_entityType_entityId_idx"
RENAME TO "GatewayControlAuditLog_entityType_entityId_idx";
ALTER INDEX "GatewayAdminAuditLog_adminUserId_idx"
RENAME TO "GatewayControlAuditLog_actorId_idx";
ALTER INDEX "GatewayAdminAuditLog_controlCredentialId_idx"
RENAME TO "GatewayControlAuditLog_controlCredentialId_idx";
