import { llmGatewayPrisma } from "../db";

import {
  envelopeFromRecord,
  getGatewayKeyWrapper,
  rewrapEnvelopeDataKey,
} from "./envelope";

export const rewrapGatewayKeys = async (): Promise<{
  credentials: number;
  oauthAttempts: number;
  keyWrapperId: string;
}> => {
  const wrapper = getGatewayKeyWrapper();
  const [credentials, attempts] = await Promise.all([
    llmGatewayPrisma.gatewayProviderCredential.findMany({
      where: { keyWrapperId: { not: wrapper.keyId } },
    }),
    llmGatewayPrisma.gatewayOAuthAttempt.findMany({
      where: { keyWrapperId: { not: wrapper.keyId } },
    }),
  ]);
  let credentialCount = 0;
  let attemptCount = 0;

  for (const credential of credentials) {
    const rotated = await rewrapEnvelopeDataKey(
      envelopeFromRecord(credential),
      wrapper,
    );
    const result = await llmGatewayPrisma.gatewayProviderCredential.updateMany({
      where: {
        id: credential.id,
        revision: credential.revision,
        keyWrapperId: credential.keyWrapperId,
      },
      data: {
        wrappedDataKey: Buffer.from(rotated.wrappedDataKey),
        keyWrapperId: rotated.keyWrapperId,
        revision: { increment: 1 },
      },
    });

    credentialCount += result.count;
  }

  for (const attempt of attempts) {
    const rotated = await rewrapEnvelopeDataKey(
      envelopeFromRecord(attempt),
      wrapper,
    );
    const result = await llmGatewayPrisma.gatewayOAuthAttempt.updateMany({
      where: { id: attempt.id, keyWrapperId: attempt.keyWrapperId },
      data: {
        wrappedDataKey: Buffer.from(rotated.wrappedDataKey),
        keyWrapperId: rotated.keyWrapperId,
      },
    });

    attemptCount += result.count;
  }

  return {
    credentials: credentialCount,
    oauthAttempts: attemptCount,
    keyWrapperId: wrapper.keyId,
  };
};
