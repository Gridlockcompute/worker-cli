import WebSocket from "ws";
import { resolveRegistrationAttestationQuote } from "./attestation-quote.js";
import { printStartupBanner } from "./banner.js";
import { createDashboard, isDashboardMode, plainLog, type WorkerDashboard } from "./dashboard.js";
import { wsUrl, MAX_OUTPUT_TOKENS } from "./config.js";
import { detectHardwareTier } from "./gpu.js";
import {
  getActiveModel,
  resolveInferenceBackend,
  runBenchmark,
  runInference,
  type ChatMessage,
} from "./inference.js";
import { computeJobAttestationHash } from "./attestation.js";
import { acquireWorkerLock } from "./lock.js";
import { startLiveStatsPoll } from "./live-stats.js";
import { shortWallet, parseWorkerWallet } from "./wallet.js";
import type { InferenceBackend } from "./config.js";

/** Keep REST heartbeat under backend AutoGate threshold (120s). */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** WebSocket protocol + app pings — proxies (e.g. Cloudflare) drop idle sockets ~100–120s. */
const WS_PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 3_000;
const DUPLICATE_DISCONNECT_THRESHOLD = 3;

interface SessionContext {
  wallet: string;
  backendUrl: string;
  modelName: string;
  tokPerSec: number;
  dashboard: WorkerDashboard;
  onAlreadyConnected: () => void;
}

interface WorkerOptions {
  wallet: string;
  backendUrl: string;
  benchmarkOnly?: boolean;
  inference?: InferenceBackend;
  model?: string;
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

async function ensureWorkerActive(wallet: string, backendUrl: string): Promise<string> {
  const base = backendUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/workers/${wallet}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Active" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Set worker Active failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { status?: string };
  return data.status ?? "Active";
}

async function fetchWorkerStats(
  wallet: string,
  backendUrl: string,
): Promise<{ jobsToday: number; tokensToday: number; workerStatus: string }> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/workers/${wallet}`);
    if (!res.ok) return { jobsToday: 0, tokensToday: 0, workerStatus: "Active" };
    const data = (await res.json()) as {
      jobs_today?: number;
      tokens_today?: number;
      status?: string;
    };
    return {
      jobsToday: Number(data.jobs_today ?? 0),
      tokensToday: Number(data.tokens_today ?? 0),
      workerStatus: data.status ?? "Active",
    };
  } catch {
    return { jobsToday: 0, tokensToday: 0, workerStatus: "Active" };
  }
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
    earnings_wallet: process.env.GRIDLOCK_EARNINGS_WALLET?.trim() || wallet,
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

interface QueuedJob {
  jobId: string;
  maxTokens: number;
  messages: ChatMessage[];
  confidential: boolean;
}

async function executeJobBody(
  ws: WebSocket,
  ctx: SessionContext,
  job: QueuedJob,
): Promise<void> {
  const { wallet, dashboard } = ctx;
  const { jobId, maxTokens, messages, confidential } = job;
  const jobStartedAt = performance.now();

  try {
    const result = await runInference(messages, {
      maxTokens,
      onProgress: ({ tokens, maxTokens: limit }) => {
        dashboard.setJobProgress(tokens, limit);
      },
    });
    const attestationHash = confidential
      ? computeJobAttestationHash(jobId, wallet, result.content)
      : null;
    const elapsedMs = performance.now() - jobStartedAt;
    dashboard.note(`Job ${jobId.slice(0, 12)}… done (${result.tokens} tokens)`);
    dashboard.clearJob(jobId, true, result.tokens, elapsedMs);
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
  } catch (e) {
    const elapsedMs = performance.now() - jobStartedAt;
    dashboard.note(`Job ${jobId.slice(0, 12)}… failed`);
    dashboard.clearJob(jobId, false, 0, elapsedMs);
    ws.send(
      JSON.stringify({
        type: "job:error",
        job_id: jobId,
        error: e instanceof Error ? e.message : "Inference failed",
      }),
    );
    plainLog(`Job ${jobId.slice(0, 12)}… failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function runWebSocketSession(
  ctx: SessionContext,
  opts: {
    isReconnect: boolean;
    onQuickDisconnect: () => boolean;
    onStableConnection: () => void;
  },
): Promise<void> {
  const { wallet, backendUrl, modelName, tokPerSec, dashboard, onAlreadyConnected } = ctx;
  let jobChain: Promise<void> = Promise.resolve();
  let jobsInFlight = 0;

  const enqueueJob = (ws: WebSocket, job: QueuedJob) => {
    jobsInFlight += 1;
    dashboard.setJob(job.jobId, job.maxTokens);
    dashboard.note(`Job received ${job.jobId.slice(0, 12)}…`);
    jobChain = jobChain
      .then(() => executeJobBody(ws, ctx, job))
      .catch((e) => {
        dashboard.note(`Job queue error: ${e instanceof Error ? e.message : String(e)}`);
        plainLog(`Job queue error: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        jobsInFlight = Math.max(0, jobsInFlight - 1);
      });
  };

  const hasActiveWork = () => jobsInFlight > 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let connectedAt: number | null = null;

  const cleanup = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pingTimer) clearInterval(pingTimer);
    heartbeatTimer = null;
    pingTimer = null;
  };

  if (opts.isReconnect) {
    dashboard.setConnection("reconnecting");
  } else {
    dashboard.setConnection("starting");
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(backendUrl));

    ws.on("open", () => {
      connectedAt = Date.now();
      dashboard.setConnection("connected");
      ws.send(
        JSON.stringify({
          type: "worker:register",
          worker_address: wallet,
          worker_type: "native",
          model: modelName,
          tok_per_sec: tokPerSec,
        }),
      );
      dashboard.note("Registered for jobs");

      void sendHeartbeat(wallet, backendUrl).catch((e) => {
        dashboard.note(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
        plainLog(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      });

      heartbeatTimer = setInterval(() => {
        void sendHeartbeat(wallet, backendUrl).catch((e) => {
          dashboard.note(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
          plainLog(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, HEARTBEAT_INTERVAL_MS);

      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
        ws.send(JSON.stringify({ type: "ping" }));
      }, WS_PING_INTERVAL_MS);
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch (e) {
        dashboard.note(`Message error: ${e instanceof Error ? e.message : String(e)}`);
        plainLog(`Message error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      if (msg.type === "error") {
        const code = String(msg.code ?? "");
        if (code === "worker_already_connected") {
          dashboard.note("Wallet already connected — stop the other worker instance");
          plainLog(
            "Rejected: this wallet already has an active worker. Stop the other instance before starting a new one.",
          );
          onAlreadyConnected();
          return;
        }
        dashboard.note(`Error: ${String(msg.message ?? "unknown")}`);
        plainLog(`Error: ${String(msg.message ?? "unknown")}`);
        return;
      }

      if (msg.type === "stats:update") {
        const hasWorkerStats =
          msg.jobs_today !== undefined
          || msg.tokens_today !== undefined
          || msg.jobs_failed_today !== undefined
          || msg.worker_inflight !== undefined;

        if (hasWorkerStats) {
          dashboard.applyLiveStats({
            jobsToday: Number(msg.jobs_today ?? 0),
            tokensToday: Number(msg.tokens_today ?? 0),
            jobsFailedToday: Number(msg.jobs_failed_today ?? 0),
            workerStatus: String(msg.worker_status ?? "Active"),
            wsTokPerSec: tokPerSec,
            queueJobs: Number(msg.jobs_in_queue ?? 0),
            inflightJobs: Number(msg.jobs_inflight ?? 0),
            workerInflightJobs: Number(msg.worker_inflight ?? 0),
          });
        } else {
          dashboard.update({
            queueJobs: Number(msg.jobs_in_queue ?? 0),
            inflightJobs: Number(msg.jobs_inflight ?? 0),
          });
        }
        return;
      }

      if (msg.type === "pong" || msg.type === "connected" || msg.type === "worker:registered") {
        return;
      }

      if (msg.type === "job:new") {
        enqueueJob(ws, {
          jobId: String(msg.job_id),
          maxTokens: Number(msg.max_tokens ?? MAX_OUTPUT_TOKENS),
          messages: (msg.messages as ChatMessage[]) ?? [],
          confidential: msg.confidential === true || msg.sla_tier === "confidential",
        });
      }
    });

    ws.on("close", (code, reason) => {
      cleanup();
      const livedMs = connectedAt ? Date.now() - connectedAt : 0;
      if (livedMs >= 5000) {
        opts.onStableConnection();
      } else if (!hasActiveWork() && opts.onQuickDisconnect()) {
        dashboard.note("Another worker instance is using this wallet — exiting");
        plainLog(
          "Disconnected repeatedly — another worker-cli process is registered with this wallet. Stop the duplicate instance.",
        );
        dashboard.setConnection("disconnected");
        resolve();
        return;
      }

      dashboard.setConnection("disconnected");
      const detail = reason.toString() ? ` (${code} ${reason})` : ` (${code})`;
      dashboard.note(`Disconnected from router${detail}`);
      resolve();
    });

    ws.on("error", (err) => {
      dashboard.note(`WebSocket error: ${err.message}`);
      plainLog(`WebSocket error: ${err.message}`);
    });
  });
}

export async function startWorker(options: WorkerOptions): Promise<void> {
  const { wallet: rawWallet, backendUrl, benchmarkOnly, inference, model } = options;
  const wallet = parseWorkerWallet(rawWallet);
  const dashboardMode = !benchmarkOnly && isDashboardMode();

  const bannerLines = printStartupBanner();
  const hardwareTier = await detectHardwareTier();
  const backend = await resolveInferenceBackend(inference, model);

  if (!dashboardMode) {
    log(`Wallet: ${shortWallet(wallet)}`);
    log(`API: ${backendUrl}`);
    log(`Hardware: ${hardwareTier}`);
    log(`Inference: ${backend} (${getActiveModel()})`);
    log("Running benchmark…");
  }

  let dashboard: WorkerDashboard | null = null;
  if (dashboardMode) {
    dashboard = createDashboard({
      wallet: shortWallet(wallet),
      api: backendUrl.replace(/^https?:\/\//, ""),
      hardware: hardwareTier,
      model: getActiveModel(),
      inference: backend,
      benchmarkTokPerSec: 0,
      connection: "starting",
      workerStatus: "Starting",
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsToday: 0,
      tokensTodayBase: 0,
      liveTokPerSec: null,
      queueJobs: null,
      inflightJobs: null,
      workerInflightJobs: null,
      currentJob: null,
    }, { anchorRow: bannerLines + 1 });
    dashboard.start();
    dashboard.note("Running benchmark…");
  }

  const tokPerSec = await runBenchmark();

  if (!dashboardMode) {
    log(`Benchmark: ${tokPerSec} tok/s`);
  } else if (dashboard) {
    dashboard.update({ benchmarkTokPerSec: tokPerSec });
    dashboard.note("Registering with router…");
  }

  if (benchmarkOnly) {
    dashboard?.stop();
    return;
  }

  const releaseLock = acquireWorkerLock(wallet);

  await ensureRegistered(wallet, backendUrl, hardwareTier);
  const workerStats = await fetchWorkerStats(wallet, backendUrl);
  const workerStatus = await ensureWorkerActive(wallet, backendUrl);

  if (!dashboard) {
    dashboard = createDashboard({
      wallet: shortWallet(wallet),
      api: backendUrl.replace(/^https?:\/\//, ""),
      hardware: hardwareTier,
      model: getActiveModel(),
      inference: backend,
      benchmarkTokPerSec: tokPerSec,
      connection: "starting",
      workerStatus,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsToday: workerStats.jobsToday,
      tokensTodayBase: workerStats.tokensToday,
      liveTokPerSec: null,
      queueJobs: null,
      inflightJobs: null,
      workerInflightJobs: null,
      currentJob: null,
    });
    dashboard.start();
  } else {
    dashboard.update({
      benchmarkTokPerSec: tokPerSec,
      workerStatus,
      jobsToday: workerStats.jobsToday,
      tokensTodayBase: workerStats.tokensToday,
    });
  }

  dashboard.note("Worker online — waiting for jobs");

  let running = true;
  const stopLiveStats = startLiveStatsPoll(wallet, backendUrl, dashboard, () => running);

  const session: SessionContext = {
    wallet,
    backendUrl,
    modelName: getActiveModel(),
    tokPerSec,
    dashboard,
    onAlreadyConnected: () => {
      running = false;
    },
  };

  let quickDisconnects = 0;
  let hadSession = false;

  const shutdown = () => {
    running = false;
    stopLiveStats();
    dashboard.note("Shutting down…");
    dashboard.stop();
    releaseLock();
    plainLog("Shutting down…");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (running) {
    try {
      await runWebSocketSession(session, {
        isReconnect: hadSession,
        onQuickDisconnect: () => {
          quickDisconnects += 1;
          if (quickDisconnects >= DUPLICATE_DISCONNECT_THRESHOLD) {
            running = false;
            return true;
          }
          return false;
        },
        onStableConnection: () => {
          quickDisconnects = 0;
        },
      });
      hadSession = true;
    } catch (e) {
      dashboard.note(`Session error: ${e instanceof Error ? e.message : String(e)}`);
      plainLog(`Session error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!running) break;
    if (quickDisconnects >= DUPLICATE_DISCONNECT_THRESHOLD) {
      running = false;
      break;
    }
    dashboard.setConnection("reconnecting");
    dashboard.note(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
    await sleep(RECONNECT_DELAY_MS);
  }

  dashboard.stop();
  stopLiveStats();
  releaseLock();
}
