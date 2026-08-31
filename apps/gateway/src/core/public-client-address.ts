import ipaddr from "ipaddr.js";

export const SHARED_PUBLIC_AUTH_BUCKET = "shared:public-gateway";

/**
 * A deployment may opt into one ingress-overwritten client-IP header. The
 * configured ingress must be the sole public path and overwrite that header;
 * otherwise the shared bucket is safer than caller-controlled forwarding data.
 */
export const publicGatewayClientAddress = (
  request: Request,
  trustedHeader: "x-azure-clientip" | "x-real-ip" | undefined,
): string => {
  if (!trustedHeader) return SHARED_PUBLIC_AUTH_BUCKET;

  const value = request.headers.get(trustedHeader)?.trim();

  if (!value || value.length > 64) return SHARED_PUBLIC_AUTH_BUCKET;

  try {
    return `ip:${ipaddr.parse(value).toNormalizedString()}`;
  } catch {
    return SHARED_PUBLIC_AUTH_BUCKET;
  }
};
