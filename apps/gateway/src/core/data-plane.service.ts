import Logger from "../config/logger";

export {
  proxyMessagesRequest,
  proxyResponsesRequest,
} from "./data-plane/inference";
export { proxyCodexSearchRequest } from "./data-plane/search";
export { countGatewayTokens } from "./data-plane/token-count";
export { wrapStreamLifecycle } from "./data-plane/stream-lifecycle";
export {
  estimateGatewayInputTokens,
  estimateGatewayResponsesInputTokens,
} from "./data-plane/token-estimation";
export {
  currentRoutingQuotaSnapshots,
  parseGatewayQuotaRules,
  persistGatewayHeaderQuota,
} from "./data-plane/routing";

export const logDataPlaneInternalError = (error: unknown): void => {
  Logger.error("LLM gateway data-plane failure", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
};
