#!/usr/bin/env node
// cli.ts — entry point. Parses args, assembles scanners, runs, reports.

import type { OutputFormat, Scanner } from "./core/types";
import { parseLockfile } from "./core/lockfile";
import { runScans } from "./core/scanner";
import { printReport } from "./report/format";

import { osvScanner } from "./scanners/osv";
import { globalStateScanner } from "./scanners/global-state";
import { eventListenerScanner } from "./scanners/event-listeners";
import { versionConflictScanner } from "./scanners/version-conflict";

// Registry — adding a 5th scanner = one import + one line here.
const allScanners: Scanner[] = [
  osvScanner,
  globalStateScanner,
  eventListenerScanner,
  versionConflictScanner,
];

interface Args {
  lockfilePath: string;
  only?: string[];
  format: OutputFormat;
}

function parseArgs(argv: string[]): Args {
  // Usage: collide scan <lockfile> [--only=a,b] [--format=json]
  // TODO: replace with a real arg parser.
  const rest = argv.slice(2); // drop "scan"
  const lockfilePath = rest.find((a) => !a.startsWith("--")) ?? "package-lock.json";
  const only = rest.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const format = (rest.find((a) => a.startsWith("--format="))?.split("=")[1] ??
    "table") as OutputFormat;
  return { lockfilePath, only, format };
}

async function main() {
  const args = parseArgs(process.argv);

  const enabled = args.only
    ? allScanners.filter((s) => args.only!.includes(s.name))
    : allScanners;

  const packages = parseLockfile(args.lockfilePath);
  const findings = await runScans(packages, enabled);
  printReport(findings, args.format);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
