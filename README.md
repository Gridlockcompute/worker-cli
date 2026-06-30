# @gridlock/native-worker

Headless GPU worker for [Gridlock](https://grid-lock.tech). Connects to the router over WebSocket and runs inference through **Ollama** (recommended on Windows) or **vLLM**.

## Quick start (Windows)

```powershell
# 1. Install Ollama from https://ollama.com/download

# 2. In the gridlock-native-worker folder (one-time setup)
npm install
npm run build
npm link

# 3. Start the worker
gridlock-native-worker --wallet YOUR_SOLANA_PUBKEY
```

The worker will auto-start Ollama if needed and pull `llama3.1:8b` on first run.

Alternative without `npm link`:

```powershell
node dist/index.js --wallet YOUR_SOLANA_PUBKEY
```

> **Note:** `npx @gridlock/native-worker` will work after the package is published to npm. Until then, use `npm link` or `node dist/index.js`.

## Options

```
--wallet <pubkey>       Worker wallet address (required, or GRIDLOCK_WALLET)
--url <url>             Backend URL (default: https://api.grid-lock.tech)
--inference <backend>   auto | ollama | vllm (default: auto)
--benchmark             Benchmark only, then exit
--version               Show version
--help                  Show help
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIDLOCK_WALLET` | — | Solana pubkey |
| `GRIDLOCK_BACKEND_URL` | `https://api.grid-lock.tech` | Router API |
| `GRIDLOCK_INFERENCE` | `auto` | `auto`, `ollama`, or `vllm` |
| `GRIDLOCK_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API |
| `GRIDLOCK_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model |
| `GRIDLOCK_VLLM_URL` | `http://127.0.0.1:8000/v1` | vLLM OpenAI API |
| `GRIDLOCK_VLLM_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` | vLLM model id |
| `GRIDLOCK_ROLE` | `Prefill` | Worker role at registration |

## Requirements

- Node.js 18+
- NVIDIA GPU with CUDA (for local inference)
- **Ollama** (Windows/macOS) or **vLLM** (Linux/WSL)

## Build

```bash
npm run build
```
