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
} from "./ollama.js";

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

async function ensureOllamaReady(): Promise<void> {
  if (await checkOllama()) return;

  const preferredUrl = process.env.GRIDLOCK_OLLAMA_URL?.replace(/\/$/, "") ?? OLLAMA_URL_CANDIDATES[0] ?? OLLAMA_URL;
  setOllamaUrl(preferredUrl);

  const binary = findOllamaBinary();
  if (binary) {
    await bootstrapOllama(preferredUrl, OLLAMA_MODEL);
    setOllamaUrl(preferredUrl);
    return;
  }

  throw new Error(
    "Ollama is not installed.\n" +
      "  1. Download from https://ollama.com/download\n" +
      "  2. Install, then open Ollama from the Start menu\n" +
      `  3. Run: ollama pull ${OLLAMA_MODEL}`,
  );
}

export async function checkVllm(): Promise<boolean> {
  try {
    const res = await fetch(`${VLLM_BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveInferenceBackend(preferred: InferenceBackend = INFERENCE_BACKEND): Promise<ActiveBackend> {
  if (preferred === "ollama") {
    await ensureOllamaReady();
    activeBackend = "ollama";
    activeModel = OLLAMA_MODEL;
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

  // auto — prefer Ollama (works well on Windows), fall back to vLLM
  if (await checkOllama()) {
    activeBackend = "ollama";
    activeModel = OLLAMA_MODEL;
    return activeBackend;
  }

  if (findOllamaBinary()) {
    await ensureOllamaReady();
    activeBackend = "ollama";
    activeModel = OLLAMA_MODEL;
    return activeBackend;
  }

  if (await checkVllm()) {
    activeBackend = "vllm";
    activeModel = VLLM_MODEL;
    return activeBackend;
  }

  throw new Error(
    "No inference server found.\n" +
      `  • Ollama (recommended on Windows): https://ollama.com/download → open Ollama app → ollama pull ${OLLAMA_MODEL}\n` +
      `  • vLLM (Linux/WSL): vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000\n` +
      "Set GRIDLOCK_INFERENCE=ollama|vllm to force one backend.",
  );
}

async function runOllamaInference(
  messages: ChatMessage[],
  maxTokens: number,
): Promise<{ content: string; tokens: number; ttftMs: number; tpotMs: number }> {
  const start = performance.now();
  let firstTokenAt: number | null = null;
  let content = "";
  let tokens = 0;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      options: { num_predict: maxTokens },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("Ollama returned empty body");

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
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed) as { message?: { content?: string } };
        const piece = chunk.message?.content ?? "";
        if (!piece) continue;
        if (firstTokenAt === null) firstTokenAt = performance.now();
        content += piece;
        tokens += 1;
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

async function runVllmInference(
  messages: ChatMessage[],
  maxTokens: number,
): Promise<{ content: string; tokens: number; ttftMs: number; tpotMs: number }> {
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
        };
        const piece = chunk.choices?.[0]?.delta?.content ?? "";
        if (!piece) continue;
        if (firstTokenAt === null) firstTokenAt = performance.now();
        content += piece;
        tokens += 1;
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
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<{ content: string; tokens: number; ttftMs: number; tpotMs: number }> {
  const backend = getActiveBackend();
  return backend === "ollama"
    ? runOllamaInference(messages, maxTokens)
    : runVllmInference(messages, maxTokens);
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
