import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/db/migrate-cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Workspace packages ship as TypeScript source, so bundle them into the build.
  noExternal: [/^@guardian\//],
});
