// scanners/rust-collision.ts
// Rust analogs of Scan 2 (global-state / resource sharing) and Scan 3
// (event-listeners / hooks). Both locate each crate's source in the cargo
// registry cache, profile it with the heuristic extractor, then flag targets
// touched by 2+ crates.
//
// Crates with no resolvable source on disk (cache miss — the crate isn't
// unpacked under ~/.cargo/registry/src) profile as empty rather than erroring,
// so those simply degrade to osv + version-conflict.

import type { ResolvedPackage, Scanner } from "../core/types";
import type { PackageProfile } from "./shared-ast-extractor";
import { extractRustProfile } from "./rust-profile-extractor";
import {
  crateSourceDir,
  getRustSourceFiles,
  readRustSource,
} from "./rust-source-locator";
import { groupByTarget } from "./util";

/** Profile every crate by locating + reading its cached source. */
function profileCrates(pkgs: ResolvedPackage[]): PackageProfile[] {
  return pkgs.map((pkg) => {
    const dir = crateSourceDir(pkg);
    if (!dir) return { writes: [], listeners: [] };
    return extractRustProfile(readRustSource(getRustSourceFiles(dir)));
  });
}

export const rustGlobalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = profileCrates(pkgs);
    return groupByTarget(pkgs, profiles, "writes")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "global-state" as const,
        severity: "high" as const, // duplicate allocator/env write collides process-wide
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} crates claim "${g.target}" — process-global resource, they collide at runtime`,
      }));
  },
};

export const rustHooksScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = profileCrates(pkgs);
    return groupByTarget(pkgs, profiles, "listeners")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "event-listeners" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} crates install "${g.target}" — competing set-once/process-wide handlers`,
      }));
  },
};
