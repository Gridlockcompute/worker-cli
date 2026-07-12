import {
  BENCHMARK_TOKENS,
  INFERENCE_BACKEND,
  MAX_OUTPUT_TOKENS,
  OLLAMA_MODEL,
  OLLAMA_URL,
  OLLAMA_URL_CANDIDATES,
  VLLM_BASE_URL,
  VLLM_MODEL,
  setOllamaUrl,
  type InferenceBackend,
} from "./config.js";
import {
  bootstrapOllama,
  checkOllamaAt,
  findOllamaBinary,
  resolveOllamaModel,
} from "./ollama.js";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface InferenceProgress {
  tokens: number;
  maxTokens: number;
}

export interface InferenceResult {
  content: string;
  tokens: number;
  ttftMs: number;
  tpotMs: number;
}

export interface InferenceOptions {
  maxTokens?: number;
  onProgress?: (progress: InferenceProgress) => void;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export type ActiveBackend = "ollama" | "vllm";

let activeBackend: ActiveBackend | null = null;
let activeModel = "";

export function getActiveBackend(): ActiveBackend {
  if (!activeBackend) throw new Error("Inference backend not initialized");
  return activeBackend;
}

export function getActiveModel(): string {
  return activeModel;
}

export async function checkOllama(): Promise<boolean> {
  if (process.env.GRIDLOCK_OLLAMA_URL) {
    return checkOllamaAt(OLLAMA_URL);
  }
  for (const url of OLLAMA_URL_CANDIDATES) {
    if (await checkOllamaAt(url)) {
      setOllamaUrl(url);
      return true;
    }
  }
  return false;
}

async function ensureOllamaReady(modelPreference?: string): Promise<string> {
  if (!(await checkOllama())) {
    const preferredUrl = process.env.GRIDLOCK_OLLAMA_URL?.replace(/\/$/, "") ?? OLLAMA_URL_CANDIDATES[0] ?? OLLAMA_URL;
    setOllamaUrl(preferredUrl);
    return bootstrapOllama(OLLAMA_URL, { preferred: modelPreference });
  }

  const binary = findOllamaBinary();
  if (!binary) {
    return bootstrapOllama(OLLAMA_URL, { preferred: modelPreference });
  }
  return resolveOllamaModel(OLLAMA_URL, binary, { preferred: modelPreference });
}

export async function checkVllm(): Promise<boolean> {
  try {
    const res = await fetch(`${VLLM_BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveInferenceBackend(
  preferred: InferenceBackend = INFERENCE_BACKEND,
  modelPreference?: string,
): Promise<ActiveBackend> {
  if (preferred === "ollama") {
    activeModel = await ensureOllamaReady(modelPreference);
    activeBackend = "ollama";
    return activeBackend;
  }

  if (preferred === "vllm") {
    if (!(await checkVllm())) {
      throw new Error(
        `vLLM not reachable at ${VLLM_BASE_URL}. Start it with: vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000`,
      );
    }
    activeBackend = "vllm";
    activeModel = VLLM_MODEL;
    return activeBackend;
  }

  // auto — prefer Ollama (installs on Linux/macOS if missing), fall back to vLLM
  if (await checkOllama()) {
    activeModel = await ensureOllamaReady(modelPreference);
    activeBackend = "ollama";
    return activeBackend;
  }

  try {
    activeModel = await ensureOllamaReady(modelPreference);
    activeBackend = "ollama";
    return activeBackend;
  } catch (ollamaError) {
    if (preferred !== "auto") throw ollamaError;
  }

  if (await checkVllm()) {
    activeBackend = "vllm";
    activeModel = VLLM_MODEL;
    return activeBackend;
  }

  throw new Error(
    "No inference server found.\n" +
      `  • Ollama: installs automatically on Linux/macOS, or https://ollama.com/download on Windows\n` +
      `  • vLLM (Linux): vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000\n` +
      "Set GRIDLOCK_INFERENCE=ollama|vllm to force one backend.",
  );
}

async function runOllamaInference(
  messages: ChatMessage[],
  maxTokens: number,
  onProgress?: (progress: InferenceProgress) => void,
): Promise<InferenceResult> {
  const model = activeModel || OLLAMA_MODEL;
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "inference-ollama-worker.js");

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      fn();
    };

    worker.on("message", (msg: {
      type: string;
      tokens?: number;
      maxTokens?: number;
      result?: InferenceResult;
      error?: string;
    }) => {
      if (msg.type === "progress") {
        onProgress?.({
          tokens: Number(msg.tokens ?? 0),
          maxTokens: Number(msg.maxTokens ?? maxTokens),
        });
        return;
      }
      if (msg.type === "done" && msg.result) {
        finish(() => resolve(msg.result!));
        return;
      }
      if (msg.type === "error") {
        finish(() => reject(new Error(msg.error ?? "Ollama worker failed")));
      }
    });

    worker.on("error", (err) => {
      finish(() => reject(err));
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Ollama worker exited (${code ?? "unknown"})`)));
      }
    });

    worker.postMessage({
      url: OLLAMA_URL,
      model,
      messages,
      maxTokens,
    });
  });
}

async function runVllmInference(
  messages: ChatMessage[],
  maxTokens: number,
  onProgress?: (progress: InferenceProgress) => void,
): Promise<InferenceResult> {
  const start = performance.now();
  let firstTokenAt: number | null = null;
  let content = "";
  let tokens = 0;

  const res = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VLLM_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vLLM error ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("vLLM returned empty body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { completion_tokens?: number };
        };
        const piece = chunk.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          content += piece;
          tokens = Math.max(tokens, Math.ceil(content.length / 4));
          onProgress?.({ tokens, maxTokens });
        }
        const usageTokens = Number(chunk.usage?.completion_tokens ?? 0);
        if (usageTokens > 0) {
          tokens = usageTokens;
          onProgress?.({ tokens, maxTokens });
        }
      } catch {
        /* skip */
      }
    }
  }

  const end = performance.now();
  const ttftMs = Math.floor((firstTokenAt ?? end) - start);
  const outputTokens = Math.max(tokens, 1);
  const tpotMs =
    outputTokens > 1 && firstTokenAt
      ? Math.floor((end - firstTokenAt) / (outputTokens - 1))
      : 0;

  return { content: content.trim() || "(empty)", tokens: outputTokens, ttftMs, tpotMs };
}

export async function runInference(
  messages: ChatMessage[],
  maxTokensOrOptions: number | InferenceOptions = MAX_OUTPUT_TOKENS,
  maybeOptions?: InferenceOptions,
): Promise<InferenceResult> {
  let maxTokens = MAX_OUTPUT_TOKENS;
  let options: InferenceOptions | undefined;

  if (typeof maxTokensOrOptions === "number") {
    maxTokens = maxTokensOrOptions;
    options = maybeOptions;
  } else {
    options = maxTokensOrOptions;
    maxTokens = options.maxTokens ?? MAX_OUTPUT_TOKENS;
  }

  const backend = getActiveBackend();
  const onProgress = options?.onProgress;
  return backend === "ollama"
    ? runOllamaInference(messages, maxTokens, onProgress)
    : runVllmInference(messages, maxTokens, onProgress);
}

export async function runBenchmark(): Promise<number> {
  const start = performance.now();
  const result = await runInference(
    [{ role: "user", content: "Say hi in one word." }],
    BENCHMARK_TOKENS,
  );
  const elapsedSec = Math.max((performance.now() - start) / 1000, 0.001);
  return Math.round((result.tokens / elapsedSec) * 10) / 10;
}
