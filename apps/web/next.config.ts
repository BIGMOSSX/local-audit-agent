import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  transpilePackages: ["@audit/ui", "@audit/design-tokens"],
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
