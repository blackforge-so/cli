import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: false,
  splitting: false,
  // The shebang in src/cli.ts is preserved by tsup, so no banner is needed
  // (adding one would duplicate the shebang and break the ESM parse).
});
