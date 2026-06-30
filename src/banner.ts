import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHEVRONS = `
\\                        //
 \\                      //
  \\                    //
   \\                  //
    \\                //
     \\              //
      \\            //
       \\          //
        \\        //
`.trimEnd();

export function printStartupBanner(): void {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
    version: string;
  };

  console.log(CHEVRONS);
  console.log(`  Gridlock Native Worker v${pkg.version}`);
  console.log();
}
