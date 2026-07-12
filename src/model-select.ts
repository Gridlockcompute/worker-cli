import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { OllamaModelInfo } from "./ollama.js";

function formatSizeGb(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptOllamaModel(
  models: OllamaModelInfo[],
  preferred: string,
): Promise<string> {
  if (models.length === 0) return preferred;

  console.log("\nInstalled Ollama models:\n");
  for (let i = 0; i < models.length; i += 1) {
    const m = models[i]!;
    console.log(`  ${i + 1}. ${m.name} (${formatSizeGb(m.size)})`);
  }
  const pullOption = models.length + 1;
  console.log(`  ${pullOption}. Pull ${preferred} (default — not installed yet)\n`);

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (
        await rl.question(`Select model [1-${pullOption}, default 1]: `)
      ).trim();
      if (!answer) return models[0]!.name;

      const choice = Number.parseInt(answer, 10);
      if (Number.isFinite(choice) && choice >= 1 && choice <= models.length) {
        return models[choice - 1]!.name;
      }
      if (choice === pullOption) return preferred;
      console.log(`Enter a number between 1 and ${pullOption}.`);
    }
  } finally {
    rl.close();
  }
}
