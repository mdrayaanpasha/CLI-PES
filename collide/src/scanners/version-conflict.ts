// scanners/version-conflict.ts
// Scan 4: pure lockfile-tree parsing — flag names resolved to 2+ versions.

import type { Scanner } from "../core/types";
import { groupBy } from "./util";

export const versionConflictScanner: Scanner = {
  name: "version-conflict",
  scan: async (pkgs) => {
    const byName = groupBy(pkgs, (p) => p.name);
    return Object.entries(byName)
      .filter(([, versions]) => new Set(versions.map((v) => v.version)).size > 1)
      .map(([name, versions]) => ({
        scanner: "version-conflict" as const,
        severity: "low" as const,
        target: name,
        owners: versions.map((v) => `${name}@${v.version}`),
        message: `Multiple versions of ${name} in dependency tree`,
      }));
  },
};
