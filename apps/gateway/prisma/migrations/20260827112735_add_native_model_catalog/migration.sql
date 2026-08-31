-- AlterTable
ALTER TABLE "GatewayProviderAccount" ADD COLUMN     "lastModelCatalogRefreshAt" TIMESTAMP(3),
ADD COLUMN     "nativeModelCatalog" JSONB,
ADD COLUMN     "nativeModelCatalogEtag" TEXT;
