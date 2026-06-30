import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function detectGpuName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    const name = stdout.trim().split("\n")[0]?.trim();
    return name || "NVIDIA GPU";
  } catch {
    return process.env.GRIDLOCK_HW_TIER ?? "NVIDIA GPU";
  }
}
