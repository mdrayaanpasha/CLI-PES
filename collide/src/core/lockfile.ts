// core/lockfile.ts
// Parse package-lock.json → a flat list of resolved packages.

import type { ResolvedPackage } from "./types";

export function parseLockfile(lockfilePath: string): ResolvedPackage[] {
  // TODO: read + JSON.parse the lockfile, walk "packages"/"dependencies",
  //       and return one ResolvedPackage per resolved node.
  throw new Error("parseLockfile: not implemented");
}
