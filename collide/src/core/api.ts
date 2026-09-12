// api.ts — the reusable scan engine, shared by the CLI (cli.ts) and the
// MCP server (mcp.ts). Ecosystem resolution + scanner registries live here so
// there is exactly one place that maps a manifest to its scanners.

import type { Finding, ResolvedPackage, Scanner } from "./types";
import { parseLockfile } from "./lockfile";
import { isGoManifest, parseGoManifest } from "./go-manifest";
import { isPipManifest, parsePipManifest } from "./pip-manifest";
import { isCargoManifest, parseCargoManifest } from "./cargo-manifest";
import { isComposerManifest, parseComposerManifest } from "./composer-manifest";
import { runScans } from "./scanner";

import { osvScanner, goOsvScanner, pyOsvScanner, rustOsvScanner, phpOsvScanner } from "../scanners/osv";
import { globalStateScanner } from "../scanners/global-state";
import { eventListenerScanner } from "../scanners/event-listeners";
import { versionConflictScanner } from "../scanners/version-conflict";
import { goVersionConflictScanner } from "../scanners/go-version-conflict";
import { goGlobalStateScanner, goEventListenerScanner } from "../scanners/go-collision";
import { pyGlobalStateScanner, pyHooksScanner } from "../scanners/py-collision";
import { rustGlobalStateScanner, rustHooksScanner } from "../scanners/rust-collision";
import { phpGlobalStateScanner, phpHooksScanner } from "../scanners/php-collision";

// npm registry — adding a 5th scanner = one import + one line here.
const npmScanners: Scanner[] = [
  osvScanner,
  globalStateScanner,
  eventListenerScanner,
  versionConflictScanner,
];

// Go registry. osv + version-conflict work off the manifest alone; global-state
// and event-listeners read module source from the Go module cache.
const goScanners: Scanner[] = [
  goOsvScanner,
  goGlobalStateScanner,
  goEventListenerScanner,
  goVersionConflictScanner,
];

// Python (pip) registry. version-conflict is language-agnostic and reused from npm.
const pyScanners: Scanner[] = [
  pyOsvScanner,
  pyGlobalStateScanner,
  pyHooksScanner,
  versionConflictScanner,
];

// Rust (Cargo) registry. version-conflict is language-agnostic and reused from npm.
const rustScanners: Scanner[] = [
  rustOsvScanner,
  rustGlobalStateScanner,
  rustHooksScanner,
  versionConflictScanner,
];

// PHP (Composer) registry. version-conflict is language-agnostic and reused from npm.
const phpScanners: Scanner[] = [
  phpOsvScanner,
  phpGlobalStateScanner,
  phpHooksScanner,
  versionConflictScanner,
];

export type EcosystemName = "npm" | "go" | "python" | "rust" | "php";

export interface Ecosystem {
  name: EcosystemName;
  scanners: Scanner[];
  parse: (manifestPath: string) => ResolvedPackage[];
}

/** Pick the ecosystem (parser + scanner set) from the manifest filename. */
export function resolveEcosystem(manifestPath: string): Ecosystem {
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

export interface ScanHooks {
  onStart?: (name: string) => void;
  onDone?: (name: string, count: number) => void;
  onError?: (name: string, err: unknown) => void;
}

export interface ScanResult {
  ecosystem: EcosystemName;
  lockfilePath: string;
  packageCount: number;
  scanners: string[];
  perScanner: Record<string, number>;
  errored: string[];
  findings: Finding[];
}

/**
 * Run all (or a subset of) scanners for a manifest and return structured
 * results. Pure data — no printing. The CLI renders this; the MCP server
 * serialises it.
 */
export async function scanManifest(
  lockfilePath: string,
  only?: string[],
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  const ecosystem = resolveEcosystem(lockfilePath);
  const enabled = only
    ? ecosystem.scanners.filter((s) => only.includes(s.name))
    : ecosystem.scanners;
  const packages = ecosystem.parse(lockfilePath);

  const perScanner: Record<string, number> = {};
  const errored: string[] = [];

  const findings = await runScans(packages, enabled, {
    onStart: (name) => hooks.onStart?.(name),
    onDone: (name, count) => {
      perScanner[name] = count;
      hooks.onDone?.(name, count);
    },
    onError: (name, err) => {
      errored.push(name);
      hooks.onError?.(name, err);
    },
  });

  return {
    ecosystem: ecosystem.name,
    lockfilePath,
    packageCount: packages.length,
    scanners: enabled.map((s) => s.name),
    perScanner,
    errored,
    findings,
  };
}
