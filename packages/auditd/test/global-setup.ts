import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/build.mjs", import.meta.url))],
    {
      stdio: "inherit",
    },
  );
}
