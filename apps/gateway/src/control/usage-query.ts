import { z } from "zod";

const DAY = 86_400_000;
export const usageQuery = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    interval: z.enum(["hour", "day"]).default("day"),
    provider: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
      .optional(),
    account_id: z.string().uuid().optional(),
    model: z.string().min(1).max(200).optional(),
    client_key_id: z.string().uuid().optional(),
  })
  .transform((query) => {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 7 * DAY);
    return { ...query, from, to, provider: query.provider?.toUpperCase() };
  })
  .superRefine((query, ctx) => {
    const duration = query.to.getTime() - query.from.getTime();
    if (
      duration <= 0 ||
      duration > 90 * DAY ||
      (query.interval === "hour" && duration > 7 * DAY)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Choose an increasing range of at most 90 days (7 days for hourly buckets).",
      });
    }
  });
export type UsageQuery = z.infer<typeof usageQuery>;
