import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function lockPath(wallet: string): string {
  const dir = join(homedir(), ".gridlock");
  mkdirSync(dir, { recursive: true });
  return join(dir, `worker-${wallet.toLowerCase()}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One worker process per wallet — prevents reconnect fights on the router. */
export function acquireWorkerLock(wallet: string): () => void {
  const path = lockPath(wallet);

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
      throw new Error(
        `Another worker is already running for this wallet (PID ${pid}).\n` +
          `  Stop it first: kill ${pid}`,
      );
    }
    try {
      unlinkSync(path);
    } catch {
      /* stale */
    }
  }

  writeFileSync(path, String(process.pid), "utf8");

  return () => {
    try {
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
        unlinkSync(path);
      }
    } catch {
      /* ignore */
    }
  };
}
