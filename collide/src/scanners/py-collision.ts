// scanners/py-collision.ts
// Python analogs of Scan 2 (global-state) and Scan 3 (event-listeners). Both
// read each package's installed source from site-packages once (sourcePath set
// by core/pip-manifest.ts), profile it with the heuristic extractor, then flag
// targets touched by 2+ packages.
//
// Packages with no resolvable source on disk (no venv, or unresolved path)
// profile as empty rather than erroring — those degrade to osv + version-conflict.

import type { ResolvedPackage, Scanner } from "../core/types";
import type { PackageProfile } from "./shared-ast-extractor";
import { extractPyProfile } from "./py-profile-extractor";
import { getPySourceFiles, readPySource } from "./py-source-locator";
import { groupByTarget } from "./util";

/** Profile every package by reading its installed source. */
function profilePackages(pkgs: ResolvedPackage[]): PackageProfile[] {
  return pkgs.map((pkg) => {
    if (!pkg.sourcePath) return { writes: [], listeners: [] };
    return extractPyProfile(readPySource(getPySourceFiles(pkg.sourcePath)));
  });
}

export const pyGlobalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = profilePackages(pkgs);
    return groupByTarget(pkgs, profiles, "writes")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "global-state" as const,
        severity: "high" as const, // shared global mutation is order-dependent, last import wins
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} packages mutate "${g.target}" — shared global state, last import wins`,
      }));
  },
};

export const pyHooksScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = profilePackages(pkgs);
    return groupByTarget(pkgs, profiles, "listeners")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "event-listeners" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} packages register "${g.target}" — competing process-wide handlers`,
      }));
  },
};
