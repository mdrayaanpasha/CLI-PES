import { defineConfig } from "tsup";

// Bundles the two entry points (CLI + MCP server) into dist/. Own source is
// bundled so relative imports resolve without .js extensions; node_modules
// dependencies (incl. the native better-sqlite3) stay external and are installed
// by npm at the consumer. Shebangs on the entry files are preserved by tsup.
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  // Keep native/runtime deps external — they are declared in "dependencies".
  external: ["better-sqlite3", "@babel/parser", "@babel/traverse", "@modelcontextprotocol/sdk", "zod"],
});
