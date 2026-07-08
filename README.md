# worker-cli

Headless GPU worker for the [Gridlock](https://grid-lock.tech) decentralized inference network. Connects to the [router](https://github.com/Gridlockcompute/router) over WebSocket, registers your **EVM wallet** (`0x…` on Robinhood Chain) as operator identity, and runs chat jobs locally via **Ollama** or **vLLM**.

**Production router:** [https://api.grid-lock.tech](https://api.grid-lock.tech)

## What it is

`worker-cli` (npm package `@gridlock/native-worker`) is the command-line worker client for operators who want to contribute GPU compute without a desktop UI. It:

1. Detects your GPU and runs a short throughput benchmark
2. Registers with the Gridlock router (`POST /v1/workers/register`)
3. Maintains REST heartbeats and a persistent WebSocket at `/v1/ws`
4. Executes inference jobs pushed by the router and reports TTFT, TPOT, and token counts
5. Optionally attaches a TEE attestation quote at registration and computes job attestation hashes for confidential work

Use the same **0x EVM address** here as on the [web worker dashboard](https://grid-lock.tech/worker) so earnings, jobs, and connection status appear in one place. Stake and withdraw native ETH from the web console — the CLI never needs your private key.

## Features

- **Headless operation** — no Electron, no browser; ideal for servers and Linux GPU boxes
- **EVM identity** — validates `0x` addresses locally before registration
- **Dual inference backends** — auto-detect Ollama or vLLM; bootstrap Ollama and pull a default model on first run
- **WebSocket job dispatch** — real-time job push from the router with automatic reconnect
- **GPU detection** — reports hardware tier at registration (via `nvidia-smi` where available)
- **Benchmark mode** — `--benchmark` runs throughput test and exits
- **Confidential jobs** — registration attestation quote + per-job SHA-256 hash for TEE-tier work
- **Configurable roles** — register as Prefill, Decode, or other worker roles via env/flag

## Prerequisites

- **Node.js** 18 or later
- **NVIDIA GPU** with CUDA drivers (recommended for local inference)
- **Ollama** ([download](https://ollama.com/download)) — recommended on Windows and macOS
- **vLLM** — recommended on Linux/WSL with an OpenAI-compatible server on port 8000
- An **EVM wallet address** (`0x…`) — private key never required in the CLI

## Installation

```bash
git clone https://github.com/Gridlockcompute/worker-cli.git
cd worker-cli
npm install
npm run build
```

Install globally (optional):

```bash
npm link
gridlock-native-worker --help
```

Or run directly:

```bash
node dist/index.js --help
```

## Quick start

```bash
# 1. Install Ollama (https://ollama.com/download) or start vLLM locally

# 2. Start the worker (same 0x address as MetaMask on /worker)
gridlock-native-worker --wallet 0xYourEvmAddress
```

On first run with Ollama, the worker auto-starts Ollama if needed and pulls `llama3.1:8b`.

Windows PowerShell example:

```powershell
npm install
npm run build
node dist/index.js --wallet 0xYourEvmAddress
```

## Configuration

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <address>` | — | EVM wallet address `0x…` (**required**, or set `GRIDLOCK_WALLET`) |
| `--url <url>` | `https://api.grid-lock.tech` | Gridlock router URL |
| `--inference <backend>` | `auto` | `auto`, `ollama`, or `vllm` |
| `--benchmark` | — | Run benchmark only, then exit |
| `--version` | — | Print version |
| `--help` | — | Print help |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIDLOCK_WALLET` | — | EVM address (alternative to `--wallet`) |
| `GRIDLOCK_BACKEND_URL` | `https://api.grid-lock.tech` | Router API base URL |
| `GRIDLOCK_INFERENCE` | `auto` | Inference backend: `auto`, `ollama`, or `vllm` |
| `GRIDLOCK_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API (local dev) |
| `GRIDLOCK_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model tag |
| `GRIDLOCK_VLLM_URL` | `http://127.0.0.1:8000/v1` | vLLM OpenAI-compatible API (local dev) |
| `GRIDLOCK_VLLM_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` | vLLM model id |
| `GRIDLOCK_ROLE` | `Prefill` | Worker role sent at registration |
| `GRIDLOCK_TEE_CAPABLE` | `false` | Set `true` to register as TEE-capable |
| `GRIDLOCK_ATTESTATION_QUOTE_FILE` | — | Path to production NRAS/SEV quote JSON for registration |
| `GRIDLOCK_ATTESTATION_QUOTE_JSON` | — | Inline attestation quote JSON (alternative to file) |
| `GRIDLOCK_TEE_TYPE` | `nvidia_cc` | TEE type in dev quotes (`nvidia_cc`, `amd_sev_snp`) |

### Local development

Point at a local router instance:

```bash
gridlock-native-worker \
  --wallet 0xYourEvmAddress \
  --url http://127.0.0.1:8080
```

## Usage examples

**Standard production run:**

```bash
export GRIDLOCK_WALLET=0xYourEvmAddress
gridlock-native-worker
```

**Force vLLM backend:**

```bash
gridlock-native-worker --wallet 0xYourEvmAddress --inference vllm
```

**Benchmark only (no registration):**

```bash
gridlock-native-worker --wallet 0xYourEvmAddress --benchmark
```

**TEE / confidential registration (dev attestation quote from router challenge):**

```bash
GRIDLOCK_TEE_CAPABLE=true gridlock-native-worker --wallet 0xYourEvmAddress
```

For production CC GPUs, provide a vendor attestation quote:

```bash
export GRIDLOCK_TEE_CAPABLE=true
export GRIDLOCK_ATTESTATION_QUOTE_FILE=/path/to/quote.json
gridlock-native-worker --wallet 0xYourEvmAddress
```

## On-chain registration

The CLI does **not** sign Robinhood Chain transactions itself. When the router has `WORKER_REGISTRY_ONCHAIN_ENABLED=true` and `EVM_*` contract addresses configured, the **router** may register your worker on-chain after `POST /v1/workers/register`. Staking, payouts, and billing are handled via the web dashboard and router APIs.

After starting, the worker connects to `wss://api.grid-lock.tech/v1/ws`, sends `worker:register` with `worker_type: native`, and waits for `job:new` messages.

Monitor your operator on the web: [https://grid-lock.tech/worker](https://grid-lock.tech/worker)

## Development

```bash
npm run dev          # tsx watch — src/index.ts
npm run build        # compile TypeScript → dist/
npm start            # node dist/index.js
```

Project layout:

```
worker-cli/
├── src/
│   ├── index.ts            # CLI entry (commander)
│   ├── worker.ts           # WebSocket session + job loop
│   ├── wallet.ts           # EVM address validation
│   ├── attestation-quote.ts # Registration TEE quotes
│   ├── inference.ts        # Ollama / vLLM adapters
│   ├── ollama.ts           # Ollama bootstrap
│   ├── gpu.ts              # GPU detection
│   └── attestation.ts      # Per-job confidential hashing
├── bin/
│   └── gridlock-native-worker.cjs
└── package.json
```

## Related repos

| Repo | Role |
|------|------|
| [router](https://github.com/Gridlockcompute/router) | Hono API — job routing, WebSocket hub, billing |
| [worker-desktop](https://github.com/Gridlockcompute/worker-desktop) | Electron GUI worker with setup wizard |
| [contracts](https://github.com/Gridlockcompute/gridlockcompute) | EVM Solidity contracts on Robinhood Chain |

**Website:** [https://grid-lock.tech](https://grid-lock.tech) · **API docs:** [https://grid-lock.tech/docs](https://grid-lock.tech/docs)

## License

MIT
