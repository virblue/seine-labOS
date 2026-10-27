// Bundle the CLI + MCP server into one self-contained ESM file, so running it
// needs only `node` — no node_modules at the install location.
import { chmodSync } from "node:fs";
import { build } from "esbuild";

const outfile = "dist/seine.mjs";

await build({
  entryPoints: ["src/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  // Optional native accelerators of `ws`; never needed on Node >= 22.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __seineCreateRequire } from 'node:module';",
      "const require = __seineCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync(outfile, 0o755);
