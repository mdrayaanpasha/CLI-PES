// scanners/event-listeners.ts
// Scan 3: same profiles as global-state, different bucket (listeners).

import type { Scanner } from "../core/types";
import { getOrCache } from "../cache/db";
import { extractPackageProfile } from "./shared-ast-extractor";
import { groupByTarget } from "./util";

export const eventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = await Promise.all(
      pkgs.map((p) => getOrCache(p, extractPackageProfile)),
    );
    return groupByTarget(pkgs, profiles, "listeners")
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "event-listeners" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} packages register a listener on "${g.target}"`,
      }));
  },
};
