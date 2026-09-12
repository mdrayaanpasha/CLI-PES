// scanners/go-version-conflict.ts
// Go analog of Scan 4. Go's minimal version selection means one version per
// module path per build, so plain duplicates are rare — EXCEPT across
// major-version module paths (`.../v2`, `.../v3`), which Go treats as distinct
// modules. `github.com/foo/bar` and `github.com/foo/bar/v2` coexisting is the
// Go version-conflict. We detect it by stripping a trailing `/vN` when grouping.
// See docs/ecosystems/go-modules.md §2.

import type { Scanner } from "../core/types";
import { groupBy } from "./util";

/** Strip a trailing major-version path segment: `.../v2` → `...`. `v0`/`v1`
 *  are never used as path suffixes in Go, so only match v2 and up. */
export function stripMajorVersionPath(modulePath: string): string {
  return modulePath.replace(/\/v[2-9][0-9]*$/, "");
}

export const goVersionConflictScanner: Scanner = {
  name: "version-conflict",
  scan: async (pkgs) => {
    const byBase = groupBy(pkgs, (p) => stripMajorVersionPath(p.name));

    return Object.entries(byBase)
      .filter(([, members]) => {
        // conflict when the base resolves to 2+ distinct module@version identities
        const identities = new Set(members.map((m) => `${m.name}@${m.version}`));
        return identities.size > 1;
      })
      .map(([base, members]) => {
        const distinctPaths = new Set(members.map((m) => m.name));
        const isMajorPathConflict = distinctPaths.size > 1;
        return {
          scanner: "version-conflict" as const,
          severity: "low" as const,
          target: base,
          owners: [...new Set(members.map((m) => `${m.name}@${m.version}`))],
          message: isMajorPathConflict
            ? `Multiple major versions of ${base} coexist as separate modules`
            : `Multiple versions of ${base} in module graph`,
        };
      });
  },
};
