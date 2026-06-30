# worker-cli

Headless GPU worker for the [Gridlock](https://grid-lock.tech) decentralized inference network. Connects to the [router](https://github.com/Gridlockcompute/router) over WebSocket, registers your Solana wallet as operator identity, and runs chat jobs locally via **Ollama** or **vLLM**.

**Production router:** [https://api.grid-lock.tech](https://api.grid-lock.tech)

## What it is

`worker-cli` (npm package `@gridlock/native-worker`) is the command-line worker client for operators who want to contribute GPU compute without a desktop UI. It:

1. Detects your GPU and runs a short throughput benchmark
2. Registers with the Gridlock router (`POST /v1/workers/register`)
3. Maintains REST heartbeats and a persistent WebSocket at `/v1/ws`
4. Executes inference jobs pushed by the router and reports TTFT, TPOT, and token counts
5. Optionally computes attestation hashes for confidential (TEE) jobs

Use the same Solana **public address** here as on the [web dashboard](https://grid-lock.tech/worker) so earnings, jobs, and connection status appear in one place.

## Features

- **Headless operation** — no Electron, no browser; ideal for servers and Linux GPU boxes
- **Dual inference backends** — auto-detect Ollama or vLLM; bootstrap Ollama and pull a default model on first run
- **WebSocket job dispatch** — real-time job push from the router with automatic reconnect
- **GPU detection** — reports hardware tier at registration (via `nvidia-smi` where available)
- **Benchmark mode** — `--benchmark` runs throughput test and exits
- **Confidential jobs** — SHA-256 attestation hash for TEE-tier work when enabled
- **Configurable roles** — register as Prefill, Decode, or other worker roles via env/flag

## Prerequisites

- **Node.js** 18 or later
- **NVIDIA GPU** with CUDA drivers (recommended for local inference)
- **Ollama** ([download](https://ollama.com/download)) — recommended on Windows and macOS
- **vLLM** — recommended on Linux/WSL with an OpenAI-compatible server on port 8000
- A **Solana wallet public key** (private key never required)

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

# 2. Start the worker
gridlock-native-worker --wallet YOUR_SOLANA_PUBKEY
```

On first run with Ollama, the worker auto-starts Ollama if needed and pulls `llama3.1:8b`.

Windows PowerShell example:

```powershell
npm install
npm run build
node dist/index.js --wallet YOUR_SOLANA_PUBKEY
```

## Configuration

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <pubkey>` | — | Solana wallet address (**required**, or set `GRIDLOCK_WALLET`) |
| `--url <url>` | `https://api.grid-lock.tech` | Gridlock router URL |
| `--inference <backend>` | `auto` | `auto`, `ollama`, or `vllm` |
| `--benchmark` | — | Run benchmark only, then exit |
| `--version` | — | Print version |
| `--help` | — | Print help |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIDLOCK_WALLET` | — | Solana pubkey (alternative to `--wallet`) |
| `GRIDLOCK_BACKEND_URL` | `https://api.grid-lock.tech` | Router API base URL |
| `GRIDLOCK_INFERENCE` | `auto` | Inference backend: `auto`, `ollama`, or `vllm` |
| `GRIDLOCK_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API (local dev) |
| `GRIDLOCK_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model tag |
| `GRIDLOCK_VLLM_URL` | `http://127.0.0.1:8000/v1` | vLLM OpenAI-compatible API (local dev) |
| `GRIDLOCK_VLLM_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` | vLLM model id |
| `GRIDLOCK_ROLE` | `Prefill` | Worker role sent at registration |
| `GRIDLOCK_TEE_CAPABLE` | `false` | Set `true` to register as TEE-capable |

### Local development

Point at a local router instance:

```bash
gridlock-native-worker \
  --wallet YOUR_SOLANA_PUBKEY \
  --url http://127.0.0.1:8080
```

## Usage examples

**Standard production run:**

```bash
export GRIDLOCK_WALLET=YourSolanaPubkeyHere
gridlock-native-worker
```

**Force vLLM backend:**

```bash
gridlock-native-worker --wallet YOUR_PUBKEY --inference vllm
```

**Benchmark only (no registration):**

```bash
gridlock-native-worker --wallet YOUR_PUBKEY --benchmark
```

**Custom Ollama model:**

```bash
GRIDLOCK_OLLAMA_MODEL=mistral:7b gridlock-native-worker --wallet YOUR_PUBKEY
```

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
│   ├── index.ts       # CLI entry (commander)
│   ├── worker.ts      # WebSocket session + job loop
│   ├── inference.ts   # Ollama / vLLM adapters
│   ├── ollama.ts      # Ollama bootstrap
│   ├── gpu.ts         # GPU detection
│   └── attestation.ts # Confidential job hashing
├── bin/
│   └── gridlock-native-worker.cjs
└── package.json
```

## Related repos

| Repo | Role |
|------|------|
| [router](https://github.com/Gridlockcompute/router) | Hono API — job routing, WebSocket hub, billing |
| [worker-desktop](https://github.com/Gridlockcompute/worker-desktop) | Electron GUI worker with setup wizard |
| [programs](https://github.com/Gridlockcompute/programs) | Solana Anchor programs — escrow, SLA, fees |

**Website:** [https://grid-lock.tech](https://grid-lock.tech) · **API docs:** [https://grid-lock.tech/docs](https://grid-lock.tech/docs)

## License

MIT
