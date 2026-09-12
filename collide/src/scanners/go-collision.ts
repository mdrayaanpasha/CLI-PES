// scanners/go-collision.ts
// Go analogs of Scan 2 (global-state) and Scan 3 (event-listeners). Both read
// each module's source from the Go module cache once, profile it with the
// heuristic extractor, then flag targets touched by 2+ modules.
//
// No SQLite cache here (getOrCache is wired to npm's node_modules resolution);
// each module's source is read once per scan via the shared profiler below.

import type { ResolvedPackage, Scanner } from "../core/types";
import type { PackageProfile } from "./shared-ast-extractor";
import { extractGoProfile } from "./go-profile-extractor";
import {
  getGoSourceFiles,
  moduleSourceDir,
  readGoSource,
} from "./go-source-locator";
import { groupByTarget } from "./util";

/** Profile every module by locating + reading its cached source. Modules with
 *  no source on disk (cache miss) profile as empty rather than erroring. */
function profileModules(pkgs: ResolvedPackage[]): PackageProfile[] {
  return pkgs.map((pkg) => {
    const dir = moduleSourceDir(pkg);
    if (!dir) return { writes: [], listeners: [] };
    return extractGoProfile(readGoSource(getGoSourceFiles(dir)));
  });
}

export const goGlobalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = profileModules(pkgs);
    return groupByTarget(pkgs, profiles, "writes")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "global-state" as const,
        severity: "high" as const, // duplicate flag/route/expvar panics or clobbers at runtime
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} modules register "${g.target}" — duplicate registration collides at runtime`,
      }));
  },
};

export const goEventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = profileModules(pkgs);
    return groupByTarget(pkgs, profiles, "listeners")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "event-listeners" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} modules hook "${g.target}"`,
      }));
  },
};
