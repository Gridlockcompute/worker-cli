import { createHash } from "node:crypto";

/** Must match gridlock-backend/src/attestation.ts computeJobAttestationHash. */
export function computeJobAttestationHash(
  jobId: string,
  workerAddress: string,
  response: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      jobId,
      workerAddress,
      response: response.slice(0, 512),
    }))
    .digest("hex");
}
