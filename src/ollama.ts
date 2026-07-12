import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workerLog } from "./console-io.js";
import { isInteractiveTerminal, promptOllamaModel } from "./model-select.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkOllamaAt(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function findOllamaBinary(): string | null {
  const candidates: string[] = [];

  if (process.env.GRIDLOCK_OLLAMA_BIN) {
    candidates.push(process.env.GRIDLOCK_OLLAMA_BIN);
  }
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
    }
    if (process.env.ProgramFiles) {
      candidates.push(join(process.env.ProgramFiles, "Ollama", "ollama.exe"));
    }
  }
  candidates.push("ollama");

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const out = spawnSync(cmd, [candidate], { encoding: "utf8" });
      if (out.status === 0 && out.stdout.trim()) {
        return out.stdout.trim().split(/\r?\n/)[0] ?? candidate;
      }
    } catch {
      /* try next */
    }
  }

  return null;
}

/** Install Ollama on Linux/macOS when missing (official install script). */
export async function installOllama(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      "Ollama is not installed.\n" +
        "  1. Download from https://ollama.com/download\n" +
        "  2. Install, then open Ollama from the Start menu\n" +
        "  3. Re-run this worker",
    );
  }

  if (process.env.GRIDLOCK_SKIP_OLLAMA_INSTALL === "true") {
    throw new Error(
      "Ollama is not installed. Set GRIDLOCK_SKIP_OLLAMA_INSTALL=false or install from https://ollama.com/download",
    );
  }

  workerLog("Ollama not found — installing via https://ollama.com/install.sh …");
  const result = spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      "Ollama install failed. Install manually: curl -fsSL https://ollama.com/install.sh | sh",
    );
  }
}

export async function resolveOllamaBinary(): Promise<string> {
  const existing = findOllamaBinary();
  if (existing) return existing;
  await installOllama();
  const binary = findOllamaBinary();
  if (!binary) {
    throw new Error("Ollama install completed but binary not found in PATH. Restart your shell and retry.");
  }
  return binary;
}

export function startOllamaServe(binary: string): void {
  const child = spawn(binary, ["serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function waitForOllama(baseUrl: string, timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkOllamaAt(baseUrl)) return true;
    await sleep(750);
  }
  return false;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
}

export async function listOllamaModels(baseUrl: string): Promise<OllamaModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string; size?: number }[] };
    return (data.models ?? [])
      .map((m) => ({ name: String(m.name ?? "").trim(), size: Number(m.size ?? 0) }))
      .filter((m) => m.name.length > 0);
  } catch {
    return [];
  }
}

export function findModelMatch(models: OllamaModelInfo[], preferred: string): string | null {
  const want = preferred.trim();
  if (!want) return null;
  const names = models.map((m) => m.name);
  if (names.includes(want)) return want;
  const base = want.split(":", 1)[0] ?? want;
  return names.find((n) => n === base || n.startsWith(`${base}:`)) ?? null;
}

const FALLBACK_MODEL_CANDIDATES = ["llama3.2:3b", "llama3.1:8b", "phi3:mini"];

export function pickInstalledFallback(models: OllamaModelInfo[], preferred: string): string | null {
  for (const candidate of [preferred, ...FALLBACK_MODEL_CANDIDATES]) {
    const hit = findModelMatch(models, candidate);
    if (hit) return hit;
  }
  return models[0]?.name ?? null;
}

async function modelIsAvailable(baseUrl: string, model: string): Promise<boolean> {
  const installed = await listOllamaModels(baseUrl);
  return findModelMatch(installed, model) !== null;
}

export async function ensureOllamaModel(baseUrl: string, binary: string, model: string): Promise<void> {
  if (await modelIsAvailable(baseUrl, model)) return;

  workerLog(`Pulling Ollama model ${model}… (one-time download, may take several minutes)`);
  const result = spawnSync(binary, ["pull", model], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to pull ${model}. Run manually: ollama pull ${model}`);
  }
}

export interface ResolveOllamaModelOptions {
  /** User-requested model (--model); pulls if missing instead of picking another install. */
  preferred?: string;
  interactive?: boolean;
}

export async function resolveOllamaModel(
  baseUrl: string,
  binary: string,
  options: ResolveOllamaModelOptions = {},
): Promise<string> {
  const explicitPreferred = Boolean(options.preferred?.trim());
  const preferred = (options.preferred ?? process.env.GRIDLOCK_OLLAMA_MODEL ?? "llama3.1:8b").trim();
  const interactive = options.interactive ?? isInteractiveTerminal();
  const installed = await listOllamaModels(baseUrl);

  const preferredHit = findModelMatch(installed, preferred);
  if (preferredHit) return preferredHit;

  if (explicitPreferred) {
    workerLog(`Pulling requested Ollama model ${preferred}…`);
    await ensureOllamaModel(baseUrl, binary, preferred);
    return preferred;
  }

  if (installed.length === 1) {
    const only = installed[0]!.name;
    workerLog(`Using installed Ollama model: ${only}`);
    return only;
  }

  if (installed.length > 1) {
    if (interactive) {
      const picked = await promptOllamaModel(installed, preferred);
      if (findModelMatch(installed, picked)) return picked;
      await ensureOllamaModel(baseUrl, binary, picked);
      return picked;
    }

    const fallback = pickInstalledFallback(installed, preferred);
    if (fallback) {
      workerLog(`Using installed Ollama model: ${fallback}`);
      return fallback;
    }
  }

  workerLog(
    installed.length === 0
      ? `No Ollama models installed. Pulling ${preferred}…`
      : `Preferred model ${preferred} not installed. Pulling…`,
  );
  await ensureOllamaModel(baseUrl, binary, preferred);
  return preferred;
}

export async function bootstrapOllama(
  baseUrl: string,
  modelOptions: ResolveOllamaModelOptions = {},
): Promise<string> {
  const binary = await resolveOllamaBinary();

  if (!(await checkOllamaAt(baseUrl))) {
    workerLog("Ollama not running — starting it…");
    startOllamaServe(binary);
    if (!(await waitForOllama(baseUrl))) {
      throw new Error(
        `Ollama did not respond at ${baseUrl}.\n` +
          (process.platform === "win32"
            ? "  Open the Ollama app from the Start menu (system tray), wait a few seconds, then retry."
            : "  Check: systemctl status ollama  — or run: ollama serve"),
      );
    }
  }

  return resolveOllamaModel(baseUrl, binary, modelOptions);
}
