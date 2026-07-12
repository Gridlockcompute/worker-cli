import { isDashboardMode } from "./dashboard.js";

/** Log without breaking the live stdout dashboard (uses stderr in dashboard mode). */
export function workerLog(...args: unknown[]): void {
  if (isDashboardMode()) {
    console.error(...args);
  } else {
    console.log(...args);
  }
}
