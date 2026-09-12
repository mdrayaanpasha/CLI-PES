#!/usr/bin/env node
// cli.ts — entry point. Parses args, assembles scanners, runs, reports.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OutputFormat, Scanner } from "./core/types.js";
import { parseLockfile } from "./core/lockfile.js";
import { runScans } from "./core/scanner.js";
import { printReport } from "./report/format.js";

import { osvScanner } from "./scanners/osv.js";
import { globalStateScanner } from "./scanners/global-state.js";
import { eventListenerScanner } from "./scanners/event-listeners.js";
import { versionConflictScanner } from "./scanners/version-conflict.js";

// Registry — adding a 5th scanner = one import + one line here.
export const allScanners: Scanner[] = [
  osvScanner,
  globalStateScanner,
  eventListenerScanner,
  versionConflictScanner,
];

export interface Args {
  lockfilePath: string;
  only?: string[];
  format: OutputFormat;
}

export function parseArgs(argv: string[]): Args {
  // Usage: collide scan <lockfile> [--only=a,b] [--format=json]
  const args = argv.slice(2);
  const rest = args[0] === "scan" ? args.slice(1) : args;
  const lockfilePath = rest.find((a) => !a.startsWith("--")) ?? "package-lock.json";
  const onlyArg = rest.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? onlyArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const format = (rest.find((a) => a.startsWith("--format="))?.split("=")[1] ??
    "table") as OutputFormat;
  return { lockfilePath, only, format };
}

export function resolveEnabledScanners(
  only?: string[],
  scanners: Scanner[] = allScanners,
): Scanner[] {
  if (!only || only.length === 0) {
    return scanners;
  }
  return scanners.filter((s) => only.includes(s.name));
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const enabled = resolveEnabledScanners(args.only, allScanners);
  const packages = parseLockfile(args.lockfilePath);
  const findings = await runScans(packages, enabled);
  printReport(findings, args.format);
}

// Only auto-run if directly executed as the main CLI entry script
const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

