import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIME_GREEN = "\x1b[38;2;182;255;60m";
const RESET = "\x1b[0m";

const CHEVRONS = `
   █████████  ███████████   █████ ██████████   █████          ███████      █████████  █████   ████
  ███▒▒▒▒▒███▒▒███▒▒▒▒▒███ ▒▒███ ▒▒███▒▒▒▒███ ▒▒███         ███▒▒▒▒▒███   ███▒▒▒▒▒███▒▒███   ███▒ 
 ███     ▒▒▒  ▒███    ▒███  ▒███  ▒███   ▒▒███ ▒███        ███     ▒▒███ ███     ▒▒▒  ▒███  ███   
▒███          ▒██████████   ▒███  ▒███    ▒███ ▒███       ▒███      ▒███▒███          ▒███████    
▒███    █████ ▒███▒▒▒▒▒███  ▒███  ▒███    ▒███ ▒███       ▒███      ▒███▒███          ▒███▒▒███   
▒▒███  ▒▒███  ▒███    ▒███  ▒███  ▒███    ███  ▒███      █▒▒███     ███ ▒▒███     ███ ▒███ ▒▒███  
 ▒▒█████████  █████   █████ █████ ██████████   ███████████ ▒▒▒███████▒   ▒▒█████████  █████ ▒▒████
  ▒▒▒▒▒▒▒▒▒  ▒▒▒▒▒   ▒▒▒▒▒ ▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒▒  ▒▒▒▒▒   ▒▒▒▒ 
                                                                                                  
                                                                                                  
                                                                                                                                                                                                  
`.trimEnd();

function shouldColorize(): boolean {
  const { FORCE_COLOR, NO_COLOR } = process.env;
  if (FORCE_COLOR !== undefined) {
    return FORCE_COLOR !== "0" && FORCE_COLOR.toLowerCase() !== "false";
  }
  if (NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function colorize(text: string): string {
  if (!shouldColorize()) return text;
  return `${LIME_GREEN}${text}${RESET}`;
}

/** Print banner; returns how many terminal rows it consumed. */
export function printStartupBanner(): number {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
    version: string;
  };

  console.log(colorize(CHEVRONS));
  console.log(colorize(`  Gridlock Native Worker v${pkg.version}`));
  console.log();
  return CHEVRONS.split("\n").length + 2;
}
