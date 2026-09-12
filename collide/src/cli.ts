#!/usr/bin/env node
// cli.ts — entry point. Parses args, dispatches subcommands.

import type { OutputFormat } from "./core/types";
import { parseLockfile } from "./core/lockfile";
import { isGoManifest } from "./core/go-manifest";
import { isPipManifest } from "./core/pip-manifest";
import { isCargoManifest } from "./core/cargo-manifest";
import { isComposerManifest } from "./core/composer-manifest";
import { scanManifest } from "./core/api";
import { printProfiles, printReport } from "./report/format";
import type { NamedProfile } from "./report/format";
import { c, sym } from "./report/ui";
import { getOrCache } from "./cache/db";
import { extractPackageProfile } from "./scanners/shared-ast-extractor";

type Severity = "low" | "medium" | "high";
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

interface Args {
  command: string;
  lockfilePath: string;
  only?: string[];
  format: OutputFormat;
  failOn?: Severity;
}

function parseArgs(argv: string[]): Args {
  // Usage: collide <command> <lockfile> [--only=a,b] [--format=json]
  const rest = argv.slice(2);
  const command = rest[0] ?? "scan";
  const positional = rest.slice(1).filter((a) => !a.startsWith("--"));
  const flags = rest.slice(1).filter((a) => a.startsWith("--"));

  const lockfilePath = positional[0] ?? "package-lock.json";
  const only = flags.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const format = (flags.find((a) => a.startsWith("--format="))?.split("=")[1] ??
    "table") as OutputFormat;
  const failOnRaw = flags.find((a) => a.startsWith("--fail-on="))?.split("=")[1];
  if (failOnRaw !== undefined && !(failOnRaw in SEVERITY_RANK)) {
    console.error(
      `Invalid --fail-on="${failOnRaw}". Expected one of: low, medium, high.`,
    );
    process.exit(2);
  }
  const failOn = failOnRaw as Severity | undefined;
  return { command, lockfilePath, only, format, failOn };
}

/** Phase 1: per-package profiling — the `profile` subcommand. */
async function runProfile(args: Args): Promise<void> {
  if (isGoManifest(args.lockfilePath)) {
    console.error(
      `\n  ${c.red(sym.cross)} ${c.bold("profile is not supported for Go manifests.")}`,
    );
    console.error(
      `  ${c.gray("Go source lives in the module cache — use `scan` (osv + version-conflict).")}\n`,
    );
    process.exit(2);
  }
  if (isPipManifest(args.lockfilePath)) {
    console.error(
      `\n  ${c.red(sym.cross)} ${c.bold("profile is not supported for Python manifests.")}`,
    );
    console.error(
      `  ${c.gray("Python source lives in site-packages — use `scan` (osv + version-conflict + collision).")}\n`,
    );
    process.exit(2);
  }
  if (isCargoManifest(args.lockfilePath)) {
    console.error(
      `\n  ${c.red(sym.cross)} ${c.bold("profile is not supported for Rust manifests.")}`,
    );
    console.error(
      `  ${c.gray("Crate source lives in the cargo registry cache — use `scan` (osv + version-conflict).")}\n`,
    );
    process.exit(2);
  }
  if (isComposerManifest(args.lockfilePath)) {
    console.error(
      `\n  ${c.red(sym.cross)} ${c.bold("profile is not supported for PHP manifests.")}`,
    );
    console.error(
      `  ${c.gray("Vendor source is scanned heuristically — use `scan` (osv + version-conflict + collision).")}\n`,
    );
    process.exit(2);
  }
  const packages = parseLockfile(args.lockfilePath);
  const profiles: NamedProfile[] = await Promise.all(
    packages.map(async (pkg) => ({
      name: pkg.name,
      version: pkg.version,
      profile: await getOrCache(pkg, extractPackageProfile),
    })),
  );
  printProfiles(profiles, args.format, { lockfilePath: args.lockfilePath });
}

async function runScan(args: Args): Promise<void> {
  const quiet = args.format === "json"; // keep JSON output pristine

  const result = await scanManifest(args.lockfilePath, args.only, {
    onStart: (name) => {
      if (!quiet) process.stderr.write(`  ${c.gray(`${sym.dot} scanning ${name}…`)}\n`);
    },
    onError: (name, err) => {
      if (!quiet) {
        process.stderr.write(`  ${c.yellow(sym.warn)} ${name} failed: ${(err as Error).message}\n`);
      }
    },
  });

  printReport(result.findings, args.format, {
    lockfilePath: result.lockfilePath,
    packageCount: result.packageCount,
    scanners: result.scanners,
    perScanner: result.perScanner,
    errored: result.errored,
  });

  // CI gate: exit non-zero when findings meet or exceed the --fail-on threshold.
  if (args.failOn) {
    const threshold = SEVERITY_RANK[args.failOn];
    const breaching = result.findings.filter(
      (f) => SEVERITY_RANK[f.severity as Severity] >= threshold,
    );
    if (breaching.length > 0) {
      if (args.format !== "json") {
        process.stderr.write(
          `\n  ${c.red(sym.cross)} ${c.bold(
            `${breaching.length} finding${breaching.length === 1 ? "" : "s"} at severity ≥ ${args.failOn}`,
          )} ${c.gray("— failing (--fail-on)")}\n`,
        );
      }
      process.exit(1);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "profile":
      await runProfile(args);
      break;
    case "scan":
      await runScan(args);
      break;
    default:
      console.error(
        `Unknown command "${args.command}". Usage: collide <scan|profile> <lockfile> [--only=...] [--format=json] [--fail-on=low|medium|high]`,
      );
      process.exit(2);
  }
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT") {
    console.error(`\n  ${c.red(sym.cross)} ${c.bold("Lockfile not found:")} ${e.path ?? ""}`);
    console.error(`  ${c.gray("Check the path, or run `npm install` in that project first.")}\n`);
  } else {
    console.error(`\n  ${c.red(sym.cross)} ${c.bold(e.message)}\n`);
  }
  process.exit(1);
});
