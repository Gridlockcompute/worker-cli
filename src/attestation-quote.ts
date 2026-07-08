import { readFileSync } from "node:fs";

export interface AttestationQuotePayload {
  worker_pubkey: string;
  tee_type: string;
  nonce: string;
  enclave_pubkey: string;
  report_bytes: string;
  timestamp: number;
  certificate_chain?: string[];
}

async function fetchChallenge(backendUrl: string, wallet: string): Promise<string> {
  const base = backendUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/v1/attestation/challenge?wallet=${encodeURIComponent(wallet)}`,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`attestation challenge failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { nonce?: string };
  if (!data.nonce) throw new Error("attestation challenge missing nonce");
  return data.nonce;
}

function loadQuoteFromEnv(): AttestationQuotePayload | null {
  const file = process.env.GRIDLOCK_ATTESTATION_QUOTE_FILE?.trim();
  if (file) {
    return JSON.parse(readFileSync(file, "utf8")) as AttestationQuotePayload;
  }
  const json = process.env.GRIDLOCK_ATTESTATION_QUOTE_JSON?.trim();
  if (json) {
    return JSON.parse(json) as AttestationQuotePayload;
  }
  return null;
}

function buildDevAttestationQuote(wallet: string, nonce: string): AttestationQuotePayload {
  const reportBytes = Buffer.from(
    `mock-${wallet.toLowerCase()}-${nonce}-${Date.now()}`,
    "utf8",
  ).toString("base64");
  return {
    worker_pubkey: wallet,
    tee_type: process.env.GRIDLOCK_TEE_TYPE?.trim() || "nvidia_cc",
    nonce,
    enclave_pubkey: process.env.GRIDLOCK_ENCLAVE_PUBKEY?.trim() || wallet,
    report_bytes: reportBytes,
    timestamp: Date.now(),
    certificate_chain: [],
  };
}

/** Resolve TEE attestation quote for worker registration (production file or dev challenge). */
export async function resolveRegistrationAttestationQuote(
  backendUrl: string,
  wallet: string,
  teeCapable: boolean,
): Promise<AttestationQuotePayload | undefined> {
  if (!teeCapable) return undefined;

  const fromEnv = loadQuoteFromEnv();
  if (fromEnv) {
    console.log("[attestation] Using quote from GRIDLOCK_ATTESTATION_QUOTE_FILE / _JSON");
    return fromEnv;
  }

  try {
    const nonce = await fetchChallenge(backendUrl, wallet);
    console.log(
      "[attestation] Dev quote from router challenge (production CC GPUs: set GRIDLOCK_ATTESTATION_QUOTE_FILE)",
    );
    return buildDevAttestationQuote(wallet, nonce);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[attestation] Skipping registration quote: ${msg}`);
    return undefined;
  }
}
