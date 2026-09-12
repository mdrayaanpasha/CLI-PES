#!/usr/bin/env node
// cli.ts — entry point. Parses args, dispatches subcommands.

import type { OutputFormat, ResolvedPackage, Scanner } from "./core/types";
import { parseLockfile } from "./core/lockfile";
import { isGoManifest, parseGoManifest } from "./core/go-manifest";
import { isPipManifest, parsePipManifest } from "./core/pip-manifest";
import { isCargoManifest, parseCargoManifest } from "./core/cargo-manifest";
import { isComposerManifest, parseComposerManifest } from "./core/composer-manifest";
import { runScans } from "./core/scanner";
import { printProfiles, printReport } from "./report/format";
import type { NamedProfile } from "./report/format";
import { c, sym } from "./report/ui";
import { getOrCache } from "./cache/db";
import { extractPackageProfile } from "./scanners/shared-ast-extractor";

import { osvScanner, goOsvScanner, pyOsvScanner, rustOsvScanner, phpOsvScanner } from "./scanners/osv";
import { globalStateScanner } from "./scanners/global-state";
import { eventListenerScanner } from "./scanners/event-listeners";
import { versionConflictScanner } from "./scanners/version-conflict";
import { goVersionConflictScanner } from "./scanners/go-version-conflict";
import { goGlobalStateScanner, goEventListenerScanner } from "./scanners/go-collision";
import { pyGlobalStateScanner, pyHooksScanner } from "./scanners/py-collision";
import { rustGlobalStateScanner, rustHooksScanner } from "./scanners/rust-collision";
import { phpGlobalStateScanner, phpHooksScanner } from "./scanners/php-collision";

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

// Python (pip) registry. osv + version-conflict work off the manifest alone;
// global-state and event-listeners read installed source from a venv's
// site-packages when one is discoverable beside the manifest (heuristic scan —
// see py-profile-extractor). version-conflict is language-agnostic and reused
// from npm. See docs/ecosystems/python-pip.md.
const pyScanners: Scanner[] = [
  pyOsvScanner,
  pyGlobalStateScanner,
  pyHooksScanner,
  versionConflictScanner,
];

// Rust (Cargo) registry. osv + version-conflict work off the manifest alone
// (version-conflict is language-agnostic and reused from npm); global-state and
// event-listeners read crate source from the cargo registry cache
// (~/.cargo/registry/src, or COLLIDE_CARGO_SRC) when a crate is unpacked there
// — a heuristic scan flagging process-global resource sharing (global allocator,
// env writes) and set-once hooks (logger, panic hook, signals). Crates not on
// disk degrade to osv + version-conflict. See docs/ecosystems/rust-cargo.md.
const rustScanners: Scanner[] = [
  rustOsvScanner,
  rustGlobalStateScanner,
  rustHooksScanner,
  versionConflictScanner,
];

// PHP (Composer) registry. osv + version-conflict work off the manifest alone
// (version-conflict is language-agnostic and reused from npm); global-state and
// event-listeners read vendor source, which Composer co-locates beside the
// lockfile at vendor/<vendor>/<package>/ (heuristic scan — see
// php-profile-extractor). Root-namespace function redeclarations (a PHP fatal
// error), define()/ini_set()/$GLOBALS writes, and set-once hooks (error/exception
// handlers, shutdown functions, autoloaders, pcntl signals) are flagged.
// Packages absent from vendor/ degrade to osv + version-conflict. See
// docs/ecosystems/php-composer.md.
const phpScanners: Scanner[] = [
  phpOsvScanner,
  phpGlobalStateScanner,
  phpHooksScanner,
  versionConflictScanner,
];

interface Ecosystem {
  name: "npm" | "go" | "python" | "rust" | "php";
  scanners: Scanner[];
  parse: (manifestPath: string) => ResolvedPackage[];
}

/** Pick the ecosystem (parser + scanner set) from the manifest filename. */
function resolveEcosystem(manifestPath: string): Ecosystem {
  if (isGoManifest(manifestPath)) {
    return { name: "go", scanners: goScanners, parse: parseGoManifest };
  }
  if (isPipManifest(manifestPath)) {
    return { name: "python", scanners: pyScanners, parse: parsePipManifest };
  }
  if (isCargoManifest(manifestPath)) {
    return { name: "rust", scanners: rustScanners, parse: parseCargoManifest };
  }
  if (isComposerManifest(manifestPath)) {
    return { name: "php", scanners: phpScanners, parse: parseComposerManifest };
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
