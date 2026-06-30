export const DEFAULT_BACKEND_URL =
  process.env.GRIDLOCK_BACKEND_URL ?? "https://api.grid-lock.tech";

/** Gridlock router — jobs, registration, WebSocket. */
export const ROUTER_URL = DEFAULT_BACKEND_URL;

/** Local vLLM OpenAI-compatible API (separate process on your GPU machine). */
export const VLLM_BASE_URL =
  (process.env.GRIDLOCK_VLLM_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");

/** Resolved at runtime after probing localhost / 127.0.0.1. */
export let OLLAMA_URL = (process.env.GRIDLOCK_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

export function setOllamaUrl(url: string): void {
  OLLAMA_URL = url.replace(/\/$/, "");
}

export const OLLAMA_URL_CANDIDATES = [
  process.env.GRIDLOCK_OLLAMA_URL?.replace(/\/$/, ""),
  "http://127.0.0.1:11434",
  "http://localhost:11434",
].filter(Boolean) as string[];

export type InferenceBackend = "auto" | "ollama" | "vllm";

export const INFERENCE_BACKEND = (process.env.GRIDLOCK_INFERENCE ?? "auto") as InferenceBackend;

export const VLLM_MODEL =
  process.env.GRIDLOCK_VLLM_MODEL ?? process.env.GRIDLOCK_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct";

export const OLLAMA_MODEL = process.env.GRIDLOCK_OLLAMA_MODEL ?? "llama3.1:8b";

export const DEFAULT_ROLE = process.env.GRIDLOCK_ROLE ?? "Prefill";

export const BENCHMARK_TOKENS = 32;
export const MAX_OUTPUT_TOKENS = 512;

export function wsUrl(httpBase: string): string {
  const base = httpBase.replace(/\/$/, "");
  if (base.startsWith("https://")) return base.replace("https://", "wss://") + "/v1/ws";
  return base.replace("http://", "ws://") + "/v1/ws";
}
