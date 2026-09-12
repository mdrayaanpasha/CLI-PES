// scanners/global-state.ts
// Scan 2: flag global/prototype write targets owned by 2+ packages.

import type { Scanner } from "../core/types";
import { getOrCache } from "../cache/db";
import { extractPackageProfile } from "./shared-ast-extractor";
import { groupByTarget } from "./util";

export const globalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = await Promise.all(
      pkgs.map((p) => getOrCache(p, extractPackageProfile)),
    );
    return groupByTarget(pkgs, profiles, "writes")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "global-state" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} packages write to "${g.target}"`,
      }));
  },
};
