import { llmGatewayPrisma } from "../core/db";

export interface GatewayAuditFilters {
  page: number;
  perPage: number;
  actorId?: string;
  action?: string;
  entityType?: string;
  status?: number;
}

export const listGatewayAudit = async (filters: GatewayAuditFilters) => {
  const where = {
    ...(filters.actorId && { actorId: filters.actorId }),
    ...(filters.action && { action: filters.action }),
    ...(filters.entityType && { entityType: filters.entityType }),
    ...(filters.status !== undefined && { status: filters.status }),
  };
  const [rows, total] = await Promise.all([
    llmGatewayPrisma.gatewayControlAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
      select: {
        id: true,
        controlCredentialId: true,
        actorId: true,
        actorEmail: true,
        actorName: true,
        action: true,
        entityType: true,
        entityId: true,
        method: true,
        path: true,
        status: true,
        ip: true,
        userAgent: true,
        createdAt: true,
      },
    }),
    llmGatewayPrisma.gatewayControlAuditLog.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
};
