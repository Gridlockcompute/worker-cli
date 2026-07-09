#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getBackendUrl, type InferenceBackend } from "./config.js";
import { parseWorkerWallet } from "./wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

const program = new Command();

program
  .name("gridlock-native-worker")
  .description("Native headless worker for the Gridlock inference network")
  .version(pkg.version)
  .option("--wallet <address>", "EVM wallet address (worker identity)")
  .option("--inference <backend>", "Inference backend: auto, ollama, or vllm", "auto")
  .option("--benchmark", "Run benchmark only, then exit")
  .action(async (opts: { wallet?: string; inference: string; benchmark?: boolean }) => {
    const walletRaw = opts.wallet ?? process.env.GRIDLOCK_WALLET;
    if (!walletRaw) {
      console.error("Error: --wallet is required (or set GRIDLOCK_WALLET to your 0x EVM address).");
      process.exit(1);
    }

    let wallet: string;
    try {
      wallet = parseWorkerWallet(walletRaw);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    const inference = opts.inference as InferenceBackend;
    if (!["auto", "ollama", "vllm"].includes(inference)) {
      console.error('Error: --inference must be "auto", "ollama", or "vllm".');
      process.exit(1);
    }

    try {
      const { startWorker } = await import("./worker.js");
      await startWorker({
        wallet,
        backendUrl: getBackendUrl(),
        inference,
        benchmarkOnly: opts.benchmark ?? false,
      });
    } catch (err) {
      console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parse();
