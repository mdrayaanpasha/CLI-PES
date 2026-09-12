#!/usr/bin/env node
// cli.ts — entry point. Parses args, dispatches subcommands.

import type { OutputFormat, ResolvedPackage, Scanner } from "./core/types";
import { parseLockfile } from "./core/lockfile";
import { isGoManifest, parseGoManifest } from "./core/go-manifest";
import { runScans } from "./core/scanner";
import { printProfiles, printReport } from "./report/format";
import type { NamedProfile } from "./report/format";
import { c, sym } from "./report/ui";
import { getOrCache } from "./cache/db";
import { extractPackageProfile } from "./scanners/shared-ast-extractor";

import { osvScanner, goOsvScanner } from "./scanners/osv";
import { globalStateScanner } from "./scanners/global-state";
import { eventListenerScanner } from "./scanners/event-listeners";
import { versionConflictScanner } from "./scanners/version-conflict";
import { goVersionConflictScanner } from "./scanners/go-version-conflict";
import { goGlobalStateScanner, goEventListenerScanner } from "./scanners/go-collision";

// npm registry — adding a 5th scanner = one import + one line here.
const npmScanners: Scanner[] = [
  osvScanner,
  globalStateScanner,
  eventListenerScanner,
  versionConflictScanner,
];

// Go registry. osv + version-conflict work off the manifest alone; global-state
// and event-listeners read module source from the Go module cache (heuristic
// scan — see go-profile-extractor). See docs/ecosystems/go-modules.md.
const goScanners: Scanner[] = [
  goOsvScanner,
  goGlobalStateScanner,
  goEventListenerScanner,
  goVersionConflictScanner,
];

interface Ecosystem {
  name: "npm" | "go";
  scanners: Scanner[];
  parse: (manifestPath: string) => ResolvedPackage[];
}

/** Pick the ecosystem (parser + scanner set) from the manifest filename. */
function resolveEcosystem(manifestPath: string): Ecosystem {
  if (isGoManifest(manifestPath)) {
    return { name: "go", scanners: goScanners, parse: parseGoManifest };
  }
  return { name: "npm", scanners: npmScanners, parse: parseLockfile };
}

interface Args {
  command: string;
  lockfilePath: string;
  only?: string[];
  format: OutputFormat;
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
  return { command, lockfilePath, only, format };
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
  const ecosystem = resolveEcosystem(args.lockfilePath);
  const enabled = args.only
    ? ecosystem.scanners.filter((s) => args.only!.includes(s.name))
    : ecosystem.scanners;
  const packages = ecosystem.parse(args.lockfilePath);

  const perScanner: Record<string, number> = {};
  const errored: string[] = [];
  const quiet = args.format === "json"; // keep JSON output pristine

  const findings = await runScans(packages, enabled, {
    onStart: (name) => {
      if (!quiet) process.stderr.write(`  ${c.gray(`${sym.dot} scanning ${name}…`)}\n`);
    },
    onDone: (name, count) => {
      perScanner[name] = count;
    },
    onError: (name, err) => {
      errored.push(name);
      if (!quiet) {
        process.stderr.write(`  ${c.yellow(sym.warn)} ${name} failed: ${(err as Error).message}\n`);
      }
    },
  });

  printReport(findings, args.format, {
    lockfilePath: args.lockfilePath,
    packageCount: packages.length,
    scanners: enabled.map((s) => s.name),
    perScanner,
    errored,
  });
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
        `Unknown command "${args.command}". Usage: collide <scan|profile> <lockfile> [--only=...] [--format=json]`,
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
