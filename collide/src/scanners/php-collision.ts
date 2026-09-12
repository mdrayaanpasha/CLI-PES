// scanners/php-collision.ts
// PHP analogs of Scan 2 (global-state) and Scan 3 (event-listeners). Both read
// each package's vendor source once (sourcePath set by core/composer-manifest.ts),
// profile it with the heuristic extractor, then flag targets touched by 2+
// packages. Mirrors py-collision.
//
// Packages with no resolvable source on disk (e.g. a `--no-dev` install with no
// vendor/ entry) profile as empty rather than erroring — those degrade to osv +
// version-conflict.

import type { ResolvedPackage, Scanner } from "../core/types";
import type { PackageProfile } from "./shared-ast-extractor";
import { extractPhpProfile } from "./php-profile-extractor";
import { getPhpSourceFiles, readPhpSource } from "./php-source-locator";
import { groupByTarget } from "./util";

/** Profile every package by reading its vendor source. */
function profilePackages(pkgs: ResolvedPackage[]): PackageProfile[] {
  return pkgs.map((pkg) => {
    if (!pkg.sourcePath) return { writes: [], listeners: [] };
    return extractPhpProfile(readPhpSource(getPhpSourceFiles(pkg.sourcePath)));
  });
}

export const phpGlobalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = profilePackages(pkgs);
    return groupByTarget(pkgs, profiles, "writes")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "global-state" as const,
        // a root-namespace function redeclared by two packages is a PHP fatal
        // error; other global writes are order-dependent last-wins hazards.
        severity: "high" as const,
        target: g.target,
        owners: g.owners,
        message: g.target.startsWith("function:")
          ? `${g.owners.length} packages define root-namespace ${g.target} — fatal redeclaration error if both load`
          : `${g.owners.length} packages mutate "${g.target}" — shared global state, last write wins`,
      }));
  },
};

export const phpHooksScanner: Scanner = {
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
        message: `${g.owners.length} packages register "${g.target}" — competing process-wide handlers, last call wins`,
      }));
  },
};
