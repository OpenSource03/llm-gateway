import type { Context, ValidationTargets } from "hono";
import type { z, ZodError } from "zod";

import { validator } from "hono/validator";

const formatValidationError = (context: Context, error: ZodError) =>
  context.json(
    {
      success: false,
      error: {
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
    400,
  );

export function zValidator<T extends z.ZodType>(
  target: keyof ValidationTargets,
  schema: T,
) {
  return validator(target, (value, context) => {
    const result = schema.safeParse(value);

    return result.success
      ? result.data
      : formatValidationError(context, result.error);
  });
}
