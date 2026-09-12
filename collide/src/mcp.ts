#!/usr/bin/env node
// mcp.ts — Model Context Protocol server exposing collide's scanner to Claude
// (and any MCP client). Speaks stdio. Wraps the same in-process scan engine the
// CLI uses (core/api.ts), so tool output stays identical to `collide scan --format=json`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { scanManifest } from "./core/api.js";

const server = new McpServer({
  name: "collide",
  version: "0.1.0",
});

server.registerTool(
  "scan_dependencies",
  {
    title: "Scan dependencies for collisions & vulnerabilities",
    description:
      "Scan a dependency manifest/lockfile for known vulnerabilities (OSV), " +
      "duplicate/conflicting versions, global-state writes, and event-listener " +
      "collisions. Auto-detects the ecosystem from the filename: package-lock.json " +
      "(npm), go.sum (Go), requirements.txt (Python), Cargo.lock (Rust), " +
      "composer.lock (PHP). Returns structured findings as JSON.",
    inputSchema: {
      manifestPath: z
        .string()
        .describe(
          "Path to the lockfile/manifest to scan (e.g. ./package-lock.json, ./go.sum, ./Cargo.lock, ./composer.lock, ./requirements.txt).",
        ),
      only: z
        .array(z.string())
        .optional()
        .describe(
          "Optional subset of scanner names to run, e.g. ['osv','version-conflict']. Omit to run all scanners for the ecosystem.",
        ),
    },
  },
  async ({ manifestPath, only }) => {
    const abs = resolve(manifestPath);
    if (!existsSync(abs)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Manifest not found: ${abs}. Provide a path to a lockfile such as package-lock.json, go.sum, requirements.txt, Cargo.lock, or composer.lock.`,
          },
        ],
      };
    }

    try {
      const result = await scanManifest(abs, only);
      const counts = { high: 0, medium: 0, low: 0 } as Record<string, number>;
      for (const f of result.findings) counts[f.severity]++;

      const summary = {
        ecosystem: result.ecosystem,
        manifest: result.lockfilePath,
        packageCount: result.packageCount,
        scannersRun: result.scanners,
        scannersErrored: result.errored,
        findingCount: result.findings.length,
        severityCounts: counts,
        findings: result.findings,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Scan failed: ${(err as Error).message}` },
        ],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP protocol channel.
  process.stderr.write("collide MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`collide MCP server failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
