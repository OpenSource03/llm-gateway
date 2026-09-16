import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage<{ httpRequestId: string }>();

/** Internal correlation only. Never trusts inbound request IDs or headers. */
export const runWithRequestDiagnostics = <T>(callback: () => T): T =>
  context.run({ httpRequestId: randomUUID() }, callback);

export const requestDiagnosticContext = (): { httpRequestId?: string } =>
  context.getStore() ?? {};
