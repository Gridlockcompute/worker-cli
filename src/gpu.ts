import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { cpus } from "node:os";

const execFileAsync = promisify(execFile);

type GpuVendor = "nvidia" | "amd" | "unknown";

interface DetectedGpu {
  vendor: GpuVendor;
  name: string;
  index: number;
}

async function runCmd(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

function nvidiaSmiBin(): string {
  const override = process.env.GRIDLOCK_NVIDIA_SMI?.trim();
  if (override) return override;

  if (process.platform === "win32") {
    for (const path of [
      join(process.env.ProgramFiles ?? "", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe"),
    ]) {
      if (path && existsSync(path)) return path;
    }
  }

  return "nvidia-smi";
}

async function rocmSmiBin(): Promise<string | null> {
  const override = process.env.GRIDLOCK_ROCM_SMI?.trim();
  if (override && existsSync(override)) return override;

  for (const candidate of ["rocm-smi", "amd-smi"]) {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(cmd, [candidate], { encoding: "utf8", windowsHide: true });
      const path = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (path) return path;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function detectCpuName(): Promise<string> {
  if (process.platform === "linux") {
    try {
      const cpuinfo = await readFile("/proc/cpuinfo", "utf8");
      for (const line of cpuinfo.split("\n")) {
        if (line.toLowerCase().includes("model name")) {
          const name = line.split(":")[1]?.trim();
          if (name) return name;
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (process.platform === "darwin") {
    const out = await runCmd("sysctl", ["-n", "machdep.cpu.brand_string"]);
    if (out) return out;
  }

  if (process.platform === "win32") {
    const out = await runCmd("wmic", ["cpu", "get", "Name", "/format:list"]);
    if (out) {
      for (const line of out.split("\n")) {
        if (line.toLowerCase().startsWith("name=")) {
          const name = line.split("=")[1]?.trim();
          if (name) return name;
        }
      }
    }
  }

  const model = cpus()[0]?.model?.trim();
  return model || `${process.platform} CPU`;
}

async function detectNvidiaGpus(): Promise<DetectedGpu[]> {
  const out = await runCmd(nvidiaSmiBin(), [
    "--query-gpu=index,name",
    "--format=csv,noheader",
  ]);
  if (!out) return [];

  const gpus: DetectedGpu[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;
    const index = Number.parseInt(parts[0] ?? "", 10);
    const name = parts[1] ?? "";
    if (!name) continue;
    gpus.push({
      vendor: "nvidia",
      name,
      index: Number.isFinite(index) ? index : gpus.length,
    });
  }
  return gpus;
}

async function detectAmdGpus(): Promise<DetectedGpu[]> {
  const bin = await rocmSmiBin();
  if (!bin) return [];

  const out = await runCmd(bin, ["--showproductname"]);
  if (!out) return [];

  const gpus: DetectedGpu[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("=") || !/gpu/i.test(trimmed)) continue;
    const name = trimmed.includes(":") ? trimmed.split(":").slice(1).join(":").trim() : trimmed;
    if (!name) continue;
    gpus.push({ vendor: "amd", name, index: gpus.length });
  }
  return gpus;
}

async function detectAllGpus(): Promise<DetectedGpu[]> {
  const nvidia = await detectNvidiaGpus();
  if (nvidia.length > 0) return nvidia;

  return detectAmdGpus();
}

function selectGpu(gpus: DetectedGpu[], gpuIndex: number): DetectedGpu | null {
  if (gpus.length === 0) return null;
  return gpus.find((g) => g.index === gpuIndex) ?? gpus[0] ?? null;
}

function formatGpuLabel(gpu: DetectedGpu): string {
  const prefix =
    gpu.vendor === "amd" ? "AMD" : gpu.vendor === "nvidia" ? "NVIDIA" : "";
  if (prefix && !gpu.name.toLowerCase().includes(prefix.toLowerCase())) {
    return `${prefix} ${gpu.name}`;
  }
  return gpu.name;
}

/** Detect compute hardware for router registration and startup logs. */
export async function detectHardwareTier(): Promise<string> {
  const override = process.env.GRIDLOCK_HW_TIER?.trim();
  if (override) return override;

  const gpuIndex = Number.parseInt(process.env.GRIDLOCK_GPU_INDEX ?? "0", 10);
  const gpus = await detectAllGpus();
  const gpu = selectGpu(gpus, Number.isFinite(gpuIndex) ? gpuIndex : 0);
  if (gpu) return formatGpuLabel(gpu);

  const cpuName = await detectCpuName();
  return `CPU · ${cpuName}`;
}

/** @deprecated Use detectHardwareTier() */
export async function detectGpuName(): Promise<string> {
  return detectHardwareTier();
}
