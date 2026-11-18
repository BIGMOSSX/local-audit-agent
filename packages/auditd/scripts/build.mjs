import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/main.js`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "warning",
});
