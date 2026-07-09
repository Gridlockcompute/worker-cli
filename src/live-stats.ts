import type { WorkerDashboard } from "./dashboard.js";

export const LIVE_STATS_POLL_MS = 3_000;

export interface LiveStats {
  jobsToday: number;
  tokensToday: number;
  jobsFailedToday: number;
  workerStatus: string;
  wsTokPerSec: number;
  queueJobs: number;
  inflightJobs: number;
  workerInflightJobs: number;
}

interface RecentJob {
  ts?: number;
  status?: string;
  sla_met?: boolean;
  completion_tokens?: number;
  tokens_generated?: number;
  output_tokens?: number;
}

async function fetchWorkerLiveStats(
  wallet: string,
  backendUrl: string,
): Promise<Omit<LiveStats, "queueJobs" | "inflightJobs"> | null> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/workers/${wallet}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      jobs_today?: number;
      tokens_today?: number;
      jobs_failed_today?: number;
      status?: string;
      ws_tok_per_sec?: number;
      in_flight?: number;
      recent_jobs?: RecentJob[];
    };
    const recentJobs = Array.isArray(data.recent_jobs) ? data.recent_jobs : [];
    const dayStart = Date.now() / 1000 - 86_400;
    const recentToday = recentJobs.filter((job) => Number(job.ts ?? 0) >= dayStart);
    const fallbackTokensToday = recentToday.reduce(
      (sum, job) => sum + Number(job.completion_tokens ?? job.tokens_generated ?? job.output_tokens ?? 0),
      0,
    );
    const fallbackFailedToday = recentToday.filter(
      (job) => job.status === "failed" || job.sla_met === false,
    ).length;

    return {
      jobsToday: Number(data.jobs_today ?? recentToday.length),
      tokensToday: Number(data.tokens_today ?? fallbackTokensToday),
      jobsFailedToday: Number(data.jobs_failed_today ?? fallbackFailedToday),
      workerStatus: data.status ?? "Active",
      wsTokPerSec: Number(data.ws_tok_per_sec ?? 0),
      workerInflightJobs: Number(data.in_flight ?? 0),
    };
  } catch {
    return null;
  }
}

async function fetchRouterQueueStats(
  backendUrl: string,
): Promise<{ queueJobs: number; inflightJobs: number } | null> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/stats/ws`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      jobs_in_queue?: number;
      jobs_inflight?: number;
    };
    return {
      queueJobs: Number(data.jobs_in_queue ?? 0),
      inflightJobs: Number(data.jobs_inflight ?? 0),
    };
  } catch {
    return null;
  }
}

export async function fetchLiveStats(
  wallet: string,
  backendUrl: string,
): Promise<LiveStats | null> {
  const [worker, queue] = await Promise.all([
    fetchWorkerLiveStats(wallet, backendUrl),
    fetchRouterQueueStats(backendUrl),
  ]);
  if (!worker) return null;
  return {
    ...worker,
    queueJobs: queue?.queueJobs ?? 0,
    inflightJobs: queue?.inflightJobs ?? worker.workerInflightJobs,
  };
}

export function startLiveStatsPoll(
  wallet: string,
  backendUrl: string,
  dashboard: WorkerDashboard,
  isRunning: () => boolean,
): () => void {
  const poll = async () => {
    if (!isRunning()) return;
    const stats = await fetchLiveStats(wallet, backendUrl);
    if (!stats || !isRunning()) return;
    dashboard.applyLiveStats(stats);
  };

  void poll();
  const timer = setInterval(() => void poll(), LIVE_STATS_POLL_MS);
  return () => clearInterval(timer);
}
