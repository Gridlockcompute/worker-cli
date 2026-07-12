import { parentPort } from "node:worker_threads";

export interface OllamaWorkerRequest {
  url: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
}

parentPort?.on("message", async (req: OllamaWorkerRequest) => {
  try {
    const start = performance.now();
    let firstAt: number | null = null;
    let content = "";
    let tokens = 0;

    const res = await fetch(`${req.url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        options: { num_predict: req.maxTokens },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      parentPort?.postMessage({
        type: "error",
        error: `Ollama error ${res.status}: ${text.slice(0, 200)}`,
      });
      return;
    }
    if (!res.body) {
      parentPort?.postMessage({ type: "error", error: "Ollama returned empty body" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed) as {
            message?: { content?: string };
            done?: boolean;
            eval_count?: number;
          };
          const piece = chunk.message?.content ?? "";
          if (piece) {
            if (firstAt === null) firstAt = performance.now();
            content += piece;
          }

          const evalCount = Number(chunk.eval_count ?? 0);
          if (evalCount > 0) {
            tokens = evalCount;
          } else if (piece) {
            tokens = Math.max(tokens, Math.ceil(content.length / 4));
          }

          if (piece || evalCount > 0 || chunk.done) {
            parentPort?.postMessage({
              type: "progress",
              tokens: Math.max(tokens, piece ? 1 : 0),
              maxTokens: req.maxTokens,
            });
          }
        } catch {
          /* skip malformed chunk */
        }
      }
    }

    const end = performance.now();
    const ttftMs = Math.floor((firstAt ?? end) - start);
    const outputTokens = Math.max(tokens, 1);
    const tpotMs =
      outputTokens > 1 && firstAt
        ? Math.floor((end - firstAt) / (outputTokens - 1))
        : 0;

    parentPort?.postMessage({
      type: "done",
      result: {
        content: content.trim() || "(empty)",
        tokens: outputTokens,
        ttftMs,
        tpotMs,
      },
    });
  } catch (e) {
    parentPort?.postMessage({
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
