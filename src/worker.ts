import WebSocket from "ws";
import { resolveRegistrationAttestationQuote } from "./attestation-quote.js";
import { printStartupBanner } from "./banner.js";
import { wsUrl } from "./config.js";
import { detectGpuName } from "./gpu.js";
import {
  getActiveModel,
  resolveInferenceBackend,
  runBenchmark,
  runInference,
  type ChatMessage,
} from "./inference.js";
import { computeJobAttestationHash } from "./attestation.js";
import { shortWallet, parseWorkerWallet } from "./wallet.js";
import type { InferenceBackend } from "./config.js";

/** Keep REST heartbeat under backend AutoGate threshold (120s). */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** WebSocket protocol + app pings — proxies (e.g. Cloudflare) drop idle sockets ~100–120s. */
const WS_PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 3_000;

interface WorkerOptions {
  wallet: string;
  backendUrl: string;
  benchmarkOnly?: boolean;
  inference?: InferenceBackend;
}

interface SessionContext {
  wallet: string;
  backendUrl: string;
  modelName: string;
  tokPerSec: number;
}

async function apiPost<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function sendHeartbeat(wallet: string, backendUrl: string): Promise<void> {
  await apiPost(backendUrl, "/v1/workers/heartbeat", { worker_address: wallet });
}

async function ensureRegistered(wallet: string, backendUrl: string, hardwareTier: string) {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/workers/${wallet}`);
    if (res.ok) {
      await sendHeartbeat(wallet, backendUrl);
      return;
    }
  } catch {
    /* register below */
  }

  const teeCapable = process.env.GRIDLOCK_TEE_CAPABLE === "true";
  const attestationQuote = await resolveRegistrationAttestationQuote(
    backendUrl,
    wallet,
    teeCapable,
  );

  const body: Record<string, unknown> = {
    operator_address: wallet,
    role: process.env.GRIDLOCK_ROLE ?? "Prefill",
    hardware_tier: hardwareTier,
    tee_capable: teeCapable,
    is_confidential: teeCapable,
    endpoint: `native://${hardwareTier.toLowerCase().replace(/\s+/g, "-")}`,
  };
  if (attestationQuote) body.attestation_quote = attestationQuote;

  try {
    await apiPost(backendUrl, "/v1/workers/register", body);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("(409)")) {
      await sendHeartbeat(wallet, backendUrl);
      return;
    }
    throw error;
  }
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWebSocketSession(ctx: SessionContext): Promise<void> {
  const { wallet, backendUrl, modelName, tokPerSec } = ctx;
  let activeJob: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pingTimer) clearInterval(pingTimer);
    heartbeatTimer = null;
    pingTimer = null;
  };

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(backendUrl));

    ws.on("open", () => {
      log("Connected to router");
      ws.send(
        JSON.stringify({
          type: "worker:register",
          worker_address: wallet,
          worker_type: "native",
          model: modelName,
          tok_per_sec: tokPerSec,
        }),
      );
      log("Registered for jobs");

      void sendHeartbeat(wallet, backendUrl).catch((e) => {
        log(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      });

      heartbeatTimer = setInterval(() => {
        void sendHeartbeat(wallet, backendUrl).catch((e) => {
          log(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, HEARTBEAT_INTERVAL_MS);

      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
        ws.send(JSON.stringify({ type: "ping" }));
      }, WS_PING_INTERVAL_MS);
    });

    ws.on("message", (raw) => {
      void (async () => {
        try {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          if (msg.type === "error") {
            log(`Error: ${String(msg.message ?? "unknown")}`);
            return;
          }
          if (msg.type === "pong" || msg.type === "connected" || msg.type === "worker:registered") {
            return;
          }
          if (msg.type !== "job:new" || activeJob) return;

          const jobId = String(msg.job_id);
          activeJob = jobId;
          log(`Job ${jobId.slice(0, 12)}…`);

          const messages = (msg.messages as ChatMessage[]) ?? [];
          const confidential = msg.confidential === true || msg.sla_tier === "confidential";
          try {
            const result = await runInference(messages);
            const attestationHash = confidential
              ? computeJobAttestationHash(jobId, wallet, result.content)
              : null;
            ws.send(
              JSON.stringify({
                type: "job:complete",
                job_id: jobId,
                response: result.content,
                tokens_generated: result.tokens,
                ttft_ms: result.ttftMs,
                tpot_ms: result.tpotMs,
                attestation_hash: attestationHash,
              }),
            );
            log(`Job ${jobId.slice(0, 12)}… done (${result.tokens} tokens)`);
          } catch (e) {
            ws.send(
              JSON.stringify({
                type: "job:error",
                job_id: jobId,
                error: e instanceof Error ? e.message : "Inference failed",
              }),
            );
            log(`Job ${jobId.slice(0, 12)}… failed`);
          } finally {
            activeJob = null;
          }
        } catch (e) {
          log(`Message error: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    });

    ws.on("close", () => {
      cleanup();
      log("Disconnected");
      resolve();
    });

    ws.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });
}

export async function startWorker(options: WorkerOptions): Promise<void> {
  const { wallet: rawWallet, backendUrl, benchmarkOnly, inference } = options;
  const wallet = parseWorkerWallet(rawWallet);

  printStartupBanner();

  const hardwareTier = await detectGpuName();
  log(`Wallet: ${shortWallet(wallet)}`);
  log(`API: ${backendUrl}`);
  log(`GPU: ${hardwareTier}`);

  const backend = await resolveInferenceBackend(inference);
  log(`Inference: ${backend} (${getActiveModel()})`);

  log("Running benchmark…");
  const tokPerSec = await runBenchmark();
  log(`Benchmark: ${tokPerSec} tok/s`);

  if (benchmarkOnly) return;

  await ensureRegistered(wallet, backendUrl, hardwareTier);

  const session: SessionContext = {
    wallet,
    backendUrl,
    modelName: getActiveModel(),
    tokPerSec,
  };

  let running = true;
  const shutdown = () => {
    running = false;
    log("Shutting down…");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (running) {
    try {
      await runWebSocketSession(session);
    } catch (e) {
      log(`Session error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!running) break;
    log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
    await sleep(RECONNECT_DELAY_MS);
  }
}
