import pino from "pino";

const base = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "authorization",
      "cookie",
      "*.authorization",
      "*.cookie",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.secret",
      "*.key",
      "*.code",
      "*.verifier",
      "*.ciphertext",
      "*.wrappedDataKey",
    ],
    censor: "[REDACTED]",
  },
  base: undefined,
});

const entry = (message: string, context?: Record<string, unknown>) =>
  context ? [context, message] : [message];

const Logger = {
  debug: (message: string, context?: Record<string, unknown>) =>
    base.debug(
      ...(entry(message, context) as [Record<string, unknown>, string]),
    ),
  info: (message: string, context?: Record<string, unknown>) =>
    base.info(
      ...(entry(message, context) as [Record<string, unknown>, string]),
    ),
  warn: (message: string, context?: Record<string, unknown>) =>
    base.warn(
      ...(entry(message, context) as [Record<string, unknown>, string]),
    ),
  error: (message: string, context?: Record<string, unknown>) =>
    base.error(
      ...(entry(message, context) as [Record<string, unknown>, string]),
    ),
};

export default Logger;
