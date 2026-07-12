const LIME = "\x1b[38;2;182;255;60m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

/** Fixed height — keep in sync with buildLines(). */
const FIXED_LINES = 15;

export type ConnectionStatus = "starting" | "connected" | "disconnected" | "reconnecting";

export interface DashboardSnapshot {
  wallet: string;
  api: string;
  hardware: string;
  model: string;
  inference: string;
  benchmarkTokPerSec: number;
  connection: ConnectionStatus;
  workerStatus: string;
  jobsCompleted: number;
  jobsFailed: number;
  jobsToday: number;
  tokensTodayBase: number;
  liveTokPerSec: number | null;
  queueJobs: number | null;
  inflightJobs: number | null;
  workerInflightJobs: number | null;
  currentJob: {
    id: string;
    tokens: number;
    maxTokens: number;
    startedAt: number;
  } | null;
}

export interface LiveStatsPatch {
  jobsToday: number;
  tokensToday: number;
  jobsFailedToday: number;
  workerStatus: string;
  wsTokPerSec: number;
  queueJobs: number;
  inflightJobs: number;
  workerInflightJobs: number;
}

export interface DashboardOptions {
  /** First terminal row for the dashboard box (1-based, below banner). */
  anchorRow?: number;
}

export interface WorkerDashboard {
  update(patch: Partial<DashboardSnapshot>): void;
  applyLiveStats(stats: LiveStatsPatch): void;
  setJob(jobId: string, maxTokens: number): void;
  setJobProgress(tokens: number, maxTokens?: number): void;
  clearJob(jobId: string, success: boolean, tokens: number, elapsedMs: number): void;
  setConnection(status: ConnectionStatus): void;
  note(message: string): void;
  start(): void;
  stop(): void;
}

function shouldColorize(): boolean {
  if (process.env.GRIDLOCK_PLAIN_LOGS === "true") return false;
  const { FORCE_COLOR, NO_COLOR } = process.env;
  if (FORCE_COLOR !== undefined) {
    return FORCE_COLOR !== "0" && FORCE_COLOR.toLowerCase() !== "false";
  }
  if (NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

/** Interactive TTY dashboard — suppresses startup log lines. */
export function isDashboardMode(): boolean {
  return shouldColorize() && process.stdout.isTTY === true;
}

function c(text: string, color: string): string {
  if (!shouldColorize()) return text;
  return `${color}${text}${RESET}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function activityBar(now: number, width = 18): string {
  const pulseWidth = 5;
  const travel = width - pulseWidth;
  const offset = Math.floor(now / 120) % (travel + 1);
  const chars = Array.from({ length: width }, (_, i) =>
    i >= offset && i < offset + pulseWidth ? "█" : "░",
  );
  return c(`[${chars.join("")}]`, LIME);
}

function connectionLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return c("● Connected", GREEN);
    case "disconnected":
      return c("○ Disconnected", RED);
    case "reconnecting":
      return c("↻ Reconnecting", YELLOW);
    default:
      return c("… Starting", YELLOW);
  }
}

function row(label: string, value: string, width = 76): string {
  const left = `  ${c(label, DIM)}`;
  const gap = Math.max(1, 22 - label.length);
  const content = left + " ".repeat(gap) + value;
  return content.length > width ? content.slice(0, width) : content;
}

function topBorder(width = 76): string {
  const title = " Gridlock Worker Dashboard ";
  const dashes = Math.max(1, width - title.length - 2);
  return c(`┌${title}${"─".repeat(dashes)}┐`, LIME);
}

function bottomBorder(width = 76): string {
  return c(`└${"─".repeat(width - 2)}┘`, LIME);
}

export function createDashboard(
  initial: DashboardSnapshot,
  options: DashboardOptions = {},
): WorkerDashboard {
  const state: DashboardSnapshot = { ...initial };
  const anchorRow = Math.max(1, options.anchorRow ?? 1);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let jobTimer: ReturnType<typeof setInterval> | null = null;
  let lastNote = c("—", DIM);
  let started = false;
  let renderPending = false;

  const enabled = shouldColorize() && process.stdout.isTTY;

  function buildLines(): string[] {
    const uptime = formatDuration(Date.now() - startedAt);
    const jobs = `${state.jobsCompleted} session · ${state.jobsToday} today · ${state.jobsFailed} failed`;
    const bench = `${state.benchmarkTokPerSec} tok/s`;
    const live =
      state.liveTokPerSec !== null ? `${state.liveTokPerSec} tok/s` : c("—", DIM);
    const queue =
      state.queueJobs !== null
        ? `${state.queueJobs} queued · ${state.inflightJobs ?? 0} net · ${state.workerInflightJobs ?? 0} worker`
        : c("—", DIM);
    const tokens =
      state.tokensTodayBase + (state.currentJob?.tokens ?? 0);

    const lines = [
      topBorder(),
      row("Wallet", state.wallet),
      row("API", state.api),
      row("Hardware", state.hardware),
      row("Model", `${state.model} (${state.inference})`),
      row("Status", `${connectionLabel(state.connection)} · ${state.workerStatus}`),
      row("Uptime", uptime),
      row("Jobs", jobs),
      row("Tokens", String(tokens)),
      row("Throughput", `bench ${bench} · live ${live}`),
      row("Router queue", queue),
    ];

    if (state.currentJob) {
      const job = state.currentJob;
      const elapsed = formatDuration(Date.now() - job.startedAt);
      const liveRate = state.liveTokPerSec !== null ? `${state.liveTokPerSec} tok/s` : "warming up";
      lines.push(row("Current job", `${job.id.slice(0, 12)}… · ${elapsed}`));
      lines.push(
        row(
          "Generation",
          `${activityBar(Date.now())} ${job.tokens} tok · ${liveRate}`,
        ),
      );
    } else {
      lines.push(row("Current job", c("idle — waiting for work", DIM)));
      lines.push(row("Generation", c("idle", DIM)));
    }

    lines.push(row("Last event", lastNote));
    lines.push(bottomBorder());
    return lines;
  }

  function render() {
    if (!enabled || !started) return;

    const lines = buildLines();
    while (lines.length < FIXED_LINES) lines.push("");
    if (lines.length > FIXED_LINES) lines.length = FIXED_LINES;

    for (let i = 0; i < FIXED_LINES; i += 1) {
      const rowNum = anchorRow + i;
      process.stdout.write(`\x1b[${rowNum};1H\x1b[2K${lines[i] ?? ""}`);
    }
    process.stdout.write(`\x1b[${anchorRow + FIXED_LINES};1H`);
  }

  function scheduleRender() {
    if (!started) return;
    if (renderPending) return;
    renderPending = true;
    setImmediate(() => {
      renderPending = false;
      render();
    });
  }

  function startJobTicker() {
    stopJobTicker();
    jobTimer = setInterval(() => {
      if (!state.currentJob) return;
      scheduleRender();
    }, 100);
  }

  function stopJobTicker() {
    if (!jobTimer) return;
    clearInterval(jobTimer);
    jobTimer = null;
  }

  return {
    update(patch) {
      Object.assign(state, patch);
      scheduleRender();
    },

    applyLiveStats(stats) {
      state.jobsToday = Math.max(state.jobsToday, stats.jobsToday);
      state.workerStatus = stats.workerStatus;
      state.queueJobs = stats.queueJobs;
      state.inflightJobs = stats.inflightJobs;
      state.workerInflightJobs = stats.workerInflightJobs;
      state.jobsFailed = Math.max(state.jobsFailed, stats.jobsFailedToday);
      state.tokensTodayBase = Math.max(state.tokensTodayBase, stats.tokensToday);

      if (!state.currentJob) {
        state.liveTokPerSec = stats.wsTokPerSec > 0 ? stats.wsTokPerSec : null;
      }

      scheduleRender();
    },

    setJob(jobId, maxTokens) {
      state.currentJob = {
        id: jobId,
        tokens: 0,
        maxTokens: Math.max(1, maxTokens),
        startedAt: Date.now(),
      };
      state.liveTokPerSec = 0;
      startJobTicker();
      scheduleRender();
    },

    setJobProgress(tokens, maxTokens) {
      if (!state.currentJob) return;
      state.currentJob.tokens = Math.max(0, tokens);
      if (maxTokens !== undefined) state.currentJob.maxTokens = Math.max(1, maxTokens);
      const elapsedSec = Math.max((Date.now() - state.currentJob.startedAt) / 1000, 0.001);
      state.liveTokPerSec = Math.round((state.currentJob.tokens / elapsedSec) * 10) / 10;
      scheduleRender();
    },

    clearJob(jobId, success, tokens, elapsedMs) {
      if (success) {
        state.jobsCompleted += 1;
        state.tokensTodayBase += tokens;
      } else {
        state.jobsFailed += 1;
      }

      if (state.currentJob?.id !== jobId) {
        scheduleRender();
        return;
      }

      if (elapsedMs > 0 && tokens > 0) {
        state.liveTokPerSec = Math.round((tokens / (elapsedMs / 1000)) * 10) / 10;
      }
      state.currentJob = null;
      stopJobTicker();
      scheduleRender();
    },

    setConnection(status) {
      state.connection = status;
      scheduleRender();
    },

    note(message) {
      lastNote = message.length > 52 ? `${message.slice(0, 49)}…` : message;
      scheduleRender();
    },

    start() {
      if (!enabled) return;
      process.stdout.write("\x1b[?25l");
      started = true;
      scheduleRender();
      timer = setInterval(scheduleRender, 200);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stopJobTicker();
      if (!enabled || !started) return;
      started = false;
      process.stdout.write("\x1b[?25h");
    },
  };
}

export function plainLog(msg: string): void {
  if (process.env.GRIDLOCK_PLAIN_LOGS === "true" || !process.stdout.isTTY) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }
}
