import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

async function modelIsAvailable(baseUrl: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = data.models?.map((m) => m.name) ?? [];
    const base = model.split(":")[0] ?? model;
    return names.some((n) => n === model || n.startsWith(`${base}:`));
  } catch {
    return false;
  }
}

export async function ensureOllamaModel(baseUrl: string, binary: string, model: string): Promise<void> {
  if (await modelIsAvailable(baseUrl, model)) return;

  console.log(`Pulling Ollama model ${model}… (one-time download, may take several minutes)`);
  const result = spawnSync(binary, ["pull", model], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to pull ${model}. Run manually: ollama pull ${model}`);
  }
}

export async function bootstrapOllama(baseUrl: string, model: string): Promise<void> {
  const binary = findOllamaBinary();
  if (!binary) {
    throw new Error(
      "Ollama is not installed.\n" +
        "  1. Download from https://ollama.com/download\n" +
        "  2. Install, then open Ollama from the Start menu\n" +
        `  3. Run: ollama pull ${model}`,
    );
  }

  if (!(await checkOllamaAt(baseUrl))) {
    console.log("Ollama not running — starting it…");
    startOllamaServe(binary);
    if (!(await waitForOllama(baseUrl))) {
      throw new Error(
        `Ollama did not respond at ${baseUrl}.\n` +
          "  Open the Ollama app from the Start menu (system tray), wait a few seconds, then retry.",
      );
    }
  }

  await ensureOllamaModel(baseUrl, binary, model);
}
